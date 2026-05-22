/**
 * generate-post.mjs
 * Generates a blog post for Jorge Bernardo's site using the Claude API.
 * Rotates through 5 topic pillars, writes the post HTML, and updates blog/index.html.
 *
 * Usage:
 *   node generate-post.mjs
 *   node generate-post.mjs --pillar data-security   (force a specific pillar)
 *   node generate-post.mjs --dry-run                (generate but don't write files)
 *
 * Requires: ANTHROPIC_API_KEY environment variable
 */

import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BLOG_DIR   = path.join(__dirname, 'blog');
const POSTS_DIR  = path.join(BLOG_DIR, 'posts');
const INDEX_FILE = path.join(BLOG_DIR, 'index.html');

const PILLARS = [
  {
    id: 'data-security',
    label: 'Segurança de Dados',
    description: 'Data security, AI governance, privacy engineering, LGPD/GDPR compliance, enterprise data protection trends, BigID use cases, privacy-by-design'
  },
  {
    id: 'entrepreneurship',
    label: 'Empreendedorismo',
    description: 'Black entrepreneurship in Brazil, Afro-Brazilian business, racial equity in business, Feira Preta, community-driven ventures, building ventures with cultural identity'
  },
  {
    id: 'cycling',
    label: 'Ciclismo',
    description: 'Cycling as identity and activism, Black cyclists in Brazil, diversity in cycling culture, DePretoPraPreto mission, Team Africa Rising, urban cycling, sport as political act'
  },
  {
    id: 'brand',
    label: 'Marcas',
    description: 'Building brands with meaning, aesthetics meets strategy, brand identity, purpose-driven design, cultural branding, how design serves community'
  },
  {
    id: 'wellness',
    label: 'Wellness',
    description: 'Wellness and performance technology, afterALL platform, athlete mindset, disciplina, mental health and sport, tech applied to human performance'
  }
];

const JORGE_CONTEXT = `
Jorge Bernardo is a Brazilian professional with a rare dual identity:

PROFESSIONAL CAREER (15+ years):
- Sr. Technical Trainer at BigID (2024–present): designs and leads global learning experiences in data security and AI governance for engineers, architects, and privacy professionals across LATAM, North America, Europe, and APAC.
- Senior Delivery Services Engineer at BigID (2021–2024): led technical implementations for enterprise clients globally.
- Client Solutions Manager & Senior Cyber Engineer, LATAM at Forcepoint (2018–2021): SME in pre-sales for cybersecurity solutions across Latin America.
- DLP Technical Account Manager → Principal TAM at Symantec (2010–2018): 8 years protecting enterprise data at scale.

ENTREPRENEURIAL VENTURES:
- Founder, DePretoPraPreto (2022–present): Afro-Brazilian cycling brand — jerseys, identity, movement. Built on the conviction that Black beauty, excellence, and cycling have always walked together.
- Founder, afterALL: wellness technology platform.
- Presence at Feira Preta, Brazil's largest Black culture festival.

EDUCATION:
- MBA, FGV (2022–2024)
- Postgraduate in Privacy, IDESP (2024–2025)
- AI/ML, MIT / Instituto Infnet (2025–2026)
- Certifications: Symantec DLP, BigID Master Operator, ITIL V3

IDENTITY & VOICE:
- Black Brazilian man. Cyclist. Builder. Activist.
- Speaks Portuguese, English, and Spanish.
- Believes aesthetics and strategy are inseparable.
- Personal brand tagline: "Quando a estética encontra a estratégia, as pessoas não conseguem deixar de notar."
- Writes in Brazilian Portuguese.
`;

function getNextPillar() {
  if (!fs.existsSync(POSTS_DIR)) return PILLARS[0];
  const files = fs.readdirSync(POSTS_DIR).filter(f => f.endsWith('.html'));
  if (files.length === 0) return PILLARS[0];

  // Read pillar metadata from the most recent post files to find rotation position
  const pillarCounts = Object.fromEntries(PILLARS.map(p => [p.id, 0]));
  for (const file of files) {
    const content = fs.readFileSync(path.join(POSTS_DIR, file), 'utf8');
    const match = content.match(/data-pillar="([^"]+)"/);
    if (match && pillarCounts[match[1]] !== undefined) {
      pillarCounts[match[1]]++;
    }
  }
  // Pick the pillar with the fewest posts (round-robin)
  return PILLARS.reduce((least, p) => pillarCounts[p.id] < pillarCounts[least.id] ? p : least);
}

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
  return date.toLocaleDateString('pt-BR', {
    day: '2-digit', month: 'long', year: 'numeric'
  });
}

function isoDate(date) {
  return date.toISOString().split('T')[0];
}

function estimateReadTime(text) {
  const words = text.replace(/<[^>]+>/g, '').split(/\s+/).length;
  return Math.max(2, Math.round(words / 200));
}

