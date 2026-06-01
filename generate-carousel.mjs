/**
 * generate-carousel.mjs
 * Reads the latest blog post, decides post format (carousel or single image),
 * picks the right template, screenshots with Puppeteer, and writes
 * caption.txt alongside the output PNGs.
 *
 * Usage:
 *   node generate-carousel.mjs
 */

import './load-env.mjs';
import Anthropic from '@anthropic-ai/sdk';
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHROME = 'C:/Users/Jorge Bernardo/.cache/puppeteer/chrome/win64-148.0.7778.167/chrome-win64/chrome.exe';
const HTML_TEMPLATES_DIR = path.join(__dirname, 'templates', 'html');
const USAGE_PATH = path.join(__dirname, 'carousel-usage.json');
const POSTS_DIR = path.join(__dirname, 'blog', 'posts');

const SLIDE_W = 1080;
const SLIDE_H = 1080;

/* ── Content type → template file ──────────────────────────── */

const TEMPLATE_MAP = {
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
]);

const SINGLE_TYPES = new Set([
  'quote','tags','polaroid','split_photo','triptych','arch_photo',
  'circle_photo','split_h','dual_photo','editorial_photo','rotated_text','profile_quote',
]);

const ITEM_TYPES = new Set([
  'list','checklist','numbered_tip','guide','checklist_dark','numbered_checklist','tags',
]);

const PILLAR_HASHTAGS = {
  'data-security':    ['#SegurançaDeDados', '#PrivacidadeDeDados', '#LGPD', '#GovernançaDeIA', '#DataPrivacy', '#PrivacyByDesign', '#TechBR'],
  'entrepreneurship': ['#EmpreendedorismoNegro', '#FeiraPreta', '#EmpreendeContaCom', '#NegociosAfrobrasileiros', '#BlackBusiness', '#JorgeBernardo'],
  'cycling':          ['#DePretoPraPreto', '#CiclismoNegro', '#TeamAfricaRising', '#CiclismoSP', '#BlackCycling', '#PedalaNegro'],
  'brand':            ['#MarcaComPropósito', '#IdentidadeVisual', '#CulturalBranding', '#StrategyMeetAesthetics', '#BrandBuilding'],
  'wellness':         ['#Wellness', '#MindsetDeAtleta', '#TechSaúde', '#PerformanceHumana'],
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
    return `- ${label}: ${p.format}, ${p.slideCount} slide(s) [${seq}]`;
  }).join('\n');
}

/* ── Photo inventory ───────────────────────────────────────── */

function loadInventory() {
  const invPath = path.join(__dirname, 'brand_assets', 'Fotos', 'INVENTORY.md');
  if (!fs.existsSync(invPath)) return '';
  return fs.readFileSync(invPath, 'utf8');
}

/* ── Photo resolver (inventory-aware, env override, random fallback) ── */

function resolvePhoto(preferredName) {
  const photoDir = path.join(__dirname, 'brand_assets', 'Fotos');
  if (!fs.existsSync(photoDir)) return null;

  // Resolve a name that may be a bare basename ("DSC00412") or full filename.
  const tryName = (raw) => {
    if (!raw || typeof raw !== 'string') return null;
    const name = path.basename(raw.trim()).replace(/[^A-Za-z0-9_.-]/g, '');
    if (!name) return null;
    const direct = path.join(photoDir, name);
    if (fs.existsSync(direct)) return direct;
    const withJpg = path.join(photoDir, `${name}.jpg`);
    if (fs.existsSync(withJpg)) return withJpg;
    return null;
  };

  // 1. Explicit env override always wins
  const envHit = tryName(process.env.JORGE_CAROUSEL_PHOTO);
  if (envHit) return envHit;

  // 2. Inventory-recommended photo (chosen by Claude from INVENTORY.md)
  const prefHit = tryName(preferredName);
  if (prefHit) return prefHit;

  // 3. Random fallback for variety
  const jpgs = fs.readdirSync(photoDir).filter(f => /\.(jpg|jpeg|png)$/i.test(f));
  if (jpgs.length === 0) return null;
  return path.join(photoDir, jpgs[Math.floor(Math.random() * jpgs.length)]);
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
    return { ...meta, plainText };
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
  };
}

/* ── Claude: decide format + extract content ──────────────── */

