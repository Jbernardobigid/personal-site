/**
 * post-to-instagram.mjs
 * Publishes carousels, single images, and Reels to Instagram via the Graph API.
 *
 * Media must be reachable at a public URL. Images are staged into social/
 * (committed → served by Vercel at SITE_URL/social/...). Reel videos need an
 * externally hosted URL until the VPS serves media (Phase 2 of the plan).
 *
 * Usage:
 *   node post-to-instagram.mjs check
 *   node post-to-instagram.mjs stage carousels/2026-06-11-some-slug
 *   node post-to-instagram.mjs publish-carousel 2026-06-11-some-slug [--dry-run]
 *   node post-to-instagram.mjs publish-reel --video-url <url> [--caption-file <file>] [--dry-run]
 *
 * Flow: stage → git commit + push social/ → wait for Vercel deploy → publish-carousel.
 */

import './load-env.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// graph.facebook.com = Facebook-login flavor (Page-linked); graph.instagram.com = Instagram-login flavor
const API_BASE = (process.env.INSTAGRAM_API_BASE || 'https://graph.facebook.com').replace(/\/$/, '');
const GRAPH = `${API_BASE}/v23.0`;
const IS_IG_LOGIN = API_BASE.includes('graph.instagram.com');
const SOCIAL_DIR = path.join(__dirname, 'social');
const SITE_URL = (process.env.SITE_URL || '').replace(/\/$/, '');

const REEL_STATUS_POLL_MS = 10_000;
const REEL_STATUS_TIMEOUT_MS = 5 * 60_000;
const MAX_CAROUSEL_SLIDES = 10;

/* ── Graph API helpers ─────────────────────────────────────── */

export function requireEnv() {
  const token = process.env.INSTAGRAM_ACCESS_TOKEN;
  const igUserId = process.env.INSTAGRAM_USER_ID;
  if (!token || !igUserId) {
    console.error('Missing INSTAGRAM_ACCESS_TOKEN / INSTAGRAM_USER_ID in .env.');
    console.error('Follow docs/setup-meta-and-notion.md Part A, then retry.');
    process.exit(1);
  }
  return { token, igUserId };
}

export async function graphCall(method, apiPath, params) {
  const url = new URL(`${GRAPH}${apiPath}`);
  const init = { method };
  if (method === 'GET') {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  } else {
    init.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    init.body = new URLSearchParams(params).toString();
  }
  const res = await fetch(url, init);
  const body = await res.json();
  if (!res.ok || body.error) {
    const msg = body.error ? `${body.error.type}: ${body.error.message}` : `HTTP ${res.status}`;
    throw new Error(`Graph API ${method} ${apiPath} failed — ${msg}`);
  }
  return body;
}

async function assertUrlReachable(url) {
  const res = await fetch(url, { method: 'HEAD' });
  if (!res.ok) {
    throw new Error(`Media URL not reachable (HTTP ${res.status}): ${url}\nDid you commit+push social/ and wait for the Vercel deploy?`);
  }
}

/* ── check ─────────────────────────────────────────────────── */

async function cmdCheck() {
  const { token, igUserId } = requireEnv();
  // Instagram-login tokens introspect via /me; Facebook-login tokens via the IG user node
  const apiPath = IS_IG_LOGIN ? '/me' : `/${igUserId}`;
  const fields = IS_IG_LOGIN
    ? 'user_id,username,account_type,followers_count,media_count'
    : 'username,name,followers_count,media_count';
  const profile = await graphCall('GET', apiPath, { fields, access_token: token });
  console.log(`Connected as @${profile.username}${profile.account_type ? ` (${profile.account_type})` : ''}`);
  console.log(`Followers: ${profile.followers_count} · Posts: ${profile.media_count}`);
  if (IS_IG_LOGIN && String(profile.user_id) !== String(igUserId)) {
    console.warn(`Warning: token belongs to IG user ${profile.user_id}, but INSTAGRAM_USER_ID=${igUserId}. Update .env.`);
    return;
  }
  console.log('Token and account ID are valid.');
}

