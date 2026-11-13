/**
 * newsletter-send-approved.mjs  (run on the VPS by "A Interseção — Send Approved")
 *
 * Polls the Notion "Newsletter Approvals" DB for rows with Status=Approved, then for each:
 *   - reads the built email-safe HTML from $NEWSLETTER_DIR/.tmp/<slug>.html,
 *   - locks the row (Status=Sending) and records the Resend broadcast id on it,
 *   - sends the Broadcast to the subscriber Audience (RESEND_AUDIENCE_ID),
 *   - flips the row to Status=Sent.
 *
 * The built HTML carries the {{{RESEND_UNSUBSCRIBE_URL}}} tag, which Resend resolves per recipient.
 *
 * A broadcast cannot be recalled, so the order of writes is what matters. The row used
 * to stay Approved until AFTER the send, so a Notion failure at that last step made the
 * next 30-minute poll send the whole list a second copy. Now the row leaves Approved
 * before anything is sent, and only steps that provably sent nothing put it back:
 *
 *   Approved ─lock→ Sending ─create─record id─send→ Sent
 *      ↑               │
 *      └── reverted ───┘  only if create or record-id failed (nothing was sent)
 *
 * A row left in Sending is reconciled against Resend on the next run: delivered or on
 * its way → Sent; still a draft, or no id on the row → reported as stuck with exit 1,
 * for a human. It is never re-sent automatically. A missed issue is recoverable; a
 * duplicate in every inbox is not.
 *
 * Env: NEWSLETTER_DIR, NOTION_API_KEY, NOTION_NEWSLETTER_DB_ID,
 *      RESEND_API_KEY, RESEND_AUDIENCE_ID, NEWSLETTER_FROM
 */

import './load-env.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { queryDatabase, updatePage, prop, getTitle, getRichText } from './notion-api.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NEWSLETTER_DIR = process.env.NEWSLETTER_DIR || path.join(__dirname, '..', 'newsletter');
const TMP_DIR = path.join(NEWSLETTER_DIR, '.tmp');
const FROM_EMAIL = process.env.NEWSLETTER_FROM || 'Jorge Bernardo <newsletter@jorgebernardo.tech>';

const STATUS = Object.freeze({ APPROVED: 'Approved', SENDING: 'Sending', SENT: 'Sent' });
const BROADCAST_NAME_MAX = 70;
const BROADCAST_ID_NOTE = /broadcast_id:\s*([\w-]{6,})/gi;
const RESEND_TIMEOUT_MS = 30000;
const errorText = (err) => String(err?.message || err);

/** The most recent broadcast id recorded on a row. A row that was re-approved after a
 *  failed attempt carries one id per attempt; only the last one describes the current
 *  attempt. Reading the first would report a stale draft and invite a second send. */
function latestBroadcastId(notes) {
  const ids = [...notes.matchAll(BROADCAST_ID_NOTE)].map((m) => m[1]);
  return ids.length ? ids[ids.length - 1] : null;
}

