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
 * Optional: COMMENT_TRIGGER_KEYWORD (default "censo"), COMMENT_REPLY_MESSAGE.
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

const TRIGGER = (process.env.COMMENT_TRIGGER_KEYWORD || 'censo').toLowerCase();
const REPLY_MESSAGE = process.env.COMMENT_REPLY_MESSAGE || [
  'Oi! Aqui está o relatório completo, com todos os números e a metodologia:',
  'https://www.jorgebernardo.tech/relatorios/censo-de-nomes-ligados-a-escravidao/',
  '',
  'Se você ainda não segue a página, ficaria feliz em ter você por aqui.'
].join('\n');

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

function matchesTrigger(text) {
  if (!text) return false;
  const normalized = stripAccents(text.toLowerCase());
  return new RegExp(`\\b${TRIGGER}\\b`, 'i').test(normalized);
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
    if (!matchesTrigger(comment.text)) {
      results.push({ commentId: comment.id, skipped: 'no keyword match' });
      continue;
    }

    try {
      await sendPrivateReply(token, igUserId, comment.id, REPLY_MESSAGE);
      markReplied(comment.id);
      results.push({ commentId: comment.id, sent: true, to: comment.from?.username });
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
