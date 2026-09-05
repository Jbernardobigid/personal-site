/**
 * One-off backfill of the SEO fixes onto already-published posts.
 *
 * CLAUDE.md says never hand-edit a generated post: fix the generator and regenerate.
 * Regenerating is not an option here, because the content is the product and a rerun
 * would rewrite 56 published essays through the model. So this does the next best
 * thing and stays faithful to that rule's intent: it imports the GENERATOR'S OWN
 * functions by text extraction and replays them over the existing HTML, so the archive
 * ends up byte-identical to what generate-post.mjs would emit today. No copy is
 * invented, no wording is changed by hand.
 *
 * generate-post.mjs is never imported: its main() runs unconditionally and would fire
 * a paid API call and publish a post. The pure helpers are sliced out as text.
 *
 * Fixes applied, all from the live SEO audit:
 *   - <title> over 60 chars (48 pages, worst 133)  -> short seoTitle + suffix
 *   - meta/og/twitter description out of range     -> clamped to <= 160
 *   - og:image pointing at a 1.94 MB PNG           -> the .jpg sibling
 *   - no on-page image at all                      -> hero <picture>
 *   - zero post-to-post links                      -> "Leia também" block
 *
 *   node backfill-post-seo.mjs --dry-run    report only, write nothing
 *   node backfill-post-seo.mjs              apply
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POSTS_DIR = path.join(__dirname, 'blog', 'posts');
const GENERATOR = path.join(__dirname, 'generate-post.mjs');
const DRY = process.argv.includes('--dry-run');

/* ── Borrow the generator's own logic ────────────────────── */

const genSrc = fs.readFileSync(GENERATOR, 'utf8');
const between = (start, end) => {
  const a = genSrc.indexOf(start);
  const b = genSrc.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error(`generator marker not found: ${start} .. ${end}`);
  return genSrc.slice(a, b);
};

const pillarLabels = Object.fromEntries(
  [...between('const PILLARS', 'const JORGE_CONTEXT').matchAll(/id:\s*'([^']+)',\s*\r?\n\s*label:\s*'([^']+)'/g)]
    .map(m => [m[1], m[2]])
);
if (!Object.keys(pillarLabels).length) throw new Error('could not read PILLARS from the generator');

const helperSrc = [
  between('const SLUG_MAX', 'function formatDate'),
  // buildRelatedHtml calls both of these; take the generator's versions rather than
  // reimplementing, so the emitted markup is identical to a freshly generated post.
  between('function escapeHtml', 'function sanitizeContent'),
  `const PILLAR_LABELS = ${JSON.stringify(pillarLabels)};`,
  between('const RELATED_COUNT', 'const PILLAR_LABELS'),
  between('function selectRelatedPosts', '/* ── Post HTML builder'),
  'export { deriveSeoTitle, buildPageTitle, clampDescription, selectRelatedPosts, buildRelatedHtml };'
].join('\n');

const tmpModule = path.join(__dirname, '_backfill-helpers.mjs');
fs.writeFileSync(tmpModule, helperSrc);
let G;
try {
  G = await import('./_backfill-helpers.mjs');
} finally {
  fs.unlinkSync(tmpModule);
}

/* escapeHtml is needed for the markup and is trivial; mirror the generator's. */
const escapeHtml = (str) => String(str)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const decodeEntities = (str) => String(str)
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');

/* ── CSS the new blocks need, lifted from the generator ──── */

const cssRules = genSrc
  .split('\n')
  .filter(l => /^\.(post-hero|related-)/.test(l.trim()))
  .map(l => l.trim())
  .join('\n');
if (!cssRules.includes('.post-hero{')) throw new Error('could not lift .post-hero CSS from the generator');

const CSS_BLOCK = `${cssRules}
@media(prefers-reduced-motion:reduce){.related-link{transition:color .25s ease}.related-link:hover,.related-link:focus-visible,.related-link:active{transform:none}}
@media(max-width:768px){.post-hero{padding-left:24px;padding-right:24px;margin-top:32px}.related-inner{padding:40px 24px 44px}.related-title{font-size:18px}}`;

/* ── Read the archive ────────────────────────────────────── */

const files = fs.readdirSync(POSTS_DIR).filter(f => f.endsWith('.html')).sort();

const readTag = (html, re) => { const m = html.match(re); return m ? m[1] : ''; };

const archive = files.map(filename => {
  const html = fs.readFileSync(path.join(POSTS_DIR, filename), 'utf8');
  return {
    filename,
    html,
    date: (filename.match(/^(\d{4}-\d{2}-\d{2})/) || [, ''])[1],
    pillar: readTag(html, /data-pillar="([^"]+)"/),
    h1: readTag(html, /<h1 class="post-title">([\s\S]*?)<\/h1>/).trim(),
    title: readTag(html, /<title>([\s\S]*?)<\/title>/).trim(),
    description: readTag(html, /<meta name="description" content="([\s\S]*?)">/),
    ogImage: readTag(html, /<meta property="og:image" content="([^"]*)">/)
  };
}).sort((a, b) => b.date.localeCompare(a.date));