async function resendRequest(method, apiPath, body) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY not set');
  const res = await fetch(`https://api.resend.com${apiPath}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    // A hung request would otherwise stall the poller forever. A timeout on /send is
    // handled like any other ambiguous failure: the row stays locked and is reconciled.
    signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Resend ${method} ${apiPath} ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

/** Built HTML and subject for an issue. Throws when the build output is gone. */
function readIssueFromDisk(slug) {
  // The slug is a Notion title, so it is treated as untrusted before touching the disk.
  if (!/^[\w.-]+$/.test(slug) || slug.includes('..')) throw new Error(`unsafe issue slug "${slug}"`);
  const htmlPath = path.join(TMP_DIR, `${slug}.html`);
  if (!fs.existsSync(htmlPath)) throw new Error(`built HTML missing for ${slug} (was .tmp cleared?)`);
  const manifestPath = path.join(TMP_DIR, `${slug}_manifest.json`);
  const subject = fs.existsSync(manifestPath)
    ? (JSON.parse(fs.readFileSync(manifestPath, 'utf8')).subject || slug)
    : slug;
  return { html: fs.readFileSync(htmlPath, 'utf8'), subject };
}

/** Put a locked row back in the queue. Only called when nothing was sent. If even this
 *  fails the row stays in Sending and surfaces as stuck, which is the safe direction. */
async function unlock(deps, page) {
  try { await deps.updatePage(page.id, { Status: prop.select(STATUS.APPROVED) }); return true; }
  catch { return false; }
}

/** Notion's answer to a filter on a select option the database does not have. */
const isMissingOptionError = (err, option) =>
  /validation_error/.test(errorText(err)) && errorText(err).includes(`select option "${option}" not found`);

/** Rows currently locked in Sending. The Sending option is created by Notion the first
 *  time a row is set to it, and until then Notion rejects a filter on it outright. That
 *  rejection means "no locked rows", not a failure; any other error still propagates. */
async function lockedRows(deps) {
  try {
    return await deps.queryDatabase(deps.dbId, { property: 'Status', select: { equals: STATUS.SENDING } });
  } catch (err) {
    if (isMissingOptionError(err, STATUS.SENDING)) return [];
    throw err;
  }
}

/** Rows a previous run left locked: ask Resend what actually happened. */
async function reconcileSending(deps) {
  const locked = await lockedRows(deps);
  const stuck = [];
  let reconciled = 0;
  for (const page of locked) {
    const slug = getTitle(page);
    const broadcastId = latestBroadcastId(getRichText(page, 'Notes'));
    if (!broadcastId) {
      stuck.push({ slug, reason: 'locked with no broadcast id on the row: check Resend for this issue, then set Status to Sent or Approved by hand' });
      continue;
    }
    try {
      const broadcast = await deps.resend('GET', `/broadcasts/${broadcastId}`);
      // Resend documents only "draft" and "sent". Those two are acted on; anything else
      // (queued, scheduled, a failure state) is reported and looked at again next run,
      // never guessed at: guessing "sent" hides a missed issue, guessing "not sent"
      // invites a duplicate.
      const wasSent = Boolean(broadcast.sent_at) || broadcast.status === 'sent';
      if (!wasSent) {
        stuck.push({
          slug, broadcastId,
          reason: broadcast.status === 'draft'
            ? 'broadcast is still a draft in Resend, so nothing went out: set Status back to Approved to send it'
            : `Resend reports status "${broadcast.status}": not confirmed sent yet, will check again next run`,
        });
        continue;
      }
      await deps.updatePage(page.id, { Status: prop.select(STATUS.SENT) });
      reconciled += 1;
    } catch (err) {
      stuck.push({ slug, broadcastId, reason: `could not reconcile: ${errorText(err)}` });
    }
  }
  return { reconciled, stuck };
}

/** Send one approved row. Never throws: returns what happened to it. */
async function sendOne(deps, page) {
  const slug = getTitle(page);
  let issue;
  try { issue = deps.readIssue(slug); }
  catch (err) { return { slug, sent: false, error: errorText(err) }; }

  try { await deps.updatePage(page.id, { Status: prop.select(STATUS.SENDING) }); }
  catch (err) { return { slug, sent: false, error: `could not lock the row, nothing sent: ${errorText(err)}` }; }

  let broadcastId;
  try {
    const created = await deps.resend('POST', '/broadcasts', {
      audience_id: deps.audienceId, from: deps.from, subject: issue.subject, html: issue.html,
      name: `A Interseção — ${slug}`.slice(0, BROADCAST_NAME_MAX),
    });
    broadcastId = created.id;
    if (!broadcastId) throw new Error('Resend returned no broadcast id');
    const notes = getRichText(page, 'Notes');
    await deps.updatePage(page.id, { Notes: prop.longText(`${notes}${notes ? '\n' : ''}broadcast_id: ${broadcastId}`) });
  } catch (err) {
    const requeued = await unlock(deps, page);
    return { slug, sent: false, broadcastId, error: `nothing sent${requeued ? ', back in the queue' : ', row left in Sending'}: ${errorText(err)}` };
  }

  try { await deps.resend('POST', `/broadcasts/${broadcastId}/send`, {}); }
  catch (err) {
    return { slug, sent: false, broadcastId, error: `send call failed and MAY have gone out; row parked in Sending for the next run to reconcile: ${errorText(err)}` };
  }

  try { await deps.updatePage(page.id, { Status: prop.select(STATUS.SENT) }); }
  catch (err) {
    return { slug, sent: true, broadcastId, error: `sent, but the row is still Sending; the next run will reconcile it: ${errorText(err)}` };
  }
  return { slug, sent: true, broadcastId };
}

/**
 * Reconcile locked rows, then send every approved one. Dependencies are injected so the
 * state machine is testable without Notion or Resend.
 * @param {{ dbId: string, audienceId?: string, from?: string,
 *           queryDatabase: Function, updatePage: Function, resend: Function, readIssue: Function }} deps
 */
export async function processQueue(deps) {
  const { reconciled, stuck } = await reconcileSending(deps);
  const approved = await deps.queryDatabase(deps.dbId, { property: 'Status', select: { equals: STATUS.APPROVED } });
  const results = [];
  for (const page of approved) results.push(await sendOne(deps, page));
  return {
    success: stuck.length === 0 && results.every((r) => r.sent && !r.error),
    sent: results.filter((r) => r.sent).length,
    total: approved.length,
    // Kept from the old output shape: n8n nodes downstream may branch on it.
    ...(approved.length === 0 ? { reason: 'nothing approved' } : {}),
    reconciled,
    stuck,
    results,
  };
}

async function main() {
  const dbId = process.env.NOTION_NEWSLETTER_DB_ID;
  const audienceId = process.env.RESEND_AUDIENCE_ID;
  if (!dbId) throw new Error('NOTION_NEWSLETTER_DB_ID not set');
  if (!audienceId) throw new Error('RESEND_AUDIENCE_ID not set');
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY not set');
  return processQueue({
    dbId, audienceId, from: FROM_EMAIL,
    queryDatabase, updatePage, resend: resendRequest, readIssue: readIssueFromDisk,
  });
}

// Report by setting exitCode, never process.exit(): exiting while undici sockets are
// still closing trips a libuv assertion on Windows (see publish-linkedin.mjs).
const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  main()
    .then((summary) => {
      console.log(JSON.stringify(summary));
      process.exitCode = summary.success ? 0 : 1;
    })
    .catch((err) => {
      console.log(JSON.stringify({ success: false, error: errorText(err) }));
      process.exitCode = 1;
    });
}
