/**
 * generate-carousel.mjs
 * Reads the latest blog post, runs the Phase 3.5 editorial filter (see
 * docs/carousel-reframe-playbook.md) to decide the post format — a reframe
 * carousel ("Não é sobre X. É sobre Y.") when the post qualifies, a single
 * image otherwise — picks templates, screenshots with Puppeteer, and writes
 * caption.txt alongside the output PNGs. The legacy educational carousel
 * shape is still reachable via --format carousel.
 *
 * Usage:
 *   node generate-carousel.mjs [post.html] [--format reframe|carousel|single]
 *   node generate-carousel.mjs --topic "..." --format single --photo-required
 *                                            (rules out the "quote" single-type,
 *                                            the only one with no real photo —
 *                                            used by photo-day.mjs)
 */

import './load-env.mjs';
import Anthropic from '@anthropic-ai/sdk';
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME_PATH || 'C:/Users/Jorge Bernardo/.cache/puppeteer/chrome/win64-148.0.7778.167/chrome-win64/chrome.exe';
const HTML_TEMPLATES_DIR = path.join(__dirname, 'templates', 'html');
const USAGE_PATH = path.join(__dirname, 'carousel-usage.json');
const POSTS_DIR = path.join(__dirname, 'blog', 'posts');

const SLIDE_W = 1080;
const SLIDE_H = 1080;

/* ── Content type → template file ──────────────────────────── */

const TEMPLATE_MAP = {
  // Reframe carousel types (Phase 3.5 — docs/carousel-reframe-playbook.md)
  reframe_cover:       'reframe_cover.html',
  reframe_beat:        'reframe_beat.html',
  reframe_beat_dark:   'reframe_beat_dark.html',
  reframe_cta:         'reframe_cta.html',
  // Carousel types (multi-slide)
  hook:                'hook.html',
  tip:                 'tip.html',
  numbered_tip:        'numbered_tip.html',
  guide:               'guide.html',
  list:                'list.html',
  checklist:           'checklist.html',
  checklist_dark:      'checklist_dark.html',
  numbered_checklist:  'numbered_checklist.html',
  myth_truth:          'myth_truth.html',
  qa:                  'qa.html',
  photo_reflection:    'photo_reflection.html',
  cta:                 'cta.html',
  // Single post types
  quote:               'quote.html',
  tags:                'tags.html',
  polaroid:            'polaroid.html',
  split_photo:         'split_photo.html',
  triptych:            'triptych.html',
  arch_photo:          'arch_photo.html',
  circle_photo:        'circle_photo.html',
  split_h:             'split_h.html',
  dual_photo:          'dual_photo.html',
  editorial_photo:     'editorial_photo.html',
  rotated_text:        'rotated_text.html',
  profile_quote:       'profile_quote.html',
};

const CAROUSEL_TYPES = new Set([
  'hook','tip','numbered_tip','guide','list','checklist',
  'checklist_dark','numbered_checklist','myth_truth','qa','photo_reflection','cta',
  'reframe_cover','reframe_beat','reframe_beat_dark','reframe_cta',
]);

const SINGLE_TYPES = new Set([
  'quote','tags','polaroid','split_photo','triptych','arch_photo',
  'circle_photo','split_h','dual_photo','editorial_photo','rotated_text','profile_quote',
]);

const ITEM_TYPES = new Set([
  'list','checklist','numbered_tip','guide','checklist_dark','numbered_checklist','tags',
]);

const PILLAR_HASHTAGS = {
  'black-identity':   ['#IdentidadeNegra', '#OrgulhoNegro', '#NegrosNaTech', '#RepresentatividadeImporta', '#BlackExcellence', '#JorgeBernardo'],
  'cycling':          ['#DePretoPraPreto', '#CiclismoNegro', '#TeamAfricaRising', '#CiclismoSP', '#BlackCycling', '#PedalaNegro'],
  'technology':       ['#Tecnologia', '#IA', '#SegurançaDeDados', '#PrivacidadeDeDados', '#GovernançaDeIA', '#TechBR', '#InovaçãoTech'],
  'entrepreneurship': ['#EmpreendedorismoNegro', '#FeiraPreta', '#EmpreendeContaCom', '#NegociosAfrobrasileiros', '#BlackBusiness', '#JorgeBernardo'],
  'fatherhood':       ['#Paternidade', '#PaiPresente', '#PaternidadeNegra', '#FamíliaECarreira', '#Legado'],
  'learning':         ['#Aprendizado', '#EducaçãoContinuada', '#MindsetDeCrescimento', '#NuncaPararDeAprender', '#Educação'],
  'career-growth':    ['#Carreira', '#CrescimentoProfissional', '#CarreiraAposOs40', '#Reinvenção', '#DesenvolvimentoDeCarreira', '#JorgeBernardo'],
};

/* ── Utilities ─────────────────────────────────────────────── */

function sanitizeEmDashes(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/ — /g, ', ').replace(/— /g, ', ').replace(/ —/g, ',').replace(/—/g, ',');
}

function slugify(text) {
  return text
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .substring(0, 60);
}

function isoDate() {
  return new Date().toISOString().split('T')[0];
}

