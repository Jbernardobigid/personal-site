/**
 * linkedin-media.mjs
 * Media for the LinkedIn series, one builder per format:
 *   photo / photos  real frames of Jorge from brand_assets/Fotos (1, or 2-4 from one shoot)
 *   ai-image        one gpt-image illustration, cropped to 4:5
 *   document        a PDF carousel rendered with the curated Instagram slide templates
 *   video           one of Jorge's own published Reels, copied before the Blob recycler
 *                   deletes it (video/ blobs go 7 days after the IG card is Published)
 * Plus the Blob upload shared by all of them.
 */

import './load-env.mjs';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';
import sharp from 'sharp';
import puppeteer from 'puppeteer-core';
import { pickPhoto, photoLedger, extractPostStructure, injectContent, screenshotSlides, TEMPLATE_MAP } from './generate-carousel.mjs';
import { buildImagePrompt } from './generate-image.mjs';
import { OPENAI_IMAGE_MODEL } from './image-model.mjs';
import { queryDatabase, getTitle, getUrl, getRichText } from './notion-api.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PHOTO_DIR = path.join(__dirname, 'brand_assets', 'Fotos');
const INVENTORY_PATH = path.join(PHOTO_DIR, 'INVENTORY.md');
const TEMPLATES_DIR = path.join(__dirname, 'templates', 'html');
const CHROME = process.env.CHROME_PATH || 'C:/Users/Jorge Bernardo/.cache/puppeteer/chrome/win64-148.0.7778.167/chrome-win64/chrome.exe';
const DAY1_ROOT = process.env.NEWSLETTER_REPO || 'C:/DevWork/AI Automation Society/Day 1';
const BLOB_UPLOAD = path.join(DAY1_ROOT, 'tools', 'blob_upload.mjs');
const INVENTORY_SECTIONS = ['⚡ FAST PICK', '1. `DSC00*`', '5. `20260816', '5b. `20260927'];
const SLIDE_PX = 1080;
const REEL_MAX_AGE_DAYS = 21;
// The slide templates sign off with the Instagram handle; on LinkedIn that reads as
// a cross-platform plug, so it becomes the name people see on the profile.
const IG_HANDLE = /@jotabernard[o0]/gi;

/* ── Availability (checked before any paid call) ─────────── */

export function hasPhotos() {
  return fs.existsSync(PHOTO_DIR) && fs.readdirSync(PHOTO_DIR).some(f => /\.(jpe?g|png)$/i.test(f));
}

/* ── Photos ──────────────────────────────────────────────── */

export function inventoryExcerpt() {
  if (!fs.existsSync(INVENTORY_PATH)) return '';
  const sections = fs.readFileSync(INVENTORY_PATH, 'utf8').split(/\n(?=## )/);
  return sections.filter(s => INVENTORY_SECTIONS.some(h => s.startsWith(`## ${h}`))).join('\n').slice(0, 16000);
}

/** Photos used lately on LinkedIn AND on Instagram, oldest first (the pickPhoto contract). */
export function recentPhotos(posts) {
  let ig = [];
  try { ig = photoLedger(JSON.parse(fs.readFileSync(path.join(__dirname, 'carousel-usage.json'), 'utf8'))); } catch { /* no IG ledger here */ }
  const li = posts.flatMap(p => p.photos || (p.photo ? [p.photo] : []));
  return [...ig.slice(-30), ...li.slice(-30)];
}

const stemOf = (s) => String(s || '').replace(/\.(jpe?g|png|webp)$/i, '').replace(/[^A-Za-z0-9_-]/g, '');

/**
 * One buffer per requested frame. Each pick joins the exclusion list before the next,
 * so a multi-photo post never repeats a frame or its burst neighbour.
 */
export async function photosMedia(choices, used) {
  if (!hasPhotos()) throw new Error('brand_assets/Fotos is missing on this machine');
  const files = fs.readdirSync(PHOTO_DIR).filter(f => /\.(jpe?g|png)$/i.test(f));
  const ledger = [...used];
  const out = [];
  for (const choice of choices) {
    const picked = pickPhoto(files, stemOf(choice), ledger);
    if (!picked) break;
    ledger.push(picked);
    const buffer = await sharp(path.join(PHOTO_DIR, picked)).rotate()
      .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 86, mozjpeg: true }).toBuffer();
    out.push({ buffer, photo: path.basename(picked, path.extname(picked)) });
  }
  if (!out.length) throw new Error('no photo available');
  return out;
}

/* ── AI image ────────────────────────────────────────────── */

export async function aiMedia(scene, seed) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');
  const prompt = buildImagePrompt({ pillarId: 'cycling', scene, seed });
  const res = await new OpenAI().images.generate({ model: OPENAI_IMAGE_MODEL, prompt, n: 1, size: '1024x1536', quality: 'medium' });
  const raw = Buffer.from(res.data[0].b64_json, 'base64');
  // 4:5 is the tallest ratio the LinkedIn feed shows uncropped.
  const buffer = await sharp(raw).resize(1080, 1350, { fit: 'cover', position: 'attention' }).jpeg({ quality: 88, mozjpeg: true }).toBuffer();
  return { buffer, prompt };
}