function buildPostHtml({ title, pillar, date, readTime, content }) {
  const formattedDate = formatDate(date);
  const iso = isoDate(date);
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} — Jorge Bernardo</title>
<meta name="description" content="${title}">
<link rel="icon" href="../../brand_assets/logo_page_20.png" type="image/png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+Display:ital,wght@0,300;0,400;0,700;0,900;1,300;1,400;1,700;1,900&family=Lora:ital,wght@0,400;0,500;0,600;1,400;1,500&family=DM+Mono:wght@300;400;500&display=swap" rel="stylesheet">
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
    <div class="post-pillar" data-pillar="${pillar.id}">${pillar.label}</div>
    <h1 class="post-title">${title}</h1>
    <div class="post-byline">
      <span>Jorge Bernardo</span>
      <time datetime="${iso}">${formattedDate}</time>
      <span>${readTime} min de leitura</span>
    </div>
  </div>
</header>

<article class="post-body">
${content}
</article>

<div class="post-footer">
  <div class="author-block">
    <div class="author-name">Jorge Bernardo</div>
    <div class="author-role">Sr. Technical Trainer · Fundador · Ciclista</div>
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

  // Remove empty state placeholder if present
  html = html.replace(/\s*<div class="posts-empty">[\s\S]*?<\/div>/, '');

  // Insert new post at the top of the list
  html = html.replace(
    /(<div class="posts-list" id="postsList">)/,
    `$1\n${newEntry}`
  );

  fs.writeFileSync(INDEX_FILE, html, 'utf8');
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const forcePillar = args.includes('--pillar') ? args[args.indexOf('--pillar') + 1] : null;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('Error: ANTHROPIC_API_KEY environment variable is not set.');
    process.exit(1);
  }

  const pillar = forcePillar
    ? PILLARS.find(p => p.id === forcePillar) || getNextPillar()
    : getNextPillar();

  console.log(`Generating post for pillar: ${pillar.label}`);

  const client = new Anthropic({ apiKey });

  const systemPrompt = `You are a ghostwriter creating blog posts for Jorge Bernardo. Write in first person, in Brazilian Portuguese, in Jorge's authentic voice — thoughtful, direct, culturally grounded, never corporate.

${JORGE_CONTEXT}

Writing style:
- First person ("Aprendi que...", "Acredito que...", "Na minha experiência...")
- Conversational but substantive — like a smart friend writing, not a LinkedIn post
- Mix personal experience with broader insight
- No hollow motivational phrases or corporate jargon
- Use concrete examples from Jorge's actual experience when relevant
- Paragraphs are short (2-4 sentences max)
- End with something that opens a question or invites reflection, not a call-to-action`;

  const userPrompt = `Write a blog post on the topic pillar: "${pillar.label}" — ${pillar.description}

Requirements:
- Title: compelling, specific, not generic (in Portuguese)
- Length: 600-900 words of body content
- Structure: flowing prose with 2-3 H2 subheadings
- Include at least one blockquote that captures a key insight
- First paragraph must be a strong hook that draws the reader in immediately
- The post should feel authentic to Jorge's dual identity as a data/tech professional AND an entrepreneur/activist/cyclist

Respond with a JSON object:
{
  "title": "...",
  "excerpt": "One sentence excerpt for the blog listing page (in Portuguese, ~25 words)",
  "content": "Full HTML post body — use <p>, <h2>, <h3>, <strong>, <em>, <blockquote><p>...</p></blockquote>, <ul><li>...</li></ul> tags only. Do NOT include the title in the content."
}`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    messages: [{ role: 'user', content: userPrompt }],
    system: systemPrompt,
  });

  const raw = response.content[0].text;

  let parsed;
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    console.error('Failed to parse Claude response as JSON.');
    console.error(raw);
    process.exit(1);
  }

  const { title, excerpt, content } = parsed;
  const date = new Date();
  const readTime = estimateReadTime(content);
  const slug = slugify(title);
  const filename = `${isoDate(date)}-${slug}.html`;
  const postPath = path.join(POSTS_DIR, filename);

  const postHtml = buildPostHtml({ title, pillar, date, readTime, content });
  const listItem = buildPostListItem({ title, pillar, date, excerpt, filename });

  if (dryRun) {
    console.log('\n--- DRY RUN: Post HTML (first 500 chars) ---');
    console.log(postHtml.substring(0, 500));
    console.log('\n--- DRY RUN: List item ---');
    console.log(listItem);
    console.log('\nDry run complete. No files written.');
    return;
  }

  fs.mkdirSync(POSTS_DIR, { recursive: true });
  fs.writeFileSync(postPath, postHtml, 'utf8');
  updateBlogIndex(listItem);

  console.log(`Post created: blog/posts/${filename}`);
  console.log(`Blog index updated: blog/index.html`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