// Pull the YYYY-MM-DD prefix off a post filename so the carousel folder is
// keyed to the POST's date, not the (re-)build date. Stable id = idempotent
// re-runs (no date-shifted duplicate folders/Notion cards).
function dateFromFilename(name) {
  const m = /(\d{4}-\d{2}-\d{2})/.exec(name || '');
  return m ? m[1] : null;
}

function toFileUrl(absPath) {
  return 'file:///' + absPath.replace(/\\/g, '/').replace(/^\//, '');
}

function escapeHtml(str) {
  return (str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Recent-post history: retained on disk and summarized into the structure prompt
// so the generator actively varies format, length, and template mix over time.
const HISTORY_LIMIT = 8;         // posts kept in carousel-usage.json
const HISTORY_PROMPT_COUNT = 5;  // posts summarized into the Claude prompt

function loadUsage() {
  if (!fs.existsSync(USAGE_PATH)) return { posts: [] };
  try {
    const data = JSON.parse(fs.readFileSync(USAGE_PATH, 'utf8'));
    // New schema: { posts: [{ date, title, format, slideCount, templates }] }.
    // Legacy schema only had a flat { recentTemplates } with no per-post format
    // or length, which can't be recovered — start the history fresh from there.
    return Array.isArray(data.posts) ? data : { posts: [] };
  } catch {
    return { posts: [] };
  }
}

function saveUsage(record) {
  const { posts } = loadUsage();
  const updated = [...posts, record].slice(-HISTORY_LIMIT);
  fs.writeFileSync(USAGE_PATH, JSON.stringify({ lastRun: isoDate(), posts: updated }, null, 2), 'utf8');
}

// Human-readable recap of recent posts, most recent first, for the prompt.
function buildHistorySummary(posts, count = HISTORY_PROMPT_COUNT) {
  const recent = posts.slice(-count).reverse();
  if (recent.length === 0) return '(no recent posts on record — clean slate, choose freely)';
  return recent.map((p, i) => {
    const seq = (p.templates ?? []).join(' → ') || '(unknown)';
    const label = i === 0 ? 'Most recent' : `${i + 1} posts ago`;
    const photo = p.photo ? ` — photo ${p.photo}` : '';
    return `- ${label}: ${p.format}, ${p.slideCount} slide(s) [${seq}]${photo}`;
  }).join('\n');
}

// Photos used across the whole stored history (all HISTORY_LIMIT posts, not
// just the prompt window) — hard exclusion list so the same image can't
// headline two nearby posts. Records written before photo tracking existed
// have no photo field and are skipped.
function recentPhotoBasenames(posts) {
  return [...new Set(posts.map(p => p.photo).filter(Boolean))];
}

// The old anti-streak guard (force-alternating carousel/single) is gone: since
// Phase 3.5 the format is decided by the editorial filter — a post that fails
// the reframe tests must NOT be force-promoted into a carousel for variety's
// sake, and a run of qualifying posts is the strategy working, not a rut.
// Format overrides now come only from the explicit --format flag.

/* ── Photo inventory ───────────────────────────────────────── */

function loadInventory() {
  const invPath = path.join(__dirname, 'brand_assets', 'Fotos', 'INVENTORY.md');
  if (!fs.existsSync(invPath)) return '';
  return fs.readFileSync(invPath, 'utf8');
}

/* ── Photo resolver (inventory-aware, env override, random fallback) ── */

// The model may name any frame inside an inventory range, but ranges have
// gaps (culled frames). Substitute the numerically closest surviving frame
// of the same shoot — close frame numbers mean the same scene and look.
// The window keeps the substitute within the same look, not a neighboring one.
const NEAREST_FRAME_WINDOW = 20;

function splitFrameName(stem) {
  const m = stem.match(/^([A-Za-z0-9_]*?)(\d+)$/);
  return m ? { prefix: m[1], num: parseInt(m[2], 10) } : null;
}

function nearestPhoto(photoDir, stem, excluded) {
  const want = splitFrameName(stem);
  if (!want) return null;
  const best = fs.readdirSync(photoDir)
    .filter(f => /\.(jpg|jpeg|png)$/i.test(f) && !excluded.has(f.toLowerCase()))
    .map(f => {
      const got = splitFrameName(path.basename(f, path.extname(f)));
      return got && got.prefix === want.prefix
        ? { f, dist: Math.abs(got.num - want.num) }
        : null;
    })
    .filter(c => c && c.dist <= NEAREST_FRAME_WINDOW)
    .sort((a, b) => a.dist - b.dist)[0];
  return best ? path.join(photoDir, best.f) : null;
}

function resolvePhoto(preferredName, excludeBasenames = []) {
  const photoDir = path.join(__dirname, 'brand_assets', 'Fotos');
  if (!fs.existsSync(photoDir)) return null;
  const excluded = new Set(excludeBasenames.map(b => b.toLowerCase()));

  // Resolve a name that may be a bare basename ("DSC00412") or full filename.
  const tryName = (raw) => {
    if (!raw || typeof raw !== 'string') return null;
    const basename = path.basename(raw.trim());
    const ext = path.extname(basename).toLowerCase();
    const safeExt = ['.jpg', '.jpeg', '.png', '.webp'].includes(ext) ? ext : '';
    const stem = path.basename(basename, ext).replace(/[^A-Za-z0-9_-]/g, '');
    const name = stem + safeExt;
    if (!name) return null;
    const direct = path.join(photoDir, name);
    if (fs.existsSync(direct)) return direct;
    const withJpg = path.join(photoDir, `${name}.jpg`);
    if (fs.existsSync(withJpg)) return withJpg;
    return null;
  };

  // 1. Explicit env override always wins — even over the recent-photo exclusion
  const envHit = tryName(process.env.JORGE_CAROUSEL_PHOTO);
  if (envHit) return envHit;

  // 2. Inventory-recommended photo (chosen by Claude from INVENTORY.md).
  // A recently used pick counts as a miss: the prompt already forbids repeats,
  // but enforce it here too — same philosophy as the format streak guard,
  // determinism over prompt self-correction.
  const prefHit = tryName(preferredName);
  if (prefHit && !excluded.has(path.basename(prefHit).toLowerCase())) return prefHit;

  // 2b. Gap in the range or a recent repeat: nearest surviving neighbor
  // from the same shoot keeps the scene the model chose.
  const stem = typeof preferredName === 'string'
    ? path.basename(preferredName.trim()).replace(/\.(jpg|jpeg|png|webp)$/i, '').replace(/[^A-Za-z0-9_-]/g, '')
    : '';
  if (stem) {
    const near = nearestPhoto(photoDir, stem, excluded);
    if (near) return near;
  }

  // 3. Random fallback for variety (still avoiding recent repeats)
  const jpgs = fs.readdirSync(photoDir).filter(f => /\.(jpg|jpeg|png)$/i.test(f));
  const fresh = jpgs.filter(f => !excluded.has(f.toLowerCase()));
  const pool = fresh.length > 0 ? fresh : jpgs;
  if (pool.length === 0) return null;
  return path.join(photoDir, pool[Math.floor(Math.random() * pool.length)]);
}

/* ── Blog post reader ──────────────────────────────────────── */

function readLatestPost(explicitFile) {
  if (explicitFile) {
    const filePath = path.isAbsolute(explicitFile)
      ? explicitFile
      : path.join(__dirname, explicitFile);
    const html = fs.readFileSync(filePath, 'utf8');
    return {
      title: (html.match(/<title>([^<]+)<\/title>/) ?? [])[1]?.replace(' — Jorge Bernardo', '') ?? 'Post',
      excerpt: (html.match(/<meta name="description" content="([^"]+)"/) ?? [])[1] ?? '',
      pillarId: (html.match(/data-pillar="([^"]+)"/) ?? [])[1] ?? 'cycling',
      plainText: html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
      sourceDate: dateFromFilename(path.basename(filePath)),
    };
  }

  const metaPath = path.join(__dirname, 'post-meta.json');
  if (fs.existsSync(metaPath)) {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const slug = slugify(meta.title);
    const htmlFile = fs.readdirSync(POSTS_DIR)
      .filter(f => f.endsWith('.html') && f.includes(slug))
      .sort().pop();
    const plainText = htmlFile
      ? fs.readFileSync(path.join(POSTS_DIR, htmlFile), 'utf8').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      : meta.excerpt;
    return { ...meta, plainText, sourceDate: dateFromFilename(htmlFile) };
  }

  const htmlFiles = fs.readdirSync(POSTS_DIR).filter(f => f.endsWith('.html')).sort().reverse();
  if (htmlFiles.length === 0) throw new Error('No blog posts found in blog/posts/');

  const latest = htmlFiles[0];
  const html = fs.readFileSync(path.join(POSTS_DIR, latest), 'utf8');
  return {
    title: (html.match(/<title>([^<]+)<\/title>/) ?? [])[1]?.replace(' — Jorge Bernardo', '') ?? 'Post',
    excerpt: (html.match(/<meta name="description" content="([^"]+)"/) ?? [])[1] ?? '',
    pillarId: (html.match(/data-pillar="([^"]+)"/) ?? [])[1] ?? 'cycling',
    plainText: html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    sourceDate: dateFromFilename(latest),
  };
}

/* ── Claude: decide format + extract content ──────────────── */

async function extractPostStructure(client, post, { hasBlogPost = true, inventoryText = '', historySummary = '', recentPhotos = [], forcedFormat = null, photoRequired = false } = {}) {
  const contentBlock = post.excerpt
    ? `BLOG POST:\nTitle: ${post.title}\nExcerpt: ${post.excerpt}\nContent: ${post.plainText.substring(0, 3000)}`
    : `TOPIC IDEA:\n${post.title}`;

  // Optional explicit format override (--format reframe|carousel|single). When
  // set, the model still extracts the content but is told which shape to
  // produce, instead of deciding on its own. "carousel" (the legacy educational
  // shape) is ONLY reachable through this flag since the Phase 3.5 redesign.
  // --photo-required (photo-day.mjs) additionally rules out "quote" — the one
  // SINGLE type with no {{PHOTO_URL}} slot — so a photo-day post can't land on
  // a 100%-typographic card by chance; every other SINGLE type has a real
  // photo, not just a background accent.
  const formatDirective = forcedFormat === 'reframe'
    ? '\n\nFORMAT OVERRIDE (mandatory): You MUST return "format": "reframe" — skip the editorial filter and build the reframe carousel from the strongest available angle.'
    : forcedFormat === 'carousel'
    ? '\n\nFORMAT OVERRIDE (mandatory): You MUST return "format": "carousel" (LEGACY shape) with 6-8 slides: first slide hook, last slide cta, middle slides from the LEGACY types (tip, numbered_tip, guide, list, checklist, checklist_dark, numbered_checklist, myth_truth, qa, photo_reflection). Lead the data points with myth_truth / numbered_tip / qa slides, and give cited numbers and quotes their own slides.'
    : forcedFormat === 'single' && photoRequired
    ? '\n\nFORMAT OVERRIDE (mandatory): You MUST return "format": "single" with exactly 1 slide. This post MUST prominently show the chosen photo, so pick the content type from: polaroid, split_photo, triptych, arch_photo, circle_photo, split_h, dual_photo, editorial_photo, rotated_text, profile_quote, tags — NEVER "quote" (it renders no photo at all).'
    : forcedFormat === 'single'
    ? '\n\nFORMAT OVERRIDE (mandatory): You MUST return "format": "single" with exactly 1 slide, using one SINGLE content type.'
    : '';

  const legacyCta = hasBlogPost
    ? '- LEGACY carousel only: first slide must be hook, last must be cta (headline = "Leia o post completo", body = "Link na bio ↗")'
    : '- LEGACY carousel only: first slide must be hook, last must be cta (headline = "Salva pra não perder", body = "E compartilha com quem precisa ver"). This post is NOT a blog post, so NEVER write "Link na bio" or "Leia o post" anywhere in the slides.';

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2500,
    messages: [{
      role: 'user',
      content: `You are the social media editor for Jorge Bernardo — Black Brazilian cyclist, entrepreneur, and data security professional behind the DePretoPraPreto brand.

${contentBlock}${formatDirective}

STEP 1 — EDITORIAL FILTER (decides the format; see docs/carousel-reframe-playbook.md):
A post earns a REFRAME CAROUSEL only if it passes ALL THREE tests:
1. Flip test — its core idea states cleanly as "Não é sobre X. É sobre Y." where X is the mundane/painful surface framing and Y affirms the reader's identity or dignity. If the flip has to be forced, it fails.
2. Recognition test — the target follower sees their OWN lived experience in it ("se você já viveu isso, sabe"), not a topic they're learning about. Third-person analysis fails.
3. Screenshot test — it contains at least one line someone would screenshot or DM to a friend. If every line is informational, it fails.
If ANY test fails → return "format": "single" (one slide carrying the post's sharpest idea). Heavy critique/statistics posts belong on the blog, not forced into a carousel.

REFRAME CAROUSEL structure (6-8 slides), when it qualifies:
- Slide 1: contentType "reframe_cover" — headline = the X half ("Não é sobre …", max 8 words). body = "" — or the Y line ("É sobre …") ONLY if the flip lands harder stated together.
- Middle slides (4-6): ONE reframe beat per slide, escalating outer → inner (the fact of life → what it costs → who you become). Alternate contentType "reframe_beat" and "reframe_beat_dark" — never the same one twice in a row. You MAY use ONE "photo_reflection" slide mid-sequence for visual variety.
- Second-to-last: contentType "quote" — the recognition line, "Se você já viveu isso, sabe." register. Make it the single most screenshot-able sentence of the whole post — ONE sentence, max 20 words.
- Last: contentType "reframe_cta" — headline = a short share ask (e.g. "Envia pra quem precisa ler isso."), body = a short save ask (e.g. "E salva pra reler quando precisar.").
Reframe copy rules: 1-2 lines per slide, max ~16 words, second person, present tense. NO statistics, NO citations, NO lecture register, NO "Link na bio" anywhere in the slides — the carousel's job is saves and shares.

RECENT POSTS (most recent first) — vary templates, photos, and rhythm so the feed never looks repetitive (the FORMAT is decided by the filter above, not by variety):
${historySummary}

SINGLE content types (use for 1 slide):
quote: A single powerful statement or quote
polaroid: Personal reflection with photo, intimate tone
split_photo: Strong photo with headline overlaid on it
triptych: Bold statement with rich visual support
arch_photo: Editorial photo layout, headline + supporting text
circle_photo: Clean portrait with headline below
split_h: Horizontal editorial — photo left, text right
dual_photo: Dramatic two-photo layout, headline crossing the seam
editorial_photo: Photo top half, structured text + CTA below
rotated_text: Typography-forward, experimental layout
profile_quote: Personal brand moment, circular photo + reflection
tags: Keyword/concept cloud — headline + 6 short concept tags (uses items array)

LEGACY carousel content types (ONLY when a FORMAT OVERRIDE demands "carousel"):
hook (slide 1, always) · tip · numbered_tip · guide · list · checklist · checklist_dark · numbered_checklist · myth_truth · qa · photo_reflection · cta (last slide, always)

Return JSON: { "format": "reframe" | "carousel" | "single", "photo": "<filename>", "slides": [ ... ] }

PHOTO SELECTION:
Choose ONE photo for this post from the inventory below and return its exact filename in the top-level "photo" field (extension optional, e.g. "DSC00412" or "DSC00412.jpg").
- Cycling / endurance / sport topics, use the DSC cycling-action shots.
- Identity / lifestyle / technology / entrepreneurship / career topics, use the 7B7A Madrid editorial shots.
- Community / family / event / culture topics, use the 20221203 event portraits.
- Activism / resistance themes, use the yellow fist-raised frames.
- You may pick ANY frame number inside a listed range (e.g. "7B7A0110" from the range 7B7A0097–0132) — the "hero frames" are quality anchors, NOT the only choices. Vary your picks so the feed never settles on the same few images.
- NEVER pick a photo from this recently-used list (a nearby frame number from the same scene is fine):
${recentPhotos.length ? recentPhotos.join(', ') : '(none on record)'}

PHOTO INVENTORY:
${inventoryText || '(inventory unavailable — return "photo": "")'}

Each slide object:
- slideNum (1-based)
- contentType (from the lists above)
- headline: short, punchy (max 55 chars, Brazilian Portuguese)
- body: supporting text (max 110 chars, Portuguese) — use empty string when not needed
- items: array of 3-6 short strings — for list/checklist/numbered_tip/guide/checklist_dark/numbered_checklist/tags types; empty array otherwise
- steps: array of 3-5 strings — for guide type only; empty array otherwise
- myth: string (max 70 chars) — for myth_truth only; null otherwise
- truth: string (max 70 chars) — for myth_truth only; null otherwise
- question: string (max 70 chars) — for qa only; null otherwise
- answer: string (max 110 chars) — for qa only; null otherwise

RULES:
- Write ALL text in Brazilian Portuguese
- Keep text SHORT — Instagram is scanned, not read
${legacyCta}
- LEGACY carousel only: do not repeat the same contentType more than twice
- For tags: items should be 6 short keyword phrases (2-4 words each)
- Return ONLY valid JSON, no markdown fences, no explanation
- Do NOT use brand names like "afterALL" or "AfterALL" in slide text — refer to it as "a marca" instead`,
    }],
  });

  const raw = response.content[0].text.trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Claude did not return valid JSON');
  const parsed = JSON.parse(raw.slice(start, end + 1));
  if (!parsed.format || !Array.isArray(parsed.slides)) throw new Error('Unexpected JSON structure from Claude');
  return { ...parsed, photo: typeof parsed.photo === 'string' ? parsed.photo : '' };
}

/* ── Claude: generate caption ──────────────────────────────── */

// Returns { caption, hashtags } — hashtags is null unless the reframe format
// produced its own tighter tag set (4-5 subject-specific tags beat the generic
// pillar block for reach on the reframe posts; see the playbook).
async function generateCaption(client, post, format, hashtags, hasBlogPost = true) {
  const formatHint = format === 'single'
    ? 'This is a single image post.'
    : 'This is a carousel (swipe) post.';

  const reframeRules = format === 'reframe'
    ? '- Open by restating the post\'s reframe ("Não é sobre X. É sobre Y.") in first person, in Jorge\'s own words\n- Include ONE direct question the reader can answer in one line in the comments (real comment bait, not rhetorical)\n- After the caption, on the very LAST line, output 4-5 hashtags SPECIFIC to this post\'s actual subject (not generic pillar tags), space-separated\n'
    : '';
  const saveRule = (format === 'carousel' && hasBlogPost)
    ? '- For carousel: add "Salva esse post 📌" somewhere\n'
    : '';
  const endingRule = hasBlogPost
    ? `- ${pickCrossChannelCta()}${format === 'reframe' ? ' (before the hashtag line)' : ''}`
    : '- This post is NOT a blog post: do NOT write "Link na bio" or mention reading a post anywhere. End with a short engagement line on its own line, e.g. "Salva esse post 📌" or "Compartilha com quem precisa ver isso"';

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 400,
    messages: [{
      role: 'user',
      content: `Write an Instagram caption in Brazilian Portuguese for this post by Jorge Bernardo.
${formatHint}

${post.excerpt ? `Post title: ${post.title}\nPost excerpt: ${post.excerpt}` : `Topic: ${post.title}`}

Jorge's voice:
- First person ("Aprendi que...", "Acredito que...", "Na minha experiência...")
- Conversational but substantive — like a smart friend writing, not a LinkedIn post
- Mix personal experience with broader insight
- Short paragraphs (2-3 sentences max)

Rules:
- 280-400 characters (not counting hashtags)
- Start with a hook — a question or bold statement (NOT a broad generic claim)
${reframeRules}${saveRule}${endingRule}
- Do NOT include hashtags in the caption body
- Return ONLY the caption text, nothing else

NEVER use:
- Em dash (—) anywhere. Use a comma or split into two sentences instead.
- Transition fillers: "Além disso", "Portanto", "Vale ressaltar", "Em suma", "Nesse contexto", "No entanto"
- Openers like "O fato é que", "É fundamental que", "É importante destacar"
- LinkedIn-style motivational phrases
- Brand names like "afterALL" or "AfterALL" — refer to it as "a marca" instead`,
    }],
  });

  const text = sanitizeEmDashes(response.content[0].text.trim());

  // Reframe posts carry their own tag set on the final line; peel it off so the
  // caller can use it instead of the generic pillar block. Anything else (or a
  // malformed line) falls back to null → pillar hashtags.
  if (format === 'reframe') {
    const lines = text.split('\n');
    const last = lines[lines.length - 1].trim();
    const tags = last.split(/\s+/).filter(Boolean);
    if (tags.length >= 3 && tags.every(t => /^#\S+$/.test(t))) {
      return { caption: lines.slice(0, -1).join('\n').trim(), hashtags: tags };
    }
  }
  return { caption: text, hashtags: null };
}

