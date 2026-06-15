/**
 * generate-linkedin-issue.mjs
 * Turns a blog post into a paste-ready LinkedIn *newsletter* issue.
 *
 * LinkedIn newsletter articles cannot be published via the public member API,
 * so this produces a self-contained HTML file. Open it in a browser, select
 * all, copy, and paste into LinkedIn's article editor — headings, bold, links
 * and blockquotes carry over. Each issue funnels readers to the OWNED email
 * list (Resend) via a subscribe CTA, with a canonical link back to the site.
 *
 * With --email it also emails the rendered issue (inline preview + .html
 * attachment) via Resend, so you can build it from anywhere (e.g. an n8n
 * webhook on the VPS) and just paste from your inbox.
 *
 * Usage:
 *   node generate-linkedin-issue.mjs                 # uses post-meta.json, else newest post
 *   node generate-linkedin-issue.mjs <path-to-post>  # specific blog/posts/*.html
 *   node generate-linkedin-issue.mjs --email         # also email the issue
 *
 * Env:
 *   PUBLIC_SITE_URL         — brand origin for the canonical link (defaults to https://www.jorgebernardo.tech)
 *   NEWSLETTER_URL          — subscribe link (defaults to www.jorgebernardo.tech/#newsletter)
 *   RESEND_API_KEY          — required for --email
 *   NEWSLETTER_FROM         — From header (defaults to Jorge Bernardo <newsletter@jorgebernardo.tech>)
 *   CAROUSEL_NOTIFY_EMAIL   — recipient (defaults to jorge.mbernardo@gmail.com)
 */

import './load-env.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NEWSLETTER_NAME = 'A Interseção';
// Public subscribe link is a brand/marketing URL — always the live domain, never the
// Vercel preview that SITE_URL may point at. Overridable, but defaults to the brand domain.
const NEWSLETTER_URL = (process.env.NEWSLETTER_URL || 'https://www.jorgebernardo.tech/#newsletter');
// Public brand origin for the "publicado originalmente em" canonical link. www is the
// non-redirecting host (apex 307s to www). Independent of SITE_URL by design.
const PUBLIC_SITE_URL = (process.env.PUBLIC_SITE_URL || 'https://www.jorgebernardo.tech').replace(/\/$/, '');
const POSTS_DIR = path.join(__dirname, 'blog', 'posts');
const OUT_DIR   = path.join(__dirname, 'linkedin-newsletter');

// Email delivery (mirrors prepare-video.mjs).
const NOTIFY_EMAIL = process.env.CAROUSEL_NOTIFY_EMAIL || 'jorge.mbernardo@gmail.com';
const FROM_EMAIL   = process.env.NEWSLETTER_FROM || 'Jorge Bernardo <newsletter@jorgebernardo.tech>';

const SUBTITLE = 'tecnologia, identidade e reinvenção';

function fail(msg) {
  // Machine-readable so an n8n SSH node sees a clean failure line.
  console.log(JSON.stringify({ success: false, error: msg }));
  process.exit(1);
}

