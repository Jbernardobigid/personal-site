/**
 * blob-recycle.mjs
 * Reclaims space in the Vercel Blob store by deleting objects that are provably
 * finished with, and refusing to touch anything else.
 *
 *   node blob-recycle.mjs                 # dry run - prints the plan, deletes nothing
 *   node blob-recycle.mjs --apply         # actually delete
 *   node blob-recycle.mjs --json          # machine-readable plan (for n8n)
 *
 * WHY THE RULES LOOK LIKE THIS
 *
 * Blob objects fall into two very different classes, and conflating them is how you
 * break something quietly:
 *
 *   1. STATE-REFERENCED - something we can query says whether the object is still
 *      needed. A Reel's blob URL is the Notion card's `Media URL`; publish-approved.mjs
 *      hands that URL to Instagram at publish time, and once Instagram has ingested the
 *      video it serves its own copy forever. So a Reel whose card reads Published or
 *      Archived is genuinely finished, and we can prove it.
 *
 *   2. EXTERNALLY REFERENCED - the reference lives somewhere we cannot query, namely
 *      an email that already landed in someone's inbox. Newsletter charts and heroes are
 *      referenced by Resend broadcasts and Gmail copies that recipients can reopen at any
 *      time. A reconciliation pass sees no reference to these and will happily call them
 *      orphans. They are not orphans. They get age-based retention only, never
 *      "unreferenced means delete".
 *
 * Podcast audio is neither: podcast/*.mp3 is served to Spotify and Apple through
 * podcast.xml. Deleting one breaks a published episode permanently. The prefix is hard
 * protected and no flag in this script will remove it.
 *
 * FAIL CLOSED: if the Notion query fails, every Reel would look unreferenced and the
 * script would propose deleting all of them. So a Notion failure aborts the run.
 */

import './load-env.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { list, del } from '@vercel/blob';
import { queryDatabase, getSelect, getUrl, getTitle } from './notion-api.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Notion statuses that mean a Reel will never need its blob served again. */
const TERMINAL_STATUSES = new Set(['Published', 'Archived']);

/** Prefixes no flag may ever delete. */
const PROTECTED_PREFIXES = new Set(['podcast']);

/**
 * Retention policy per prefix.
 *   mode 'notion-state' - delete once the owning card is terminal, after graceDays.
 *                         Objects with no card at all wait orphanGraceDays instead, in
 *                         case they belong to a run still in flight.
 *   mode 'age'          - delete purely on age. Used where the reference is an email we
 *                         cannot inspect, so the only safe signal is "old enough that
 *                         nobody is reopening it".
 *   mode 'protected'    - never.
 */
const POLICY = {
  'podcast':           { mode: 'protected', why: 'served to Spotify/Apple via podcast.xml' },
  'video':             { mode: 'notion-state', graceDays: 7, orphanGraceDays: 30,
                         why: 'Instagram serves its own copy once the Reel is published' },
  'instagram':         { mode: 'age', retainDays: 30,
                         why: 'IG media staging; Instagram hosts its own copy after publish' },
  'reels':             { mode: 'age', retainDays: 30, why: 'superseded by the video/ prefix' },
  'video-test':        { mode: 'age', retainDays: 7,  why: 'test artifacts' },
  'newsletter-charts': { mode: 'age', retainDays: 180,
                         why: 'referenced by delivered emails recipients can still reopen' },
  'newsletter-heroes': { mode: 'age', retainDays: 180,
                         why: 'referenced by delivered emails recipients can still reopen' }
};

/** Anything under a prefix with no policy is kept and reported, never guessed at. */
const DEFAULT_POLICY = { mode: 'unknown', why: 'no policy for this prefix - kept' };

const MB = bytes => bytes / 1048576;
const fmtMB = bytes => MB(bytes).toFixed(1);
const daysOld = date => (Date.now() - new Date(date).getTime()) / 86400_000;