/* ── Content injection ─────────────────────────────────────── */

function buildItemsHtml(items, contentType) {
  if (contentType === 'tags') {
    return (items ?? []).map(item => {
      const clean = item.replace(/^\s*\d+[\.\)]\s*/, '');
      return `<div class="item"><span class="item-text">${escapeHtml(clean)}</span></div>`;
    }).join('\n');
  }
  const numbered = ['numbered_tip', 'guide', 'numbered_checklist'].includes(contentType);
  const checkmark = ['checklist', 'checklist_dark'].includes(contentType);
  return (items ?? []).map((item, i) => {
    const clean = item.replace(/^\s*\d+[\.\)]\s*/, '');
    const prefix = numbered ? `${i + 1}.` : (checkmark ? '✓' : '•');
    return `<div class="item"><span class="item-prefix">${prefix}</span><span class="item-text">${escapeHtml(clean)}</span></div>`;
  }).join('\n');
}

// Cross-channel CTA funnel: the newsletter and podcast are both blog-sourced
// but, unlike the blog itself, never get promoted in-feed — only "Link na bio"
// ever appears. Rotate the blog-linked caption's closing line across all three
// funnels (never stacked in one caption) so newsletter/podcast get feed
// visibility too. Blog stays the majority weight since it's the direct source
// of most posts; newsletter/podcast are the added funnels.
const CROSS_CHANNEL_CTAS = [
  { weight: 5, instruction: 'End the caption body with "Link na bio ↗" on its own line' },
  { weight: 2, instruction: 'End the caption body with a line inviting the reader to subscribe to the weekly newsletter "A Interseção" (it\'s blog-sourced), e.g. "Toda semana eu escrevo sobre isso na newsletter. Link na bio ↗" — do NOT also mention reading the post' },
  { weight: 2, instruction: 'End the caption body with a line inviting the reader to listen to the podcast episode on this subject (audio version of the blog), e.g. "Tem episódio novo do podcast sobre isso. Link na bio ↗" — do NOT also mention reading the post' },
];

