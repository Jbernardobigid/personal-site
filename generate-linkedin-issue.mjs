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
 * Usage:
 *   node generate-linkedin-issue.mjs                 # uses post-meta.json, else newest post
 *   node generate-linkedin-issue.mjs <path-to-post>  # specific blog/posts/*.html
 *
 * Env:
 *   SITE_URL — public site origin (defaults to https://jorgebernardo.tech)
 */

import './load-env.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE_URL  = (process.env.SITE_URL || 'https://jorgebernardo.tech').replace(/\/$/, '');
const NEWSLETTER_NAME = 'A Interseção';
// Public subscribe link is a brand/marketing URL — always the live domain, never the
// Vercel preview that SITE_URL may point at. Overridable, but defaults to the brand domain.
const NEWSLETTER_URL = (process.env.NEWSLETTER_URL || 'https://jorgebernardo.tech/#newsletter');
const POSTS_DIR = path.join(__dirname, 'blog', 'posts');
const OUT_DIR   = path.join(__dirname, 'linkedin-newsletter');

function fail(msg) { console.error(`Error: ${msg}`); process.exit(1); }

/** Resolve which blog post to turn into an issue. */
function resolveSourcePost() {
  const argPath = process.argv[2];
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

function buildIssue({ postPath, meta }) {
  const html = fs.readFileSync(postPath, 'utf8');

  const title   = meta?.title   || stripTags(extract(html, /<h1 class="post-title">([\s\S]*?)<\/h1>/, 'title'));
  const excerpt = meta?.excerpt || stripTags(
    (html.match(/<meta name="description" content="([^"]*)"/) ||
     html.match(/<meta property="og:description" content="([^"]*)"/) || [, ''])[1]
  );
  const pillar  = (html.match(/<div class="post-pillar"[^>]*>([\s\S]*?)<\/div>/) || [, ''])[1].trim();
  const bodyInner = extract(html, /<article class="post-body"[^>]*>([\s\S]*?)<\/article>/, 'article body');

  const canonicalUrl = meta?.postUrl || `${SITE_URL}/blog/posts/${path.basename(postPath)}`;
  const subscribeUrl = NEWSLETTER_URL;

  // Self-contained, minimally styled so the rendered text pastes cleanly into
  // LinkedIn's editor. Brand colors kept subtle; LinkedIn strips most CSS anyway.
  const issueHtml = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<title>LinkedIn issue · ${escapeHtml(title)}</title>
<style>
  body { max-width: 680px; margin: 40px auto; padding: 0 20px;
         font: 17px/1.7 Georgia, 'Times New Roman', serif; color: #1e1a14; }
  .copy-hint { font: 13px/1.5 -apple-system, system-ui, sans-serif; color: #5e412d;
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
</style></head>
<body>
  <div class="copy-hint">Selecione tudo (Ctrl/Cmd+A), copie e cole no editor de artigo da newsletter do LinkedIn. Esta caixa não é copiada se você selecionar a partir do título.</div>

  <div class="masthead">${escapeHtml(NEWSLETTER_NAME)} · tecnologia, identidade e reinvenção</div>
  ${pillar ? `<div class="eyebrow">${escapeHtml(pillar)}</div>` : ''}
  <h1>${escapeHtml(title)}</h1>
  ${excerpt ? `<p class="lead">${escapeHtml(excerpt)}</p>` : ''}

  ${bodyInner}

  <div class="cta">
    <p><strong>Recebeu A Interseção pelo LinkedIn?</strong> Os próximos artigos chegam primeiro no email — sem algoritmo no meio, sem ruído.</p>
    <p>👉 <a href="${subscribeUrl}">Assine em jorgebernardo.tech</a></p>
  </div>
  <p class="source">Publicado originalmente em <a href="${canonicalUrl}">${canonicalUrl}</a></p>
</body></html>`;

  return { title, issueHtml, sourceName: path.basename(postPath) };
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                  .replace(/"/g, '&quot;');
}

function main() {
  const source = resolveSourcePost();
  const { title, issueHtml, sourceName } = buildIssue(source);

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, sourceName.replace(/\.html$/, '') + '-linkedin.html');
  fs.writeFileSync(outPath, issueHtml, 'utf8');

  console.log(`LinkedIn newsletter issue ready:\n  "${title}"\n  → ${outPath}\n`);
  console.log('Next: open that file in a browser, select all, copy, and paste into');
  console.log('LinkedIn → Write article → your newsletter. Formatting carries over.');
}

main();
