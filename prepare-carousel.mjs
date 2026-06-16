/**
 * prepare-carousel.mjs
 * One-shot orchestrator (for the n8n "Instagram — Build carousel" workflow): takes the
 * newest blog post, builds the Instagram carousel, uploads the slide PNGs to Vercel Blob,
 * and emails Jorge the public image links + the ready-to-paste caption. Jorge posts to
 * Instagram manually (no Meta Graph API). Mirrors the newsletter's build_from_latest_blog.py
 * pattern: deterministic logic in code, n8n just triggers it.
 *
 * Usage:
 *   node prepare-carousel.mjs                (build + upload + email, then mark prepared)
 *   node prepare-carousel.mjs --dry-run      (build + upload, but PRINT the email instead of sending; don't mark)
 *   node prepare-carousel.mjs --force        (re-prepare even if this post was already done)
 *
 * Requires (all already in .env): ANTHROPIC_API_KEY (carousel), RESEND_API_KEY (email),
 * and BLOB_READ_WRITE_TOKEN in the newsletter repo's .env (used by blob_upload.mjs).
 * Optional: CAROUSEL_NOTIFY_EMAIL (default jorge.mbernardo@gmail.com).
 *
 * IMPORTANT: passes the newest post file EXPLICITLY to generate-carousel.mjs, so it never
 * relies on the gitignored post-meta.json (which is not synced from the GitHub Actions cloud run).
 */

import './load-env.mjs';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POSTS_DIR    = path.join(__dirname, 'blog', 'posts');
const META_PATH    = path.join(__dirname, 'carousel-meta.json');
const LEDGER_PATH  = path.join(__dirname, 'carousel-prepared.json');
const DAY1_ROOT    = process.env.NEWSLETTER_REPO || 'C:/DevWork/AI Automation Society/Day 1';
const BLOB_UPLOAD  = path.join(DAY1_ROOT, 'tools', 'blob_upload.mjs');

const NOTIFY_EMAIL = process.env.CAROUSEL_NOTIFY_EMAIL || 'jorge.mbernardo@gmail.com';
const FROM_EMAIL   = process.env.NEWSLETTER_FROM || 'Jorge Bernardo <newsletter@jorgebernardo.tech>';

function fail(msg, detail = '') {
  console.log(JSON.stringify({ success: false, error: msg, detail }));
  process.exit(1);
}

/* ── Newest post + dedup ledger ──────────────────────────── */

function newestPost() {
  if (!fs.existsSync(POSTS_DIR)) fail(`posts dir not found: ${POSTS_DIR}`);
  const files = fs.readdirSync(POSTS_DIR).filter(f => f.endsWith('.html')).sort();
  if (files.length === 0) fail('no .html posts found');
  const file = files[files.length - 1];               // ISO-date prefix → lexical sort = newest last
  const html = fs.readFileSync(path.join(POSTS_DIR, file), 'utf8');
  const title = (html.match(/<title>([^<]+)<\/title>/) ?? [])[1]?.replace(' — Jorge Bernardo', '').trim() ?? file;
  return { file, stem: file.replace(/\.html$/, ''), abs: path.join(POSTS_DIR, file), title };
}

function loadLedger() {
  try {
    const l = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
    return Array.isArray(l?.prepared) ? l : { prepared: [] };
  } catch { return { prepared: [] }; }
}

function markPrepared(stem) {
  const l = loadLedger();
  if (!l.prepared.some(p => p.stem === stem)) {
    l.prepared.push({ stem, preparedAt: new Date().toISOString() });
    fs.writeFileSync(LEDGER_PATH, JSON.stringify(l, null, 2), 'utf8');
  }
}

/* ── Steps ───────────────────────────────────────────────── */

function buildCarousel(postAbs) {
  // Pass the post file explicitly → bypasses the stale/gitignored post-meta.json.
  execFileSync('node', ['generate-carousel.mjs', postAbs], {
    cwd: __dirname, stdio: 'inherit', timeout: 300000, env: process.env
  });
  if (!fs.existsSync(META_PATH)) fail('carousel-meta.json not produced');
  return JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
}