function pickCrossChannelCta() {
  const total = CROSS_CHANNEL_CTAS.reduce((s, c) => s + c.weight, 0);
  let r = Math.random() * total;
  for (const c of CROSS_CHANNEL_CTAS) {
    r -= c.weight;
    if (r <= 0) return c.instruction;
  }
  return CROSS_CHANNEL_CTAS[0].instruction;
}

// Blog-referencing CTA labels baked into some templates (not {{placeholders}}),
// swapped to engagement labels when the post is standalone (not from the blog).
const STANDALONE_CTA_SWAPS = [
  [/Link na bio ↗/g, 'Salva esse post ↗'],
  [/Leia o post completo/g, 'Salva esse post'],
  [/Leia o post ↗/g, 'Salva esse post ↗'],
];

// Not every template has a photo slot — the reframe set and most legacy text
// slides are type-on-gradient by design. The resolver still picks a photo for
// every run, so without this check a run can select an image, record it as
// "used" (burning it out of the rotation) and never put it on a canvas.
function templateUsesPhoto(templateHtml) {
  return /\{\{PHOTO_URL\}\}/.test(templateHtml);
}

function injectContent(templateHtml, slide, photoAbsPath, hasBlogPost = true, { slideNum = 1, slideTotal = 1, format = 'carousel' } = {}) {
  const contentType = slide.contentType;
  const headline  = sanitizeEmDashes(slide.headline);
  const body      = sanitizeEmDashes(slide.body);
  const items     = (slide.items ?? []).map(sanitizeEmDashes);
  const steps     = (slide.steps ?? []).map(sanitizeEmDashes);
  const myth      = sanitizeEmDashes(slide.myth);
  const truth     = sanitizeEmDashes(slide.truth);
  const question  = sanitizeEmDashes(slide.question);
  const answer    = sanitizeEmDashes(slide.answer);
  let html = templateHtml;

  html = html.replace(/\{\{HEADLINE\}\}/g, escapeHtml(headline ?? ''));
  html = html.replace(/\{\{BODY\}\}/g, escapeHtml(body ?? ''));
  html = html.replace(/\{\{MYTH\}\}/g, escapeHtml(myth ?? ''));
  html = html.replace(/\{\{TRUTH\}\}/g, escapeHtml(truth ?? ''));
  html = html.replace(/\{\{QUESTION\}\}/g, escapeHtml(question ?? ''));
  html = html.replace(/\{\{ANSWER\}\}/g, escapeHtml(answer ?? ''));
  html = html.replace(/\{\{SLIDE_NUM\}\}/g, String(slideNum).padStart(2, '0'));
  html = html.replace(/\{\{SLIDE_TOTAL\}\}/g, String(slideTotal).padStart(2, '0'));

  if (ITEM_TYPES.has(contentType)) {
    const useItems = contentType === 'guide' ? (steps ?? []) : (items ?? []);
    html = html.replace(/\{\{ITEMS_HTML\}\}/g, buildItemsHtml(useItems, contentType));
  }

  if (photoAbsPath) {
    html = html.replace(/\{\{PHOTO_URL\}\}/g, toFileUrl(photoAbsPath));
  }

  // Standalone posts must not reference the blog/bio anywhere, including
  // hardcoded button labels in the templates. Reframe carousels ban blog CTAs
  // in the slides too (blog-linked or not) — their job is saves/shares, and
  // the bio link lives in the caption instead.
  if (!hasBlogPost || format === 'reframe') {
    for (const [pattern, replacement] of STANDALONE_CTA_SWAPS) {
      html = html.replace(pattern, replacement);
    }
  }

  return html;
}

