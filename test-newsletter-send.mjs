/* Tests for the newsletter broadcaster's send state machine. Notion and Resend are
   in-memory fakes: nothing is sent and no network is touched. The property under test
   is that one approved issue can never be broadcast twice, whatever fails and when. */
import { processQueue } from './newsletter-send-approved.mjs';

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  if (!ok) console.log(`FAIL ${name}\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`);
};

/* ── fakes ───────────────────────────────────────────────── */

function makeNotion(rows) {
  const pages = rows.map(([slug, status, notes = '']) => ({
    id: `page-${slug}`,
    properties: {
      Name: { type: 'title', title: [{ plain_text: slug }] },
      Status: { type: 'select', select: { name: status } },
      Notes: { type: 'rich_text', rich_text: notes ? [{ plain_text: notes }] : [] },
    },
  }));
  const failures = [];   // predicates: (pageId, properties) => boolean, consumed once
  // Real Notion refuses to filter on a select option the database does not have yet,
  // and "Sending" only comes into existence the first time a row is set to it. Rows
  // created already in a status (e.g. Sending fixtures) mean that option exists.
  const options = new Set(['Pending', 'Approved', 'Sent', 'Rejected', ...rows.map((r) => r[1])]);
  return {
    pages,
    options,
    failOnce: (predicate) => failures.push(predicate),
    status: (slug) => pages.find((p) => p.id === `page-${slug}`).properties.Status.select.name,
    notes: (slug) => pages.find((p) => p.id === `page-${slug}`).properties.Notes.rich_text.map((x) => x.plain_text).join(''),
    queryDatabase: async (_db, filter) => {
      const wanted = filter.select.equals;
      if (!options.has(wanted)) {
        throw new Error(`Notion API POST /databases/db/query failed — validation_error: select option "${wanted}" not found for property "Status". Available options: "Pending", "Approved", "Sent", "Rejected".`);
      }
      return structuredClone(pages.filter((p) => p.properties.Status.select.name === wanted));
    },
    updatePage: async (pageId, properties) => {
      const hit = failures.findIndex((f) => f(pageId, properties));
      if (hit >= 0) { failures.splice(hit, 1); throw new Error('Notion 502'); }
      const page = pages.find((p) => p.id === pageId);
      if (properties.Status) {
        page.properties.Status.select.name = properties.Status.select.name;
        options.add(properties.Status.select.name);   // Notion creates the option on first use
      }
      if (properties.Notes) page.properties.Notes.rich_text = properties.Notes.rich_text.map((x) => ({ plain_text: x.text.content }));
    },
  };
}

function makeResend() {
  const broadcasts = new Map();
  const failures = [];   // predicates: (method, path) => boolean | Error, consumed once
  let nextId = 1;
  const api = async (method, apiPath) => {
    const hit = failures.findIndex((f) => f(method, apiPath));
    if (hit >= 0) { failures.splice(hit, 1); throw new Error('Resend 500'); }
    if (method === 'POST' && apiPath === '/broadcasts') {
      const id = `bc-0000000${nextId++}`;
      broadcasts.set(id, { id, status: 'draft', sent_at: null });
      return { id };
    }
    const send = /^\/broadcasts\/([^/]+)\/send$/.exec(apiPath);
    if (method === 'POST' && send) {
      const b = broadcasts.get(send[1]);
      b.status = 'sent'; b.sent_at = '2026-11-13 12:00:00+00'; api.sends.push(send[1]);
      return { id: b.id };
    }
    const get = /^\/broadcasts\/([^/]+)$/.exec(apiPath);
    if (method === 'GET' && get) {
      if (!broadcasts.has(get[1])) throw new Error('Resend GET 404');
      return { ...broadcasts.get(get[1]) };
    }
    throw new Error(`unexpected Resend call ${method} ${apiPath}`);
  };
  api.sends = [];
  api.broadcasts = broadcasts;
  api.failOnce = (predicate) => failures.push(predicate);
  return api;
}

