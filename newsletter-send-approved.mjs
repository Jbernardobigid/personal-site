/**
 * newsletter-send-approved.mjs  (run on the VPS by "A Interseção — Send Approved")
 *
 * Polls the Notion "Newsletter Approvals" DB for rows with Status=Approved, then for each:
 *   - reads the built email-safe HTML from $NEWSLETTER_DIR/.tmp/<slug>.html,
 *   - creates + sends a Resend Broadcast to the subscriber Audience (RESEND_AUDIENCE_ID),
 *   - flips the Notion row to Status=Sent.
 *
 * The built HTML carries the {{{RESEND_UNSUBSCRIBE_URL}}} tag, which Resend resolves per recipient.
 * Idempotent: only Approved rows are sent, and each is flipped to Sent immediately.
 *
 * Env: NEWSLETTER_DIR, NOTION_API_KEY, NOTION_NEWSLETTER_DB_ID,
 *      RESEND_API_KEY, RESEND_AUDIENCE_ID, NEWSLETTER_FROM
 */

import './load-env.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { queryDatabase, updatePage, prop, getTitle } from './notion-api.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NEWSLETTER_DIR = process.env.NEWSLETTER_DIR || path.join(__dirname, '..', 'newsletter');
const TMP_DIR = path.join(NEWSLETTER_DIR, '.tmp');
const DB_ID = process.env.NOTION_NEWSLETTER_DB_ID;
const FROM_EMAIL = process.env.NEWSLETTER_FROM || 'Jorge Bernardo <newsletter@jorgebernardo.tech>';

function out(obj) { console.log(JSON.stringify(obj)); }
function fail(msg) { out({ success: false, error: msg }); process.exit(1); }

async function resend(method, apiPath, body) {
  const key = process.env.RESEND_API_KEY;
  if (!key) fail('RESEND_API_KEY not set');
  const res = await fetch(`https://api.resend.com${apiPath}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Resend ${method} ${apiPath} ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

async function broadcast(slug, subject, html) {
  const audienceId = process.env.RESEND_AUDIENCE_ID;
  if (!audienceId) throw new Error('RESEND_AUDIENCE_ID not set');
  const created = await resend('POST', '/broadcasts', {
    audience_id: audienceId, from: FROM_EMAIL, subject, html, name: `A Interseção — ${slug}`,
  });
  await resend('POST', `/broadcasts/${created.id}/send`, {});
  return created.id;
}

async function main() {
  if (!DB_ID) fail('NOTION_NEWSLETTER_DB_ID not set');
  const approved = await queryDatabase(DB_ID, { property: 'Status', select: { equals: 'Approved' } });
  if (!approved.length) { out({ success: true, sent: 0, reason: 'nothing approved' }); return; }

  const results = [];
  for (const page of approved) {
    const slug = getTitle(page);
    try {
      const htmlPath = path.join(TMP_DIR, `${slug}.html`);
      if (!fs.existsSync(htmlPath)) throw new Error(`built HTML missing for ${slug} (was .tmp cleared?)`);
      const html = fs.readFileSync(htmlPath, 'utf8');
      const manifestPath = path.join(TMP_DIR, `${slug}_manifest.json`);
      const subject = fs.existsSync(manifestPath)
        ? (JSON.parse(fs.readFileSync(manifestPath, 'utf8')).subject || slug)
        : slug;

      const broadcastId = await broadcast(slug, subject, html);
      await updatePage(page.id, { Status: prop.select('Sent') });
      results.push({ slug, broadcastId, sent: true });
    } catch (err) {
      results.push({ slug, sent: false, error: err.message });
    }
  }
  const sent = results.filter(r => r.sent).length;
  out({ success: results.every(r => r.sent), sent, total: approved.length, results });
}

main().catch(err => fail(err?.message || String(err)));
