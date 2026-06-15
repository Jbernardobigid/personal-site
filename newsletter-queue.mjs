/**
 * newsletter-queue.mjs  (run on the VPS by the "A Interseção — Build & Queue" workflow)
 *
 * After the Python engine builds the newsletter (build_from_latest_blog.py), this:
 *   1. reads the newest build in $NEWSLETTER_DIR/.tmp (email-safe HTML + newsletter.json),
 *   2. builds the LinkedIn-paste HTML from the SAME newsletter content (one source, two channels),
 *   3. emails Jorge: the email preview (what subscribers get) + LinkedIn-paste + cover image,
 *   4. creates a Notion "Newsletter Approvals" row (Status=Pending) to gate the broadcast.
 *
 * Dedupe via newsletter-queue-state.json so re-runs don't re-queue the same issue.
 *
 * Env: NEWSLETTER_DIR (engine repo root), NOTION_API_KEY, NOTION_NEWSLETTER_DB_ID,
 *      RESEND_API_KEY, NEWSLETTER_FROM, CAROUSEL_NOTIFY_EMAIL, NEWSLETTER_URL, PUBLIC_SITE_URL
 * Flags: --force (re-queue even if handled), --slug <stem> (target a specific build)
 */

import './load-env.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createPage, queryDatabase, prop } from './notion-api.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NEWSLETTER_DIR = process.env.NEWSLETTER_DIR || path.join(__dirname, '..', 'newsletter');
const TMP_DIR = path.join(NEWSLETTER_DIR, '.tmp');
const OUT_DIR = path.join(__dirname, 'linkedin-newsletter');
const STATE_PATH = path.join(__dirname, 'newsletter-queue-state.json');

const NEWSLETTER_NAME = 'A Interseção';
const SUBTITLE = 'tecnologia, identidade e reinvenção';
const NEWSLETTER_URL = process.env.NEWSLETTER_URL || 'https://www.jorgebernardo.tech/#newsletter';
const PUBLIC_SITE_URL = (process.env.PUBLIC_SITE_URL || 'https://www.jorgebernardo.tech').replace(/\/$/, '');
const NOTIFY_EMAIL = process.env.CAROUSEL_NOTIFY_EMAIL || 'jorge.mbernardo@gmail.com';
const FROM_EMAIL = process.env.NEWSLETTER_FROM || 'Jorge Bernardo <newsletter@jorgebernardo.tech>';
const DB_ID = process.env.NOTION_NEWSLETTER_DB_ID;

function out(obj) { console.log(JSON.stringify(obj)); }
function fail(msg) { out({ success: false, error: msg }); process.exit(1); }

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return { handled: [] }; }
}
function writeState(s) { fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2), 'utf8'); }