const readIssue = (slug) => {
  if (slug.includes('missing')) throw new Error(`built HTML missing for ${slug}`);
  return { html: '<p>oi</p>', subject: `Assunto ${slug}` };
};
const run = (notion, resend) => processQueue({
  dbId: 'db', queryDatabase: notion.queryDatabase, updatePage: notion.updatePage, resend, readIssue,
});
const isStatus = (name) => (_id, props) => props.Status?.select.name === name;
const isNotes = (_id, props) => !!props.Notes;

/* ── first run ever: the database has no "Sending" option yet ─ */
{
  const notion = makeNotion([['2026-11-13-z', 'Pending']]);
  const resend = makeResend();
  const idle = await run(notion, resend);
  t('no Sending option yet, nothing approved: clean no-op', [idle.success, idle.sent, idle.reason], [true, 0, 'nothing approved']);
  notion.pages[0].properties.Status.select.name = 'Approved';
  const first = await run(notion, resend);
  t('no Sending option yet: an approved issue still goes out', [first.success, resend.sends.length, notion.status('2026-11-13-z')], [true, 1, 'Sent']);
}

/* ── happy path ──────────────────────────────────────────── */
{
  const notion = makeNotion([['2026-11-13-a', 'Approved', 'Revise a prévia.']]);
  const resend = makeResend();
  const out = await run(notion, resend);
  t('happy: reported success', [out.success, out.sent, out.total], [true, 1, 1]);
  t('happy: sent once', resend.sends.length, 1);
  t('happy: row ends Sent', notion.status('2026-11-13-a'), 'Sent');
  t('happy: broadcast id recorded, original note kept', notion.notes('2026-11-13-a'), 'Revise a prévia.\nbroadcast_id: bc-00000001');
  t('happy: a second run does nothing', [(await run(notion, resend)).sent, resend.sends.length], [0, 1]);
}

/* ── the reported bug: Notion fails AFTER the send ───────── */
{
  const notion = makeNotion([['2026-11-13-b', 'Approved']]);
  const resend = makeResend();
  notion.failOnce(isStatus('Sent'));
  const first = await run(notion, resend);
  t('post-send failure: run reports failure', first.success, false);
  t('post-send failure: row is locked, not Approved', notion.status('2026-11-13-b'), 'Sending');
  const second = await run(notion, resend);
  t('post-send failure: NOT sent again on the next run', resend.sends.length, 1);
  t('post-send failure: reconciled to Sent from Resend', [notion.status('2026-11-13-b'), second.reconciled, second.success], ['Sent', 1, true]);
  await run(notion, resend);
  t('post-send failure: still one send after a third run', resend.sends.length, 1);
}

/* ── failures before anything could be sent: retried later ─ */
{
  const notion = makeNotion([['2026-11-13-c', 'Approved']]);
  const resend = makeResend();
  resend.failOnce((m, p) => m === 'POST' && p === '/broadcasts');
  const first = await run(notion, resend);
  t('create fails: nothing sent, row back to Approved', [resend.sends.length, notion.status('2026-11-13-c'), first.success], [0, 'Approved', false]);
  await run(notion, resend);
  t('create fails: next run sends exactly once', [resend.sends.length, notion.status('2026-11-13-c')], [1, 'Sent']);
}
{
  const notion = makeNotion([['2026-11-13-d', 'Approved']]);
  const resend = makeResend();
  notion.failOnce(isNotes);
  await run(notion, resend);
  t('id cannot be recorded: not sent, row back to Approved', [resend.sends.length, notion.status('2026-11-13-d')], [0, 'Approved']);
}
{
  const notion = makeNotion([['2026-11-13-e', 'Approved']]);
  const resend = makeResend();
  notion.failOnce(isStatus('Sending'));
  const out = await run(notion, resend);
  t('lock fails: nothing created or sent', [resend.broadcasts.size, resend.sends.length, notion.status('2026-11-13-e'), out.success], [0, 0, 'Approved', false]);
}
{
  const notion = makeNotion([['2026-11-13-missing', 'Approved']]);
  const resend = makeResend();
  const out = await run(notion, resend);
  t('missing HTML: row untouched, nothing sent', [notion.status('2026-11-13-missing'), resend.broadcasts.size, out.success], ['Approved', 0, false]);
}