/* ── stage ─────────────────────────────────────────────────── */

export function cmdStage(carouselDir) {
  const srcDir = path.isAbsolute(carouselDir) ? carouselDir : path.join(__dirname, carouselDir);
  if (!fs.existsSync(srcDir)) {
    console.error(`Carousel folder not found: ${srcDir}`);
    process.exit(1);
  }
  const id = path.basename(srcDir);
  const destDir = path.join(SOCIAL_DIR, id);
  fs.mkdirSync(destDir, { recursive: true });

  const files = fs.readdirSync(srcDir).filter((f) => f.endsWith('.png') || f === 'caption.txt');
  if (!files.some((f) => f.endsWith('.png'))) {
    console.error(`No PNG slides found in ${srcDir}.`);
    process.exit(1);
  }
  for (const f of files) {
    fs.copyFileSync(path.join(srcDir, f), path.join(destDir, f));
  }

  const pngs = files.filter((f) => f.endsWith('.png')).sort();
  console.log(`Staged ${pngs.length} slide(s) → social/${id}/`);
  for (const f of pngs) console.log(`  ${SITE_URL}/social/${id}/${f}`);
  console.log('\nNext: commit + push social/, wait for the Vercel deploy, then run:');
  console.log(`  node post-to-instagram.mjs publish-carousel ${id}`);
}

/* ── publish: carousel / single image ──────────────────────── */

export function readCaption(dir, captionFileArg) {
  const captionPath = captionFileArg
    ? (path.isAbsolute(captionFileArg) ? captionFileArg : path.join(__dirname, captionFileArg))
    : path.join(dir, 'caption.txt');
  if (!fs.existsSync(captionPath)) {
    console.error(`Caption file not found: ${captionPath}`);
    process.exit(1);
  }
  const raw = fs.readFileSync(captionPath, 'utf8');
  // generate-carousel.mjs wraps the actual caption between ───── divider lines,
  // with a metadata header above and a SLIDES footer below — publish only the middle.
  const parts = raw.split(/^─{5,}\s*$/m);
  if (parts.length >= 3) return parts[1].trim();
  return raw.trim();
}

export async function cmdPublishCarousel(id, { dryRun, captionFile } = {}) {
  const { token, igUserId } = requireEnv();
  if (!SITE_URL) {
    console.error('SITE_URL missing from .env — needed to build public media URLs.');
    process.exit(1);
  }
  const dir = path.join(SOCIAL_DIR, id);
  if (!fs.existsSync(dir)) {
    console.error(`Not staged: social/${id}/ — run the stage command first.`);
    process.exit(1);
  }

  const pngs = fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
  if (pngs.length === 0) {
    console.error(`No PNGs in social/${id}/.`);
    process.exit(1);
  }
  if (pngs.length > MAX_CAROUSEL_SLIDES) {
    console.error(`Instagram allows at most ${MAX_CAROUSEL_SLIDES} slides; found ${pngs.length}.`);
    process.exit(1);
  }

  const caption = readCaption(dir, captionFile);
  const urls = pngs.map((f) => `${SITE_URL}/social/${id}/${f}`);

  if (dryRun) {
    console.log('[dry-run] Would publish', pngs.length === 1 ? 'single image:' : `carousel of ${pngs.length}:`);
    for (const u of urls) console.log(`  ${u}`);
    console.log(`[dry-run] Caption (${caption.length} chars): ${caption.slice(0, 120)}...`);
    return;
  }

  console.log('Verifying media URLs are live...');
  for (const u of urls) await assertUrlReachable(u);

  let creationId;
  if (urls.length === 1) {
    console.log('Creating single-image container...');
    const container = await graphCall('POST', `/${igUserId}/media`, {
      image_url: urls[0],
      caption,
      access_token: token,
    });
    creationId = container.id;
  } else {
    console.log(`Creating ${urls.length} carousel item containers...`);
    const childIds = [];
    for (const u of urls) {
      const child = await graphCall('POST', `/${igUserId}/media`, {
        image_url: u,
        is_carousel_item: 'true',
        access_token: token,
      });
      childIds.push(child.id);
    }
    console.log('Creating carousel container...');
    const container = await graphCall('POST', `/${igUserId}/media`, {
      media_type: 'CAROUSEL',
      children: childIds.join(','),
      caption,
      access_token: token,
    });
    creationId = container.id;
  }

  console.log('Publishing...');
  const published = await graphCall('POST', `/${igUserId}/media_publish`, {
    creation_id: creationId,
    access_token: token,
  });
  console.log(`Published. IG media id: ${published.id}`);
}