/** Newest build = newest *_manifest.json in .tmp (or a specific --slug). */
function resolveBuild(slugArg) {
  if (!fs.existsSync(TMP_DIR)) fail(`newsletter .tmp not found at ${TMP_DIR}`);
  if (slugArg) {
    const m = path.join(TMP_DIR, `${slugArg}_manifest.json`);
    if (!fs.existsSync(m)) fail(`no manifest for slug ${slugArg}`);
    return m;
  }
  const manifests = fs.readdirSync(TMP_DIR)
    .filter(f => f.endsWith('_manifest.json'))
    .map(f => ({ f, m: fs.statSync(path.join(TMP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  if (!manifests.length) fail(`no newsletter builds in ${TMP_DIR}`);
  return path.join(TMP_DIR, manifests[0].f);
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const STYLE = `<style>
  body { max-width: 680px; margin: 40px auto; padding: 0 20px;
         font: 17px/1.7 Georgia, 'Times New Roman', serif; color: #1e1a14; }
  .banner { font: 13px/1.5 -apple-system, system-ui, sans-serif; color: #5e412d;
            background: #f3ede6; border: 1px solid #d9d9d9; border-radius: 8px;
            padding: 12px 16px; margin-bottom: 32px; -webkit-user-select: none; user-select: none; }
  .masthead { font: 600 14px/1 'DM Mono', ui-monospace, monospace; letter-spacing: .14em;
              text-transform: uppercase; color: #5e412d; padding-bottom: 16px;
              border-bottom: 1px solid #d9d9d9; margin-bottom: 24px; }
  h1 { font-size: 30px; line-height: 1.2; letter-spacing: -.02em; margin: 4px 0 20px; }
  h2 { font-size: 22px; line-height: 1.3; margin: 32px 0 12px; }
  .lead { font-size: 19px; color: #3a342b; font-style: italic; margin-bottom: 28px; }
  blockquote { border-left: 3px solid #a0714f; margin: 24px 0; padding: 4px 0 4px 20px;
               font-style: italic; color: #3a342b; }
  .cta { margin: 40px 0 8px; padding: 20px 24px; border: 1px solid #d9d9d9; border-radius: 12px;
         background: #f3ede6; font: 16px/1.6 -apple-system, system-ui, sans-serif; }
  .cta a { color: #1c314a; font-weight: 600; }
  .source { font: 14px/1.6 -apple-system, system-ui, sans-serif; color: #6b6357; margin-top: 24px; }
</style>`;

/** LinkedIn-paste HTML from the newsletter content (the single source). */
function buildLinkedInPaste(nl, slug) {
  const canonicalUrl = `${PUBLIC_SITE_URL}/blog/posts/${slug}.html`;
  const sections = (nl.sections || [])
    .map(s => `<h2>${escapeHtml(s.heading)}</h2>\n${s.body}`).join('\n');
  const content = `
  <div class="masthead">${escapeHtml(NEWSLETTER_NAME)} · ${SUBTITLE}</div>
  <h1>${escapeHtml(nl.title)}</h1>
  ${nl.intro ? `<p class="lead">${escapeHtml(nl.intro)}</p>` : ''}
  ${nl.nut_graf ? `<p>${escapeHtml(nl.nut_graf)}</p>` : ''}
  ${sections}
  ${nl.blockquote ? `<blockquote><p>${escapeHtml(nl.blockquote)}</p></blockquote>` : ''}
  ${nl.close ? `<p>${escapeHtml(nl.close)}</p>` : ''}
  <div class="cta">
    <p><strong>Recebeu A Interseção pelo LinkedIn?</strong> Os próximos artigos chegam primeiro no email — sem algoritmo no meio, sem ruído.</p>
    <p>👉 <a href="${NEWSLETTER_URL}">Assine em jorgebernardo.tech</a></p>
  </div>
  <p class="source">Publicado originalmente em <a href="${canonicalUrl}">${canonicalUrl}</a></p>`;
  const banner = `<div class="banner">Abra este arquivo no navegador, selecione tudo (Ctrl/Cmd+A), copie e cole no editor de artigo do LinkedIn.</div>`;
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>${escapeHtml(NEWSLETTER_NAME)} · ${escapeHtml(nl.title)}</title>
${STYLE}</head>
<body>
  ${banner}
${content}
</body></html>`;
}

async function sendEmail(subject, html, attachments) {
  const key = process.env.RESEND_API_KEY;
  if (!key) fail('RESEND_API_KEY not set');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM_EMAIL, to: [NOTIFY_EMAIL], subject, html, attachments })
  });
  if (!res.ok) fail(`Resend failed (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`);
  return (await res.json()).id;
}

async function main() {
  if (!DB_ID) fail('NOTION_NEWSLETTER_DB_ID not set');
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const slugArg = args.includes('--slug') ? args[args.indexOf('--slug') + 1] : null;

  const manifestPath = resolveBuild(slugArg);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const slug = manifest.slug;

  const state = readState();
  if (!force && state.handled.includes(slug)) {
    out({ success: true, skipped: true, reason: 'already queued', slug });
    return;
  }

  const builtHtmlPath = path.join(NEWSLETTER_DIR, manifest.html_path);
  const nlJsonPath = path.join(TMP_DIR, `${slug}_newsletter.json`);
  if (!fs.existsSync(builtHtmlPath)) fail(`built HTML missing: ${builtHtmlPath}`);
  if (!fs.existsSync(nlJsonPath)) fail(`newsletter.json missing: ${nlJsonPath}`);
  const nl = JSON.parse(fs.readFileSync(nlJsonPath, 'utf8'));

  // 1. LinkedIn paste from the same content.
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const liPath = path.join(OUT_DIR, `${slug}-linkedin.html`);
  const liHtml = buildLinkedInPaste(nl, slug);
  fs.writeFileSync(liPath, liHtml, 'utf8');

  // 2. Email: preview (the broadcast itself) + LinkedIn paste + cover image.
  const attachments = [{ filename: `linkedin-${slug}.html`, content: Buffer.from(liHtml, 'utf8').toString('base64') }];
  const coverPath = path.join(__dirname, 'blog', 'posts', 'images', `${slug}.png`);
  if (fs.existsSync(coverPath)) {
    attachments.push({ filename: `cover-${slug}.png`, content: fs.readFileSync(coverPath).toString('base64') });
  }
  const previewBanner = `<div style="background:#f3ede6;border:1px solid #d9d9d9;border-radius:8px;padding:12px 16px;margin:16px;font:14px/1.5 -apple-system,sans-serif;color:#5e412d">✅ <strong>A Interseção</strong> — prévia do email para a lista. Aprove no Notion para enviar. 📋 Para o LinkedIn: anexo <code>linkedin-*.html</code> + a imagem de capa anexa.</div>`;
  const previewHtml = fs.readFileSync(builtHtmlPath, 'utf8').replace(/(<body[^>]*>)/i, `$1${previewBanner}`);
  const emailId = await sendEmail(`📰 A Interseção — revisar e aprovar: ${manifest.subject}`, previewHtml, attachments);

  // 3. Notion Pending row.
  const properties = {
    Name: prop.title(slug),
    Status: prop.select('Pending'),
    Subject: prop.richText(manifest.subject || nl.title || slug),
    Preview: prop.richText(manifest.preview_text || nl.preview_text || ''),
    'Source Post': prop.url(`${PUBLIC_SITE_URL}/blog/posts/${slug}.html`),
    Notes: prop.richText('Revise a prévia no email. Aprove definindo Status = "Approved" para enviar à lista.'),
  };
  const dateMatch = /^(\d{4}-\d{2}-\d{2})/.exec(slug);
  if (dateMatch) properties['Built At'] = prop.date(dateMatch[1]);
  if (nl.hero_image_url) properties.Cover = prop.files([nl.hero_image_url]);
  await createPage(DB_ID, properties);

  state.handled.push(slug);
  writeState(state);
  out({ success: true, slug, subject: manifest.subject, emailId, linkedinPaste: liPath, cover: fs.existsSync(coverPath) });
}

main().catch(err => fail(err?.message || String(err)));
