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

// SEO budgets. A live audit (2026-09) found 48 of 63 pages with titles past the
// SERP truncation point, 22 descriptions outside the snippet window, one exact
// title collision and 107 MB of homepage imagery — none of which anything here
// could see. These constants are the regression fence.
const TITLE_MAX_CHARS = 60;   // beyond this Google truncates the SERP line
// Google truncates long snippets but enforces no minimum, so a short description is a
// missed opportunity rather than a defect. Only a stub short enough to be effectively
// missing fails the build; between the two bounds it is reported as advice.
const DESC_MIN_CHARS  = 120;  // below this the snippet reads thin (advisory)
const DESC_STUB_CHARS = 50;   // below this it is effectively no description (failure)
const DESC_MAX_CHARS  = 165;  // beyond this the snippet is cut mid-sentence
const IMAGE_MAX_BYTES = 400 * 1024;
// www is the canonical host and must stay that way — the podcast feed identity
// is built on it. Do not "simplify" this to the apex domain.
const CANONICAL_ORIGIN = 'https://www.jorgebernardo.tech';
// Image weight is measured by stat'ing these directories directly: both live
// inside IGNORED_DIRS (images/, blog/), so the page-discovery walk above never
// reaches them. Two separate concerns, deliberately not merged.
const IMAGE_DIRS = ['images', path.join('blog', 'posts', 'images')];

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

  // RSS <enclosure> requires url + length + type. Google Search Console flagged
  // a missing length once (2026-07-28) because generateFeed() only wrote two of
  // the three — check for any enclosure tag lacking one of them.
  // [^>]*, not [^/]* — the url attribute itself contains slashes, so excluding
  // slashes truncates the match before the tag ever closes (this shipped once).
  const enclosureCount = (feed.match(/<enclosure\b/g) || []).length;
  const enclosures = feed.match(/<enclosure\b[^>]*\/>/g) || [];
  check(enclosures.length === enclosureCount,
    `feed.xml has ${enclosureCount} <enclosure> tag(s) but only ${enclosures.length} matched a well-formed self-closing tag — one is likely malformed.`);
  const malformed = enclosures.filter(e => !/\burl="/.test(e) || !/\blength="\d+"/.test(e) || !/\btype="/.test(e));
  check(malformed.length === 0,
    `feed.xml has ${malformed.length} <enclosure> tag(s) missing url/length/type (first: ${malformed[0] ?? '-'}).`);
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

/* ── per-page SEO budgets ────────────────────────────────── */
// The deployed page surface, derived from the same two sources the sitemap
// checks use: the post directory and findStaticPages(). Nothing is hardcoded,
// so a new landing page is audited the moment it exists.
const deployedPages = [
  { url: '/',      file: path.join(__dirname, 'index.html') },
  { url: '/blog/', file: BLOG_INDEX },
  ...findStaticPages().map(u => ({ url: u, file: path.join(__dirname, u, 'index.html') })),
  ...posts.map(p => ({ url: `/blog/posts/${p}`, file: path.join(POSTS_DIR, p) })),
].filter(p => fs.existsSync(p.file));

// Character counts must reflect what a human sees, so entities are decoded
// before measuring — "Preto &amp; Branco" is 15 characters, not 19.
const decodeEntities = (s) => s
  .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
  .replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&amp;/g, '&').trim();

const getTitle = (html) => {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1].replace(/\s+/g, ' ')) : null;
};
// Attribute order varies between the generator and the hand-authored pages, so
// meta tags are located first and their content attribute read second.
const getMeta = (html, name) => {
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    if (!new RegExp(`\\bname\\s*=\\s*["']${name}["']`, 'i').test(tag)) continue;
    const c = tag.match(/\bcontent\s*=\s*"([^"]*)"|\bcontent\s*=\s*'([^']*)'/i);
    if (c) return decodeEntities(c[1] ?? c[2]);
  }
  return null;
};
const getCanonical = (html) => {
  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    if (!/\brel\s*=\s*["']canonical["']/i.test(tag)) continue;
    const h = tag.match(/\bhref\s*=\s*"([^"]*)"|\bhref\s*=\s*'([^']*)'/i);
    return h ? (h[1] ?? h[2]).trim() : '';
  }
  return null;
};

const longTitles   = [];
const badDescs     = [];
const shortDescs   = [];
const missingDescs = [];
const badH1        = [];
const badCanonical = [];
const imgsNoAlt    = [];
const imgsNoDims   = [];
const titleOwners  = new Map();  // title  → [pages]
const descOwners   = new Map();  // desc   → [pages]