/* ── ambiguous send: never retried automatically ─────────── */
{
  const notion = makeNotion([['2026-11-13-f', 'Approved']]);
  const resend = makeResend();
  resend.failOnce((m, p) => m === 'POST' && p.endsWith('/send'));
  const first = await run(notion, resend);
  t('send errors: row parked in Sending', [notion.status('2026-11-13-f'), first.success], ['Sending', false]);
  const second = await run(notion, resend);
  t('send errors: draft is reported as stuck, not re-sent', [resend.sends.length, second.stuck.length, second.success, notion.status('2026-11-13-f')], [0, 1, false, 'Sending']);
  t('send errors: stuck entry names the row', second.stuck[0].slug, '2026-11-13-f');
}
{
  const notion = makeNotion([['2026-11-13-g', 'Sending', 'sem id']]);
  const resend = makeResend();
  const out = await run(notion, resend);
  t('Sending row with no broadcast id: stuck, nothing sent', [out.stuck.length, resend.sends.length, out.success], [1, 0, false]);
}

/* ── a re-approved row carries two ids: only the latest counts ─ */
{
  const notion = makeNotion([['2026-11-13-i', 'Approved']]);
  const resend = makeResend();
  resend.failOnce((m, p) => m === 'POST' && p.endsWith('/send'));
  await run(notion, resend);                                   // bc-1 created, send failed → parked
  notion.pages[0].properties.Status.select.name = 'Approved';  // Jorge re-approves by hand
  notion.failOnce(isStatus('Sent'));
  await run(notion, resend);                                   // bc-2 created and SENT, final write fails
  t('re-approved: second broadcast went out once', resend.sends, ['bc-00000002']);
  t('re-approved: both ids are on the row', (notion.notes('2026-11-13-i').match(/broadcast_id:/g) || []).length, 2);
  const third = await run(notion, resend);
  t('re-approved: reconciled from the LATEST id, not the stale draft', [notion.status('2026-11-13-i'), third.stuck.length, resend.sends.length], ['Sent', 0, 1]);
}

/* ── a status that is neither draft nor sent is waited on, never assumed ─ */
{
  const notion = makeNotion([['2026-11-13-j', 'Sending', 'broadcast_id: bc-queued01']]);
  const resend = makeResend();
  resend.broadcasts.set('bc-queued01', { id: 'bc-queued01', status: 'queued', sent_at: null });
  const waiting = await run(notion, resend);
  t('in-flight status: row left alone and reported', [notion.status('2026-11-13-j'), waiting.stuck.length, waiting.success, resend.sends.length], ['Sending', 1, false, 0]);
  resend.broadcasts.set('bc-queued01', { id: 'bc-queued01', status: 'sent', sent_at: '2026-11-13 12:00:00+00' });
  const done = await run(notion, resend);
  t('in-flight status: flips to Sent once Resend says so', [notion.status('2026-11-13-j'), done.reconciled, done.success], ['Sent', 1, true]);
}
{
  const notion = makeNotion([['2026-11-13-k', 'Sending', 'broadcast_id: bc-failed01']]);
  const resend = makeResend();
  resend.broadcasts.set('bc-failed01', { id: 'bc-failed01', status: 'failed', sent_at: null });
  const out = await run(notion, resend);
  t('unknown status: never silently marked Sent', [notion.status('2026-11-13-k'), out.stuck.length, /failed/.test(out.stuck[0].reason)], ['Sending', 1, true]);
}

/* ── one bad row does not block the rest ─────────────────── */
{
  const notion = makeNotion([['2026-11-13-missing', 'Approved'], ['2026-11-13-h', 'Approved']]);
  const resend = makeResend();
  const out = await run(notion, resend);
  t('mixed batch: the good row still goes out', [out.sent, out.total, notion.status('2026-11-13-h'), out.success], [1, 2, 'Sent', false]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
