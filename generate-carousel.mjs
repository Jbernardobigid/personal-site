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
  'data-security':    ['#SegurançaDeDados', '#PrivacidadeDeDados', '#LGPD', '#GovernançaDeIA', '#BigID', '#PrivacyByDesign', '#TechBR'],
  'entrepreneurship': ['#EmpreendedorismoNegro', '#FeiraPreta', '#EmpreendeContaCom', '#NegociosAfrobrasileiros', '#BlackBusiness', '#JorgeBernardo'],
  'cycling':          ['#DePretoPraPreto', '#CiclismoNegro', '#TeamAfricaRising', '#CiclismoSP', '#BlackCycling', '#PedalaNegro'],
  'brand':            ['#MarcaComPropósito', '#IdentidadeVisual', '#CulturalBranding', '#StrategyMeetAesthetics', '#BrandBuilding'],
  'wellness':         ['#Wellness', '#AfterALL', '#MindsetDeAtleta', '#TechSaúde', '#PerformanceHumana'],
};

/* ── Utilities ─────────────────────────────────────────────── */

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

function loadUsage() {
  if (!fs.existsSync(USAGE_PATH)) return { recentTemplates: [] };
  return JSON.parse(fs.readFileSync(USAGE_PATH, 'utf8'));
}

function saveUsage(used) {
  const existing = loadUsage();
  const updated = [...existing.recentTemplates, ...used].slice(-35);
  fs.writeFileSync(USAGE_PATH, JSON.stringify({ recentTemplates: updated, lastRun: isoDate() }, null, 2), 'utf8');
}

/* ── Photo resolver (random pick for variety) ──────────────── */

function resolvePhoto() {
  const photoDir = path.join(__dirname, 'brand_assets', 'Fotos');
  if (!fs.existsSync(photoDir)) return null;

  const envPhoto = process.env.JORGE_CAROUSEL_PHOTO;
  if (envPhoto) {
    const candidate = path.join(photoDir, envPhoto);
    if (fs.existsSync(candidate)) return candidate;
  }

  const jpgs = fs.readdirSync(photoDir).filter(f => /\.(jpg|jpeg|png)$/i.test(f));
  if (jpgs.length === 0) return null;
  return path.join(photoDir, jpgs[Math.floor(Math.random() * jpgs.length)]);
}

/* ── Blog post reader ──────────────────────────────────────── */

function readLatestPost() {
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

async function extractPostStructure(client, post) {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2500,
    messages: [{
      role: 'user',
      content: `You are a social media manager for Jorge Bernardo — Black Brazilian cyclist, entrepreneur, and data security professional behind the DePretoPraPreto brand.

BLOG POST:
Title: ${post.title}
Excerpt: ${post.excerpt}
Content: ${post.plainText.substring(0, 3000)}

Decide the best Instagram post format, then extract the content.

FORMAT RULES:
- "carousel" (3-7 slides): For educational, sequential content — guides, tip lists, myth-busting, Q&A, step-by-step processes. Maximum saves and shares.
- "single" (1 slide): For powerful quotes, personal reflections, photo stories, brand moments. Higher reach, simpler message.

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

Return JSON: { "format": "carousel" | "single", "slides": [ ... ] }

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
- For carousels: first slide must be hook, last must be cta (headline = "Leia o post completo", body = "Link na bio ↗")
- For carousels: do not repeat the same contentType more than twice
- For tags: items should be 6 short keyword phrases (2-4 words each)
- Return ONLY valid JSON, no markdown fences, no explanation`,
    }],
  });

  const raw = response.content[0].text.trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Claude did not return valid JSON');
  const parsed = JSON.parse(raw.slice(start, end + 1));
  if (!parsed.format || !Array.isArray(parsed.slides)) throw new Error('Unexpected JSON structure from Claude');
  return parsed;
}

/* ── Claude: generate caption ──────────────────────────────── */

async function generateCaption(client, post, format, hashtags) {
  const formatHint = format === 'single'
    ? 'This is a single image post.'
    : 'This is a carousel (swipe) post.';

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 400,
    messages: [{
      role: 'user',
      content: `Write an Instagram caption in Brazilian Portuguese for this post by Jorge Bernardo.
${formatHint}

Post title: ${post.title}
Post excerpt: ${post.excerpt}

Rules:
- 280-400 characters (not counting hashtags)
- Conversational, first-person, not formal
- Start with a hook — a question or bold statement
- For carousel: add "Salva esse post 📌" somewhere
- End with "Link na bio ↗" on its own line
- Do NOT include hashtags in the body
- Return ONLY the caption text, nothing else`,
    }],
  });

  return response.content[0].text.trim();
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

function injectContent(templateHtml, slide, photoAbsPath) {
  const { contentType, headline, body, items, steps, myth, truth, question, answer } = slide;
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

  console.log('Reading blog post...');
  const post = readLatestPost();
  console.log(`  Title: ${post.title}`);
  console.log(`  Pillar: ${post.pillarId}`);

  console.log('Deciding format and extracting content with Claude...');
  const { format, slides } = await extractPostStructure(client, post);
  console.log(`  Format: ${format} | Slides: ${slides.length}`);
  console.log(`  Types: ${slides.map(s => s.contentType).join(', ')}`);

  const photoPath = resolvePhoto();
  if (photoPath) console.log(`  Photo: ${path.basename(photoPath)}`);
  else console.warn('  Warning: No photos found in brand_assets/Fotos/');

  const date = isoDate();
  const slug = slugify(post.title);
  const outDir = path.join(__dirname, 'carousels', `${date}-${slug}`);
  fs.mkdirSync(outDir, { recursive: true });

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
    const injected = injectContent(templateHtml, slide, photoPath);
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
  const captionBody = await generateCaption(client, post, format, hashtags);
  const fullCaption = `${captionBody}\n\n${hashtags.join(' ')}`;

  // Write caption.txt into output folder AND project root for easy access
  const captionTxt = [
    `POST FORMAT: ${format.toUpperCase()} (${slides.length} slide${slides.length > 1 ? 's' : ''})`,
    `DATE: ${date}`,
    `PILLAR: ${post.pillarId}`,
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
    JSON.stringify({ date, slug, format, pillar: post.pillarId, caption: fullCaption, hashtags, contentTypes: usedTypes, slides: pngs.map(p => p.replace(/\\/g, '/')) }, null, 2),
    'utf8'
  );

  saveUsage(usedTypes);

  console.log(`\nDone! ${slides.length} slide${slides.length > 1 ? 's' : ''} → carousels/${date}-${slug}/`);
  console.log('Caption → post-caption.txt (also inside the output folder)');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
