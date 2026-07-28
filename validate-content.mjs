/**
 * Integrity check for the generated-content surface.
 *
 * Exists because of a two-month silent failure: generate-post.mjs rewrote
 * sitemap.xml on every run, but the commit steps only staged blog/, so the
 * sitemap was discarded each time and froze at 4 posts while 36 were live.
 * Nothing failed, nothing warned — the pipeline reported success throughout.
 *
 * This asserts that the generated artifacts actually agree with each other and
 * with what is on disk. Exits non-zero with a readable diff so it can gate a
 * pipeline step.
 *
 *   node validate-content.mjs      (or: npm run content:check)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POSTS_DIR  = path.join(__dirname, 'blog', 'posts');
const SITEMAP    = path.join(__dirname, 'sitemap.xml');
const ROBOTS     = path.join(__dirname, 'robots.txt');
const FEED       = path.join(__dirname, 'feed.xml');
const BLOG_INDEX = path.join(__dirname, 'blog', 'index.html');

// Crawlers that must stay explicitly opted in — losing them silently would drop
// the site out of AI answer engines.
const REQUIRED_AGENTS = ['GPTBot', 'ChatGPT-User', 'PerplexityBot', 'ClaudeBot', 'anthropic-ai', 'Bingbot'];
// Directories never scanned for hand-authored pages.
const IGNORED_DIRS = new Set(['node_modules', 'blog', 'templates', 'temp', 'docs', 'sim', 'social', 'images', 'api', 'brand_assets', 'assets', '.git', '.github', '.impeccable', 'temporary screenshots']);

const problems = [];
const check = (ok, msg) => { if (!ok) problems.push(msg); };
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);

const posts = fs.existsSync(POSTS_DIR)
  ? fs.readdirSync(POSTS_DIR).filter(f => f.endsWith('.html'))
  : [];

/** Hand-authored pages (any dir with an index.html), found rather than hardcoded
 *  so a new landing page cannot be silently left out of the sitemap. */
function findStaticPages(dir = __dirname, depth = 0, found = []) {
  if (depth > 2) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (fs.existsSync(path.join(full, 'index.html'))) {
      found.push('/' + path.relative(__dirname, full).split(path.sep).join('/') + '/');
    }
    findStaticPages(full, depth + 1, found);
  }
  return found;
}

/* ── sitemap covers every post and every hand-authored page ── */
const sitemap = read(SITEMAP);
if (!sitemap) {
  problems.push('sitemap.xml is missing.');
} else {
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
  const listedPosts = locs.map(l => l.match(/\/blog\/posts\/(.+)$/)?.[1]).filter(Boolean);

  const missing = posts.filter(p => !listedPosts.includes(p));
  const stale   = listedPosts.filter(l => !posts.includes(l));
  check(missing.length === 0,
    `sitemap.xml is missing ${missing.length} of ${posts.length} posts (first: ${missing[0] ?? '-'}).\n` +
    `      Usual cause: the commit step did not stage sitemap.xml, so the regenerated copy was discarded.`);
  check(stale.length === 0,
    `sitemap.xml lists ${stale.length} post(s) that no longer exist (first: ${stale[0] ?? '-'}).`);

  for (const p of ['/', '/blog/', ...findStaticPages()]) {
    check(locs.some(l => l.endsWith(p)), `sitemap.xml does not list the page ${p} — it would be orphaned.`);
  }

  const hosts = new Set(locs.map(l => l.match(/^(https?:\/\/[^/]+)/)?.[1]));
  check(hosts.size <= 1, `sitemap.xml mixes hosts: ${[...hosts].join(', ')}. Split ranking signal.`);
}

/* ── blog index links every post ─────────────────────────── */
const index = read(BLOG_INDEX);
if (!index) problems.push('blog/index.html is missing.');
else {
  const unlinked = posts.filter(p => !index.includes(p));
  check(unlinked.length === 0,
    `blog/index.html does not link ${unlinked.length} post(s) (first: ${unlinked[0] ?? '-'}).`);
}

/* ── feed tracks the newest posts ────────────────────────── */
const feed = read(FEED);
if (!feed) {
  problems.push('feed.xml is missing — every page advertises it via <link rel="alternate">.');
} else {
  const items = [...feed.matchAll(/<link>([^<]*\/blog\/posts\/[^<]+)<\/link>/g)].map(m => m[1]);
  check(items.length > 0, 'feed.xml contains no items.');
  const newest = [...posts].sort().reverse()[0];
  check(!newest || items[0]?.endsWith(newest),
    `feed.xml's first item is not the newest post (${newest}) — the feed is stale.`);
  check(!/<pubDate>Invalid/.test(feed), 'feed.xml contains an invalid pubDate.');
}

/* ── robots.txt keeps the AI-crawler allowlist ───────────── */
const robots = read(ROBOTS);
if (!robots) {
  problems.push('robots.txt is missing.');
} else {
  const dropped = REQUIRED_AGENTS.filter(ua => !robots.includes(`User-agent: ${ua}`));
  check(dropped.length === 0,
    `robots.txt lost its allowlist for: ${dropped.join(', ')}.\n` +
    `      generateRobotsTxt() in generate-post.mjs is the source of truth — do not hand-edit.`);
  check(/^Sitemap:\s*https?:\/\/\S+/m.test(robots), 'robots.txt has no Sitemap: directive.');
}

/* ── referenced site assets actually exist ───────────────── */
for (const asset of ['favicon.png', 'apple-touch-icon.png']) {
  check(fs.existsSync(path.join(__dirname, asset)),
    `${asset} is referenced by every page but is not present at the repo root.`);
}

/* ── report ──────────────────────────────────────────────── */
if (problems.length) {
  console.error(`\n content check FAILED — ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`  • ${p}`);
  console.error('');
  process.exit(1);
}

console.log(`content check passed — ${posts.length} posts; sitemap, feed and robots.txt consistent.`);
