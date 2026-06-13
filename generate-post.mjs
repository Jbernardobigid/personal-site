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
import { fileURLToPath } from 'url';
import { generatePostImage } from './generate-image.mjs';
import { selectSignal, recordUsedSignal } from './signals.mjs';
import { researchTopic } from './research.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BLOG_DIR    = path.join(__dirname, 'blog');
const POSTS_DIR   = path.join(BLOG_DIR, 'posts');
const IMAGES_DIR  = path.join(POSTS_DIR, 'images');
const RESEARCH_DIR = path.join(POSTS_DIR, 'research');
const INDEX_FILE = path.join(BLOG_DIR, 'index.html');
const SITEMAP    = path.join(__dirname, 'sitemap.xml');
const ROBOTS     = path.join(__dirname, 'robots.txt');

// Set SITE_URL as a GitHub Actions secret for the live URL.
// When you get a custom domain, update the secret value — everything regenerates automatically.
const SITE_URL = (process.env.SITE_URL || 'https://jorgebernardo.tech').replace(/\/$/, '');

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

/* ── Existing posts (for sitemap) ────────────────────────── */

function getAllPostMeta() {
  if (!fs.existsSync(POSTS_DIR)) return [];
  return fs.readdirSync(POSTS_DIR)
    .filter(f => f.endsWith('.html'))
    .map(filename => {
      const dateMatch = filename.match(/^(\d{4}-\d{2}-\d{2})/);
      return { filename, date: dateMatch ? dateMatch[1] : isoDate(new Date()) };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

/* ── Utilities ───────────────────────────────────────────── */

function slugify(text) {
  return text
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .substring(0, 60);
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

function escapeJson(str) {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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

/* ── Post HTML builder ───────────────────────────────────── */

function buildPostHtml({ title, excerpt, pillar, date, readTime, content, filename, imageUrl }) {
  const formattedDate = formatDate(date);
  const iso = isoDate(date);
  const postUrl = `${SITE_URL}/blog/posts/${filename}`;

  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: title,
    description: excerpt,
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
<title>${escapeHtml(title)} — Jorge Bernardo</title>
<meta name="description" content="${escapeJson(excerpt)}">
<link rel="canonical" href="${postUrl}">
<meta property="og:type" content="article">
<meta property="og:title" content="${escapeJson(title)}">
<meta property="og:description" content="${escapeJson(excerpt)}">
<meta property="og:url" content="${postUrl}">
<meta property="og:locale" content="pt_BR">
${imageUrl ? `<meta property="og:image" content="${imageUrl}">
<meta property="og:image:width" content="1536">
<meta property="og:image:height" content="1024">` : ''}
<meta name="twitter:card" content="${imageUrl ? 'summary_large_image' : 'summary'}">
<meta name="twitter:image" content="${imageUrl ?? ''}">
<meta property="og:site_name" content="Jorge Bernardo">
<meta property="article:author" content="Jorge Bernardo">
<meta property="article:published_time" content="${iso}">
<meta name="twitter:title" content="${escapeJson(title)}">
<meta name="twitter:description" content="${escapeJson(excerpt)}">
<link rel="icon" href="../../brand_assets/logo_page_20.png" type="image/png">
<script>
  window.si = window.si || function () { (window.siq = window.siq || []).push(arguments); };
</script>
<script defer src="/_vercel/speed-insights/script.js"></script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+Display:ital,wght@0,300;0,400;0,700;0,900;1,300;1,400;1,700;1,900&family=Lora:ital,wght@0,400;0,500;0,600;1,400;1,500&family=DM+Mono:wght@300;400;500&display=swap" rel="stylesheet">
<script type="application/ld+json">
${jsonLd}
</script>
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

<article class="post-body" itemscope itemtype="https://schema.org/BlogPosting">
${sanitizeContent(content)}
</article>

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

function generateSitemap(posts) {
  const postEntries = posts.map(p => `  <url>
    <loc>${SITE_URL}/blog/posts/${escapeXml(p.filename)}</loc>
    <lastmod>${p.date}</lastmod>
    <changefreq>never</changefreq>
    <priority>0.7</priority>
  </url>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${SITE_URL}/</loc>
    <changefreq>monthly</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>${SITE_URL}/blog/</loc>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
${postEntries}
</urlset>`;
}

/* ── robots.txt ──────────────────────────────────────────── */

function generateRobotsTxt() {
  return `User-agent: *
Allow: /

Sitemap: ${SITE_URL}/sitemap.xml
`;
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
        const query = `${signal.title} ${signal.source} Brasil`.trim();
        console.log('Researching the signal (Tavily + synthesis)...');
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

  const userPrompt = `Write a blog post on the topic pillar: "${pillar.label}" — ${pillar.description}${signalBlock}${researchBlock}

Requirements:
- Title: compelling, specific, not generic (in Portuguese)
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
- Sentence rhythm should feel uneven and human — not every paragraph the same length${groundingRequirements}`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    tools: [{
      name: 'create_blog_post',
      description: 'Create a blog post with title, excerpt, and HTML content',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'The blog post title in Portuguese' },
          excerpt: { type: 'string', description: 'One sentence excerpt (~25 words max) in Portuguese, no surrounding quotes' },
          content: { type: 'string', description: 'Full HTML post body using only p, h2, h3, strong, em, blockquote>p, ul>li tags. Do NOT include the title.' }
        },
        required: ['title', 'excerpt', 'content']
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
  const excerpt = sanitizeEmDashes(parsed.excerpt);
  const content = sanitizeEmDashes(parsed.content);
  const date = new Date();
  const readTime = estimateReadTime(content);
  const slug = slugify(title);
  const filename = `${isoDate(date)}-${slug}.html`;
  const postPath = path.join(POSTS_DIR, filename);
  const imageFilename = `${isoDate(date)}-${slug}.png`;
  const imagePath = path.join(IMAGES_DIR, imageFilename);
  const imageUrl = `${SITE_URL}/blog/posts/images/${imageFilename}`;

  const postHtml = buildPostHtml({ title, excerpt, pillar, date, readTime, content, filename, imageUrl });
  const listItem = buildPostListItem({ title, pillar, date, excerpt, filename });

  if (dryRun) {
    console.log('\n--- DRY RUN: Title ---');
    console.log(title);
    console.log('\n--- DRY RUN: Excerpt ---');
    console.log(excerpt);
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
    const imageBuffer = await generatePostImage(pillar.id, process.env.OPENAI_API_KEY);
    fs.writeFileSync(imagePath, imageBuffer);
    savedImagePath = imagePath;
    console.log(`OG image saved: blog/posts/images/${imageFilename}`);
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

  fs.writeFileSync(ROBOTS, generateRobotsTxt(), 'utf8');
  console.log('robots.txt updated.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