/* ── Puppeteer screenshots ─────────────────────────────────── */

async function screenshotSlides(slideHtmlPaths, outDir) {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--allow-file-access-from-files'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: SLIDE_W, height: SLIDE_H });

  const pngs = [];
  for (let i = 0; i < slideHtmlPaths.length; i++) {
    await page.goto(toFileUrl(slideHtmlPaths[i]), { waitUntil: 'networkidle0', timeout: 15000 });
    await new Promise(r => setTimeout(r, 400));
    const filename = `slide-0${i + 1}.png`;
    const outPath = path.join(outDir, filename);
    await page.screenshot({ path: outPath, clip: { x: 0, y: 0, width: SLIDE_W, height: SLIDE_H } });
    pngs.push(outPath);
    console.log(`  Saved: ${filename}`);
  }

  await browser.close();
  return pngs;
}

/* ── Main ──────────────────────────────────────────────────── */

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY not set. Add it to .env');
    process.exit(1);
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const args = process.argv.slice(2);
  const topicIdx = args.indexOf('--topic');
  const pillarIdx = args.indexOf('--pillar');
  const formatIdx = args.indexOf('--format');
  const topicArg  = topicIdx  !== -1 ? args[topicIdx  + 1] : null;
  const pillarArg = pillarIdx !== -1 ? args[pillarIdx + 1] : null;
  const formatArg = formatIdx !== -1 ? args[formatIdx + 1] : null;
  const explicitFormat = ['reframe', 'carousel', 'single'].includes(formatArg) ? formatArg : null;
  // Rules out the "quote" single-type (no photo slot) — for callers where the
  // whole point of the post is the real photo (photo-day.mjs).
  const photoRequired = args.includes('--photo-required');

  // Whether the post links back to the blog ("Link na bio" CTA) or is standalone.
  // Defaults: --topic runs are standalone; reading a blog file is blog-linked.
  // Override either way with --blog or --standalone (--no-blog alias).
  const forceStandalone = args.includes('--standalone') || args.includes('--no-blog');
  const forceBlog = args.includes('--blog');

  let post;
  let hasBlogPost;
  if (topicArg) {
    const pillarId = pillarArg && PILLAR_HASHTAGS[pillarArg] ? pillarArg : 'cycling';
    post = { title: topicArg, excerpt: '', pillarId, plainText: topicArg };
    hasBlogPost = forceBlog;                            // ad-hoc topic: standalone unless --blog
    console.log(`Topic:  ${topicArg}`);
    console.log(`Pillar: ${pillarId}`);
  } else {
    const fileArg = args.find(a => a.endsWith('.html'));
    console.log('Reading blog post...');
    post = readLatestPost(fileArg);
    hasBlogPost = forceBlog ? true : !forceStandalone;  // blog file: blog-linked unless --standalone
    console.log(`  Title: ${post.title}`);
    console.log(`  Pillar: ${post.pillarId}`);
  }
  console.log(`  Source: ${hasBlogPost ? 'blog post (Link na bio CTA)' : 'standalone (no bio link)'}`);

  console.log('Deciding format and extracting content with Claude...');
  const inventoryText = loadInventory();
  const usagePosts = loadUsage().posts;
  const historySummary = buildHistorySummary(usagePosts);
  const recentPhotos = recentPhotoBasenames(usagePosts);
  // Only the explicit --format flag forces a shape; otherwise the editorial
  // filter in the prompt decides reframe vs single.
  const forcedFormat = explicitFormat;
  console.log('  Recent history (avoiding repeats):');
  console.log(historySummary.split('\n').map(l => `    ${l}`).join('\n'));
  if (recentPhotos.length) console.log(`  Excluded photos (recently used): ${recentPhotos.join(', ')}`);
  if (forcedFormat) console.log(`  Format override: ${forcedFormat} (--format flag)`);
  const { format, slides, photo } = await extractPostStructure(client, post, { hasBlogPost, inventoryText, historySummary, recentPhotos, forcedFormat, photoRequired });
  console.log(`  Format: ${format} | Slides: ${slides.length}`);
  console.log(`  Types: ${slides.map(s => s.contentType).join(', ')}`);

  const photoPath = resolvePhoto(photo, recentPhotos);
  if (photoPath) console.log(`  Photo: ${path.basename(photoPath)}${photo ? ` (recommended: ${photo})` : ' (random fallback)'}`);
  else console.warn('  Warning: No photos found in brand_assets/Fotos/');

  const date = post.sourceDate || isoDate();
  const slug = slugify(post.title);
  const outDir = path.join(__dirname, 'carousels', `${date}-${slug}`);
  fs.mkdirSync(outDir, { recursive: true });

  // Clear stale slides from a previous run of the same post, so switching to a
  // shorter format (e.g. 7-slide carousel → 1-slide single) never leaves
  // orphaned slide-NN.png files behind.
  for (const f of fs.readdirSync(outDir)) {
    if (/^slide-\d+\.(png|html)$/i.test(f)) {
      try { fs.unlinkSync(path.join(outDir, f)); } catch (_) {}
    }
  }

  // Write and screenshot slides
  const slideHtmlPaths = [];
  const usedTypes = [];
  const photoSlots = [];

  for (const [i, slide] of slides.entries()) {
    const templateFile = TEMPLATE_MAP[slide.contentType];
    if (!templateFile) throw new Error(`Unknown contentType: "${slide.contentType}"`);

    const templatePath = path.join(HTML_TEMPLATES_DIR, templateFile);
    if (!fs.existsSync(templatePath)) {
      throw new Error(`Template not found: ${templateFile}. Run: node agent-templates.mjs`);
    }

    const templateHtml = fs.readFileSync(templatePath, 'utf8');
    if (templateUsesPhoto(templateHtml)) photoSlots.push(slide.contentType);
    const injected = injectContent(templateHtml, slide, photoPath, hasBlogPost, { slideNum: i + 1, slideTotal: slides.length, format });
    const slidePath = path.join(outDir, `slide-0${i + 1}.html`);
    fs.writeFileSync(slidePath, injected, 'utf8');
    slideHtmlPaths.push(slidePath);
    usedTypes.push(slide.contentType);
  }

  // A photo only counts as "used" once a template with a slot actually renders
  // it. Recording an unrendered pick would exclude that frame from the next
  // HISTORY_LIMIT posts for nothing.
  const photoRendered = Boolean(photoPath) && photoSlots.length > 0;
  const renderedPhoto = photoRendered ? path.basename(photoPath) : null;

  if (photoPath && photoSlots.length === 0) {
    console.warn(`  ⚠ Photo ${path.basename(photoPath)} was selected but DISCARDED — none of these templates `
      + `(${[...new Set(usedTypes)].join(', ')}) has a {{PHOTO_URL}} slot. This post is 100% typographic.`);
  }
  if (!photoPath && photoSlots.length > 0) {
    console.warn(`  ⚠ Templates ${[...new Set(photoSlots)].join(', ')} expect a photo but none resolved — `
      + `slides will render a broken image. Check brand_assets/Fotos/ exists on this machine.`);
  }

  console.log('Screenshotting...');
  const pngs = await screenshotSlides(slideHtmlPaths, outDir);

  // Clean up HTML files
  for (const f of slideHtmlPaths) {
    try { fs.unlinkSync(f); } catch (_) {}
  }

  // Generate caption. Reframe posts may bring their own tighter tag set;
  // everything else uses the pillar block.
  console.log('Generating caption...');
  const pillarTags = PILLAR_HASHTAGS[post.pillarId] ?? PILLAR_HASHTAGS['cycling'];
  const { caption: captionBody, hashtags: ownTags } = await generateCaption(client, post, format, pillarTags, hasBlogPost);
  const hashtags = ownTags ?? pillarTags;
  if (ownTags) console.log(`  Reframe hashtags: ${ownTags.join(' ')}`);
  const fullCaption = `${captionBody}\n\n${hashtags.join(' ')}`;

  // Write caption.txt into output folder AND project root for easy access
  const captionTxt = [
    `POST FORMAT: ${format.toUpperCase()} (${slides.length} slide${slides.length > 1 ? 's' : ''})`,
    `DATE: ${date}`,
    `PILLAR: ${post.pillarId}`,
    `FROM BLOG: ${hasBlogPost ? 'yes' : 'no'}`,
    `PHOTO: ${renderedPhoto ?? 'none (no template in this post has a photo slot)'}`,
    '',
    '─────────────────────────────────',
    fullCaption,
    '─────────────────────────────────',
    '',
    `SLIDES: ${pngs.map(p => path.basename(p)).join(', ')}`,
  ].join('\n');

  fs.writeFileSync(path.join(outDir, 'caption.txt'), captionTxt, 'utf8');
  fs.writeFileSync(path.join(__dirname, 'post-caption.txt'), captionTxt, 'utf8');

  // Keep carousel-meta.json for backward compatibility
  fs.writeFileSync(
    path.join(__dirname, 'carousel-meta.json'),
    JSON.stringify({ date, slug, format, pillar: post.pillarId, fromBlog: hasBlogPost, photo: renderedPhoto, caption: fullCaption, hashtags, contentTypes: usedTypes, slides: pngs.map(p => p.replace(/\\/g, '/')) }, null, 2),
    'utf8'
  );

  saveUsage({ date, title: post.title, format, slideCount: slides.length, templates: usedTypes, photo: renderedPhoto });

  console.log(`\nDone! ${slides.length} slide${slides.length > 1 ? 's' : ''} → carousels/${date}-${slug}/`);
  console.log('Caption → post-caption.txt (also inside the output folder)');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
