/**
 * prepare-linkedin.mjs
 * Builds one post for the LinkedIn cycling series (#EsportesNoLinkedIn) and queues it
 * in the Notion pipeline for approval. Publishing is a separate step
 * (publish-linkedin.mjs), so nothing reaches LinkedIn without Jorge's approval.
 *
 *   beacon shortlist -> Opus picks story + angle -> Tavily research -> Opus writes
 *   -> media (real photo | AI image | none) -> Blob -> Notion card (Draft, Type=LinkedIn)
 *
 * Format rotates text -> photo -> ai-image by least recent use, so the feed keeps varying.
 *
 * Usage:
 *   node prepare-linkedin.mjs                 build + queue
 *   node prepare-linkedin.mjs --dry-run       build locally, no Blob/Notion/ledger writes
 *   node prepare-linkedin.mjs --format photo  force a format (text | photo | ai-image)
 *
 * Writes linkedin/<id>/ (post.txt, comment.txt, meta.json, image.jpg). Ledger:
 * linkedin-ledger.json (gitignored; the VPS copy is the real one).
 * Prints one JSON line {success, ...} last, for the n8n guard node.
 */

import './load-env.mjs';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import sharp from 'sharp';
import { buildShortlist } from './linkedin-beacon.mjs';
import { chooseStory, writePost, assembleCommentary, policeFirstComment, citableUrl } from './linkedin-writer.mjs';
import { researchTopic } from './research.mjs';
import { stravaRecentRides } from './cycling-topics.mjs';
import { pickPhoto, photoLedger } from './generate-carousel.mjs';
import { buildImagePrompt } from './generate-image.mjs';
import { OPENAI_IMAGE_MODEL } from './image-model.mjs';
import { tokenIsValid } from './linkedin-api.mjs';
import { queryDatabase, createPage, prop } from './notion-api.mjs';
import { titleKey } from './signals.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEDGER_PATH = path.join(__dirname, 'linkedin-ledger.json');
const OUT_ROOT = path.join(__dirname, 'linkedin');
const PHOTO_DIR = path.join(__dirname, 'brand_assets', 'Fotos');
const INVENTORY_PATH = path.join(PHOTO_DIR, 'INVENTORY.md');
const DAY1_ROOT = process.env.NEWSLETTER_REPO || 'C:/DevWork/AI Automation Society/Day 1';
const BLOB_UPLOAD = path.join(DAY1_ROOT, 'tools', 'blob_upload.mjs');

export const FORMATS = ['text', 'photo', 'ai-image'];
const PUBLISH_WEEKDAYS = [2, 4];      // Tue, Thu: the slots publish-linkedin.mjs serves
const RECENT_FOR_PROMPT = 8;
const LEDGER_KEEP = 120;
const INVENTORY_SECTIONS = ['⚡ FAST PICK', '1. `DSC00*`', '5. `20260816', '5b. `20260927'];

class BuildError extends Error {
  constructor(msg, detail = '') { super(msg); this.detail = detail; }
}

/** Abort the build. The entrypoint prints the JSON line and sets exitCode; process.exit()
 *  after fetch trips a libuv assertion on Windows. */
function fail(msg, detail = '') {
  throw new BuildError(msg, detail);
}

function parseArgs(argv) {
  const args = { dryRun: argv.includes('--dry-run'), format: null };
  const i = argv.indexOf('--format');
  if (i !== -1) args.format = argv[i + 1];
  if (args.format && !FORMATS.includes(args.format)) fail(`unknown --format ${args.format}`, `use ${FORMATS.join(' | ')}`);
  return args;
}

function loadLedger() {
  try {
    const l = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
    return Array.isArray(l?.posts) ? l : { posts: [] };
  } catch { return { posts: [] }; }
}

function saveLedger(ledger, entry) {
  const posts = [...ledger.posts, entry].slice(-LEDGER_KEEP);
  fs.writeFileSync(LEDGER_PATH, JSON.stringify({ posts }, null, 2), 'utf8');
}

/**
 * Least recently used format whose media can actually be made here; never-used formats
 * first, in FORMATS order. Failed attempts count as use, so a format that keeps failing
 * (photos not synced to the VPS, an image-model refusal) cannot pin the rotation and
 * re-spend the Opus calls every run. Exported for tests.
 */
export function pickFormat(posts, forced = null, isAvailable = () => true) {
  if (forced) return forced;
  const lastUse = (f) => posts.map(p => p.format).lastIndexOf(f);
  return [...FORMATS].sort((a, b) => lastUse(a) - lastUse(b)).find(isAvailable) || 'text';
}

/** Checked BEFORE any paid call: can this machine make the media for the format? */
function formatAvailable(format) {
  if (format === 'photo') return fs.existsSync(PHOTO_DIR) && fs.readdirSync(PHOTO_DIR).some(f => /\.(jpe?g|png)$/i.test(f));
  if (format === 'ai-image') return !!process.env.OPENAI_API_KEY;
  return true;
}

