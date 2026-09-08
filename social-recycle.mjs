/**
 * social-recycle.mjs
 * Deletes staged Instagram media in social/ that is provably finished with, and
 * refuses to touch anything else.
 *
 *   node social-recycle.mjs                 # dry run - prints the plan, deletes nothing
 *   node social-recycle.mjs --apply         # delete + git commit (no push)
 *   node social-recycle.mjs --apply --push  # ...and push, so Vercel picks it up
 *   node social-recycle.mjs --json          # machine-readable plan (for n8n)
 *
 * WHY THIS EXISTS
 *
 * social/ is a staging area, not a served asset directory: no page on the site links
 * to it. Its only job is to hold a public URL long enough for the Graph API to fetch
 * the media at container-creation time, after which Instagram serves its own copy
 * forever. social/README.md has always said the folders are deletable once the post
 * is live; nothing ever deleted them.
 *
 * The cost of that landed as a Vercel bill. social/ reached 202 MB of the 266 MB
 * shipped on every deployment, and the repo deploys on every push - ~65 pushes per
 * 30-day window. Under a 30-day retention policy that is ~17 GB of Deployment
 * Storage against a 10 GB tier, and roughly three quarters of it is images that
 * nothing will ever request again.
 *
 * WHY THE RULES LOOK LIKE THIS
 *
 * Deleting a folder too early breaks a post permanently: if the Notion card has not
 * been approved yet, Instagram has never fetched the media, and publish-approved.mjs
 * will hand the Graph API a URL that 404s. So age alone is not a safe signal - a card
 * can sit in Draft for weeks and still be genuinely pending.
 *
 * The signal that is safe is the same one blob-recycle.mjs uses for Reels: the card's
 * Status. queue-to-notion.mjs writes `Media URL` as SITE_URL/social/<id>/<first>.png,
 * so a card can be mapped back to the folder it owns. Once that card reads Published
 * or Archived, Instagram is done with the folder and so are we.
 *
 * FAIL CLOSED: if the Notion query fails, every folder looks unreferenced and the
 * script would propose deleting all of them. A Notion failure aborts the run.
 */

import './load-env.mjs';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { queryDatabase, getSelect, getUrl, getTitle } from './notion-api.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOCIAL_DIR = path.join(__dirname, 'social');

/** Notion statuses that mean Instagram will never need the folder served again. */
const TERMINAL_STATUSES = new Set(['Published', 'Archived']);

/** Days to wait after a card goes terminal. Covers a failed publish being retried. */
const GRACE_DAYS = 7;

/**
 * Days to wait for a folder with no Notion card at all. These predate the Notion flow
 * or were staged by hand with post-to-instagram.mjs, so there is no status to read and
 * age is the only signal left. Deliberately long: a missing card is ambiguous, and the
 * failure mode of waiting is a few MB, while the failure mode of guessing is a dead post.
 */
const ORPHAN_GRACE_DAYS = 30;

/** Entries in social/ that are not staged media and must survive. */
const KEEP_FILES = new Set(['README.md']);

const MB = bytes => bytes / 1048576;
const fmtMB = bytes => MB(bytes).toFixed(1);

/**
 * Age of a staged folder in days.
 *
 * Prefers the YYYY-MM-DD prefix the pipeline puts in every id over mtime, because
 * mtime is the checkout time on a fresh clone - on the VPS every folder would look
 * seconds old and nothing would ever be reclaimed.
 */
function folderAgeDays(id, dir) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(id);
  const when = m ? new Date(`${m[1]}T00:00:00Z`).getTime() : fs.statSync(dir).mtimeMs;
  return (Date.now() - when) / 86400_000;
}

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(full) : fs.statSync(full).size;
  }
  return total;
}

/**
 * social id -> { status, card } for every Notion card whose Media URL points at social/.
 * Throws on failure: see FAIL CLOSED above.
 */