async function extractPostStructure(client, post, { hasBlogPost = true, inventoryText = '', historySummary = '' } = {}) {
  const contentBlock = post.excerpt
    ? `BLOG POST:\nTitle: ${post.title}\nExcerpt: ${post.excerpt}\nContent: ${post.plainText.substring(0, 3000)}`
    : `TOPIC IDEA:\n${post.title}`;

  const ctaInstruction = hasBlogPost
    ? '- For carousels: first slide must be hook, last must be cta (headline = "Leia o post completo", body = "Link na bio ↗")'
    : '- For carousels: first slide must be hook, last must be cta (headline = "Salva pra não perder", body = "E compartilha com quem precisa ver"). This post is NOT a blog post, so NEVER write "Link na bio" or "Leia o post" anywhere in the slides.';

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2500,
    messages: [{
      role: 'user',
      content: `You are a social media manager for Jorge Bernardo — Black Brazilian cyclist, entrepreneur, and data security professional behind the DePretoPraPreto brand.

${contentBlock}

Decide the best Instagram post format FOR THIS SPECIFIC POST, then extract the content.

RECENT POSTS (most recent first) — vary from these so the feed never looks repetitive:
${historySummary}

FORMAT RULES — let the content decide, never default to one fixed shape:
- "single" (1 slide): best when the post's power is one sharp idea, quote, reflection, or striking image. Use a SINGLE content type below. These are currently underused — reach for them whenever the content can carry a single frame.
- "carousel" (3-10 slides): best for educational or sequential content — guides, tip lists, myth-busting, Q&A, step-by-step. SIZE IT TO THE SUBSTANCE: 3-5 slides for a punchy or quick idea, 6-8 for a normal teaching post, 8-10 only for a genuinely deep guide. Do NOT pad to a fixed slide count.

VARIETY RULES (important):
- Do NOT repeat the most recent post's format, slide count, or opening template sequence shown above.
- If the last 1-2 posts were carousels, strongly prefer a single-image post now whenever the content allows it.
- Favor content types and layouts that do NOT appear in the recent list above.

CAROUSEL content types (use for multi-slide):
hook (slide 1, always) · tip · numbered_tip · guide · list · checklist · checklist_dark · numbered_checklist · myth_truth · qa · photo_reflection · cta (last slide, always)

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

Return JSON: { "format": "carousel" | "single", "photo": "<filename>", "slides": [ ... ] }

PHOTO SELECTION:
Choose ONE photo for this post from the inventory below and return its exact filename in the top-level "photo" field (extension optional, e.g. "DSC00412" or "DSC00412.jpg").
- Cycling / endurance / sport / wellness topics, use the DSC cycling-action shots.
- Lifestyle / brand / business / entrepreneurship / data-security topics, use the 7B7A Madrid editorial shots.
- Community / event / culture topics, use the 20221203 event portraits.
- Activism / resistance themes, use the yellow fist-raised frames.
- When unsure, pick a clean editorial portrait. Prefer the listed "hero frames".

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
${ctaInstruction}
- For carousels: do not repeat the same contentType more than twice
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

async function generateCaption(client, post, format, hashtags, hasBlogPost = true) {
  const formatHint = format === 'single'
    ? 'This is a single image post.'
    : 'This is a carousel (swipe) post.';

  const saveRule = (format === 'carousel' && hasBlogPost)
    ? '- For carousel: add "Salva esse post 📌" somewhere\n'
    : '';
  const endingRule = hasBlogPost
    ? '- End with "Link na bio ↗" on its own line'
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
${saveRule}${endingRule}
- Do NOT include hashtags in the body
- Return ONLY the caption text, nothing else

NEVER use:
- Em dash (—) anywhere. Use a comma or split into two sentences instead.
- Transition fillers: "Além disso", "Portanto", "Vale ressaltar", "Em suma", "Nesse contexto", "No entanto"
- Openers like "O fato é que", "É fundamental que", "É importante destacar"
- LinkedIn-style motivational phrases
- Brand names like "afterALL" or "AfterALL" — refer to it as "a marca" instead`,
    }],
  });

  return sanitizeEmDashes(response.content[0].text.trim());
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

// Blog-referencing CTA labels baked into some templates (not {{placeholders}}),
// swapped to engagement labels when the post is standalone (not from the blog).
const STANDALONE_CTA_SWAPS = [
  [/Link na bio ↗/g, 'Salva esse post ↗'],
  [/Leia o post completo/g, 'Salva esse post'],
  [/Leia o post ↗/g, 'Salva esse post ↗'],
];