/** Next Tue/Thu strictly after `now`, as YYYY-MM-DD in Brazil time. Exported for tests. */
export function nextSlotDate(now = new Date()) {
  const today = now.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  const d = new Date(`${today}T12:00:00Z`);
  do { d.setUTCDate(d.getUTCDate() + 1); } while (!PUBLISH_WEEKDAYS.includes(d.getUTCDay()));
  return d.toISOString().slice(0, 10);
}

function slugify(s) {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60).replace(/-$/, '');
}

/* ── Photo inventory + rotation ──────────────────────────── */

function inventoryExcerpt() {
  if (!fs.existsSync(INVENTORY_PATH)) return '';
  const sections = fs.readFileSync(INVENTORY_PATH, 'utf8').split(/\n(?=## )/);
  return sections.filter(s => INVENTORY_SECTIONS.some(h => s.startsWith(`## ${h}`))).join('\n').slice(0, 16000);
}

/** Photos used lately on LinkedIn AND on Instagram, oldest first (the pickPhoto contract). */
function recentPhotos(ledger) {
  let ig = [];
  try { ig = photoLedger(JSON.parse(fs.readFileSync(path.join(__dirname, 'carousel-usage.json'), 'utf8'))); } catch { /* no IG ledger here */ }
  const li = ledger.posts.map(p => p.photo).filter(Boolean);
  return [...ig.slice(-30), ...li.slice(-20)];
}

async function photoMedia(choice, usedPhotos) {
  if (!fs.existsSync(PHOTO_DIR)) throw new Error('brand_assets/Fotos is missing on this machine');
  const files = fs.readdirSync(PHOTO_DIR).filter(f => /\.(jpe?g|png)$/i.test(f));
  const stem = String(choice || '').replace(/\.(jpe?g|png|webp)$/i, '').replace(/[^A-Za-z0-9_-]/g, '');
  const picked = pickPhoto(files, stem, usedPhotos);
  if (!picked) throw new Error('no photo available');
  const buffer = await sharp(path.join(PHOTO_DIR, picked)).rotate()
    .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 86, mozjpeg: true }).toBuffer();
  return { buffer, photo: path.basename(picked, path.extname(picked)) };
}

async function aiMedia(scene, seed) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');
  const prompt = buildImagePrompt({ pillarId: 'cycling', scene, seed });
  const res = await new OpenAI().images.generate({ model: OPENAI_IMAGE_MODEL, prompt, n: 1, size: '1024x1536', quality: 'medium' });
  const raw = Buffer.from(res.data[0].b64_json, 'base64');
  // 4:5 is the tallest ratio the LinkedIn feed shows uncropped.
  const buffer = await sharp(raw).resize(1080, 1350, { fit: 'cover', position: 'attention' }).jpeg({ quality: 88, mozjpeg: true }).toBuffer();
  return { buffer, prompt };
}

function uploadToBlob(filePath, blobPath) {
  const out = execFileSync('node', [BLOB_UPLOAD, filePath, blobPath], { encoding: 'utf8', timeout: 180000 });
  const parsed = JSON.parse(out.trim().split('\n').pop());
  if (!parsed.success || !parsed.url) throw new Error(`blob upload failed: ${parsed.error || 'no url'}`);
  return parsed.url;
}

/* ── Notion ──────────────────────────────────────────────── */

function notesFor({ format, story, research, altText, tokenOk, photo, imagePrompt }) {
  const lines = [
    tokenOk === false ? 'ATENÇÃO: o token do LinkedIn está expirado. Renove antes de aprovar, senão a publicação falha.' : null,
    `Formato: ${format}${photo ? ` (foto ${photo})` : ''}${imagePrompt ? ' (imagem gerada por IA)' : ''}`,
    `Notícia: ${story.title} (${story.source}, lente ${story.lens})`,
    altText ? `Texto alternativo: ${altText}` : null,
    research?.sources?.length ? `Pesquisa: ${research.sources.slice(0, 4).join(' ')}` : 'Pesquisa: nenhuma',
    'Edite Caption e First Comment à vontade. Aprove com Status = "Approved For Publishing"; sai no próximo horário (ter/qui 08:30).'
  ];
  return lines.filter(Boolean).join('\n');
}

async function queueCard({ id, commentary, firstComment, mediaUrl, notes, slot }) {
  const dbId = process.env.NOTION_IG_DB_ID;
  if (!dbId) throw new Error('NOTION_IG_DB_ID not set');
  const existing = await queryDatabase(dbId, { property: 'Name', title: { equals: id } });
  if (existing.length) return false;
  await createPage(dbId, {
    Name: prop.title(id),
    Status: prop.select('Draft'),
    Type: prop.select('LinkedIn'),
    Series: prop.select('EsportesNoLinkedIn'),
    Pillar: prop.select('Cycling'),
    Caption: prop.longText(commentary),
    'First Comment': prop.longText(firstComment),
    ...(mediaUrl ? { 'Media URL': prop.url(mediaUrl), Preview: prop.files([mediaUrl]) } : {}),
    Notes: prop.longText(notes),
    'Publish Date': prop.date(slot)
  });
  return true;
}