async function loadNotionState() {
  const dbId = process.env.NOTION_IG_DB_ID;
  if (!dbId) throw new Error('NOTION_IG_DB_ID not set');
  const pages = await queryDatabase(dbId);
  if (!Array.isArray(pages)) throw new Error('Notion returned no page array');
  const byId = new Map();
  for (const page of pages) {
    const url = getUrl(page, 'Media URL');
    if (!url) continue;
    const m = /\/social\/([^/?#]+)\//.exec(url);
    if (!m) continue;  // a Reel's blob URL, not a staged folder
    byId.set(m[1], { status: getSelect(page, 'Status') || '(none)', card: getTitle(page) });
  }
  return { byId, cardCount: pages.length };
}

/** Decide one folder's fate. Returns { action: 'delete'|'keep', reason }. */
function classify(id, dir, notionById) {
  const age = Math.floor(folderAgeDays(id, dir));
  const card = notionById.get(id);

  if (!card) {
    return age >= ORPHAN_GRACE_DAYS
      ? { action: 'delete', reason: `no Notion card, ${age}d old (>= ${ORPHAN_GRACE_DAYS}d)` }
      : { action: 'keep',   reason: `no Notion card but only ${age}d old - may be in flight` };
  }
  if (!TERMINAL_STATUSES.has(card.status)) {
    return { action: 'keep', reason: `card status "${card.status}" is not terminal` };
  }
  return age >= GRACE_DAYS
    ? { action: 'delete', reason: `card ${card.status}, ${age}d old (>= ${GRACE_DAYS}d)` }
    : { action: 'keep',   reason: `card ${card.status} but only ${age}d old - within grace` };
}

function git(cmd) {
  return execSync(`git ${cmd}`, { cwd: __dirname, encoding: 'utf8' }).trim();
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const push = args.includes('--push');
  const asJson = args.includes('--json');

  if (!fs.existsSync(SOCIAL_DIR)) {
    console.error('No social/ directory - nothing to do.');
    return;
  }

  // Fail closed: without Notion we cannot tell a published post from a pending one.
  //
  // Set process.exitCode and return rather than calling process.exit(), matching
  // blob-recycle.mjs: a hard exit mid-fetch aborts with a libuv assertion on Windows
  // and the shell reports 127 instead of 1, which n8n reads as a different failure.
  let notion;
  try {
    notion = await loadNotionState();
  } catch (e) {
    console.error(`Error: could not read Notion (${e.message}).`);
    console.error('Aborting: without card statuses every folder looks unreferenced and would be deleted.');
    process.exitCode = 1;
    return;
  }

  const folders = fs.readdirSync(SOCIAL_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory() && !KEEP_FILES.has(e.name))
    .map(e => e.name)
    .sort();

  const decisions = folders.map(id => {
    const dir = path.join(SOCIAL_DIR, id);
    return { id, dir, bytes: dirSize(dir), ...classify(id, dir, notion.byId) };
  });

  const toDelete = decisions.filter(d => d.action === 'delete');
  const totalBefore = decisions.reduce((s, d) => s + d.bytes, 0);
  const freed = toDelete.reduce((s, d) => s + d.bytes, 0);

  if (asJson) {
    console.log(JSON.stringify({
      apply,
      totals:  { folders: decisions.length, mb: +fmtMB(totalBefore) },
      reclaim: { folders: toDelete.length,  mb: +fmtMB(freed) },
      after:   { folders: decisions.length - toDelete.length, mb: +fmtMB(totalBefore - freed) },
      delete:  toDelete.map(d => ({ id: d.id, mb: +fmtMB(d.bytes), reason: d.reason }))
    }, null, 2));
  } else {
    console.log(`social/: ${decisions.length} folders, ${fmtMB(totalBefore)} MB`);
    console.log(`Notion:  ${notion.cardCount} cards, ${notion.byId.size} pointing at social/\n`);
    for (const d of decisions) {
      const mark = d.action === 'delete' ? 'RECLAIM' : 'keep   ';
      console.log(`${mark} ${fmtMB(d.bytes).padStart(6)}MB  ${d.id}`);
      console.log(`                 ${d.reason}`);
    }
    console.log(`\nReclaimable: ${toDelete.length} folders, ${fmtMB(freed)} MB`);
    console.log(`After:       ${decisions.length - toDelete.length} folders, ${fmtMB(totalBefore - freed)} MB`);
  }

  if (!apply) {
    if (!asJson) console.log('\nDry run. Re-run with --apply to delete (add --push to deploy the shrink).');
    return;
  }
  if (!toDelete.length) return;

  for (const d of toDelete) fs.rmSync(d.dir, { recursive: true, force: true });
  git('add -A -- social');
  const staged = git('diff --cached --name-only -- social');
  if (!staged) {
    console.log('\nNothing staged - social/ was already clean in git.');
    return;
  }
  git(`commit -m "chore: recycle ${toDelete.length} published social/ folder(s), ${fmtMB(freed)} MB"`);
  console.log(`\nCommitted removal of ${toDelete.length} folder(s), ${fmtMB(freed)} MB.`);
  if (push) {
    git('push');
    console.log('Pushed - the next deployment ships the smaller tree.');
  } else {
    console.log('Not pushed. Run `git push` to shrink the next deployment.');
  }
}

main().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
