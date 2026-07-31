/**
 * reply-to-comments.mjs
 * Auto-replies to Instagram comments matching a trigger keyword with a private
 * DM containing the report link. Triggered by the IG `comments` webhook field,
 * called from the n8n VPS workflow on each incoming comment event.
 *
 * No follow-check: Instagram's API has no endpoint to verify whether a commenter
 * follows the account, so every matching comment gets the DM. The reply message
 * can still ask the person to follow; it just can't be enforced.
 *
 * Per Meta's current docs (Instagram API with Instagram Login), a private reply
 * to a comment is sent through the unified messages endpoint, not a dedicated
 * private_replies edge: POST /{IG_USER_ID}/messages with a JSON body
 * { recipient: { comment_id }, message: { text } }. Meta allows exactly one
 * reply per comment, within 7 days of the comment.
 *
 * Usage:
 *   node reply-to-comments.mjs <payload.json>   (Meta webhook body as a file)
 *   echo '{...}' | node reply-to-comments.mjs   (Meta webhook body via stdin)
 *
 * Requires: INSTAGRAM_ACCESS_TOKEN, INSTAGRAM_USER_ID, re-authed with the
 * instagram_business_manage_comments scope (the existing token only has
 * posting scopes — see docs/setup-meta-and-notion.md).
 * Keywords live in the TRIGGERS table below (one row per report). The optional
 * COMMENT_TRIGGER_KEYWORD / COMMENT_REPLY_MESSAGE env pair overrides the table
 * with a single keyword, kept for back-compat.
 */

import './load-env.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { requireEnv } from './post-to-instagram.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEDGER_PATH = path.join(__dirname, 'replied-comments.json');
const API_BASE = (process.env.INSTAGRAM_API_BASE || 'https://graph.facebook.com').replace(/\/$/, '');
const GRAPH = `${API_BASE}/v23.0`;

// One keyword per report. Adding a report means adding a row here and pushing:
// the n8n VPS workflow git-resets to origin/main before every invocation, so a
// push IS the deploy. Keywords are matched accent-insensitively as whole words.
const TRIGGERS = [
  {
    keyword: 'censo',
    message: [
      'Oi! Aqui está o relatório completo, com todos os números e a metodologia:',
      'https://www.jorgebernardo.tech/relatorios/censo-de-nomes-ligados-a-escravidao/',
      '',
      'Se você ainda não segue a página, ficaria feliz em ter você por aqui.'
    ].join('\n')
  },
  {
    keyword: 'mitologia',
    message: [
      'Oi! Aqui está o relatório completo, com as 12 comparações, as fontes e os limites:',
      'https://www.jorgebernardo.tech/relatorios/o-que-apagaram-dos-nossos-deuses/',
      '',
      'Se você ainda não segue a página, ficaria feliz em ter você por aqui.'
    ].join('\n')
  }
];

// Back-compat: the single-keyword env pair still works and, when set, overrides
// the table above rather than sitting alongside it.
const ENV_KEYWORD = process.env.COMMENT_TRIGGER_KEYWORD;
const ENV_MESSAGE = process.env.COMMENT_REPLY_MESSAGE;
const ACTIVE_TRIGGERS = ENV_KEYWORD
  ? [{ keyword: ENV_KEYWORD.toLowerCase(), message: ENV_MESSAGE || TRIGGERS[0].message }]
  : TRIGGERS;

/* ── Idempotency ledger ──────────────────────────────────── */

function loadLedger() {
  try {
    const l = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
    return Array.isArray(l?.repliedCommentIds) ? l : { repliedCommentIds: [] };
  } catch { return { repliedCommentIds: [] }; }
}

function markReplied(commentId) {
  const l = loadLedger();
  if (!l.repliedCommentIds.includes(commentId)) {
    l.repliedCommentIds.push(commentId);
    fs.writeFileSync(LEDGER_PATH, JSON.stringify(l, null, 2), 'utf8');
  }
}

/* ── Webhook payload parsing ─────────────────────────────── */

function stripAccents(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Returns the matching trigger (so the caller knows WHICH report to send), or
// null. First match wins, so keyword order in the table is the tie-breaker for
// a comment that somehow contains two of them.
function matchTrigger(text) {
  if (!text) return null;
  const normalized = stripAccents(text.toLowerCase());
  return ACTIVE_TRIGGERS.find(t =>
    new RegExp(`\\b${stripAccents(t.keyword)}\\b`, 'i').test(normalized)
  ) || null;
}

function extractComments(payload, igUserId) {
  const out = [];
  for (const entry of payload?.entry || []) {
    if (entry?.id && String(entry.id) !== String(igUserId)) continue;
    for (const change of entry?.changes || []) {
      if (change?.field !== 'comments') continue;
      const v = change.value;
      if (v?.id && v?.text) out.push(v);
    }
  }
  return out;
}

async function readPayload() {
  const file = process.argv[2];
  if (file) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/* ── Graph API ────────────────────────────────────────────── */

async function sendPrivateReply(token, igUserId, commentId, text) {
  const res = await fetch(`${GRAPH}/${igUserId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ recipient: { comment_id: commentId }, message: { text } })
  });
  const body = await res.json();
  if (!res.ok || body.error) {
    const msg = body.error ? `${body.error.type}: ${body.error.message}` : `HTTP ${res.status}`;
    throw new Error(`Graph API POST /${igUserId}/messages failed — ${msg}`);
  }
  return body;
}

/* ── Main ────────────────────────────────────────────────── */

async function main() {
  const { token, igUserId } = requireEnv();
  const payload = await readPayload();
  const comments = extractComments(payload, igUserId);

  if (comments.length === 0) {
    console.log(JSON.stringify({ success: true, processed: 0, reason: 'no comment changes in payload' }));
    return;
  }

  const ledger = loadLedger();
  const results = [];

  for (const comment of comments) {
    if (String(comment.from?.id) === String(igUserId)) {
      results.push({ commentId: comment.id, skipped: 'own comment' });
      continue;
    }
    if (ledger.repliedCommentIds.includes(comment.id)) {
      results.push({ commentId: comment.id, skipped: 'already replied' });
      continue;
    }
    const trigger = matchTrigger(comment.text);
    if (!trigger) {
      results.push({ commentId: comment.id, skipped: 'no keyword match' });
      continue;
    }

    try {
      await sendPrivateReply(token, igUserId, comment.id, trigger.message);
      markReplied(comment.id);
      results.push({ commentId: comment.id, sent: true, keyword: trigger.keyword, to: comment.from?.username });
    } catch (err) {
      results.push({ commentId: comment.id, error: err.message });
    }
  }

  console.log(JSON.stringify({ success: true, processed: results.length, results }, null, 2));
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  main().catch((err) => {
    console.error(`\nFailed: ${err.message}`);
    process.exit(1);
  });
}