function uploadSlides(slides, folder) {
  const urls = [];
  slides.forEach((slide, i) => {
    const local = slide.replace(/\//g, path.sep);
    if (!fs.existsSync(local)) { console.warn(`  ! slide missing: ${local}`); return; }
    try {
      const out = execFileSync('node', [BLOB_UPLOAD, local, `${folder}/slide-${i + 1}.png`], {
        encoding: 'utf8', timeout: 60000
      });
      const parsed = JSON.parse(out.trim().split('\n').pop());
      if (parsed.success && parsed.url) urls.push(parsed.url);
      else console.warn(`  ! blob upload failed for slide ${i + 1}: ${parsed.error}`);
    } catch (e) {
      console.warn(`  ! blob upload error for slide ${i + 1}: ${e.message}`);
    }
  });
  return urls;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildEmail(title, caption, urls) {
  const imgs = urls.map((u, i) =>
    `<a href="${encodeURI(u)}"><img src="${encodeURI(u)}" alt="slide ${i + 1}" width="260" style="border-radius:8px;margin:0 8px 8px 0;border:1px solid #ddd"></a>`
  ).join('\n');
  const captionHtml = escapeHtml(caption);
  return `<!DOCTYPE html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#faf8f5;padding:24px;color:#1e1a14">
  <p style="font-family:monospace;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#a0714f;margin:0 0 8px">Carrossel pronto para postar</p>
  <h2 style="margin:0 0 16px;font-size:20px">${escapeHtml(title)}</h2>
  <p style="color:#555;margin:0 0 16px">${urls.length} slide(s). Salve as imagens no celular e poste no Instagram. Legenda abaixo (toque para copiar).</p>
  <div style="margin-bottom:20px">${imgs}</div>
  <p style="font-family:monospace;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#a0714f;margin:0 0 6px">Legenda</p>
  <pre style="white-space:pre-wrap;background:#fff;border:1px solid #e6e0d8;border-radius:8px;padding:16px;font-family:inherit;font-size:14px;line-height:1.6;margin:0">${captionHtml}</pre>
</body></html>`;
}

async function sendEmail(subject, html) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY not set');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM_EMAIL, to: [NOTIFY_EMAIL], subject, html })
  });
  if (!res.ok) throw new Error(`Resend send failed (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.id;
}

/* ── Main ────────────────────────────────────────────────── */

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');

  const post = newestPost();
  if (!force && loadLedger().prepared.some(p => p.stem === post.stem)) {
    console.log(JSON.stringify({ success: true, skipped: true, reason: 'already prepared', stem: post.stem }));
    return;
  }

  console.log(`Preparing carousel for: ${post.title} (${post.file})`);
  const meta = buildCarousel(post.abs);
  const folder = `instagram/${meta.date}-${meta.slug}`;
  console.log(`Uploading ${meta.slides.length} slide(s) to Blob...`);
  const urls = uploadSlides(meta.slides, folder);
  if (urls.length === 0) fail('no slides uploaded to Blob');

  const subject = `📸 Carrossel pronto: ${post.title}`;
  const html = buildEmail(post.title, meta.caption, urls);

  let emailId = null;
  let emailError = null;
  if (dryRun) {
    console.log('\n--- DRY RUN: email NOT sent ---');
    console.log(`To: ${NOTIFY_EMAIL} | Subject: ${subject}`);
    console.log(`Blob URLs:\n${urls.join('\n')}`);
  } else {
    // The carousel is built and the slides are uploaded — the expensive,
    // meaningful work is done. Record it NOW so a transient email failure can't
    // make the 8h schedule re-prepare (and re-queue) this same post forever.
    markPrepared(post.stem);
    try {
      emailId = await sendEmail(subject, html);
      console.log(`Email sent (${emailId}); marked prepared.`);
    } catch (err) {
      emailError = String(err?.message || err);
      console.warn(`Marked prepared, but email send failed (non-fatal): ${emailError}`);
    }
  }

  console.log(JSON.stringify({
    success: true, dryRun, stem: post.stem, title: post.title,
    slides: urls.length, blobUrls: urls, emailId, emailError
  }));
}

main().catch(err => fail('unexpected error', String(err?.stack || err)));
