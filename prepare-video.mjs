/**
 * prepare-video.mjs
 * Orchestrator for the n8n "Video — Build from latest post" workflow: build the
 * educational video for the newest blog post (or reuse the latest already-built
 * one), upload it to Vercel Blob (video/mp4), and create a Reel card in the
 * Notion IG Pipeline (Status=Draft) — the same approval surface carousels use.
 * publish-approved.mjs publishes it once Status = "Approved For Publishing".
 * Mirrors prepare-carousel.mjs + queue-to-notion.mjs. On-demand (no auto-schedule).
 *
 * Usage:
 *   node prepare-video.mjs                 (build + upload + queue in Notion, then mark prepared)
 *   node prepare-video.mjs --kie-broll     (AI video b-roll via KIE, costs credits)
 *   node prepare-video.mjs --real-broll    (real-footage photo b-roll, Ken Burns)
 *   node prepare-video.mjs --skip-generate (queue the most recent already-built video)
 *   node prepare-video.mjs --dry-run       (build/find + upload, print the card; don't create/mark)
 *   node prepare-video.mjs --force         (re-prepare even if this post was already done)
 */

import './load-env.mjs';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { queryDatabase, createPage, prop } from './notion-api.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POSTS_DIR = path.join(__dirname, 'blog', 'posts');
const VIDEOS_DIR = path.join(__dirname, 'videos');
const LEDGER_PATH = path.join(__dirname, 'video-prepared.json');
const DAY1_ROOT = process.env.NEWSLETTER_REPO || 'C:/DevWork/AI Automation Society/Day 1';
const BLOB_UPLOAD = path.join(DAY1_ROOT, 'tools', 'blob_upload.mjs');

function fail(msg, detail = '') { console.log(JSON.stringify({ success: false, error: msg, detail })); process.exit(1); }

function newestPostStem() {
  const files = fs.readdirSync(POSTS_DIR).filter(f => f.endsWith('.html')).sort();
  if (!files.length) fail('no posts');
  return files[files.length - 1].replace(/\.html$/, '');
}

function loadLedger() {
  try { const l = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8')); return Array.isArray(l?.prepared) ? l : { prepared: [] }; }
  catch { return { prepared: [] }; }
}
function markPrepared(stem) {
  const l = loadLedger();
  if (!l.prepared.some(p => p.stem === stem)) { l.prepared.push({ stem, preparedAt: new Date().toISOString() }); fs.writeFileSync(LEDGER_PATH, JSON.stringify(l, null, 2), 'utf8'); }
}

function newestBuiltVideoDir() {
  if (!fs.existsSync(VIDEOS_DIR)) return null;
  const dirs = fs.readdirSync(VIDEOS_DIR)
    .map(d => path.join(VIDEOS_DIR, d))
    .filter(d => fs.existsSync(path.join(d, 'video.mp4')) && fs.existsSync(path.join(d, 'video-meta.json')));
  if (!dirs.length) return null;
  return dirs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

function buildVideo(extraArgs) {
  execFileSync('node', ['generate-video.mjs', ...extraArgs], { cwd: __dirname, stdio: 'inherit', timeout: 900000, env: process.env });
}

function uploadVideo(videoPath, slug) {
  const out = execFileSync('node', [BLOB_UPLOAD, videoPath, `video/${slug}.mp4`], { encoding: 'utf8', timeout: 180000 });
  const parsed = JSON.parse(out.trim().split('\n').pop());
  if (!parsed.success || !parsed.url) fail('blob upload failed', parsed.error);
  return parsed.url;
}

async function alreadyQueued(dbId, id) {
  const results = await queryDatabase(dbId, { property: 'Name', title: { equals: id } });
  return results.length > 0;
}

async function queueReel(id, meta, url) {
  const dbId = process.env.NOTION_IG_DB_ID;
  if (!dbId) fail('NOTION_IG_DB_ID not set');
  // Distinct from the carousel card for the same post, which is named `id` —
  // Name-based dedupe would otherwise see the carousel and skip the Reel.
  const cardName = `${id}-reel`;
  if (await alreadyQueued(dbId, cardName)) {
    console.log(`${cardName} already in Notion — not queueing again.`);
    return false;
  }
  const properties = {
    Name: prop.title(cardName),
    Status: prop.select('Draft'),
    Type: prop.select('Reel'),
    Series: prop.select('Blog-derived'),
    Caption: prop.richText(meta.caption),
    'Media URL': prop.url(url),
    Preview: prop.files([url]),
    Notes: prop.richText(`Reel ${Math.round(meta.durationSec)}s · 9:16 · voz PT-BR. Approve by setting Status = "Approved For Publishing".`),
    'Publish Date': prop.date(meta.date),
  };
  await createPage(dbId, properties);
  console.log(`Notion card created (Draft): ${cardName}`);
  return true;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');
  const skipGenerate = args.includes('--skip-generate');

  const stem = newestPostStem();
  if (!force && !skipGenerate && loadLedger().prepared.some(p => p.stem === stem)) {
    console.log(JSON.stringify({ success: true, skipped: true, reason: 'already prepared', stem })); return;
  }

  let dir;
  if (skipGenerate) {
    dir = newestBuiltVideoDir();
    if (!dir) fail('no built video found (run without --skip-generate)');
    console.log(`Queueing existing: ${path.relative(__dirname, dir)}`);
  } else {
    const passthrough = [];
    if (args.includes('--kie-broll')) passthrough.push('--kie-broll');
    if (args.includes('--real-broll')) passthrough.push('--real-broll');
    if (args.includes('--seconds')) passthrough.push('--seconds', args[args.indexOf('--seconds') + 1]);
    console.log('Building video...');
    buildVideo(passthrough);
    dir = newestBuiltVideoDir();
    if (!dir) fail('build finished but no video found');
  }

  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'video-meta.json'), 'utf8'));
  const id = path.basename(dir);
  console.log('Uploading to Blob...');
  const url = uploadVideo(path.join(dir, 'video.mp4'), meta.slug);

  if (dryRun) {
    console.log('\n--- DRY RUN: Notion card NOT created ---');
    console.log(`Name: ${id} | Type: Reel | Status: Draft`);
    console.log(`Media URL: ${url}`);
    console.log(`Caption (${meta.caption.length} chars): ${meta.caption.slice(0, 120)}...`);
  } else {
    await queueReel(id, meta, url);
    // Only tie the ledger to the newest post when we actually built for it —
    // --skip-generate may be delivering a video for an older post.
    if (!skipGenerate) markPrepared(stem);
  }
  console.log(JSON.stringify({ success: true, dryRun, stem, id, title: meta.title, durationSec: meta.durationSec, url }));
}

main().catch(e => fail('unexpected', String(e?.stack || e)));