for (const page of deployedPages) {
  const html = fs.readFileSync(page.file, 'utf8');

  /* title: length + uniqueness */
  const title = getTitle(html);
  if (title === null || title === '') {
    longTitles.push(`${page.url} — no <title> at all`);
  } else {
    if (title.length > TITLE_MAX_CHARS) {
      longTitles.push(`${page.url} — ${title.length} chars (budget ${TITLE_MAX_CHARS}): "${title}"`);
    }
    if (!titleOwners.has(title)) titleOwners.set(title, []);
    titleOwners.get(title).push(page.url);
  }

  /* meta description: presence, length, uniqueness */
  const desc = getMeta(html, 'description');
  if (desc === null || desc === '') {
    missingDescs.push(page.url);
  } else {
    if (desc.length < DESC_STUB_CHARS || desc.length > DESC_MAX_CHARS) {
      badDescs.push(`${page.url} — ${desc.length} chars (budget ${DESC_MIN_CHARS}-${DESC_MAX_CHARS})`);
    } else if (desc.length < DESC_MIN_CHARS) {
      shortDescs.push(`${page.url} — ${desc.length} chars (aim for ${DESC_MIN_CHARS}-${DESC_MAX_CHARS})`);
    }
    if (!descOwners.has(desc)) descOwners.set(desc, []);
    descOwners.get(desc).push(page.url);
  }

  /* exactly one h1 */
  const h1s = (html.match(/<h1[\s>]/gi) || []).length;
  if (h1s !== 1) badH1.push(`${page.url} — ${h1s} <h1> element(s), expected exactly 1`);

  /* canonical: present, absolute, www-hosted */
  const canonical = getCanonical(html);
  if (canonical === null || canonical === '') {
    badCanonical.push(`${page.url} — no <link rel="canonical">`);
  } else if (!/^https?:\/\//i.test(canonical)) {
    badCanonical.push(`${page.url} — canonical is relative ("${canonical}"), must be absolute`);
  } else if (!canonical.startsWith(CANONICAL_ORIGIN + '/') && canonical !== CANONICAL_ORIGIN) {
    badCanonical.push(`${page.url} — canonical points at "${canonical}", expected ${CANONICAL_ORIGIN}`);
  }

  /* images: descriptive alt + explicit box to reserve (CLS) */
  for (const tag of html.match(/<img\b[^>]*>/gi) || []) {
    // JS-populated images carry src="" — fall back to the id so the message
    // still names something greppable in the file.
    const src  = (tag.match(/\bsrc\s*=\s*"([^"]*)"|\bsrc\s*=\s*'([^']*)'/i) || []).slice(1).find(Boolean)
      || ((tag.match(/\bid\s*=\s*"([^"]*)"|\bid\s*=\s*'([^']*)'/i) || []).slice(1).find(Boolean) ?? '(unnamed)');
    const alt  = tag.match(/\balt\s*=\s*"([^"]*)"|\balt\s*=\s*'([^']*)'/i);
    const altV = alt ? (alt[1] ?? alt[2]).trim() : null;
    if (!altV) imgsNoAlt.push(`${page.url} — <img src="${src}"> has ${alt ? 'an empty' : 'no'} alt attribute`);
    const missingDims = ['width', 'height'].filter(d => !new RegExp(`\\b${d}\\s*=`, 'i').test(tag));
    if (missingDims.length) {
      imgsNoDims.push(`${page.url} — <img src="${src}"> is missing ${missingDims.join(' and ')}`);
    }
  }
}

const listOf = (items, max = 8) => items.slice(0, max).map(i => `\n        ${i}`).join('') +
  (items.length > max ? `\n        …and ${items.length - max} more` : '');

check(longTitles.length === 0,
  `${longTitles.length} of ${deployedPages.length} page(s) have a <title> over ${TITLE_MAX_CHARS} chars — Google truncates the SERP line:${listOf(longTitles)}`);

const titleCollisions = [...titleOwners].filter(([, pages]) => pages.length > 1);
check(titleCollisions.length === 0,
  `${titleCollisions.length} <title> collision(s) — duplicate titles make the pages compete with each other:` +
  titleCollisions.map(([t, pages]) => `\n        "${t}"\n          ${pages.join('\n          ')}`).join(''));

check(missingDescs.length === 0,
  `${missingDescs.length} page(s) have no meta description — Google will invent a snippet:${listOf(missingDescs)}`);

check(badDescs.length === 0,
  `${badDescs.length} of ${deployedPages.length} page(s) have a meta description outside ${DESC_MIN_CHARS}-${DESC_MAX_CHARS} chars:${listOf(badDescs)}`);

const descCollisions = [...descOwners].filter(([, pages]) => pages.length > 1);
check(descCollisions.length === 0,
  `${descCollisions.length} duplicate meta description(s):` +
  descCollisions.map(([d, pages]) => `\n        "${d.slice(0, 70)}…"\n          ${pages.join('\n          ')}`).join(''));

check(badH1.length === 0,
  `${badH1.length} page(s) do not have exactly one <h1>:${listOf(badH1)}`);

