/**
 * prepare-linkedin.mjs
 * Builds one post for the LinkedIn cycling series (#EsportesNoLinkedIn) and queues it
 * as a Draft in the Notion "LinkedIn Pipeline" database (IG Studio page). Publishing
 * is a separate step (publish-linkedin.mjs), so nothing reaches LinkedIn without
 * Jorge's approval.
 *
 * News formats (text, photo, photos, ai-image, document):
 *   beacon shortlist -> Opus picks story + angle -> Tavily research -> Opus writes -> media
 * Video:
 *   newest published Reel not used yet -> Opus frames it for LinkedIn -> copy the mp4
 *
 * The format rotates by least recent use, skipping formats this machine cannot make.
 *
 * Usage:
 *   node prepare-linkedin.mjs                   build + queue
 *   node prepare-linkedin.mjs --dry-run         build locally, no Blob/Notion/ledger writes
 *   node prepare-linkedin.mjs --format photos   force a format (see FORMATS)
 *
 * Writes linkedin/<id>/ (post.txt, comment.txt, meta.json, media). Ledger:
 * linkedin-ledger.json (gitignored; the VPS copy is the real one).
 * Prints one JSON line {success, ...} last, for the n8n guard node.
 */

import './load-env.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import { buildShortlist } from './linkedin-beacon.mjs';
import { chooseStory, writePost, assembleCommentary, policeFirstComment, citableUrl, FORMATS_WITH_PHOTOS } from './linkedin-writer.mjs';
import { hasPhotos, inventoryExcerpt, recentPhotos, photosMedia, aiMedia, documentMedia, pickReel, downloadBuffer, uploadToBlob } from './linkedin-media.mjs';
import { researchTopic } from './research.mjs';
import { stravaRecentRides } from './cycling-topics.mjs';
import { tokenIsValid } from './linkedin-api.mjs';
import { queryDatabase, createPage, prop } from './notion-api.mjs';
import { titleKey } from './signals.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEDGER_PATH = path.join(__dirname, 'linkedin-ledger.json');
const OUT_ROOT = path.join(__dirname, 'linkedin');

// Rotation order for formats never used yet. Text first: it is the cheapest and the
// one the workshop called the base of the feed.
export const FORMATS = ['text', 'photo', 'document', 'video', 'photos', 'ai-image'];
const PUBLISH_WEEKDAYS = [2, 4];      // Tue, Thu: the slots publish-linkedin.mjs serves
const RECENT_FOR_PROMPT = 8;
const LEDGER_KEEP = 120;

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
  if (FORMATS_WITH_PHOTOS[format]) return hasPhotos();
  if (format === 'ai-image') return !!process.env.OPENAI_API_KEY;
  if (format === 'video') return !!process.env.NOTION_IG_DB_ID;
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
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60).replace(/-$/, '');
}

/* ── Sources: a news story, or one of Jorge's Reels ──────── */

async function research(query) {
  try {
    const r = await researchTopic(query);
    return r.success ? r.data : null;
  } catch (e) {
    console.warn(`research failed (${e.message}); writing from the news item alone`);
    return null;
  }
}

async function newsSource(client, { format, published, recent, rides }) {
  const { shortlist, gathered } = await buildShortlist({ ledger: published });
  console.log(`Beacon: ${gathered.length} on-lens items, ${shortlist.length} shortlisted`);
  if (!shortlist.length) fail('no story passed the beacon screen', 'nothing queued; the next run will try again');
  const choice = await chooseStory(client, { shortlist, format, recent, rides });
  const story = shortlist[choice.choice];
  if (!story) fail('story choice out of range', `model returned ${choice.choice} for ${shortlist.length} items`);
  console.log(`Story: ${story.title} (${story.source})\nAngle: ${choice.angle}\nResearch: ${choice.research_query}`);
  const data = await research(choice.research_query);
  const allowedUrls = [...new Set([citableUrl(story.url), ...(data?.sources || [])].filter(Boolean))].slice(0, 8);
  return { story, angle: choice.angle, researchQuery: choice.research_query, data, allowedUrls };
}