function injectContent(templateHtml, slide, photoAbsPath, hasBlogPost = true) {
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

  if (ITEM_TYPES.has(contentType)) {
    const useItems = contentType === 'guide' ? (steps ?? []) : (items ?? []);
    html = html.replace(/\{\{ITEMS_HTML\}\}/g, buildItemsHtml(useItems, contentType));
  }

  if (photoAbsPath) {
    html = html.replace(/\{\{PHOTO_URL\}\}/g, toFileUrl(photoAbsPath));
  }

  // Standalone posts must not reference the blog/bio anywhere, including
  // hardcoded button labels in the templates.
  if (!hasBlogPost) {
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
  const topicArg  = topicIdx  !== -1 ? args[topicIdx  + 1] : null;
  const pillarArg = pillarIdx !== -1 ? args[pillarIdx + 1] : null;

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
  const historySummary = buildHistorySummary(loadUsage().posts);
  console.log('  Recent history (avoiding repeats):');
  console.log(historySummary.split('\n').map(l => `    ${l}`).join('\n'));
  const { format, slides, photo } = await extractPostStructure(client, post, { hasBlogPost, inventoryText, historySummary });
  console.log(`  Format: ${format} | Slides: ${slides.length}`);
  console.log(`  Types: ${slides.map(s => s.contentType).join(', ')}`);

  const photoPath = resolvePhoto(photo);
  if (photoPath) console.log(`  Photo: ${path.basename(photoPath)}${photo ? ` (recommended: ${photo})` : ' (random fallback)'}`);
  else console.warn('  Warning: No photos found in brand_assets/Fotos/');

  const date = isoDate();
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

  for (const [i, slide] of slides.entries()) {
    const templateFile = TEMPLATE_MAP[slide.contentType];
    if (!templateFile) throw new Error(`Unknown contentType: "${slide.contentType}"`);

    const templatePath = path.join(HTML_TEMPLATES_DIR, templateFile);
    if (!fs.existsSync(templatePath)) {
      throw new Error(`Template not found: ${templateFile}. Run: node agent-templates.mjs`);
    }

    const templateHtml = fs.readFileSync(templatePath, 'utf8');
    const injected = injectContent(templateHtml, slide, photoPath, hasBlogPost);
    const slidePath = path.join(outDir, `slide-0${i + 1}.html`);
    fs.writeFileSync(slidePath, injected, 'utf8');
    slideHtmlPaths.push(slidePath);
    usedTypes.push(slide.contentType);
  }

  console.log('Screenshotting...');
  const pngs = await screenshotSlides(slideHtmlPaths, outDir);

  // Clean up HTML files
  for (const f of slideHtmlPaths) {
    try { fs.unlinkSync(f); } catch (_) {}
  }

  // Generate caption
  console.log('Generating caption...');
  const hashtags = PILLAR_HASHTAGS[post.pillarId] ?? PILLAR_HASHTAGS['cycling'];
  const captionBody = await generateCaption(client, post, format, hashtags, hasBlogPost);
  const fullCaption = `${captionBody}\n\n${hashtags.join(' ')}`;

  // Write caption.txt into output folder AND project root for easy access
  const captionTxt = [
    `POST FORMAT: ${format.toUpperCase()} (${slides.length} slide${slides.length > 1 ? 's' : ''})`,
    `DATE: ${date}`,
    `PILLAR: ${post.pillarId}`,
    `FROM BLOG: ${hasBlogPost ? 'yes' : 'no'}`,
    `PHOTO: ${photoPath ? path.basename(photoPath) : 'none'}`,
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
    JSON.stringify({ date, slug, format, pillar: post.pillarId, fromBlog: hasBlogPost, photo: photoPath ? path.basename(photoPath) : null, caption: fullCaption, hashtags, contentTypes: usedTypes, slides: pngs.map(p => p.replace(/\\/g, '/')) }, null, 2),
    'utf8'
  );

  saveUsage({ date, title: post.title, format, slideCount: slides.length, templates: usedTypes });

  console.log(`\nDone! ${slides.length} slide${slides.length > 1 ? 's' : ''} → carousels/${date}-${slug}/`);
  console.log('Caption → post-caption.txt (also inside the output folder)');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