/* ── Document (PDF carousel) ─────────────────────────────── */

async function slidesToPdf(pngPaths) {
  const pages = await Promise.all(pngPaths.map(async p =>
    `data:image/jpeg;base64,${(await sharp(p).jpeg({ quality: 90, mozjpeg: true }).toBuffer()).toString('base64')}`));
  const html = `<!doctype html><html><head><style>@page{size:${SLIDE_PX}px ${SLIDE_PX}px;margin:0}body{margin:0}img{display:block;width:${SLIDE_PX}px;height:${SLIDE_PX}px;page-break-after:always}</style></head><body>${pages.map(src => `<img src="${src}">`).join('')}</body></html>`;
  const browser = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    return Buffer.from(await page.pdf({ width: `${SLIDE_PX}px`, height: `${SLIDE_PX}px`, printBackground: true }));
  } finally {
    await browser.close();
  }
}

/**
 * The finished post, cut into the curated slide templates (legacy educational shape,
 * which leads with the data) and bound into a PDF LinkedIn shows as a swipeable carousel.
 * Facts come only from the post text, which is already sourced and policed.
 */
export async function documentMedia(client, { hook, angle, commentary, outDir, used }) {
  const post = { title: hook, excerpt: angle, pillarId: 'cycling', plainText: commentary.replace(/#\S+/g, '').trim() };
  const recent = [...new Set(used.map(stemOf))].slice(-20);
  const extracted = await extractPostStructure(client, post, { hasBlogPost: false, inventoryText: inventoryExcerpt(), recentPhotos: recent, forcedFormat: 'carousel' });
  const { photo } = extracted;
  // The tip templates default their eyebrow to "Dica", which frames a reported fact as
  // advice. Number the slides instead, as the Instagram list cut does.
  const slides = extracted.slides.map((s, i) => ({ ...s, label: s.label || String(i + 1).padStart(2, '0') }));

  const files = hasPhotos() ? fs.readdirSync(PHOTO_DIR).filter(f => /\.(jpe?g|png)$/i.test(f)) : [];
  const picked = files.length ? pickPhoto(files, stemOf(photo), used) : null;
  const photoPath = picked ? path.join(PHOTO_DIR, picked) : null;

  let rendersPhoto = false;
  const htmlPaths = slides.map((slide, i) => {
    const file = TEMPLATE_MAP[slide.contentType];
    if (!file) throw new Error(`unknown slide type ${slide.contentType}`);
    const template = fs.readFileSync(path.join(TEMPLATES_DIR, file), 'utf8');
    if (template.includes('{{PHOTO_URL}}')) rendersPhoto = true;
    const html = injectContent(template, slide, photoPath, false,
      { slideNum: i + 1, slideTotal: slides.length, format: 'carousel' }).replace(IG_HANDLE, 'Jorge Bernardo');
    const p = path.join(outDir, `slide-${String(i + 1).padStart(2, '0')}.html`);
    fs.writeFileSync(p, html, 'utf8');
    return p;
  });
  const pngs = await screenshotSlides(htmlPaths, outDir);
  for (const p of htmlPaths) fs.rmSync(p, { force: true });
  const pdf = await slidesToPdf(pngs);
  // A frame only counts as used when a slide actually shows it.
  const usedPhoto = photoPath && rendersPhoto ? path.basename(picked, path.extname(picked)) : null;
  return { buffer: pdf, slides: slides.length, photo: usedPhoto };
}

/* ── Video (repurposed Reel) ─────────────────────────────── */

/**
 * The newest Reel Jorge approved and published on Instagram that this series has not
 * used yet and whose video still exists on Blob. Returns null when there is none.
 */
export async function pickReel(usedReelNames) {
  const dbId = process.env.NOTION_IG_DB_ID;
  if (!dbId) return null;
  const since = new Date(Date.now() - REEL_MAX_AGE_DAYS * 86400_000).toISOString().slice(0, 10);
  const cards = await queryDatabase(dbId, {
    and: [
      { property: 'Type', select: { equals: 'Reel' } },
      { property: 'Status', select: { equals: 'Published' } },
      { property: 'Publish Date', date: { on_or_after: since } }
    ]
  }, [{ property: 'Publish Date', direction: 'descending' }]);
  for (const card of cards) {
    const name = getTitle(card);
    const url = getUrl(card, 'Media URL');
    if (!url || usedReelNames.has(name)) continue;
    const head = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(20000) }).catch(() => null);
    if (head?.ok) return { name, url, caption: getRichText(card, 'Caption') };
  }
  return null;
}

export async function downloadBuffer(url, maxBytes = 300 * 1024 * 1024) {
  const res = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!res.ok) throw new Error(`download ${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error(`download is ${buf.length} bytes, over ${maxBytes}`);
  return buf;
}

/* ── Blob ────────────────────────────────────────────────── */

export function uploadToBlob(filePath, blobPath) {
  const out = execFileSync('node', [BLOB_UPLOAD, filePath, blobPath], { encoding: 'utf8', timeout: 300000 });
  const parsed = JSON.parse(out.trim().split('\n').pop());
  if (!parsed.success || !parsed.url) throw new Error(`blob upload failed: ${parsed.error || 'no url'}`);
  return parsed.url;
}