/* ── publish: reel ─────────────────────────────────────────── */

async function waitForContainerReady(containerId, token) {
  const deadline = Date.now() + REEL_STATUS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = await graphCall('GET', `/${containerId}`, {
      fields: 'status_code,status',
      access_token: token,
    });
    if (status.status_code === 'FINISHED') return;
    if (status.status_code === 'ERROR') {
      throw new Error(`Video processing failed: ${status.status || 'no detail from API'}`);
    }
    console.log(`  processing (${status.status_code})...`);
    await new Promise((r) => setTimeout(r, REEL_STATUS_POLL_MS));
  }
  throw new Error('Timed out waiting for video processing (5 min). Check the container status later.');
}

async function cmdPublishReel({ videoUrl, captionFile, caption, dryRun }) {
  const { token, igUserId } = requireEnv();
  if (!videoUrl) {
    console.error('Missing --video-url <public mp4 url>.');
    process.exit(1);
  }
  let captionText = caption || '';
  if (captionFile) {
    const p = path.isAbsolute(captionFile) ? captionFile : path.join(__dirname, captionFile);
    if (!fs.existsSync(p)) {
      console.error(`Caption file not found: ${p}`);
      process.exit(1);
    }
    captionText = fs.readFileSync(p, 'utf8').trim();
  }

  if (dryRun) {
    console.log(`[dry-run] Would publish Reel from: ${videoUrl}`);
    console.log(`[dry-run] Caption (${captionText.length} chars): ${captionText.slice(0, 120)}...`);
    return;
  }

  console.log('Creating Reel container...');
  const container = await graphCall('POST', `/${igUserId}/media`, {
    media_type: 'REELS',
    video_url: videoUrl,
    caption: captionText,
    share_to_feed: 'true',
    access_token: token,
  });

  console.log('Waiting for Instagram to process the video...');
  await waitForContainerReady(container.id, token);

  console.log('Publishing...');
  const published = await graphCall('POST', `/${igUserId}/media_publish`, {
    creation_id: container.id,
    access_token: token,
  });
  console.log(`Published. IG media id: ${published.id}`);
}

/* ── CLI ───────────────────────────────────────────────────── */

function parseFlags(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') flags.dryRun = true;
    else if (argv[i] === '--video-url') flags.videoUrl = argv[++i];
    else if (argv[i] === '--caption-file') flags.captionFile = argv[++i];
    else if (argv[i] === '--caption') flags.caption = argv[++i];
    else flags._.push(argv[i]);
  }
  return flags;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);

  switch (command) {
    case 'check':
      await cmdCheck();
      break;
    case 'stage':
      if (!flags._[0]) {
        console.error('Usage: node post-to-instagram.mjs stage <carousel-folder>');
        process.exit(1);
      }
      cmdStage(flags._[0]);
      break;
    case 'publish-carousel':
      if (!flags._[0]) {
        console.error('Usage: node post-to-instagram.mjs publish-carousel <staged-id> [--caption-file <file>] [--dry-run]');
        process.exit(1);
      }
      await cmdPublishCarousel(flags._[0], flags);
      break;
    case 'publish-reel':
      await cmdPublishReel(flags);
      break;
    default:
      console.error('Commands: check | stage <dir> | publish-carousel <id> | publish-reel --video-url <url>');
      process.exit(1);
  }
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  main().catch((err) => {
    console.error(`\nFailed: ${err.message}`);
    process.exit(1);
  });
}