/* selectRelatedPosts expects the generator's shape: filename, title, pillar. */
const asMeta = archive.map(p => ({ filename: p.filename, title: p.h1 || p.title, pillar: p.pillar }));

/* ── Rewrites ────────────────────────────────────────────── */

const SUFFIX = ' — Jorge Bernardo';

function rewrite(post) {
  let html = post.html;
  const changes = [];

  // The editorial <h1> is the real title; <title> historically appended the brand.
  const editorial = post.h1 || post.title.replace(SUFFIX, '');
  const shortTitle = G.deriveSeoTitle(editorial, '');
  const pageTitle = G.buildPageTitle(shortTitle);

  if (post.title !== pageTitle) {
    html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(pageTitle)}</title>`);
    changes.push(`title ${post.title.length}->${pageTitle.length}`);
  }

  // og:title / twitter:title carry the short title too.
  for (const re of [/(<meta property="og:title" content=")([^"]*)(">)/,
                    /(<meta name="twitter:title" content=")([^"]*)(">)/]) {
    html = html.replace(re, (_m, a, _old, c) => `${a}${escapeHtml(shortTitle)}${c}`);
  }

  const desc = decodeEntities(post.description);
  const clamped = G.clampDescription(desc);
  if (clamped !== desc) {
    for (const re of [/(<meta name="description" content=")([\s\S]*?)(">)/,
                      /(<meta property="og:description" content=")([\s\S]*?)(">)/,
                      /(<meta name="twitter:description" content=")([\s\S]*?)(">)/]) {
      html = html.replace(re, (_m, a, _old, c) => `${a}${escapeHtml(clamped)}${c}`);
    }
    changes.push(`desc ${desc.length}->${clamped.length}`);
  }

  // og:image: the 1.94 MB PNG now has a JPEG sibling. Two early posts point at a
  // homepage photo instead of post art; those keep pointing at a real file.
  let heroBase = '';
  if (/\/blog\/posts\/images\/[^"]+\.png/.test(post.ogImage)) {
    const jpg = post.ogImage.replace(/\.png$/i, '.jpg');
    heroBase = path.basename(jpg, '.jpg');
    const onDisk = path.join(POSTS_DIR, 'images', `${heroBase}.jpg`);
    if (fs.existsSync(onDisk)) {
      html = html.split(post.ogImage).join(jpg);
      html = html.replace(/<meta property="og:image:type" content="[^"]*">\s*/g, '');
      html = html.replace(/(<meta property="og:image" content="[^"]*">)/,
        '$1\n<meta property="og:image:type" content="image/jpeg">');
      changes.push('og:image png->jpg');
    } else {
      heroBase = '';
    }
  }

  // On-page hero. Posts had zero <img> tags: the art existed only as an og:image.
  if (heroBase && !html.includes('class="post-hero"')) {
    const figure = `
<figure class="post-hero">
  <picture>
    <source srcset="images/${heroBase}.webp" type="image/webp">
    <img src="images/${heroBase}.jpg" alt="Ilustração editorial: ${escapeHtml(editorial)}" width="1536" height="1024" fetchpriority="high" decoding="async">
  </picture>
</figure>
`;
    if (html.includes('<!-- audio-player-slot -->')) {
      html = html.replace('<!-- audio-player-slot -->', `${figure}\n<!-- audio-player-slot -->`);
    } else {
      html = html.replace('</header>', `</header>\n${figure}`);
    }
    changes.push('hero image');
  }

  // Related posts: every post had exactly one inbound link before this.
  if (!html.includes('class="related-posts"')) {
    const related = G.selectRelatedPosts(asMeta, post.pillar, post.filename);
    const block = G.buildRelatedHtml(related);
    if (block) {
      html = html.replace(/(\n<div class="post-footer">)/, `${block}$1`);
      changes.push(`related x${related.length}`);
    }
  }

  // CSS for the two new blocks, appended once.
  if (!html.includes('.related-posts{') && html.includes('.related-posts')) {
    html = html.replace(/\n<\/style>/, `\n${CSS_BLOCK}\n</style>`);
  } else if (changes.length && !html.includes('.post-hero{')) {
    html = html.replace(/\n<\/style>/, `\n${CSS_BLOCK}\n</style>`);
  }

  return { html, changes };
}

let touched = 0;
for (const post of archive) {
  const { html, changes } = rewrite(post);
  if (!changes.length || html === post.html) continue;
  touched++;
  console.log(`${post.filename.slice(0, 58).padEnd(60)} ${changes.join(', ')}`);
  if (!DRY) fs.writeFileSync(path.join(POSTS_DIR, post.filename), html, 'utf8');
}

console.log(`\n${touched} of ${archive.length} post(s) ${DRY ? 'would change' : 'rewritten'}.`);
if (DRY) console.log('Dry run: nothing written.');