/* ── Main ────────────────────────────────────────────────── */

async function research(query) {
  try {
    const r = await researchTopic(query);
    return r.success ? r.data : null;
  } catch (e) {
    console.warn(`research failed (${e.message}); writing from the news item alone`);
    return null;
  }
}

async function buildMedia(format, post, ledger, seed) {
  if (format === 'photo') return photoMedia(post.photo_choice, recentPhotos(ledger));
  if (format === 'ai-image') return aiMedia(post.image_scene, seed);
  return {};
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const ledger = loadLedger();
  const format = pickFormat(ledger.posts, args.format, formatAvailable);
  // Ledger views below exclude failed attempts: they carry a format but no post.
  const published = { posts: ledger.posts.filter(p => !p.failed) };
  const recent = published.posts.slice(-RECENT_FOR_PROMPT);
  console.log(`Format: ${format}`);

  const { shortlist, gathered } = await buildShortlist({ ledger: published });
  console.log(`Beacon: ${gathered.length} on-lens items, ${shortlist.length} shortlisted`);
  if (!shortlist.length) fail('no story passed the beacon screen', 'nothing queued; the next run will try again');

  const client = new Anthropic();
  const rides = await stravaRecentRides();
  const choice = await chooseStory(client, { shortlist, format, recent, rides });
  const story = shortlist[choice.choice];
  if (!story) fail('story choice out of range', `model returned ${choice.choice} for ${shortlist.length} items`);
  console.log(`Story: ${story.title} (${story.source})\nAngle: ${choice.angle}\nResearch: ${choice.research_query}`);

  const data = await research(choice.research_query);
  const allowedUrls = [...new Set([citableUrl(story.url), ...(data?.sources || [])].filter(Boolean))].slice(0, 8);
  const inventory = { text: format === 'photo' ? inventoryExcerpt() : '', recent: [...new Set(recentPhotos(published))].slice(-20) };
  const slot = nextSlotDate();
  const post = await writePost(client, { story, angle: choice.angle, format, research: data, rides, recent, inventory, allowedUrls, publishDate: slot });

  const commentary = assembleCommentary(post);
  let firstComment = policeFirstComment(post.first_comment, allowedUrls);
  if (format === 'ai-image') firstComment = `${firstComment}\n\nImagem ilustrativa gerada por IA.`.trim();

  const date = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  const id = `${date}-linkedin-${slugify(post.hook) || 'post'}`;
  const outDir = path.join(OUT_ROOT, id);
  fs.mkdirSync(outDir, { recursive: true });
  let media;
  try {
    media = await buildMedia(format, post, published, id);
  } catch (e) {
    if (!args.dryRun) saveLedger(ledger, { date, id, format, failed: true, error: String(e.message).slice(0, 200) });
    fail(`${format} media failed`, e.message);
  }
  const imagePath = media.buffer ? path.join(outDir, 'image.jpg') : null;
  if (imagePath) fs.writeFileSync(imagePath, media.buffer);
  fs.writeFileSync(path.join(outDir, 'post.txt'), commentary, 'utf8');
  fs.writeFileSync(path.join(outDir, 'comment.txt'), firstComment, 'utf8');
  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify({ id, format, story, angle: choice.angle, research_query: choice.research_query, post, photo: media.photo || null, imagePrompt: media.prompt || null, allowedUrls }, null, 2), 'utf8');
  console.log(`\n${commentary}\n\n--- first comment ---\n${firstComment}\n`);

  if (args.dryRun) {
    console.log(JSON.stringify({ success: true, dryRun: true, id, format, chars: commentary.length, dir: outDir }));
    return;
  }

  const tokenOk = await tokenIsValid();
  const mediaUrl = imagePath ? uploadToBlob(imagePath, `linkedin/${id}.jpg`) : null;
  const notes = notesFor({ format, story, research: data, altText: post.alt_text, tokenOk, photo: media.photo, imagePrompt: media.prompt });
  const queued = await queueCard({ id, commentary, firstComment, mediaUrl, notes, slot });
  saveLedger(ledger, {
    date, id, format, hook: post.hook.slice(0, 160), photo: media.photo || null,
    signal: { title: story.title, titleKey: titleKey(story.title), url: story.url, lens: story.lens, source: story.source }
  });
  console.log(JSON.stringify({ success: true, id, format, queued, slot, chars: commentary.length, tokenOk }));
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  main().catch(e => {
    const isBuild = e instanceof BuildError;
    console.log(JSON.stringify({ success: false, error: isBuild ? e.message : 'unexpected', detail: String(isBuild ? e.detail : (e?.stack || e)).slice(0, 500) }));
    process.exitCode = 1;
  });
}