check(badCanonical.length === 0,
  `${badCanonical.length} page(s) have a missing or wrong canonical (must be absolute and ${CANONICAL_ORIGIN}-hosted):${listOf(badCanonical)}`);

// Two separate checks on purpose: a single missing alt is an accessibility bug
// and would otherwise stay buried under a long list of layout-shift warnings.
check(imgsNoAlt.length === 0,
  `${imgsNoAlt.length} <img> element(s) have no usable alt text:${listOf(imgsNoAlt)}`);

check(imgsNoDims.length === 0,
  `${imgsNoDims.length} <img> element(s) have no explicit width/height — the box is not reserved, so they shift the layout on load (CLS):${listOf(imgsNoDims)}`);

/* ── image weight budget ─────────────────────────────────── */
// Deliberately separate from the page walk above: images/ and blog/ are both in
// IGNORED_DIRS, so these directories are stat'ed directly. The homepage once
// shipped 107 MB of photography including a single 17.9 MB JPEG; nothing warned.
const statImages = (dir, found = []) => {
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) statImages(full, found);
    else found.push({ rel: path.relative(__dirname, full).split(path.sep).join('/'), bytes: fs.statSync(full).size });
  }
  return found;
};

const kb = (b) => `${(b / 1024).toFixed(0)} KB`;
const mb = (b) => `${(b / (1024 * 1024)).toFixed(1)} MB`;

/* What matters is what a browser can actually download, not what sits on disk.
 * Two kinds of file are on disk but never served, and counting them made the guard
 * fail on its own fix:
 *   - the full-resolution photo masters and the superseded blog PNGs, both excluded
 *     from the deploy in .vercelignore (they are sources, kept in git);
 *   - the top rungs of the responsive ladder, which are deliberately large and only
 *     ever requested by a wide or retina viewport.
 * Everything else is held to the 400 KB budget. */
const DEPLOY_EXCLUDED = [/^images\/[^/]+\.jpe?g$/i, /^blog\/posts\/images\/[^/]+\.png$/i];

/* A responsive ladder cannot be held to one number: a 1920px rung is supposed to cost
 * more than a 480px one. Budget by the width baked into the filename, so the small
 * tiers most visitors actually receive stay tight while the retina rungs are allowed
 * their weight. Anything without a width suffix is a plain image and gets the default. */
const VARIANT_BUDGETS = [[2560, 1600], [1920, 1600], [1440, 800], [960, 400], [480, 200]];
const budgetFor = (rel) => {
  const m = rel.match(/-(\d{3,4})\.[a-z0-9]+$/i);
  if (!m) return IMAGE_MAX_BYTES;
  const found = VARIANT_BUDGETS.find(([width]) => width === Number(m[1]));
  return found ? found[1] * 1024 : IMAGE_MAX_BYTES;
};

const allImageFiles = IMAGE_DIRS.flatMap(d => statImages(path.join(__dirname, d)));
const imageFiles = allImageFiles.filter(f => {
  const rel = f.rel.split(path.sep).join('/');
  return !DEPLOY_EXCLUDED.some(re => re.test(rel));
});
const totalImageBytes = imageFiles.reduce((sum, f) => sum + f.bytes, 0);
const heavy = imageFiles
  .filter(f => f.bytes > budgetFor(f.rel.split(path.sep).join('/')))
  .sort((a, b) => b.bytes - a.bytes);

check(heavy.length === 0,
  `${heavy.length} of ${imageFiles.length} served image(s) exceed budget. ` +
  `Served imagery weighs ${mb(totalImageBytes)} ` +
  `(${allImageFiles.length - imageFiles.length} source file(s) excluded from the deploy are not counted):` +
  listOf(heavy.map(f => `${f.rel} — ${f.bytes > 1024 * 1024 ? mb(f.bytes) : kb(f.bytes)} ` +
    `(budget ${kb(budgetFor(f.rel.split(path.sep).join('/')))})`)) +
  `\n        Resize and re-encode (AVIF/WebP) — this is bandwidth every visitor pays for.`);

/* ── advisories ──────────────────────────────────────────── */
/* Reported but never fatal: worth improving, not worth blocking a deploy over. */
const notes = [];
if (shortDescs.length) {
  notes.push(`${shortDescs.length} page(s) have a meta description under ${DESC_MIN_CHARS} chars ` +
    `— usable, but the snippet is leaving room on the table:${listOf(shortDescs)}`);
}

/* ── report ──────────────────────────────────────────────── */
if (notes.length) {
  console.log(`
 content check advisories — ${notes.length} note(s)
`);
  for (const n of notes) console.log(`  · ${n}`);
  console.log('');
}

if (problems.length) {
  console.error(`\n content check FAILED — ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`  • ${p}`);
  console.error('');
  process.exit(1);
}

console.log(`content check passed — ${posts.length} posts; sitemap, feed and robots.txt consistent.`);