async function listAllBlobs(token) {
  const blobs = [];
  let cursor;
  do {
    const res = await list({ token, limit: 1000, cursor });
    blobs.push(...res.blobs);
    cursor = res.cursor;
  } while (cursor);
  return blobs;
}

/**
 * url -> { status, card } for every Notion card carrying a Media URL.
 * Throws on failure: see FAIL CLOSED above.
 */
async function loadNotionState() {
  const dbId = process.env.NOTION_IG_DB_ID;
  if (!dbId) throw new Error('NOTION_IG_DB_ID not set');
  const pages = await queryDatabase(dbId);
  if (!Array.isArray(pages)) throw new Error('Notion returned no page array');
  const byUrl = new Map();
  for (const page of pages) {
    const url = getUrl(page, 'Media URL');
    if (url) byUrl.set(url.split('?')[0], { status: getSelect(page, 'Status') || '(none)', card: getTitle(page) });
  }
  return { byUrl, cardCount: pages.length };
}

/** URLs hard-referenced by committed files (podcast feed, meta ledgers). */
function loadFileReferences() {
  const refs = new Set();
  for (const file of ['podcast-episodes.json', 'podcast.xml', 'carousel-meta.json', 'post-meta.json']) {
    const full = path.join(__dirname, file);
    if (!fs.existsSync(full)) continue;
    const text = fs.readFileSync(full, 'utf8');
    for (const m of text.matchAll(/https:\/\/[a-z0-9]+\.public\.blob\.vercel-storage\.com\/[^"'\s<>]+/g)) {
      refs.add(m[0].split('?')[0]);
    }
  }
  return refs;
}

/** Decide one object's fate. Returns { action: 'delete'|'keep', reason }. */
function classify(blob, { notionByUrl, fileRefs }) {
  const prefix = blob.pathname.includes('/') ? blob.pathname.split('/')[0] : '(root)';
  const policy = POLICY[prefix] || DEFAULT_POLICY;
  const url = blob.url.split('?')[0];
  const age = daysOld(blob.uploadedAt);

  if (PROTECTED_PREFIXES.has(prefix) || policy.mode === 'protected') {
    return { prefix, action: 'keep', reason: `protected (${policy.why})` };
  }
  if (fileRefs.has(url)) {
    return { prefix, action: 'keep', reason: 'referenced by a committed file' };
  }
  if (policy.mode === 'unknown') {
    return { prefix, action: 'keep', reason: policy.why };
  }

  if (policy.mode === 'notion-state') {
    const card = notionByUrl.get(url);
    if (!card) {
      return age >= policy.orphanGraceDays
        ? { prefix, action: 'delete', reason: `no Notion card, ${Math.floor(age)}d old (>= ${policy.orphanGraceDays}d)` }
        : { prefix, action: 'keep', reason: `no Notion card but only ${Math.floor(age)}d old - may be in flight` };
    }
    if (!TERMINAL_STATUSES.has(card.status)) {
      return { prefix, action: 'keep', reason: `card status "${card.status}" is not terminal` };
    }
    return age >= policy.graceDays
      ? { prefix, action: 'delete', reason: `card ${card.status}, ${Math.floor(age)}d old (>= ${policy.graceDays}d)` }
      : { prefix, action: 'keep', reason: `card ${card.status} but only ${Math.floor(age)}d old - within grace` };
  }

  // mode 'age'
  return age >= policy.retainDays
    ? { prefix, action: 'delete', reason: `${Math.floor(age)}d old (>= ${policy.retainDays}d retention)` }
    : { prefix, action: 'keep', reason: `${Math.floor(age)}d old, retained ${policy.retainDays}d (${policy.why})` };
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const asJson = args.includes('--json');

  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    console.error('Error: BLOB_READ_WRITE_TOKEN is not set.');
    process.exitCode = 1;
    return;
  }

  // Fail closed: without Notion we cannot tell a published Reel from a pending one.
  //
  // Set process.exitCode and return rather than calling process.exit(). A hard exit while
  // the Notion fetch is still unwinding aborts the process on Windows with a libuv
  // assertion, and the shell then reports 127 instead of 1 — which n8n reads as a
  // different kind of failure than the one that actually happened.
  let notion;
  try {
    notion = await loadNotionState();
  } catch (e) {
    console.error(`Error: could not read Notion (${e.message}).`);
    console.error('Aborting: without card statuses every Reel looks unreferenced and would be deleted.');
    process.exitCode = 1;
    return;
  }

  const fileRefs = loadFileReferences();
  const blobs = await listAllBlobs(token);
  const totalBefore = blobs.reduce((s, b) => s + b.size, 0);

  const decisions = blobs.map(b => ({ blob: b, ...classify(b, { notionByUrl: notion.byUrl, fileRefs }) }));
  const toDelete = decisions.filter(d => d.action === 'delete');
  const freed = toDelete.reduce((s, d) => s + d.blob.size, 0);

  if (asJson) {
    console.log(JSON.stringify({
      apply,
      totals: { objects: blobs.length, mb: +fmtMB(totalBefore) },
      reclaim: { objects: toDelete.length, mb: +fmtMB(freed) },
      after: { objects: blobs.length - toDelete.length, mb: +fmtMB(totalBefore - freed) },
      delete: toDelete.map(d => ({ pathname: d.blob.pathname, mb: +fmtMB(d.blob.size), reason: d.reason }))
    }, null, 2));
  } else {
    const byPrefix = {};
    for (const d of decisions) {
      const g = byPrefix[d.prefix] ??= { keep: 0, keepBytes: 0, del: 0, delBytes: 0 };
      if (d.action === 'delete') { g.del++; g.delBytes += d.blob.size; }
      else { g.keep++; g.keepBytes += d.blob.size; }
    }
    console.log(`Blob store: ${blobs.length} objects, ${fmtMB(totalBefore)} MB`);
    console.log(`Notion: ${notion.cardCount} cards, ${notion.byUrl.size} with a Media URL\n`);
    console.log('prefix'.padEnd(20), 'KEEP'.padStart(16), 'RECLAIM'.padStart(16));
    for (const [p, g] of Object.entries(byPrefix).sort((a, b) => b[1].delBytes - a[1].delBytes)) {
      console.log(p.padEnd(20), `${g.keep} / ${fmtMB(g.keepBytes)}MB`.padStart(16), `${g.del} / ${fmtMB(g.delBytes)}MB`.padStart(16));
    }
    console.log(`\nReclaimable: ${toDelete.length} objects, ${fmtMB(freed)} MB`);
    console.log(`After:       ${blobs.length - toDelete.length} objects, ${fmtMB(totalBefore - freed)} MB\n`);
    const shown = toDelete.slice().sort((a, b) => b.blob.size - a.blob.size).slice(0, 20);
    for (const d of shown) {
      console.log(`  ${fmtMB(d.blob.size).padStart(7)}MB  ${d.blob.pathname.slice(0, 62).padEnd(62)}  ${d.reason}`);
    }
    if (toDelete.length > shown.length) console.log(`  ... and ${toDelete.length - shown.length} more`);
  }

  if (!apply) {
    if (!asJson) console.log('\nDry run. Nothing deleted. Re-run with --apply to reclaim.');
    return;
  }

  let deleted = 0, failed = 0;
  for (const d of toDelete) {
    try {
      await del(d.blob.url, { token });
      deleted++;
    } catch (e) {
      failed++;
      console.error(`  ! failed to delete ${d.blob.pathname}: ${e.message}`);
    }
  }
  console.log(`\nDeleted ${deleted} object(s), ${fmtMB(freed)} MB reclaimed.${failed ? ` ${failed} failed.` : ''}`);
}

main().catch(err => { console.error(err); process.exitCode = 1; });
