/**
 * generate-post.mjs
 * Generates a blog post for Jorge Bernardo's site using the Claude API.
 * Rotates through 7 topic pillars, writes the post HTML, updates blog/index.html,
 * regenerates sitemap.xml, and regenerates robots.txt.
 *
 * Usage:
 *   node generate-post.mjs
 *   node generate-post.mjs --with-signals        (ground the post in a real recent news signal + research)
 *   node generate-post.mjs --pillar cycling      (force specific pillar)
 *   node generate-post.mjs --dry-run             (generate but don't write files)
 *
 * Requires: ANTHROPIC_API_KEY environment variable
 * Optional: OPENAI_API_KEY (OG image + research synthesis), TAVILY_API_KEY (--with-signals research),
 *           SITE_URL environment variable (defaults to placeholder — set in GitHub secrets)
 */

import './load-env.mjs';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { fileURLToPath } from 'url';
import { generatePostImage } from './generate-image.mjs';
import { selectSignal, recordUsedSignal } from './signals.mjs';
import { researchTopic, deriveResearchQuery } from './research.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BLOG_DIR    = path.join(__dirname, 'blog');
const POSTS_DIR   = path.join(BLOG_DIR, 'posts');
const IMAGES_DIR  = path.join(POSTS_DIR, 'images');
const RESEARCH_DIR = path.join(POSTS_DIR, 'research');
const INDEX_FILE = path.join(BLOG_DIR, 'index.html');
const SITEMAP    = path.join(__dirname, 'sitemap.xml');
const ROBOTS     = path.join(__dirname, 'robots.txt');
const FEED       = path.join(__dirname, 'feed.xml');

// Live canonical host is www (apex jorgebernardo.tech 307-redirects to www). Override with
// a SITE_URL env/secret if the primary domain changes; default targets the non-redirecting host.
const SITE_URL = (process.env.SITE_URL || 'https://www.jorgebernardo.tech').replace(/\/$/, '');

function sanitizeEmDashes(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/ — /g, ', ').replace(/— /g, ', ').replace(/ —/g, ',').replace(/—/g, ',');
}

const PILLARS = [
  {
    id: 'black-identity',
    label: 'Identidade Negra',
    description: 'Black identity and the Afro-Brazilian experience, Black beauty and excellence, representation and ancestry, belonging, navigating predominantly white professional spaces as a Black man, identity as a source of strength and purpose'
  },
  {
    id: 'cycling',
    label: 'Ciclismo',
    description: 'Cycling as identity and activism, Black cyclists in Brazil, diversity in cycling culture, urban cycling, endurance and discipline, sport as political act'
  },
  {
    id: 'technology',
    label: 'Tecnologia',
    description: 'Technology and its human impact, AI and data security, privacy engineering, AI governance, how technology reshapes work and society, staying current with emerging tech, tech applied to human performance'
  },
  {
    id: 'entrepreneurship',
    label: 'Empreendedorismo',
    description: 'Black entrepreneurship in Brazil, Afro-Brazilian business, racial equity in business, building ventures with cultural identity, community-driven ventures, purpose-driven business'
  },
  {
    id: 'fatherhood',
    label: 'Paternidade',
    description: 'Fatherhood and raising children with intention, passing on identity and values, being present, balancing family and career, what fatherhood teaches about leadership and patience, legacy and the next generation'
  },
  {
    id: 'learning',
    label: 'Aprendizado',
    description: 'Lifelong learning and education, the discipline of studying while working, curiosity as a habit, teaching and learning, a growth mindset, reinventing your skill set'
  },
  {
    id: 'career-growth',
    label: 'Carreira após os 40',
    description: 'Career growth after 40, reinvention in midlife, building a meaningful career on your own terms, what years of experience teach, the advantages of experience, ambition with balance, mentorship, defining success beyond titles'
  }
];

const JORGE_CONTEXT = `
IDENTITY & VOICE:
- Black Brazilian man. Cyclist. Builder. Activist.
- Speaks Portuguese, English, and Spanish.
- Believes aesthetics and strategy are inseparable.
- Personal brand tagline: "Quando a estética encontra a estratégia, as pessoas não conseguem deixar de notar."
- Writes in Brazilian Portuguese.

BACKGROUND (context only, NOT subject matter):
- Works in data security and AI governance; has 15+ years in enterprise tech; founded an Afro-Brazilian cycling project; studies AI/ML; is a father.
- This résumé is background for tone and perspective only. Do NOT name his employers or ventures, recite his job history, or make the post about his career or companies unless one fact is truly essential to the point being made. Most posts should not mention any of it.
`;

/* ── Pillar rotation ─────────────────────────────────────── */

function getNextPillar() {
  if (!fs.existsSync(POSTS_DIR)) return PILLARS[0];
  const files = fs.readdirSync(POSTS_DIR).filter(f => f.endsWith('.html'));
  if (files.length === 0) return PILLARS[0];

  const pillarCounts = Object.fromEntries(PILLARS.map(p => [p.id, 0]));
  for (const file of files) {
    const content = fs.readFileSync(path.join(POSTS_DIR, file), 'utf8');
    const match = content.match(/data-pillar="([^"]+)"/);
    if (match && pillarCounts[match[1]] !== undefined) pillarCounts[match[1]]++;
  }
  return PILLARS.reduce((least, p) => pillarCounts[p.id] < pillarCounts[least.id] ? p : least);
}

/* ── Recent-post memory (anti-repetition) ────────────────── */

// 20, not 10: at a post every two days a 10-post window only reaches back three weeks,
// and the repeats that prompted this ("depois dos 40", "pedalar enquanto negro") recur on
// a scale of months. Twenty titles plus excerpts cost well under a thousand tokens.
const RECENT_POSTS_WINDOW = 20;

/**
 * The last N posts, newest first, as {date, pillar, title, excerpt}.
 *
 * Fed to the writer as an explicit "do not repeat these" block. The signal feed is
 * genuinely fresh, but nothing downstream used to tell the model what it had just
 * published, so the same angles and the same title shapes kept coming round: "o que X
 * revela sobre Y" three times in thirty posts, "depois dos 40 / recomeçar" four times.
 * Filenames are date-prefixed, so a reverse name sort is a reverse chronological sort.
 */
function getRecentPosts(limit = RECENT_POSTS_WINDOW) {
  if (!fs.existsSync(POSTS_DIR)) return [];
  return fs.readdirSync(POSTS_DIR)
    .filter(f => f.endsWith('.html'))
    .sort()
    .reverse()
    .slice(0, limit)
    .map(filename => {
      let html = '';
      try { html = fs.readFileSync(path.join(POSTS_DIR, filename), 'utf8'); } catch { return null; }
      const pillarMatch = html.match(/data-pillar="([^"]+)"/);
      return {
        date: (filename.match(/^(\d{4}-\d{2}-\d{2})/) || [, ''])[1],
        pillar: pillarMatch ? pillarMatch[1] : '',
        title: readEditorialTitle(html),
        excerpt: readMetaTag(html, 'og:description')
      };
    })
    .filter(p => p && p.title);
}

/**
 * The "already published, do not repeat" prompt block. Empty when there is no history.
 *
 * Two tiers, because they catch different failures. The recent window carries excerpts so
 * the model can judge whether a THESIS is already taken; the full archive carries titles
 * only, which is cheap enough to include in its entirety and is what stops a headline from
 * coming back around months later. A 20-post window alone let "Pedalar enquanto negro"
 * regenerate almost verbatim from a post 29 editions back.
 */