/** Resolve which blog post to turn into an issue. */
function resolveSourcePost(argPath) {
  if (argPath) {
    const abs = path.resolve(argPath);
    if (!abs.startsWith(POSTS_DIR + path.sep)) fail(`post must live under ${POSTS_DIR}`);
    if (!fs.existsSync(abs)) fail(`post not found: ${abs}`);
    return { postPath: abs, meta: null };
  }

  const metaPath = path.join(__dirname, 'post-meta.json');
  if (fs.existsSync(metaPath)) {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const filename = meta.postUrl ? meta.postUrl.split('/').pop() : null;
    const postPath = filename ? path.join(POSTS_DIR, filename) : null;
    if (postPath && fs.existsSync(postPath)) return { postPath, meta };
  }

  if (!fs.existsSync(POSTS_DIR)) fail(`no posts directory at ${POSTS_DIR}`);
  const newest = fs.readdirSync(POSTS_DIR)
    .filter(f => f.endsWith('.html'))
    .map(f => ({ f, m: fs.statSync(path.join(POSTS_DIR, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)[0];
  if (!newest) fail(`no blog posts found in ${POSTS_DIR}`);
  return { postPath: path.join(POSTS_DIR, newest.f), meta: null };
}

function extract(html, re, label) {
  const m = html.match(re);
  if (!m) fail(`could not extract ${label} from post HTML`);
  return m[1].trim();
}

function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

/** Strip tags for plain-text fields (title/excerpt) only. */
function stripTags(s) { return decodeEntities(s.replace(/<[^>]+>/g, '')).trim(); }

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                  .replace(/"/g, '&quot;');
}

const STYLE = `<style>
  body { max-width: 680px; margin: 40px auto; padding: 0 20px;
         font: 17px/1.7 Georgia, 'Times New Roman', serif; color: #1e1a14; }
  .banner { font: 13px/1.5 -apple-system, system-ui, sans-serif; color: #5e412d;
            background: #f3ede6; border: 1px solid #d9d9d9; border-radius: 8px;
            padding: 12px 16px; margin-bottom: 32px;
            -webkit-user-select: none; user-select: none; }
  .masthead { font: 600 14px/1 'DM Mono', ui-monospace, monospace; letter-spacing: .14em;
              text-transform: uppercase; color: #5e412d; padding-bottom: 16px;
              border-bottom: 1px solid #d9d9d9; margin-bottom: 24px; }
  .eyebrow { font: 600 13px/1 -apple-system, system-ui, sans-serif; letter-spacing: .08em;
             text-transform: uppercase; color: #a0714f; margin-bottom: 8px; }
  h1 { font-size: 30px; line-height: 1.2; letter-spacing: -.02em; margin: 4px 0 20px; }
  h2 { font-size: 22px; line-height: 1.3; margin: 32px 0 12px; }
  .lead { font-size: 19px; color: #3a342b; font-style: italic; margin-bottom: 28px; }
  blockquote { border-left: 3px solid #a0714f; margin: 24px 0; padding: 4px 0 4px 20px;
               font-style: italic; color: #3a342b; }
  .cta { margin: 40px 0 8px; padding: 20px 24px; border: 1px solid #d9d9d9;
         border-radius: 12px; background: #f3ede6;
         font: 16px/1.6 -apple-system, system-ui, sans-serif; }
  .cta a { color: #1c314a; font-weight: 600; }
  .source { font: 14px/1.6 -apple-system, system-ui, sans-serif; color: #6b6357; margin-top: 24px; }
</style>`;

const BROWSER_BANNER = `<div class="banner">Selecione tudo (Ctrl/Cmd+A), copie e cole no editor de artigo da newsletter do LinkedIn. Esta caixa não é copiada se você selecionar a partir do título.</div>`;
const EMAIL_BANNER = `<div class="banner">📩 <strong>A Interseção</strong> — para colar no LinkedIn com a formatação intacta, abra o anexo <code>.html</code> no navegador, selecione tudo e copie. A prévia abaixo é só para conferência.</div>`;

/** Extract the reusable issue content (everything that should be pasted). */
function buildIssue({ postPath, meta }) {
  const html = fs.readFileSync(postPath, 'utf8');

  const title   = meta?.title   || stripTags(extract(html, /<h1 class="post-title">([\s\S]*?)<\/h1>/, 'title'));
  const excerpt = meta?.excerpt || stripTags(
    (html.match(/<meta name="description" content="([^"]*)"/) ||
     html.match(/<meta property="og:description" content="([^"]*)"/) || [, ''])[1]
  );
  const pillar  = (html.match(/<div class="post-pillar"[^>]*>([\s\S]*?)<\/div>/) || [, ''])[1].trim();
  const bodyInner = extract(html, /<article class="post-body"[^>]*>([\s\S]*?)<\/article>/, 'article body');

  // Force the public brand origin; keep the post's path (basename === slug in generate-post.mjs).
  const slugPath = (() => {
    if (meta?.postUrl) { try { return new URL(meta.postUrl).pathname; } catch { /* fall through */ } }
    return `/blog/posts/${path.basename(postPath)}`;
  })();
  const canonicalUrl = `${PUBLIC_SITE_URL}${slugPath}`;

  const content = `
  <div class="masthead">${escapeHtml(NEWSLETTER_NAME)} · ${SUBTITLE}</div>
  ${pillar ? `<div class="eyebrow">${escapeHtml(pillar)}</div>` : ''}
  <h1>${escapeHtml(title)}</h1>
  ${excerpt ? `<p class="lead">${escapeHtml(excerpt)}</p>` : ''}

  ${bodyInner}

  <div class="cta">
    <p><strong>Recebeu A Interseção pelo LinkedIn?</strong> Os próximos artigos chegam primeiro no email — sem algoritmo no meio, sem ruído.</p>
    <p>👉 <a href="${NEWSLETTER_URL}">Assine em jorgebernardo.tech</a></p>
  </div>
  <p class="source">Publicado originalmente em <a href="${canonicalUrl}">${canonicalUrl}</a></p>`;

  return { title, content, sourceName: path.basename(postPath) };
}

function wrapDoc(title, banner, content) {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<title>${escapeHtml(NEWSLETTER_NAME)} · ${escapeHtml(title)}</title>
${STYLE}</head>
<body>
  ${banner}
${content}
</body></html>`;
}

async function sendEmail(subject, html, attachment) {
  const key = process.env.RESEND_API_KEY;
  if (!key) fail('RESEND_API_KEY not set (required for --email)');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM_EMAIL, to: [NOTIFY_EMAIL], subject, html, attachments: [attachment] })
  });
  if (!res.ok) fail(`Resend failed (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`);
  return (await res.json()).id;
}

async function main() {
  const args = process.argv.slice(2);
  const doEmail = args.includes('--email');
  const positional = args.find(a => !a.startsWith('--'));

  const source = resolveSourcePost(positional);
  const { title, content, sourceName } = buildIssue(source);

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const fileName = sourceName.replace(/\.html$/, '') + '-linkedin.html';
  const outPath = path.join(OUT_DIR, fileName);
  const browserHtml = wrapDoc(title, BROWSER_BANNER, content);
  fs.writeFileSync(outPath, browserHtml, 'utf8');

  let emailId = null;
  if (doEmail) {
    const emailHtml = wrapDoc(title, EMAIL_BANNER, content);
    const attachment = { filename: fileName, content: Buffer.from(browserHtml, 'utf8').toString('base64') };
    emailId = await sendEmail(`📩 A Interseção — pronto para postar: ${title}`, emailHtml, attachment);
  }

  // Human log to stderr, machine status to stdout (clean for n8n).
  console.error(`LinkedIn issue ready: "${title}" → ${outPath}${emailId ? ` | emailed (${emailId})` : ''}`);
  console.log(JSON.stringify({ success: true, title, file: outPath, emailed: doEmail, emailId }));
}

main().catch(err => fail(err?.message || String(err)));
