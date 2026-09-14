/**
 * newsletter-pending-check.mjs  (run on the VPS by "A Interseção — Pending Check")
 *
 * Alarms on newsletter issues that were built and queued but never approved.
 *
 * The approval gate is one email. When that email does not arrive, nothing else
 * notices: the build workflow is green (it DID build), the send poller is green
 * (nothing was approved, which is a valid state), and the issue simply never goes
 * out. That is exactly how 2026-09-11 sat Pending for three days — Gmail had
 * silently dropped the preview, so there was nothing to approve from.
 *
 * This closes that hole from the other side: anything Pending past the threshold
 * gets a plain, attachment-free alert email AND a non-zero exit, so the n8n run
 * goes red instead of green.
 *
 * Env: NOTION_API_KEY, NOTION_NEWSLETTER_DB_ID, RESEND_API_KEY, NEWSLETTER_FROM,
 *      CAROUSEL_NOTIFY_EMAIL. Optional: NEWSLETTER_PENDING_MAX_HOURS (default 24).
 * Flags: --hours <n> (override threshold), --dry-run (report, send no email),
 *        --status <name> (check a status other than Pending — for exercising the
 *        alarm against real rows without planting a fake Pending one)
 */

import './load-env.mjs';
import { queryDatabase, getTitle, getRichText } from './notion-api.mjs';

const DB_ID = process.env.NOTION_NEWSLETTER_DB_ID;
const NOTIFY_EMAIL = process.env.CAROUSEL_NOTIFY_EMAIL || 'jorge.mbernardo@gmail.com';
const FROM_EMAIL = process.env.NEWSLETTER_FROM || 'Jorge Bernardo <newsletter@jorgebernardo.tech>';
const DEFAULT_MAX_HOURS = 24;
const MS_PER_HOUR = 60 * 60 * 1000;

function out(obj) { console.log(JSON.stringify(obj)); }

/**
 * Report and mark the run as failed. Sets exitCode rather than calling
 * process.exit(): an immediate exit can race the stdout flush and truncate the
 * JSON line that n8n parses, which is the same class of silent failure this
 * script exists to catch.
 */
function fail(msg) { out({ success: false, error: msg }); process.exitCode = 1; }

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Hours since the row was created, rounded to one decimal. */
function ageHours(page, now) {
  const created = Date.parse(page.created_time);
  if (Number.isNaN(created)) return null;
  return Math.round(((now - created) / MS_PER_HOUR) * 10) / 10;
}

/**
 * Plain text-and-links email. No attachments on purpose: the attachment is the
 * prime suspect for the dropped previews this alarm exists to catch, so the alarm
 * itself must not carry one.
 */
async function sendAlert(stale, maxHours) {
  const key = process.env.RESEND_API_KEY;
  if (!key) fail('RESEND_API_KEY not set');

  const rows = stale.map(s => `
    <li style="margin-bottom:12px">
      <strong>${escapeHtml(s.subject)}</strong><br>
      <span style="color:#6b6357">parada h&aacute; ${s.ageHours}h</span> &middot;
      <a href="${escapeHtml(s.url)}" style="color:#1c314a;font-weight:600">abrir no Notion</a>
    </li>`).join('');

  const html = `<div style="max-width:640px;margin:32px auto;padding:0 20px;font:16px/1.6 -apple-system,system-ui,sans-serif;color:#1e1a14">
    <div style="background:#f3ede6;border:1px solid #d9d9d9;border-radius:8px;padding:16px 20px;color:#5e412d">
      &#9888;&#65039; <strong>A Interse&ccedil;&atilde;o</strong> &mdash; ${stale.length} edi&ccedil;&atilde;o(&otilde;es)
      parada(s) em <code>Pending</code> h&aacute; mais de ${maxHours}h.
    </div>
    <p>A edi&ccedil;&atilde;o foi constru&iacute;da mas nunca foi aprovada, ent&atilde;o n&atilde;o foi enviada
    para a lista. Se voc&ecirc; n&atilde;o recebeu a pr&eacute;via por email, aprove direto no Notion.</p>
    <ul style="padding-left:20px">${rows}</ul>
    <p style="font-size:14px;color:#6b6357">Defina <code>Status = Approved</code> para enviar, ou
    <code>Rejected</code> para descartar e silenciar este aviso.</p>
  </div>`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [NOTIFY_EMAIL],
      subject: `⚠️ A Interseção — ${stale.length} edição(ões) parada(s) em Pending`,
      html,
    }),
  });
  if (!res.ok) fail(`Resend failed (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`);
  return (await res.json()).id;
}

async function main() {
  if (!DB_ID) fail('NOTION_NEWSLETTER_DB_ID not set');
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const hoursArg = args.includes('--hours') ? Number(args[args.indexOf('--hours') + 1]) : NaN;
  const envHours = Number(process.env.NEWSLETTER_PENDING_MAX_HOURS);
  const maxHours = Number.isFinite(hoursArg) ? hoursArg
    : Number.isFinite(envHours) ? envHours
    : DEFAULT_MAX_HOURS;

  const status = args.includes('--status') ? args[args.indexOf('--status') + 1] : 'Pending';
  const pending = await queryDatabase(DB_ID, { property: 'Status', select: { equals: status } });
  const now = Date.now();
  const stale = pending
    .map(page => ({
      slug: getTitle(page),
      subject: getRichText(page, 'Subject') || getTitle(page),
      url: page.url,
      ageHours: ageHours(page, now),
    }))
    .filter(row => row.ageHours !== null && row.ageHours > maxHours)
    .sort((a, b) => b.ageHours - a.ageHours);

  if (!stale.length) {
    out({ success: true, status, pending: pending.length, stale: 0, maxHours });
    return;
  }

  const alertId = dryRun ? null : await sendAlert(stale, maxHours);
  out({ success: false, status, pending: pending.length, stale: stale.length, maxHours, alertId, dryRun, rows: stale });

  // Non-zero so the n8n run goes red. A stale issue is a failure of the pipeline,
  // not a quiet state worth reporting as green.
  process.exitCode = 1;
}

main().catch(err => fail(err?.message || String(err)));