function buildRecentPostsBlock(recent, archiveTitles = []) {
  if (!recent.length) return '';
  const list = recent
    .map(p => `- [${p.pillar}] ${decodeHtmlEntities(p.title)}${p.excerpt ? ` (${decodeHtmlEntities(p.excerpt)})` : ''}`)
    .join('\n');

  const recentTitleSet = new Set(recent.map(p => decodeHtmlEntities(p.title)));
  const older = archiveTitles.map(decodeHtmlEntities).filter(t => !recentTitleSet.has(t));
  const archiveBlock = older.length ? `

TÍTULOS JÁ PUBLICADOS ANTES DISSO (arquivo completo, não repita nem reformule nenhum):
${older.map(t => `- ${t}`).join('\n')}` : '';

  return `

JÁ PUBLICADO NAS ÚLTIMAS ${recent.length} EDIÇÕES (evite repetir):
${list}${archiveBlock}

REGRAS DE NÃO REPETIÇÃO (obrigatórias):
- Não reescreva a tese de nenhum texto acima. Se o tema for próximo, entre por um ângulo que os textos acima NÃO cobrem, e torne essa diferença explícita já no lede.
- Não reutilize a FORMA dos títulos acima. Em especial, estão proibidos agora: "O que X revela sobre Y", "Não é sobre X, é sobre Y", "X não é Y. É Z.", e qualquer título que comece com "O que".
- Não repita as mesmas âncoras temáticas dos textos acima (por exemplo "depois dos 40", "recomeçar", "o que os dados revelam") a menos que o acontecimento atual exija.
- Nenhum título novo pode ser uma variação de um título do arquivo. Se a sua primeira ideia de título ecoa algum deles, descarte e escreva outro.
- O seoTitle segue as mesmas proibições de forma e tem limite rígido de máximo 55 caracteres.
- Varie a forma do lede: se os títulos acima sugerem aberturas de cena, abra com um número, uma contradição, uma fala ou um objeto.`;
}

/* ── Existing posts (for sitemap) ────────────────────────── */

// og:* rather than <title>/<meta name="description"> because og:title carries no
// " — Jorge Bernardo" suffix, so it drops straight into a feed item.
function readMetaTag(html, property) {
  const m = html.match(new RegExp(`<meta property="${property}" content="([^"]*)"`));
  return m ? m[1] : '';
}

// og:title now carries the SHORT seo title, so anti-repetition reads the <h1> instead —
// it is the only place the full editorial title survives, and comparing short titles
// would let a long headline shape come back around unnoticed. Falls back to og:title.
function readEditorialTitle(html) {
  const m = html.match(/<h1 class="post-title">([\s\S]*?)<\/h1>/);
  return m ? m[1].trim() : readMetaTag(html, 'og:title');
}

