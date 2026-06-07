/**
 * prepare-video.mjs
 * Orchestrator for the n8n "Video — Build from latest post" workflow: build the
 * educational video for the newest blog post (or reuse the latest already-built
 * one), upload it to Vercel Blob (video/mp4), and email Jorge the link + caption.
 * Mirrors prepare-carousel.mjs. On-demand (no auto-schedule).
 *
 * Usage:
 *   node prepare-video.mjs                 (build + upload + email, then mark prepared)
 *   node prepare-video.mjs --no-broll      (procedural bg, no KIE cost)
 *   node prepare-video.mjs --skip-generate (deliver the most recent already-built video)
 *   node prepare-video.mjs --dry-run       (build/find, upload, but PRINT the email; don't send/mark)
 *   node prepare-video.mjs --force         (re-prepare even if this post was already done)
 */

import './load-env.mjs';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POSTS_DIR = path.join(__dirname, 'blog', 'posts');
const VIDEOS_DIR = path.join(__dirname, 'videos');
const LEDGER_PATH = path.join(__dirname, 'video-prepared.json');
const DAY1_ROOT = process.env.NEWSLETTER_REPO || 'C:/DevWork/AI Automation Society/Day 1';
const BLOB_UPLOAD = path.join(DAY1_ROOT, 'tools', 'blob_upload.mjs');
const NOTIFY_EMAIL = process.env.CAROUSEL_NOTIFY_EMAIL || 'jorge.mbernardo@gmail.com';
const FROM_EMAIL = process.env.NEWSLETTER_FROM || 'Jorge Bernardo <newsletter@jorgebernardo.tech>';

function fail(msg, detail = '') { console.log(JSON.stringify({ success: false, error: msg, detail })); process.exit(1); }

function newestPostStem() {
  const files = fs.readdirSync(POSTS_DIR).filter(f => f.endsWith('.html')).sort();
  if (!files.length) fail('no posts');
  return files[files.length - 1].replace(/\.html$/, '');
}

function loadLedger() {
  try { const l = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8')); return Array.isArray(l?.prepared) ? l : { prepared: [] }; }
  catch { return { prepared: [] }; }
}
function markPrepared(stem) {
  const l = loadLedger();
  if (!l.prepared.some(p => p.stem === stem)) { l.prepared.push({ stem, preparedAt: new Date().toISOString() }); fs.writeFileSync(LEDGER_PATH, JSON.stringify(l, null, 2), 'utf8'); }
}

function newestBuiltVideoDir() {
  if (!fs.existsSync(VIDEOS_DIR)) return null;
  const dirs = fs.readdirSync(VIDEOS_DIR)
    .map(d => path.join(VIDEOS_DIR, d))
    .filter(d => fs.existsSync(path.join(d, 'video.mp4')) && fs.existsSync(path.join(d, 'video-meta.json')));
  if (!dirs.length) return null;
  return dirs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

function buildVideo(extraArgs) {
  execFileSync('node', ['generate-video.mjs', ...extraArgs], { cwd: __dirname, stdio: 'inherit', timeout: 900000, env: process.env });
}

function uploadVideo(videoPath, slug) {
  const out = execFileSync('node', [BLOB_UPLOAD, videoPath, `video/${slug}.mp4`], { encoding: 'utf8', timeout: 180000 });
  const parsed = JSON.parse(out.trim().split('\n').pop());
  if (!parsed.success || !parsed.url) fail('blob upload failed', parsed.error);
  return parsed.url;
}

function buildEmail(meta, url) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!DOCTYPE html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#faf8f5;padding:24px;color:#1e1a14">
  <p style="font-family:monospace;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#a0714f;margin:0 0 8px">Vídeo pronto para postar</p>
  <h2 style="margin:0 0 8px;font-size:20px">${esc(meta.title)}</h2>
  <p style="color:#555;margin:0 0 16px">${meta.durationSec}s · 9:16 · voz PT-BR · b-roll + legendas + música. Baixe e poste no Instagram (Reels).</p>
  <p style="margin:0 0 22px"><a href="${esc(url)}" style="display:inline-block;background:#5e412d;color:#fff;text-decoration:none;padding:14px 28px;border-radius:6px;font-family:monospace;font-size:13px;letter-spacing:1px">▶ Assistir / baixar o vídeo</a></p>
  <p style="font-size:12px;color:#888;word-break:break-all;margin:0 0 22px">${esc(url)}</p>
  <p style="font-family:monospace;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#a0714f;margin:0 0 6px">Legenda</p>
  <pre style="white-space:pre-wrap;background:#fff;border:1px solid #e6e0d8;border-radius:8px;padding:16px;font-family:inherit;font-size:14px;line-height:1.6;margin:0">${esc(meta.caption)}</pre>
</body></html>`;
}

async function sendEmail(subject, html) {
  const key = process.env.RESEND_API_KEY;
  if (!key) fail('RESEND_API_KEY not set');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM_EMAIL, to: [NOTIFY_EMAIL], subject, html })
  });
  if (!res.ok) fail(`Resend failed (HTTP ${res.status})`, (await res.text()).slice(0, 300));
  return (await res.json()).id;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');
  const skipGenerate = args.includes('--skip-generate');

  const stem = newestPostStem();
  if (!force && !skipGenerate && loadLedger().prepared.some(p => p.stem === stem)) {
    console.log(JSON.stringify({ success: true, skipped: true, reason: 'already prepared', stem })); return;
  }

  let dir;
  if (skipGenerate) {
    dir = newestBuiltVideoDir();
    if (!dir) fail('no built video found (run without --skip-generate)');
    console.log(`Delivering existing: ${path.relative(__dirname, dir)}`);
  } else {
    const passthrough = [];
    if (args.includes('--no-broll')) passthrough.push('--no-broll');
    if (args.includes('--seconds')) passthrough.push('--seconds', args[args.indexOf('--seconds') + 1]);
    console.log('Building video...');
    buildVideo(passthrough);
    dir = newestBuiltVideoDir();
    if (!dir) fail('build finished but no video found');
  }

  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'video-meta.json'), 'utf8'));
  console.log(`Uploading to Blob...`);
  const url = uploadVideo(path.join(dir, 'video.mp4'), meta.slug);
  const subject = `🎬 Vídeo pronto: ${meta.title}`;

  if (dryRun) {
    console.log('\n--- DRY RUN: email NOT sent ---');
    console.log(`To: ${NOTIFY_EMAIL} | ${url}`);
  } else {
    const id = await sendEmail(subject, buildEmail(meta, url));
    markPrepared(stem);
    console.log(`Email sent (${id}); marked prepared.`);
  }
  console.log(JSON.stringify({ success: true, dryRun, stem, title: meta.title, durationSec: meta.durationSec, url }));
}

main().catch(e => fail('unexpected', String(e?.stack || e)));
