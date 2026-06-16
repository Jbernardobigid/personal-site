/**
 * prepare-carousel.mjs
 * The build step for the n8n "Instagram — Build carousel" workflow: takes the
 * newest blog post and builds the Instagram carousel into
 * carousels/<post-date>-<slug>/. queue-to-notion.mjs then stages the slides and
 * creates the Notion approval card (with an image Preview) — that card is the
 * single notification + approval surface. No email, no Vercel Blob preview.
 *
 * Idempotent via carousel-prepared.json (keyed on the post stem): once a post is
 * built it is not rebuilt on the next 8h schedule tick.
 *
 * Usage:
 *   node prepare-carousel.mjs            (build newest post if not already built, then mark)
 *   node prepare-carousel.mjs --force    (rebuild even if already marked prepared)
 *   node prepare-carousel.mjs --dry-run  (build but do NOT mark prepared)
 *
 * Requires: ANTHROPIC_API_KEY (carousel generation).
 *
 * IMPORTANT: passes the newest post file EXPLICITLY to generate-carousel.mjs, so it
 * never relies on the gitignored post-meta.json (not synced from the cloud blog run).
 */

import './load-env.mjs';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POSTS_DIR   = path.join(__dirname, 'blog', 'posts');
const META_PATH   = path.join(__dirname, 'carousel-meta.json');
const LEDGER_PATH = path.join(__dirname, 'carousel-prepared.json');

function fail(msg, detail = '') {
  console.log(JSON.stringify({ success: false, error: msg, detail }));
  process.exit(1);
}

/* ── Newest post + dedup ledger ──────────────────────────── */

function newestPost() {
  if (!fs.existsSync(POSTS_DIR)) fail(`posts dir not found: ${POSTS_DIR}`);
  const files = fs.readdirSync(POSTS_DIR).filter(f => f.endsWith('.html')).sort();
  if (files.length === 0) fail('no .html posts found');
  const file = files[files.length - 1];               // ISO-date prefix → lexical sort = newest last
  const html = fs.readFileSync(path.join(POSTS_DIR, file), 'utf8');
  const title = (html.match(/<title>([^<]+)<\/title>/) ?? [])[1]?.replace(' — Jorge Bernardo', '').trim() ?? file;
  return { file, stem: file.replace(/\.html$/, ''), abs: path.join(POSTS_DIR, file), title };
}

function loadLedger() {
  try {
    const l = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
    return Array.isArray(l?.prepared) ? l : { prepared: [] };
  } catch { return { prepared: [] }; }
}

function markPrepared(stem) {
  const l = loadLedger();
  if (!l.prepared.some(p => p.stem === stem)) {
    l.prepared.push({ stem, preparedAt: new Date().toISOString() });
    fs.writeFileSync(LEDGER_PATH, JSON.stringify(l, null, 2), 'utf8');
  }
}

/* ── Build ───────────────────────────────────────────────── */

function buildCarousel(postAbs) {
  // Pass the post file explicitly → bypasses the stale/gitignored post-meta.json.
  execFileSync('node', ['generate-carousel.mjs', postAbs], {
    cwd: __dirname, stdio: 'inherit', timeout: 300000, env: process.env
  });
  if (!fs.existsSync(META_PATH)) fail('carousel-meta.json not produced');
  return JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
}

/* ── Main ────────────────────────────────────────────────── */

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');

  const post = newestPost();
  if (!force && loadLedger().prepared.some(p => p.stem === post.stem)) {
    console.log(JSON.stringify({ success: true, skipped: true, reason: 'already prepared', stem: post.stem }));
    return;
  }

  console.log(`Building carousel for: ${post.title} (${post.file})`);
  const meta = buildCarousel(post.abs);
  if (!dryRun) markPrepared(post.stem);

  console.log(JSON.stringify({
    success: true, dryRun, marked: !dryRun, stem: post.stem, title: post.title,
    format: meta.format, slides: Array.isArray(meta.slides) ? meta.slides.length : 0,
  }));
}

try {
  main();
} catch (err) {
  fail('unexpected error', String(err?.stack || err));
}
