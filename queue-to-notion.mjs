/**
 * queue-to-notion.mjs
 * Bridges the carousel build pipeline to the Notion approval queue.
 * For each carousel in carousels/ not yet queued: stages media into social/,
 * commits + pushes (so Vercel serves the public URLs Instagram requires),
 * and creates an IG Pipeline card in Notion with Status=Draft.
 *
 * Idempotent via ig-queue-state.json — pre-existing carousels are seeded as
 * skipped on first run so only NEW builds get queued.
 *
 * Usage:  node queue-to-notion.mjs            (run by n8n after the build step)
 *         node queue-to-notion.mjs --seed-only (mark all current carousels handled)
 */

import './load-env.mjs';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { cmdStage, readCaption } from './post-to-instagram.mjs';
import { queryDatabase, createPage, prop } from './notion-api.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CAROUSELS_DIR = path.join(__dirname, 'carousels');
const STATE_PATH = path.join(__dirname, 'ig-queue-state.json');
const SITE_URL = (process.env.SITE_URL || '').replace(/\/$/, '');

const PILLAR_LABELS = {
  'black-identity': 'Black Identity',
  cycling: 'Cycling',
  technology: 'Technology',
  entrepreneurship: 'Entrepreneurship',
  fatherhood: 'Fatherhood',
  learning: 'Learning',
  'career-growth': 'Career After 40',
};

function readState() {
  if (!fs.existsSync(STATE_PATH)) return { handled: [] };
  return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
}

function writeState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

function listCarousels() {
  if (!fs.existsSync(CAROUSELS_DIR)) return [];
  return fs.readdirSync(CAROUSELS_DIR)
    .filter((d) => fs.statSync(path.join(CAROUSELS_DIR, d)).isDirectory())
    .sort();
}

function parseMeta(carouselDir) {
  const captionPath = path.join(carouselDir, 'caption.txt');
  const raw = fs.existsSync(captionPath) ? fs.readFileSync(captionPath, 'utf8') : '';
  const format = /POST FORMAT:\s*(\w+)/i.exec(raw);
  const pillar = /PILLAR:\s*([\w-]+)/i.exec(raw);
  return {
    type: format && format[1].toUpperCase() === 'SINGLE' ? 'Single' : 'Carousel',
    pillar: pillar ? (PILLAR_LABELS[pillar[1].toLowerCase()] || null) : null,
  };
}

function git(args) {
  return execSync(`git -C "${__dirname}" ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

async function alreadyQueued(dbId, id) {
  const results = await queryDatabase(dbId, {
    property: 'Name',
    title: { equals: id },
  });
  return results.length > 0;
}

async function queueCarousel(dbId, id) {
  const srcDir = path.join(CAROUSELS_DIR, id);
  console.log(`Queueing ${id}...`);

  cmdStage(srcDir);

  // Publish the staged media so the preview/IG URLs go live on Vercel
  git(`add "social/${id}"`);
  const dirty = git('status --porcelain --untracked-files=no -- social') || git(`status --porcelain -- "social/${id}"`);
  if (dirty) {
    git(`commit -m "chore: stage IG media ${id}" -- "social/${id}"`);
    git('push');
    console.log('Pushed social/ — Vercel will deploy the media URLs (~1 min).');
  }

  const stagedDir = path.join(__dirname, 'social', id);
  const pngs = fs.readdirSync(stagedDir).filter((f) => f.endsWith('.png')).sort();
  const firstUrl = `${SITE_URL}/social/${id}/${pngs[0]}`;
  const caption = readCaption(stagedDir);
  const meta = parseMeta(srcDir);
  const dateMatch = /^(\d{4}-\d{2}-\d{2})/.exec(id);

  const properties = {
    Name: prop.title(id),
    Status: prop.select('Draft'),
    Type: prop.select(meta.type),
    Series: prop.select('Blog-derived'),
    Caption: prop.richText(caption),
    'Media URL': prop.url(firstUrl),
    Preview: prop.files([firstUrl]),
    Notes: prop.richText(`${pngs.length} slide(s). Approve by setting Status = "Approved For Publishing".`),
  };
  if (meta.pillar) properties.Pillar = prop.select(meta.pillar);
  if (dateMatch) properties['Publish Date'] = prop.date(dateMatch[1]);

  await createPage(process.env.NOTION_IG_DB_ID, properties);
  console.log(`Notion card created (Draft): ${id}`);
}

async function main() {
  const seedOnly = process.argv.includes('--seed-only');
  const dbId = process.env.NOTION_IG_DB_ID;
  if (!dbId) {
    console.error('Missing NOTION_IG_DB_ID in .env.');
    process.exit(1);
  }

  const state = readState();
  const carousels = listCarousels();
  const pending = carousels.filter((id) => !state.handled.includes(id));

  if (seedOnly) {
    state.handled = [...new Set([...state.handled, ...carousels])];
    writeState(state);
    console.log(`Seeded ${pending.length} pre-existing carousel(s) as handled — only new builds will be queued.`);
    return;
  }

  if (pending.length === 0) {
    console.log('Nothing new to queue.');
    return;
  }

  for (const id of pending) {
    if (await alreadyQueued(dbId, id)) {
      console.log(`${id} already in Notion — marking handled.`);
    } else {
      await queueCarousel(dbId, id);
    }
    state.handled.push(id);
    writeState(state);
  }
}

main().catch((err) => {
  console.error(`\nFailed: ${err.message}`);
  process.exit(1);
});