function getAllPostMeta() {
  if (!fs.existsSync(POSTS_DIR)) return [];
  return fs.readdirSync(POSTS_DIR)
    .filter(f => f.endsWith('.html'))
    .map(filename => {
      const dateMatch = filename.match(/^(\d{4}-\d{2}-\d{2})/);
      let html = '';
      try { html = fs.readFileSync(path.join(POSTS_DIR, filename), 'utf8'); } catch { /* keep going */ }
      const image = readMetaTag(html, 'og:image');
      // RSS <enclosure> requires a byte-size length attribute (not just url/type) —
      // read it from the file on disk rather than guessing, and only if it resolves,
      // so a missing image drops the enclosure instead of emitting an invalid one.
      let imageBytes = 0;
      if (image) {
        try { imageBytes = fs.statSync(path.join(IMAGES_DIR, image.split('/').pop())).size; }
        catch { /* no local file (e.g. an external OG image) — omit the enclosure */ }
      }
      return {
        filename,
        date: dateMatch ? dateMatch[1] : isoDate(new Date()),
        title: readMetaTag(html, 'og:title'),
        description: readMetaTag(html, 'og:description'),
        // Pillar drives related-post selection; the badge is the only place it is stored.
        pillar: (html.match(/data-pillar="([^"]+)"/) || [, ''])[1],
        image,
        imageBytes,
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

/* ── Utilities ───────────────────────────────────────────── */

// A hard substring(0, 60) sliced mid-word, so live URLs read as broken in search results
// ("...o-processo-que-te-destr", "...me-ensinaram-sob"). Cut at the last hyphen at or
// before the limit instead. Already-published slugs are untouched; this shapes new ones.
const SLUG_MAX = 60;

function slugify(text) {
  const base = text
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
  if (base.length <= SLUG_MAX) return base.replace(/-+$/, '');
  // A hyphen sitting exactly at the boundary means the cut is already on a word edge.
  if (base[SLUG_MAX] === '-') return base.slice(0, SLUG_MAX).replace(/-+$/, '');
  const head = base.slice(0, SLUG_MAX);
  const lastDash = head.lastIndexOf('-');
  return (lastDash > 0 ? head.slice(0, lastDash) : head).replace(/-+$/, '');
}

/* ── SEO title & description budgets ─────────────────────── */

// Google cuts the SERP title around 60 characters and the snippet around 160. The
// editorial title is deliberately long because it is the <h1>; before this, 48 of 63
// pages shipped an over-budget <title> (worst 133) and 22 an out-of-range description
// (worst 211). So a separate short title carries the <title>/og:title budget and the
// excerpt is clamped on the way into the meta tags. The <h1> and the BlogPosting
// headline keep the full editorial title.
const SEO_TITLE_MAX = 55;
const SEO_TITLE_MIN = 25;
// A structural cut shorter than SEO_TITLE_MIN is still preferred over slicing through
// the phrase after it: "Pedalar Enquanto Negro" (22) reads as a finished claim, while
// the truncation it used to fall back to ended on a dangling pronoun ("...que Ninguem
// Me"). Below this floor the stub really is too thin to stand alone.
const SEO_TITLE_FLOOR = 18;
const TITLE_SUFFIX = ' — Jorge Bernardo';
const TITLE_TOTAL_MAX = 60;
const META_DESC_MAX = 160;
const META_DESC_MIN = 120;

// Words that must never end a truncated line, or the snippet reads as a sentence
// sheared off mid-thought ("...o que a gente chama de"). Compared accent-stripped.
const DANGLING_WORDS = new Set([
  'a', 'o', 'as', 'os', 'um', 'uma', 'uns', 'umas', 'de', 'da', 'do', 'das', 'dos',
  'em', 'no', 'na', 'nos', 'nas', 'num', 'numa', 'dum', 'duma', 'ao', 'aos',
  'por', 'pelo', 'pela', 'pelos', 'pelas', 'para', 'pra', 'com', 'sem', 'sob', 'sobre',
  'entre', 'ate', 'apos', 'desde', 'contra', 'e', 'ou', 'mas', 'que', 'se', 'como',
  'quando', 'onde', 'porque', 'meu', 'minha', 'seu', 'sua', 'nosso', 'nossa',
  'este', 'esta', 'esse', 'essa', 'aquele', 'aquela', 'isso', 'isto',
  'me', 'te', 'lhe', 'lhes', 'vos', 'mim', 'ti', 'si', 'nem', 'ja', 'so',
  // Negations, pronouns and adverbs that read as a sentence sheared off when they
  // land last: "...a gente ainda nao", "...recomecar depois", "...quando ele".
  'nao', 'sim', 'ele', 'ela', 'eles', 'elas', 'depois', 'antes', 'ainda', 'mais',
  'menos', 'muito', 'pouco', 'quase', 'tao', 'todo', 'toda', 'todos', 'todas',
  'cada', 'algo', 'alguem', 'sempre', 'nunca', 'entao', 'assim', 'tambem', 'la', 'ca'
]);

function stripAccents(str) {
  return String(str).normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

// Drop trailing punctuation, then peel off dangling connectors one at a time.
function trimDangling(text) {
  let out = String(text).replace(/[\s,;:.!?…"'\-–]+$/u, '');
  for (let guard = 0; guard < 6; guard++) {
    const m = out.match(/\s+([\p{L}']+)$/u);
    if (!m || !DANGLING_WORDS.has(stripAccents(m[1]).toLowerCase())) break;
    out = out.slice(0, m.index).replace(/[\s,;:.!?…"'\-–]+$/u, '');
  }
  return out;
}

function truncateAtWord(text, max) {
  const clean = String(text);
  if (clean.length <= max) return clean;
  const head = clean.slice(0, max + 1);
  const lastSpace = head.lastIndexOf(' ');
  return trimDangling(lastSpace > 0 ? head.slice(0, lastSpace) : clean.slice(0, max));
}

/**
 * The short title that carries the <title>/og:title budget.
 *
 * Prefers the model's own seoTitle when it fits. Otherwise it derives one from the
 * editorial title by cutting at the first structural boundary, since these titles are
 * almost always "Claim: expansion" or "Claim. Expansion" and the claim alone is the SEO
 * title. A boundary that leaves a stub shorter than SEO_TITLE_MIN is ignored, and
 * anything still over budget is truncated on a word boundary.
 */
function deriveSeoTitle(editorialTitle, modelTitle) {
  const candidate = String(modelTitle || '').replace(/\s+/g, ' ').trim();
  if (candidate && candidate.length <= SEO_TITLE_MAX) return candidate;

  const source = (candidate || String(editorialTitle || '')).replace(/\s+/g, ' ').trim();

  // A title that already fits the whole 60-char tag is kept intact, brand suffix
  // dropped. Truncating "O que os jovens nos ensinam sobre recomeçar depois dos 40"
  // (57) to land under 55 threw away "dos 40", which was the entire claim, and bought
  // nothing: the tag was never over budget in the first place.
  if (source.length <= TITLE_TOTAL_MAX) return source;
  const boundary = source.search(/[:—.?]/);
  if (boundary > 0) {
    const keepMark = source[boundary] === '?';
    const head = source.slice(0, keepMark ? boundary + 1 : boundary).trim()
      .replace(/[\s,;:.\-–]+$/u, '');
    if (head.length >= SEO_TITLE_FLOOR && head.length <= SEO_TITLE_MAX) return head;
  }
  return truncateAtWord(source, SEO_TITLE_MAX);
}

// The brand suffix is dropped rather than allowed to push the tag over 60 characters.
function buildPageTitle(seoTitle) {
  return seoTitle.length + TITLE_SUFFIX.length <= TITLE_TOTAL_MAX
    ? `${seoTitle}${TITLE_SUFFIX}`
    : seoTitle;
}

/**
 * The excerpt clamped into the snippet budget. Prefers a real sentence end inside the
 * window; falls back to a word-boundary cut with dangling connectors peeled off and an
 * ellipsis appended, so the meta description never ends mid-word or on a preposition.
 * A short excerpt is passed through untouched: nothing here can invent copy.
 */
function clampDescription(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= META_DESC_MAX) return clean;

  const window = clean.slice(0, META_DESC_MAX);
  const sentenceEnd = Math.max(
    window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? ')
  );
  if (sentenceEnd >= META_DESC_MIN - 1) return window.slice(0, sentenceEnd + 1).trim();

  return `${truncateAtWord(clean, META_DESC_MAX - 1)}…`;
}

function formatDate(date) {
  return date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
}

function isoDate(date) {
  return date.toISOString().split('T')[0];
}

function estimateReadTime(text) {
  const words = text.replace(/<[^>]+>/g, '').split(/\s+/).length;
  return Math.max(2, Math.round(words / 200));
}

function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* escapeJson was removed. It escaped a double quote as \" , which is correct for a JSON
 * string literal but closes a content="..." attribute early, and every one of its call
 * sites was an HTML attribute. One published post had its meta description silently
 * truncated to 'O audiobook de \"' that way. Attributes use escapeHtml; JSON-LD is
 * built with JSON.stringify, which escapes correctly on its own. */

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Inverse of escapeHtml, for reading og:* values back out of published posts and into a
// prompt. &amp; is undone last so "&amp;lt;" round-trips to "&lt;" rather than to "<".
function decodeHtmlEntities(str) {
  return String(str)
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function sanitizeContent(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object[\s\S]*?<\/object>/gi, '')
    .replace(/<embed[^>]*>/gi, '')
    .replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, '')
    .replace(/\s+on\w+\s*=\s*[^\s>]*/gi, '')
    .replace(/javascript\s*:/gi, '');
}

/* ── Related posts ───────────────────────────────────────── */

// Every post had exactly one inbound link (the blog index), so nothing in the archive
// passed authority to anything else and readers hit a dead end at the footer. Three
// links per post, shared pillar first, turns 56 orphans into a connected cluster.
const RELATED_COUNT = 3;
const PILLAR_LABELS = Object.fromEntries(PILLARS.map(p => [p.id, p.label]));

/**
 * Three related posts: same pillar first (newest first), then the newest of everything
 * else. Candidates need a recognizable pillar and a title so the markup stays uniform.
 * Returns [] below RELATED_COUNT rather than a short list, so an early archive emits
 * nothing instead of a lopsided block.
 */
function selectRelatedPosts(allPosts, pillarId, currentFilename, limit = RELATED_COUNT) {
  const pool = allPosts.filter(p =>
    p.filename !== currentFilename && p.title && PILLAR_LABELS[p.pillar]);
  const picked = [
    ...pool.filter(p => p.pillar === pillarId),
    ...pool.filter(p => p.pillar !== pillarId)
  ].slice(0, limit);
  return picked.length === limit ? picked : [];
}

function buildRelatedHtml(related) {
  if (!related || related.length < RELATED_COUNT) return '';
  const items = related.map(p =>
    `      <li class="related-item"><a class="related-link" href="${escapeHtml(p.filename)}"><span class="related-pillar">${escapeHtml(PILLAR_LABELS[p.pillar])}</span><span class="related-title">${escapeHtml(decodeHtmlEntities(p.title))}</span></a></li>`
  ).join('\n');

  return `
<aside class="related-posts" aria-labelledby="related-heading">
  <div class="related-inner">
    <h2 class="related-heading" id="related-heading">Leia também</h2>
    <ul class="related-list">
${items}
    </ul>
  </div>
</aside>
`;
}

/* ── Post HTML builder ───────────────────────────────────── */

function buildPostHtml({ title, seoTitle, excerpt, pillar, date, readTime, content, filename, imageUrl, faq = [], related = [] }) {
  const formattedDate = formatDate(date);
  const iso = isoDate(date);
  const postUrl = `${SITE_URL}/blog/posts/${filename}`;

  // Short title carries the <title>/og:title budget; `title` stays the editorial <h1>.
  const shortTitle = seoTitle || deriveSeoTitle(title, '');
  const pageTitle = buildPageTitle(shortTitle);
  const metaDescription = clampDescription(excerpt);

  // The generated art was only ever an og:image, never rendered on the page. Posts live at
  // blog/posts/*.html and images at blog/posts/images/, so the on-page src is relative.
  // og:image stays on the JPEG: LinkedIn and WhatsApp render WebP OG images unreliably.
  const imageBase = imageUrl ? imageUrl.split('/').pop().replace(/\.[a-z0-9]+$/i, '') : '';
  const ogImageUrl = imageUrl ? imageUrl.replace(/\.[a-z0-9]+$/i, '.jpg') : '';

  const heroHtml = imageBase ? `
<figure class="post-hero">
  <picture>
    <source srcset="images/${imageBase}.webp" type="image/webp">
    <img src="images/${imageBase}.jpg" alt="Ilustração editorial: ${escapeHtml(title)}" width="1536" height="1024" fetchpriority="high" decoding="async">
  </picture>
</figure>
` : '';

  const relatedHtml = buildRelatedHtml(related);

  const faqJsonLd = faq.length ? JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faq.map(({ question, answer }) => ({
      '@type': 'Question',
      name: question,
      acceptedAnswer: { '@type': 'Answer', text: answer }
    }))
  }, null, 2) : null;

  const faqHtml = faq.length ? `
<h2>Perguntas frequentes</h2>
${faq.map(({ question, answer }) => `<h3>${escapeHtml(question)}</h3>\n<p>${escapeHtml(answer)}</p>`).join('\n')}` : '';

  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: title,
    description: metaDescription,
    // Google wants image in the structured data, not only in the og: tags —
    // without it the post is not eligible for Article rich results.
    image: ogImageUrl,
    url: postUrl,
    datePublished: iso,
    dateModified: iso,
    inLanguage: 'pt-BR',
    keywords: pillar.label,
    mainEntityOfPage: { '@type': 'WebPage', '@id': postUrl },
    author: {
      '@type': 'Person',
      name: 'Jorge Bernardo',
      url: SITE_URL,
      sameAs: [
        'https://www.linkedin.com/in/jorge-bernardo/',
        'https://www.depretoprapreto.com.br/'
      ]
    },
    publisher: {
      '@type': 'Person',
      name: 'Jorge Bernardo',
      url: SITE_URL
    }
  }, null, 2);

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(pageTitle)}</title>
<meta name="description" content="${escapeHtml(metaDescription)}">
<link rel="canonical" href="${postUrl}">
<meta property="og:type" content="article">
<meta property="og:title" content="${escapeHtml(shortTitle)}">
<meta property="og:description" content="${escapeHtml(metaDescription)}">
<meta property="og:url" content="${postUrl}">
<meta property="og:locale" content="pt_BR">
${ogImageUrl ? `<meta property="og:image" content="${ogImageUrl}">
<meta property="og:image:type" content="image/jpeg">
<meta property="og:image:width" content="1536">
<meta property="og:image:height" content="1024">` : ''}
<meta name="twitter:card" content="${ogImageUrl ? 'summary_large_image' : 'summary'}">
<meta name="twitter:image" content="${ogImageUrl}">
<meta property="og:site_name" content="Jorge Bernardo">
<meta property="article:author" content="Jorge Bernardo">
<meta property="article:published_time" content="${iso}">
<meta name="twitter:title" content="${escapeHtml(shortTitle)}">
<meta name="twitter:description" content="${escapeHtml(metaDescription)}">
<link rel="icon" href="/favicon.png" type="image/png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="alternate" type="application/rss+xml" title="Jorge Bernardo — Blog" href="/feed.xml">
<script>
  window.si = window.si || function () { (window.siq = window.siq || []).push(arguments); };
</script>
<script defer src="/_vercel/speed-insights/script.js"></script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+Display:ital,wght@0,300;0,400;0,700;0,900;1,300;1,400;1,700;1,900&family=Lora:ital,wght@0,400;0,500;0,600;1,400;1,500&family=DM+Mono:wght@300;400;500&display=swap" rel="stylesheet">
<script type="application/ld+json">
${jsonLd}
</script>${faqJsonLd ? `
<script type="application/ld+json">
${faqJsonLd}
</script>` : ''}
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth;font-size:16px}
:root{
  --black:#1e1a14;--terra:#5e412d;--terra-light:#a0714f;
  --ash:#d9d9d9;--white:#ffffff;--mid:rgba(255,255,255,0.45);
  --border:rgba(255,255,255,0.09);--border-terra:rgba(160,113,79,0.25);
  --font-display:'Noto Serif Display',Georgia,serif;
  --font-body:'Lora',Georgia,serif;--font-mono:'DM Mono',monospace;
}
body{background:var(--black);color:var(--white);font-family:var(--font-body);overflow-x:hidden;-webkit-font-smoothing:antialiased}
body::after{content:'';position:fixed;inset:0;background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");opacity:0.025;pointer-events:none;z-index:999}
::-webkit-scrollbar{width:3px}::-webkit-scrollbar-track{background:#0a0a0a}::-webkit-scrollbar-thumb{background:var(--terra-light);border-radius:2px}
nav{position:sticky;top:0;z-index:100;height:64px;display:flex;align-items:center;justify-content:space-between;padding:0 52px;background:rgba(30,26,20,0.92);border-bottom:1px solid var(--border);backdrop-filter:blur(12px)}
.nav-text{font-family:var(--font-mono);font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:var(--white);opacity:0.85;text-decoration:none}
.nav-back{font-family:var(--font-mono);font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:var(--terra-light);text-decoration:none;border:1px solid var(--border-terra);padding:8px 20px;border-radius:1px;transition:background .2s,color .2s}
.nav-back:hover{background:var(--terra);color:var(--white);border-color:var(--terra)}
.post-header{padding:72px 0 52px;border-bottom:1px solid var(--border)}
.post-header-inner{max-width:820px;margin:0 auto;padding:0 52px}
.post-pillar{font-family:var(--font-mono);font-size:10px;letter-spacing:0.16em;text-transform:uppercase;color:var(--terra-light);padding:5px 14px;border:1px solid var(--border-terra);border-radius:1px;display:inline-block;margin-bottom:28px}
.post-title{font-family:var(--font-display);font-size:clamp(32px,4.5vw,60px);font-weight:900;letter-spacing:-0.03em;line-height:1.05;margin-bottom:28px}
.post-byline{display:flex;align-items:center;gap:24px;font-family:var(--font-mono);font-size:11px;color:rgba(255,255,255,0.3);letter-spacing:0.06em}
.post-byline span{color:var(--terra-light)}
.post-body{max-width:820px;margin:0 auto;padding:60px 52px 100px}
.post-body p{font-size:18px;line-height:1.88;color:var(--ash);margin-bottom:28px}
.post-body p:first-child{font-size:20px;color:var(--white);font-weight:500}
.post-body h2{font-family:var(--font-display);font-size:clamp(22px,2.5vw,34px);font-weight:700;letter-spacing:-0.025em;line-height:1.15;margin:52px 0 20px;color:var(--white)}
.post-body h3{font-family:var(--font-display);font-size:clamp(18px,2vw,26px);font-weight:600;letter-spacing:-0.015em;margin:36px 0 16px;color:var(--white)}
.post-body strong{color:var(--white);font-weight:600}
.post-body em{font-style:italic;color:var(--ash)}
.post-body blockquote{border-left:3px solid var(--terra-light);padding:20px 32px;margin:40px 0;background:rgba(94,65,45,0.07)}
.post-body blockquote p{font-family:var(--font-display);font-size:clamp(18px,2.2vw,26px);font-weight:300;font-style:italic;color:var(--ash);margin:0}
.post-body ul,.post-body ol{padding-left:28px;margin-bottom:28px}
.post-body li{font-size:17px;line-height:1.78;color:var(--ash);margin-bottom:8px}
.post-hero{max-width:820px;margin:44px auto 0;padding:0 52px}
.post-hero picture{display:block;position:relative;overflow:hidden;border:1px solid var(--border-terra);border-radius:1px}
.post-hero img{display:block;width:100%;height:auto;aspect-ratio:3/2;object-fit:cover}
.post-hero picture::before{content:'';position:absolute;inset:0;background:var(--terra);mix-blend-mode:multiply;opacity:0.18;pointer-events:none;z-index:1}
.post-hero picture::after{content:'';position:absolute;inset:0;background:linear-gradient(to top,rgba(30,26,20,0.62),rgba(30,26,20,0) 58%),radial-gradient(120% 90% at 50% 112%,rgba(94,65,45,0.3),rgba(94,65,45,0) 62%);pointer-events:none;z-index:2}
.audio-block{max-width:820px;margin:0 auto;padding:36px 52px 0}
.audio-panel{border:1px solid var(--border-terra);background:rgba(94,65,45,0.07);padding:20px 24px;border-radius:1px}
.audio-label{font-family:var(--font-mono);font-size:10px;letter-spacing:0.16em;text-transform:uppercase;color:var(--terra-light);margin-bottom:14px}
.audio-panel audio{width:100%;height:36px;color-scheme:dark}
.audio-spotify{display:inline-block;margin-top:12px;font-family:var(--font-mono);font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:var(--terra-light);text-decoration:none;border-bottom:1px solid var(--border-terra);padding-bottom:2px;transition:color .2s,border-color .2s}
.audio-spotify:hover{color:var(--white);border-color:rgba(255,255,255,0.3)}
.related-posts{border-top:1px solid var(--border);background:rgba(94,65,45,0.06)}
.related-inner{max-width:820px;margin:0 auto;padding:48px 52px 52px}
.related-heading{font-family:var(--font-mono);font-size:10px;font-weight:400;letter-spacing:0.16em;text-transform:uppercase;color:var(--terra-light);margin-bottom:8px}
.related-list{list-style:none}
.related-item{border-top:1px solid var(--border)}
.related-link{display:block;padding:20px 0;text-decoration:none;color:var(--ash);transition:color .25s ease,transform .35s cubic-bezier(.16,1,.3,1)}
.related-link:hover,.related-link:focus-visible{color:var(--white);transform:translateX(7px)}
.related-link:focus-visible{outline:1px solid var(--terra-light);outline-offset:6px}
.related-link:active{transform:translateX(3px)}
.related-pillar{display:block;font-family:var(--font-mono);font-size:9px;letter-spacing:0.16em;text-transform:uppercase;color:var(--terra-light);opacity:0.75;margin-bottom:9px}
.related-title{display:block;font-family:var(--font-display);font-size:19px;font-weight:600;letter-spacing:-0.015em;line-height:1.32}
@media(prefers-reduced-motion:reduce){
  .related-link{transition:color .25s ease}
  .related-link:hover,.related-link:focus-visible,.related-link:active{transform:none}
}
.post-footer{border-top:1px solid var(--border);padding:52px;max-width:820px;margin:0 auto;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:20px}
.author-block{display:flex;flex-direction:column;gap:6px}
.author-name{font-family:var(--font-display);font-size:20px;font-weight:700;letter-spacing:-0.01em}
.author-role{font-family:var(--font-mono);font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:var(--terra-light)}
.author-links{display:flex;gap:16px;margin-top:8px}
.author-link{font-family:var(--font-mono);font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:rgba(255,255,255,0.35);text-decoration:none;transition:color .2s}
.author-link:hover{color:var(--terra-light)}
.back-link{font-family:var(--font-mono);font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:var(--terra-light);text-decoration:none;border-bottom:1px solid var(--border-terra);padding-bottom:4px;transition:color .2s,border-color .2s}
.back-link:hover{color:var(--white);border-color:rgba(255,255,255,0.3)}
footer{padding:28px 52px;border-top:1px solid var(--border);display:flex;align-items:center;justify-content:space-between}
.footer-copy{font-family:var(--font-mono);font-size:10px;color:rgba(255,255,255,0.22);letter-spacing:0.08em}
.footer-tag{font-family:var(--font-mono);font-size:10px;color:var(--terra-light);letter-spacing:0.1em;opacity:0.7}
@media(max-width:768px){
  nav{padding:0 24px}
  .post-header-inner,.post-body{padding-left:24px;padding-right:24px}
  .audio-block{padding-left:24px;padding-right:24px}
  .post-hero{padding-left:24px;padding-right:24px;margin-top:32px}
  .related-inner{padding:40px 24px 44px}
  .related-title{font-size:18px}
  .post-footer{padding:40px 24px}
  footer{padding:20px 24px;flex-direction:column;gap:10px;text-align:center}
}
</style>
</head>
<body>
<nav>
  <a href="../../" class="nav-text">Jorge Bernardo</a>
  <a href="../" class="nav-back">← Blog</a>
</nav>

<header class="post-header">
  <div class="post-header-inner">
    <div class="post-pillar" data-pillar="${escapeHtml(pillar.id)}">${escapeHtml(pillar.label)}</div>
    <h1 class="post-title">${escapeHtml(title)}</h1>
    <div class="post-byline">
      <span>Jorge Bernardo</span>
      <time datetime="${iso}">${formattedDate}</time>
      <span>${readTime} min de leitura</span>
    </div>
  </div>
</header>
${heroHtml}
<!-- audio-player-slot -->

<article class="post-body" itemscope itemtype="https://schema.org/BlogPosting">
${sanitizeContent(content)}
${faqHtml}
</article>
${relatedHtml}
<div class="post-footer">
  <div class="author-block">
    <div class="author-name">Jorge Bernardo</div>
    <div class="author-role">Sr. Technical Trainer · Fundador · Ciclista</div>
    <div class="author-links">
      <a href="https://www.linkedin.com/in/jorge-bernardo/" target="_blank" rel="noopener" class="author-link">LinkedIn ↗</a>
      <a href="https://www.depretoprapreto.com.br/" target="_blank" rel="noopener" class="author-link">DePretoPraPreto ↗</a>
    </div>
  </div>
  <a href="../" class="back-link">← Voltar ao blog</a>
</div>

<footer>
  <span class="footer-copy">© ${date.getFullYear()} Jorge Bernardo</span>
  <span class="footer-tag">Estética encontra Estratégia.</span>
</footer>
</body>
</html>`;
}

/* ── Blog index list item ─────────────────────────────────── */

function buildPostListItem({ title, pillar, date, excerpt, filename }) {
  const formattedDate = formatDate(date);
  const iso = isoDate(date);
  return `    <a href="posts/${filename}" class="post-item" data-pillar="${pillar.id}">
      <div class="post-meta">
        <time class="post-date" datetime="${iso}">${formattedDate}</time>
        <div class="post-pillar">${pillar.label}</div>
      </div>
      <div class="post-content">
        <div class="post-title">${title}</div>
        <p class="post-excerpt">${excerpt}</p>
        <span class="post-read">Ler post <span>→</span></span>
      </div>
    </a>`;
}

function updateBlogIndex(newEntry) {
  let html = fs.readFileSync(INDEX_FILE, 'utf8');
  html = html.replace(/\s*<div class="posts-empty">[\s\S]*?<\/div>/, '');
  html = html.replace(
    /(<div class="posts-list" id="postsList">)/,
    `$1\n${newEntry}`
  );
  fs.writeFileSync(INDEX_FILE, html, 'utf8');
}

/* ── Sitemap ─────────────────────────────────────────────── */

// Hand-authored pages. They are not generated, so nothing else would ever add
// them to the sitemap — the censo report in particular is original data worth
// surfacing, and both were orphaned (unlinked, unindexed) until 2026-07-28.
const STATIC_PAGES = [
  { path: '/',                                            changefreq: 'monthly', priority: '1.0' },
  { path: '/blog/',                                       changefreq: 'weekly',  priority: '0.8' },
  { path: '/relatorios/',                                 changefreq: 'monthly', priority: '0.7' },
  { path: '/relatorios/censo-de-nomes-ligados-a-escravidao/', changefreq: 'yearly', priority: '0.6' },
  { path: '/relatorios/o-que-apagaram-dos-nossos-deuses/',    changefreq: 'yearly', priority: '0.6' },
  { path: '/privacidade/',                                changefreq: 'yearly',  priority: '0.3' },
];

// The 56 post URLs carried <lastmod> and the 6 static ones did not, so crawlers had no
// freshness signal for the home page, the blog index or either dossier. Read it off the
// real file on disk rather than stamping a date: a hardcoded one goes stale silently.
function staticPageLastmod(urlPath) {
  const file = path.join(__dirname, urlPath.replace(/^\/+/, ''), 'index.html');
  try { return isoDate(fs.statSync(file).mtime); }
  catch { return ''; }
}

function generateSitemap(posts) {
  const staticEntries = STATIC_PAGES.map(p => {
    const lastmod = staticPageLastmod(p.path);
    return `  <url>
    <loc>${SITE_URL}${p.path}</loc>${lastmod ? `
    <lastmod>${lastmod}</lastmod>` : ''}
    <changefreq>${p.changefreq}</changefreq>
    <priority>${p.priority}</priority>
  </url>`;
  }).join('\n');

  const postEntries = posts.map(p => `  <url>
    <loc>${SITE_URL}/blog/posts/${escapeXml(p.filename)}</loc>
    <lastmod>${p.date}</lastmod>
    <changefreq>never</changefreq>
    <priority>0.7</priority>
  </url>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${staticEntries}
${postEntries}
</urlset>`;
}

/* ── RSS feed ────────────────────────────────────────────── */

const FEED_TITLE = 'Jorge Bernardo — Blog';
const FEED_DESCRIPTION = 'Ensaios sobre tecnologia, identidade negra, ciclismo, carreira e empreendedorismo.';
const FEED_MAX_ITEMS = 20;

// RSS dates must be RFC-822. Post dates are date-only, so anchor them at
// midday UTC — that way no reader shifts an item onto the previous day.
function rfc822(isoDay) {
  return new Date(`${isoDay}T12:00:00Z`).toUTCString();
}

// The enclosure type was hardcoded to image/png. og:image now points at the JPEG for new
// posts while the archive is still PNG, so derive it from the extension or the feed ships
// a mislabelled enclosure.
const ENCLOSURE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

function generateFeed(posts) {
  const items = posts.slice(0, FEED_MAX_ITEMS).map((p) => {
    const url = `${SITE_URL}/blog/posts/${escapeXml(p.filename)}`;
    const mime = ENCLOSURE_MIME[(p.image.split('.').pop() || '').toLowerCase()] || 'image/png';
    const image = (p.image && p.imageBytes)
      ? `\n      <enclosure url="${escapeXml(p.image)}" length="${p.imageBytes}" type="${mime}"/>`
      : '';
    return `    <item>
      <title>${escapeXml(p.title || p.filename)}</title>
      <link>${url}</link>
      <guid isPermaLink="true">${url}</guid>
      <pubDate>${rfc822(p.date)}</pubDate>
      <description>${escapeXml(p.description)}</description>${image}
    </item>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(FEED_TITLE)}</title>
    <link>${SITE_URL}/blog/</link>
    <description>${escapeXml(FEED_DESCRIPTION)}</description>
    <language>pt-BR</language>
    <lastBuildDate>${posts.length ? rfc822(posts[0].date) : new Date().toUTCString()}</lastBuildDate>
    <atom:link href="${SITE_URL}/feed.xml" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>`;
}

/* ── robots.txt ──────────────────────────────────────────── */

// Named explicitly so the AI-answer crawlers stay opted in even if a future
// default tightens `*`. Losing these silently would drop the site out of
// ChatGPT/Perplexity/Claude answers, which is a real slice of the traffic.
const CRAWLERS = ['*', 'GPTBot', 'ChatGPT-User', 'PerplexityBot', 'ClaudeBot', 'anthropic-ai', 'Bingbot'];

function generateRobotsTxt() {
  const agents = CRAWLERS.map(ua => `User-agent: ${ua}\nAllow: /\n`).join('\n');
  return `${agents}\nSitemap: ${SITE_URL}/sitemap.xml\n`;
}

/* ── Main ────────────────────────────────────────────────── */

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const withSignals = args.includes('--with-signals');
  const forcePillar = args.includes('--pillar') ? args[args.indexOf('--pillar') + 1] : null;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('Error: ANTHROPIC_API_KEY environment variable is not set.');
    process.exit(1);
  }

  const resolvePillar = () =>
    forcePillar ? (PILLARS.find(p => p.id === forcePillar) || getNextPillar()) : getNextPillar();

  // Signal-led selection (with balance guardrail) when --with-signals is set: a real,
  // recent, safety-checked news signal sets the pillar/angle and seeds upstream research.
  // No safe signal → fall back to evergreen rotation (today's behavior).
  let pillar, signal = null, research = null;
  if (withSignals) {
    // Any failure in the signal/research phase must NOT kill the cron (the blog
    // auto-publishes) — fall back to evergreen rotation instead.
    try {
      console.log('Signal mode: scanning press + Google News for a fresh, on-brand signal...');
      const sel = await selectSignal({ forcePillar });
      signal = sel.signal;
      if (signal) {
        pillar = PILLARS.find(p => p.id === signal.pillar) || resolvePillar();
        console.log(`Signal [${pillar.id}]: ${signal.title} — ${signal.source}`);
        // Ask for the DATA behind the story, not for the story again. The old query was
        // `<headline> <outlet> Brasil`, which searched for the source article and averaged
        // 1.3 stats per run against the newsletter's 3.1 from a derived query. The fallback
        // drops the outlet name either way — naming it steered results back to that outlet.
        const derived = await deriveResearchQuery({
          title: signal.title,
          summary: signal.summary,
          source: signal.source,
          pillarLabel: pillar.label
        });
        const query = derived || `${signal.title} Brasil`.trim();
        console.log(`Researching the signal (Tavily + synthesis) — query ${derived ? 'derived' : 'fallback'}: "${query}"`);
        const r = await researchTopic(query);
        if (r.success) {
          research = r.data;
          console.log(`Research: ${research.stats.length} stat(s), ${research.sources.length} source(s).`);
        } else {
          console.warn(`Research failed (${r.error}) — grounding on the signal headline only.`);
        }
      } else {
        console.log('No safe, on-brand signal found — falling back to evergreen rotation.');
      }
    } catch (e) {
      console.warn(`Signal mode error (${e.message}) — falling back to evergreen rotation.`);
      signal = null; research = null;
    }
    if (!pillar) pillar = resolvePillar();
  } else {
    pillar = resolvePillar();
  }

  console.log(`Generating post for pillar: ${pillar.label}`);
  console.log(`Site URL: ${SITE_URL}`);

  const client = new Anthropic({ apiKey });

  // Grounding blocks injected only when a signal/research is present (--with-signals).
  const groundingSystemNote = (signal || research) ? `

GROUNDING IN REAL EVENTS (mandatory when provided):
- When a current-events item is provided, the anecdote lede or the nut graf must connect to that real, recent event. Do not invent details beyond what is given.
- When researched data is provided, weave one or two of those real figures into the post and make clear where each came from. NEVER invent statistics or cite numbers not present in the provided data.` : '';

  const signalBlock = signal ? `

ATUALIDADE — ponto de partida real e recente (ancore o lede ou o nut graf neste acontecimento; não invente detalhes além do que está aqui):
- Manchete: ${signal.title}
- Fonte: ${signal.source}${signal.date ? ` (${signal.date.slice(0, 10)})` : ''}${signal.summary ? `\n- Resumo: ${signal.summary}` : ''}` : '';

  const researchBlock = (research && (research.stats?.length || research.insights?.length)) ? `

DADOS PESQUISADOS (use APENAS estes números/fatos, sempre deixando claro de onde vieram; NUNCA invente dados):
${(research.stats || []).map(s => `- ${s.value}: ${s.context} (${s.source})`).join('\n')}${(research.insights || []).length ? `\nContexto:\n${research.insights.slice(0, 4).map(i => `- ${i}`).join('\n')}` : ''}${(research.sources || []).length ? `\nFontes: ${research.sources.slice(0, 6).join(', ')}` : ''}` : '';

  const groundingRequirements = (signal || research) ? `
- Fundamente a abertura no acontecimento atual acima, sem inventar detalhes${researchBlock ? '\n- Teça 1 ou 2 dos dados pesquisados no texto, sempre citando a fonte; nunca invente números' : ''}` : '';

  const systemPrompt = `You are a ghostwriter creating blog posts for Jorge Bernardo. Write in first person, in Brazilian Portuguese, in Jorge's authentic voice — thoughtful, direct, culturally grounded, never corporate.

${JORGE_CONTEXT}

CENTER THE READER AND THE IDEA, NOT THE AUTHOR:
- The post is about a topic, an idea, and what it means for the reader, not a biography of Jorge.
- Personal experience is occasional seasoning, used only when it sharpens the point, never the subject.
- Most posts should not mention Jorge's employers or ventures at all. Name one only when genuinely essential to the argument, never as the subject and never as a credential flex.
- Aim for output that reads as Jorge's perspective on the world, not Jorge talking about himself.

Writing style:
- First person voice, but pointed outward ("Acredito que...", "O que me chama atenção é...", "Vale olhar para...") — first person serves the idea, it is not the topic
- Conversational but substantive — like a smart friend writing, not a LinkedIn post
- Lead with the idea; bring in personal experience only when it makes the point land harder
- No hollow motivational phrases or corporate jargon
- Use concrete examples, data, and real-world cases — drawn from the wider world, news, or other people, not primarily Jorge's own life
- Paragraphs are short (2-4 sentences max)
- End with something that opens a question or invites reflection, not a call-to-action
- Vary sentence length deliberately — short punchy sentences next to longer ones
- Use contractions and natural spoken rhythm wherever they fit

JOURNALISM TECHNIQUES — apply these rigorously:

Concrete lede: The first paragraph must open with a specific scene, moment, detail, or fact — not a broad statement. It can come from the wider world, a news event, someone else's story, a number, or occasionally from Jorge's own life. Do not make every post open with autobiography. "Em 2023, 8 em cada 10 ciclistas mortos no trânsito de São Paulo eram entregadores..." works as well as a personal scene; what matters is the specificity, not that it is about Jorge.

Nut graf: The second paragraph must make the stakes clear — what this is really about and why it matters right now. Pay off the lede before going deeper.

Show, don't tell: Replace adjective-driven claims with a specific number, name, scene, or moment. "A reunião tinha 23 executivos, nenhum deles negro" hits harder than "o ambiente era pouco diverso."

One idea per paragraph: Each paragraph carries exactly one idea. When a new idea appears, start a new paragraph. Never stack multiple points into one block.

Cut adverbs: No adverbs. Find the verb that already contains the intensity. "Disparou" not "correu rapidamente." "Afirmou" not "disse claramente."

WSJ close: If the post opens with a scene or image, return to it at the end with new meaning. The final paragraph must not summarize — it should land on a specific image, a quiet observation, or an open question. The last line cannot echo the title or the first paragraph.

NEVER use the following — they are AI tells that break authenticity:
- Em dash (—) as a clause separator. Use a comma, rewrite the sentence, or break it in two.
- Transition filler words: "Além disso", "Portanto", "Vale ressaltar", "Em suma", "Cabe destacar", "É importante destacar", "Nesse contexto", "No entanto", "Dessa forma"
- Openers like "O fato é que", "Isso significa que", "É fundamental que", "É essencial que"
- Lists that always have exactly 3 bullets — use 2, 4, or skip the list entirely if prose flows better
- A concluding paragraph that summarizes what the post just said
- Any phrase that sounds like a LinkedIn caption or a motivational slide${groundingSystemNote}`;

  // What was just published, so the writer stops re-running its own greatest hits.
  const recentPosts = getRecentPosts();
  const archiveTitles = getRecentPosts(Infinity).map(p => p.title);
  const recentBlock = buildRecentPostsBlock(recentPosts, archiveTitles);
  if (recentPosts.length) {
    console.log(`Anti-repetition: ${recentPosts.length} recent post(s) with excerpts + ${archiveTitles.length} archive title(s) passed to the writer.`);
  }

  const userPrompt = `Write a blog post on the topic pillar: "${pillar.label}" — ${pillar.description}${signalBlock}${researchBlock}${recentBlock}

Requirements:
- Title: compelling, specific, not generic (in Portuguese), and structurally different from the recent titles listed above
- seoTitle: versão curta do título, em português, com no MÁXIMO 55 caracteres (limite rígido, conte os caracteres). Sem aspas, sem dois-pontos com subtítulo, sem o nome "Jorge Bernardo". Ela aparece sozinha na página de resultados do Google, então precisa carregar a mesma afirmação do título, comprimida.
- Excerpt: uma frase de resumo em português com entre 150 e 160 caracteres (limite rígido, conte os caracteres), sem aspas ao redor. Ela vira a meta description da página.
- Length: 600-900 words of body content
- Structure: flowing prose with 2-3 H2 subheadings
- Include at least one blockquote that captures a key insight
- First paragraph must be a strong hook that draws the reader in immediately
- The post is about the topic and what it means for the reader — grounded in Jorge's perspective, but NOT a biography of his career; do not name his employers or ventures unless one fact is truly essential
- Open with a specific anecdote, scene, or fact (from the wider world or, occasionally, Jorge's life), not a broad claim
- Second paragraph pays off the lede — states what this is really about
- One idea per paragraph, no exceptions
- No adverbs — rewrite with a stronger verb instead
- No em dashes (—) anywhere in the text
- No AI filler transitions (Além disso, Vale ressaltar, Em suma, etc.)
- Close by returning to the opening moment or landing on a quiet image — never summarize
- Sentence rhythm should feel uneven and human — not every paragraph the same length${groundingRequirements}

Also provide 2-3 FAQ pairs: short reader questions this post answers, each with a direct, self-contained answer (1-2 sentences, in Portuguese, no em dashes). These run as a visible FAQ block at the end of the post, so each answer must stand alone without the reader having read the body.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    tools: [{
      name: 'create_blog_post',
      description: 'Create a blog post with title, excerpt, and HTML content',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'The blog post title in Portuguese. This is the editorial headline shown as the on-page H1, so it can be long.' },
          seoTitle: { type: 'string', description: 'Short SEO title in Portuguese for the <title> tag. Hard limit: máximo 55 caracteres. No surrounding quotes, no subtitle after a colon, no brand name.' },
          excerpt: { type: 'string', description: 'One sentence excerpt in Portuguese, entre 150 e 160 caracteres (hard limit), no surrounding quotes. Becomes the meta description.' },
          content: { type: 'string', description: 'Full HTML post body using only p, h2, h3, strong, em, blockquote>p, ul>li tags. Do NOT include the title.' },
          faq: {
            type: 'array',
            description: '2-3 short reader questions this post answers, each with a self-contained 1-2 sentence answer in Portuguese.',
            items: {
              type: 'object',
              properties: {
                question: { type: 'string' },
                answer: { type: 'string' }
              },
              required: ['question', 'answer']
            }
          }
        },
        required: ['title', 'seoTitle', 'excerpt', 'content', 'faq']
      }
    }],
    tool_choice: { type: 'tool', name: 'create_blog_post' },
    messages: [{ role: 'user', content: userPrompt }],
    system: systemPrompt,
  });

  const toolUse = response.content.find(b => b.type === 'tool_use');
  if (!toolUse) {
    console.error('Claude did not return a tool_use block.');
    console.error(JSON.stringify(response.content, null, 2));
    process.exit(1);
  }
  const parsed = toolUse.input;

  const title   = sanitizeEmDashes(parsed.title);
  // deriveSeoTitle re-derives whenever the model overshoots the 55-char budget, so a
  // missing or over-long seoTitle degrades to a clean cut instead of a 133-char <title>.
  const seoTitle = deriveSeoTitle(title, sanitizeEmDashes(parsed.seoTitle));
  const excerpt = sanitizeEmDashes(parsed.excerpt);
  const content = sanitizeEmDashes(parsed.content);
  const faq = Array.isArray(parsed.faq)
    ? parsed.faq.map(pair => ({
        question: sanitizeEmDashes(pair.question),
        answer: sanitizeEmDashes(pair.answer)
      }))
    : [];
  const date = new Date();
  const readTime = estimateReadTime(content);
  const slug = slugify(title);
  const filename = `${isoDate(date)}-${slug}.html`;
  const postPath = path.join(POSTS_DIR, filename);
  // JPEG, not PNG. These are photographic renders: the PNGs averaged 1.94 MB each and
  // 105 MB across the archive, for art that is also the og:image. JPEG keeps every
  // social platform happy (LinkedIn and WhatsApp are unreliable with WebP cards) and a
  // WebP sibling is written next to it for the on-page <picture>.
  const imageFilename = `${isoDate(date)}-${slug}.jpg`;
  const imagePath = path.join(IMAGES_DIR, imageFilename);
  const imageUrl = `${SITE_URL}/blog/posts/images/${imageFilename}`;

  // Read the archive before the new post is written, so it can never link to itself.
  const related = selectRelatedPosts(getAllPostMeta(), pillar.id, filename);
  if (related.length) {
    console.log(`Related posts: ${related.map(p => p.filename).join(', ')}`);
  } else {
    console.log(`Related posts: fewer than ${RELATED_COUNT} candidates — block omitted.`);
  }

  const postHtml = buildPostHtml({ title, seoTitle, excerpt, pillar, date, readTime, content, filename, imageUrl, faq, related });
  const listItem = buildPostListItem({ title, pillar, date, excerpt, filename });

  if (dryRun) {
    console.log('\n--- DRY RUN: Title ---');
    console.log(title);
    console.log('\n--- DRY RUN: <title> tag ---');
    const pageTitle = buildPageTitle(seoTitle);
    console.log(`${pageTitle}  [${pageTitle.length} chars]`);
    console.log('\n--- DRY RUN: Excerpt ---');
    console.log(excerpt);
    console.log('\n--- DRY RUN: meta description ---');
    const metaDescription = clampDescription(excerpt);
    console.log(`${metaDescription}  [${metaDescription.length} chars]`);
    console.log('\n--- DRY RUN: Filename ---');
    console.log(filename);
    console.log('\n--- DRY RUN: Canonical URL ---');
    console.log(`${SITE_URL}/blog/posts/${filename}`);
    if (signal) {
      console.log('\n--- DRY RUN: Grounded on signal ---');
      console.log(`[${pillar.id}] ${signal.title} — ${signal.source}`);
      if (research) console.log(`Research: ${research.stats.length} stat(s), ${research.sources.length} source(s)`);
    }
    console.log('\nDry run complete. No files written.');
    return;
  }

  fs.mkdirSync(POSTS_DIR, { recursive: true });
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  fs.writeFileSync(postPath, postHtml, 'utf8');
  console.log(`Post created: blog/posts/${filename}`);

  let savedImagePath = null;
  if (process.env.OPENAI_API_KEY) {
    // title/excerpt drive a post-specific scene; slug seeds the framing variation, so two
    // posts in the same pillar no longer resolve to the same picture.
    const imageBuffer = await generatePostImage(pillar.id, process.env.OPENAI_API_KEY, {
      title, excerpt, seed: slug
    });
    // The model returns PNG. Re-encode rather than store it: the JPEG is the og:image
    // and the on-page fallback, the WebP is what <picture> actually serves.
    await sharp(imageBuffer)
      .jpeg({ quality: 82, progressive: true, mozjpeg: true })
      .toFile(imagePath);
    await sharp(imageBuffer)
      .webp({ quality: 80 })
      .toFile(imagePath.replace(/\.jpg$/i, '.webp'));
    savedImagePath = imagePath;
    console.log(`OG image saved: blog/posts/images/${imageFilename} (+ .webp)`);
  } else {
    console.log('OPENAI_API_KEY not set — skipping OG image generation.');
  }

  fs.writeFileSync(
    path.join(__dirname, 'post-meta.json'),
    JSON.stringify({ title, excerpt, pillarId: pillar.id, postUrl: `${SITE_URL}/blog/posts/${filename}`, imagePath: savedImagePath }, null, 2),
    'utf8'
  );

  // Commit-able research artifact (non-ignored path) so the newsletter reuses the
  // SAME cited data instead of running its own Tavily pass. Shape matches
  // research_topic.py + the chosen signal's metadata.
  if (withSignals && signal) {
    fs.mkdirSync(RESEARCH_DIR, { recursive: true });
    const researchOut = {
      ...(research || { insights: [], stats: [], quotes: [], time_series: [], summary: '', sources: [] }),
      slug,
      pillar: pillar.id,
      post_url: `${SITE_URL}/blog/posts/${filename}`,
      signal: { title: signal.title, source: signal.source, url: signal.url, date: signal.date }
    };
    fs.writeFileSync(path.join(RESEARCH_DIR, `${slug}.json`), JSON.stringify(researchOut, null, 2), 'utf8');
    console.log(`Research saved: blog/posts/research/${slug}.json`);
    recordUsedSignal(signal);
    console.log('Signal recorded in used-signals ledger.');
  }

  updateBlogIndex(listItem);
  console.log('Blog index updated.');

  // Regenerate sitemap with all posts including the new one
  const allPosts = getAllPostMeta();
  fs.writeFileSync(SITEMAP, generateSitemap(allPosts), 'utf8');
  console.log(`Sitemap updated: ${allPosts.length} post(s) indexed.`);

  fs.writeFileSync(FEED, generateFeed(allPosts), 'utf8');
  console.log(`Feed updated: ${Math.min(allPosts.length, FEED_MAX_ITEMS)} item(s).`);

  fs.writeFileSync(ROBOTS, generateRobotsTxt(), 'utf8');
  console.log('robots.txt updated.');
}

/* main() used to run on import, so merely importing this module published a post and
 * spent a paid API call. That has bitten this repo before. Run it only when the file
 * is the process entrypoint, which also lets the sitemap/feed builders be reused
 * without generating anything. */
const isEntrypoint = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

export { getAllPostMeta, generateSitemap, generateFeed, generateRobotsTxt };