async function reelSource(published) {
  const used = new Set(published.posts.filter(p => p.format === 'video').map(p => p.signal?.title));
  const reel = await pickReel(used);
  if (!reel) return null;
  console.log(`Reel: ${reel.name}`);
  const story = { title: reel.name, summary: reel.caption.replace(/#\S+/g, '').trim(), source: 'Reel', lang: 'pt', lens: 'reel', url: reel.url };
  const angle = 'Mostrar por que o vídeo importa para quem trabalha, não só para quem pedala.';
  return { story, angle, researchQuery: null, data: null, allowedUrls: [] };
}

/* ── Media ───────────────────────────────────────────────── */

/** Returns { files: [{ path, blobPath }], photos: [...], extra } with files written to outDir. */
async function buildMedia(format, { client, post, commentary, source, published, id, outDir }) {
  const used = recentPhotos(published.posts);
  const write = (name, buffer) => { const p = path.join(outDir, name); fs.writeFileSync(p, buffer); return { path: p, blobPath: `linkedin/${id}-${name}` }; };

  if (FORMATS_WITH_PHOTOS[format]) {
    const want = format === 'photo' ? post.photo_choices.slice(0, 1) : post.photo_choices.slice(0, 4);
    const shots = await photosMedia(want.length ? want : [''], used);
    if (format === 'photos' && shots.length < 2) throw new Error('multi-photo post needs at least 2 photos');
    return { files: shots.map((s, i) => write(`photo-${i + 1}.jpg`, s.buffer)), photos: shots.map(s => s.photo) };
  }
  if (format === 'ai-image') {
    const { buffer, prompt } = await aiMedia(post.image_scene, id);
    return { files: [write('image.jpg', buffer)], photos: [], extra: { imagePrompt: prompt } };
  }
  if (format === 'document') {
    const doc = await documentMedia(client, { hook: post.hook, angle: source.angle, commentary, outDir, used });
    return { files: [write('carrossel.pdf', doc.buffer)], photos: doc.photo ? [doc.photo] : [], extra: { slides: doc.slides } };
  }
  if (format === 'video') {
    return { files: [write('video.mp4', await downloadBuffer(source.story.url))], photos: [] };
  }
  return { files: [], photos: [] };
}

/* ── Notion ──────────────────────────────────────────────── */

function notesFor({ format, source, altText, tokenOk, media }) {
  const { story, data } = source;
  const lines = [
    tokenOk === false ? 'ATENÇÃO: o token do LinkedIn está expirado. Renove antes de aprovar, senão a publicação falha.' : null,
    media.photos.length ? `Fotos: ${media.photos.join(', ')}` : null,
    media.extra?.imagePrompt ? 'Imagem gerada por IA (o primeiro comentário avisa).' : null,
    media.extra?.slides ? `Carrossel em PDF com ${media.extra.slides} slides (abra o Media URL para revisar).` : null,
    format === 'video' ? `Vídeo: Reel "${story.title}" já publicado no Instagram.` : `Notícia: ${story.title} (${story.source})`,
    altText ? `Texto alternativo: ${altText}` : null,
    data?.sources?.length ? `Pesquisa: ${data.sources.slice(0, 4).join(' ')}` : null
  ];
  return lines.filter(Boolean).join('\n');
}

async function queueCard({ id, format, lens, commentary, firstComment, urls, sourceUrl, notes, slot }) {
  const dbId = process.env.NOTION_LINKEDIN_DB_ID;
  if (!dbId) throw new Error('NOTION_LINKEDIN_DB_ID not set');
  const existing = await queryDatabase(dbId, { property: 'Name', title: { equals: id } });
  if (existing.length) return false;
  await createPage(dbId, {
    Name: prop.title(id),
    Status: prop.select('Draft'),
    Format: prop.select(format),
    Lens: prop.select(lens),
    'Publish Date': prop.date(slot),
    Caption: prop.longText(commentary),
    'First Comment': prop.longText(firstComment),
    ...(urls.length ? { 'Media URL': prop.url(urls[0]), Preview: prop.files(urls) } : {}),
    ...(sourceUrl ? { Source: prop.url(sourceUrl) } : {}),
    Notes: prop.longText(notes)
  });
  return true;
}

/* ── Main ────────────────────────────────────────────────── */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const ledger = loadLedger();
  // Ledger views below exclude failed attempts: they carry a format but no post.
  const published = { posts: ledger.posts.filter(p => !p.failed) };
  const recent = published.posts.slice(-RECENT_FOR_PROMPT);
  const client = new Anthropic();
  const rides = await stravaRecentRides();

  let format = pickFormat(ledger.posts, args.format, formatAvailable);
  let source = format === 'video' ? await reelSource(published) : null;
  if (format === 'video' && !source) {
    if (args.format) fail('no unused published Reel with a live video', 'try another --format');
    console.log('No usable Reel; falling back to the next format.');
    format = pickFormat(ledger.posts, null, f => f !== 'video' && formatAvailable(f));
  }
  console.log(`Format: ${format}`);
  source ??= await newsSource(client, { format, published, recent, rides });

  const slot = nextSlotDate();
  const inventory = { text: FORMATS_WITH_PHOTOS[format] ? inventoryExcerpt() : '', recent: [...new Set(recentPhotos(published.posts))].slice(-20) };
  const post = await writePost(client, { story: source.story, angle: source.angle, format, research: source.data, rides, recent, inventory, allowedUrls: source.allowedUrls, publishDate: slot });

  const commentary = assembleCommentary(post);
  let firstComment = policeFirstComment(post.first_comment, source.allowedUrls);
  if (format === 'ai-image') firstComment = `${firstComment}\n\nImagem ilustrativa gerada por IA.`.trim();

  const date = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  const id = `${date}-linkedin-${slugify(post.hook) || 'post'}`;
  const outDir = path.join(OUT_ROOT, id);
  fs.mkdirSync(outDir, { recursive: true });
  let media;
  try {
    media = await buildMedia(format, { client, post, commentary, source, published, id, outDir });
  } catch (e) {
    if (!args.dryRun) saveLedger(ledger, { date, id, format, failed: true, error: String(e.message).slice(0, 200) });
    fail(`${format} media failed`, e.message);
  }
  fs.writeFileSync(path.join(outDir, 'post.txt'), commentary, 'utf8');
  fs.writeFileSync(path.join(outDir, 'comment.txt'), firstComment, 'utf8');
  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify({ id, format, story: source.story, angle: source.angle, research_query: source.researchQuery, post, photos: media.photos, extra: media.extra || null, allowedUrls: source.allowedUrls }, null, 2), 'utf8');
  console.log(`\n${commentary}\n\n--- first comment ---\n${firstComment}\n`);

  if (args.dryRun) {
    console.log(JSON.stringify({ success: true, dryRun: true, id, format, chars: commentary.length, files: media.files.map(f => path.basename(f.path)), dir: outDir }));
    return;
  }

  const tokenOk = await tokenIsValid();
  const urls = media.files.map(f => uploadToBlob(f.path, f.blobPath));
  const notes = notesFor({ format, source, altText: post.alt_text, tokenOk, media });
  const sourceUrl = format === 'video' ? null : citableUrl(source.story.url);
  const queued = await queueCard({ id, format, lens: source.story.lens, commentary, firstComment, urls, sourceUrl, notes, slot });
  saveLedger(ledger, {
    date, id, format, hook: post.hook.slice(0, 160), photos: media.photos,
    signal: { title: source.story.title, titleKey: titleKey(source.story.title), url: source.story.url, lens: source.story.lens, source: source.story.source }
  });
  console.log(JSON.stringify({ success: true, id, format, queued, slot, chars: commentary.length, media: urls.length, tokenOk }));
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  main().catch(e => {
    const isBuild = e instanceof BuildError;
    console.log(JSON.stringify({ success: false, error: isBuild ? e.message : 'unexpected', detail: String(isBuild ? e.detail : (e?.stack || e)).slice(0, 500) }));
    process.exitCode = 1;
  });
}
