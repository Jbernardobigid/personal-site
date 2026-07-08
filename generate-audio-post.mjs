/**
 * generate-audio-post.mjs
 * Blog → audio: narrates a blog post with Jorge's ElevenLabs voice clone and
 * publishes it as a podcast episode of "A Interseção" (same essay universe as
 * the newsletter).
 *
 * Pipeline: resolve post → idempotency check (podcast-episodes.json ledger) →
 * extract article text → Claude adaptation pass (written → spoken pt-BR, full
 * essay, not a summary) → orthography/unit fixes (shared tts.mjs) → char-cap
 * guard → single TTS call → duration probe → upload MP3 to Vercel Blob
 * (deterministic path podcast/{slug}.mp3) → append ledger → regenerate
 * podcast.xml (RSS 2.0 + itunes) → inject branded <audio> player into the
 * post HTML.
 *
 * Usage:
 *   node generate-audio-post.mjs                       (latest post by filename sort)
 *   node generate-audio-post.mjs blog/posts/<file>.html  (backfill a specific post)
 *   node generate-audio-post.mjs --dry-run             (spoken script + char count only)
 *   node generate-audio-post.mjs --force               (regenerate even if in ledger)
 *   node generate-audio-post.mjs --feed-only           (rewrite podcast.xml from the ledger, no API calls)
 *   node generate-audio-post.mjs --relink              (re-render the player block in every ledgered post, no API calls — for player/link markup changes)
 *
 * Requires: ANTHROPIC_API_KEY, ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID,
 * BLOB_READ_WRITE_TOKEN. Optional: AUDIO_MAX_CHARS (default 9000, posts over it
 * are SKIPPED, never truncated), AUDIO_TTS_MODEL (default eleven_multilingual_v2;
 * eleven_flash_v2_5 = 0.5 credits/char escape hatch). ffprobe on PATH (falls
 * back to a CBR byte estimate).
 */

import './load-env.mjs';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import { put } from '@vercel/blob';
import { expandSpokenUnits, fixOrthographyLines, tts } from './tts.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POSTS_DIR = path.join(__dirname, 'blog', 'posts');
const WORK_DIR = path.join(__dirname, 'audio-work');
const LEDGER_FILE = path.join(__dirname, 'podcast-episodes.json');
const FEED_FILE = path.join(__dirname, 'podcast.xml');

const SITE_URL = (process.env.SITE_URL || 'https://www.jorgebernardo.tech').replace(/\/$/, '');
const SHOW_TITLE = 'A Interseção';
const SHOW_DESCRIPTION = 'Ensaios de Jorge Bernardo sobre tecnologia, identidade e carreira, narrados com a própria voz. A versão em áudio do blog jorgebernardo.tech.';
const SHOW_AUTHOR = 'Jorge Bernardo';
// Assigned by Spotify for Creators after RSS import (2026-07-08). No Apple Podcasts
// show URL yet — add a second link here once that submission is approved.
const SHOW_SPOTIFY_URL = 'https://open.spotify.com/show/033LX6pnZMW4pYSva5tQu1';
const SHOW_OWNER_EMAIL = 'jorge.mbernardo@gmail.com';
const AUDIO_MAX_CHARS = Number(process.env.AUDIO_MAX_CHARS) || 9000;
const TTS_MODEL = process.env.AUDIO_TTS_MODEL || 'eleven_multilingual_v2';

/* ── Post resolution + text extraction ───────────────────── */

function resolvePostFile(args) {
  const explicit = args.find(a => !a.startsWith('--'));
  if (explicit) {
    const p = path.resolve(__dirname, explicit);
    if (!fs.existsSync(p)) throw new Error(`post not found: ${p}`);
    return p;
  }
  const latest = fs.readdirSync(POSTS_DIR).filter(f => f.endsWith('.html')).sort().pop();
  if (!latest) throw new Error('no posts in blog/posts');
  return path.join(POSTS_DIR, latest);
}

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function extractPost(file) {
  const html = fs.readFileSync(file, 'utf8');
  const title = decodeEntities((html.match(/<title>([^<]+)<\/title>/) ?? [])[1] ?? path.basename(file))
    .replace(' — Jorge Bernardo', '').trim();
  const excerpt = decodeEntities((html.match(/<meta name="description" content="([^"]*)"/) ?? [])[1] ?? '');
  const iso = (html.match(/article:published_time" content="([^"]+)"/) ?? [])[1]
    ?? path.basename(file).slice(0, 10);
  const articleMatch = html.match(/<article class="post-body"[^>]*>([\s\S]*?)<\/article>/);
  if (!articleMatch) throw new Error('no <article class="post-body"> in post');
  // Headings become their own marked paragraphs so the adaptation pass can turn
  // them into spoken transitions instead of reading them as flat sentences.
  const text = articleMatch[1]
    .replace(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi, '\n\n[Subtítulo] $1\n\n')
    .replace(/<(?:p|blockquote|li)[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .split(/\n{2,}/).map(p => decodeEntities(p).replace(/\s+/g, ' ').trim()).filter(Boolean);
  const slug = path.basename(file, '.html');
  return { file, slug, title, excerpt, iso, paragraphs: text };
}

/* ── Claude adaptation: written essay → spoken script ────── */

async function adaptToSpoken(client, post) {
  const res = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8000,
    tools: [{
      name: 'spoken_script',
      description: 'O roteiro falado do episódio, parágrafo a parágrafo.',
      input_schema: {
        type: 'object',
        properties: {
          paragraphs: { type: 'array', items: { type: 'string' }, description: 'Parágrafos do roteiro falado, em ordem.' }
        },
        required: ['paragraphs']
      }
    }],
    tool_choice: { type: 'tool', name: 'spoken_script' },
    messages: [{
      role: 'user',
      content: `Adapte o ensaio abaixo, escrito por Jorge Bernardo para o blog dele, em um roteiro FALADO em português do Brasil para o podcast "A Interseção" — narrado pelo próprio Jorge em primeira pessoa.

Regras:
- O PRIMEIRO parágrafo deve ser exatamente: "Você está ouvindo A Interseção. Eu sou Jorge Bernardo. Hoje: ${post.title}."
- É o MESMO ensaio completo, não um resumo. Preserve todos os argumentos, dados, citações e a ordem das ideias.
- Adapte a linguagem escrita para falada: frases um pouco mais curtas, conectivos naturais de fala.
- As linhas marcadas com [Subtítulo] são títulos de seção — transforme cada uma em uma transição falada natural (nunca leia "subtítulo").
- NUNCA use travessão (—). Reescreva com vírgula ou ponto.
- Sem referências visuais ("como você vê acima", "no gráfico").
- O ÚLTIMO parágrafo é uma despedida curta apontando para o blog, no espírito de: "Esse ensaio, e todos os outros, está completo no blog, em jorgebernardo ponto tech. Até a próxima." (pode variar a frase, mantenha curto).

ENSAIO — "${post.title}":

${post.paragraphs.join('\n\n')}`
    }]
  });
  const tool = res.content.find(b => b.type === 'tool_use');
  if (!tool || !Array.isArray(tool.input.paragraphs) || tool.input.paragraphs.length === 0) {
    throw new Error('no spoken script returned');
  }
  return tool.input.paragraphs.map(p => String(p).replace(/\s*[—–]\s*/g, ', ').replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/* ── Ledger + feed ───────────────────────────────────────── */

function readLedger() {
  return fs.existsSync(LEDGER_FILE) ? JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8')) : [];
}

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function formatDuration(sec) {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return `${h ? h + ':' + String(m).padStart(2, '0') : m}:${String(r).padStart(2, '0')}`;
}

function generateFeed(episodes) {
  const items = episodes.map(e => `    <item>
      <title>${escapeXml(e.title)}</title>
      <description>${escapeXml(e.description)}</description>
      <link>${escapeXml(e.postUrl)}</link>
      <guid isPermaLink="false">${escapeXml(e.audioUrl)}</guid>
      <pubDate>${e.pubDate}</pubDate>
      <enclosure url="${escapeXml(e.audioUrl)}" length="${e.bytes}" type="audio/mpeg"/>
      <itunes:duration>${formatDuration(e.durationSec)}</itunes:duration>
      <itunes:author>${escapeXml(SHOW_AUTHOR)}</itunes:author>
      <itunes:explicit>false</itunes:explicit>
    </item>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(SHOW_TITLE)}</title>
    <link>${SITE_URL}/blog/</link>
    <atom:link href="${SITE_URL}/podcast.xml" rel="self" type="application/rss+xml"/>
    <language>pt-br</language>
    <description>${escapeXml(SHOW_DESCRIPTION)}</description>
    <itunes:author>${escapeXml(SHOW_AUTHOR)}</itunes:author>
    <itunes:owner>
      <itunes:name>${escapeXml(SHOW_AUTHOR)}</itunes:name>
      <itunes:email>${SHOW_OWNER_EMAIL}</itunes:email>
    </itunes:owner>
    <itunes:image href="${SITE_URL}/podcast-cover.jpg"/>
    <itunes:category text="Society &amp; Culture"/>
    <itunes:explicit>false</itunes:explicit>
${items}
  </channel>
</rss>
`;
}

/* ── Player injection into post HTML ─────────────────────── */

// Keep in sync with the .audio-* rules in generate-post.mjs buildPostHtml —
// this copy is only injected into posts generated BEFORE the audio feature
// (backfill), whose <style> block predates those rules.
const AUDIO_CSS = `
.audio-block{max-width:820px;margin:0 auto;padding:36px 52px 0}
.audio-panel{border:1px solid var(--border-terra);background:rgba(94,65,45,0.07);padding:20px 24px;border-radius:1px}
.audio-label{font-family:var(--font-mono);font-size:10px;letter-spacing:0.16em;text-transform:uppercase;color:var(--terra-light);margin-bottom:14px}
.audio-panel audio{width:100%;height:36px;color-scheme:dark}
.audio-spotify{display:inline-block;margin-top:12px;font-family:var(--font-mono);font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:var(--terra-light);text-decoration:none;border-bottom:1px solid var(--border-terra);padding-bottom:2px;transition:color .2s,border-color .2s}
.audio-spotify:hover{color:var(--white);border-color:rgba(255,255,255,0.3)}
@media(max-width:768px){.audio-block{padding-left:24px;padding-right:24px}}`;

function buildPlayerBlock(audioUrl, durationSec) {
  const min = Math.max(1, Math.round(durationSec / 60));
  return `<div class="audio-block">
  <div class="audio-panel">
    <div class="audio-label">Ouça este ensaio · ${min} min · ${SHOW_TITLE}</div>
    <audio controls preload="none" src="${audioUrl}"></audio>
    <a class="audio-spotify" href="${SHOW_SPOTIFY_URL}" target="_blank" rel="noopener">Ouça no Spotify ↗</a>
  </div>
</div>`;
}

function injectPlayer(file, audioUrl, durationSec) {
  let html = fs.readFileSync(file, 'utf8');
  const block = buildPlayerBlock(audioUrl, durationSec);
  // Re-runs (--force / --relink) replace the existing block instead of stacking a
  // second one. Generic enough to match both the pre-Spotify-link and current shape.
  const existing = /<div class="audio-block">[\s\S]*?<\/div>\s*<\/div>/;
  if (existing.test(html)) {
    html = html.replace(existing, block);
  } else if (html.includes('<!-- audio-player-slot -->')) {
    html = html.replace('<!-- audio-player-slot -->', block);
  } else {
    html = html.replace(/<\/header>/, `</header>\n\n${block}`);
  }
  if (!html.includes('.audio-block{')) {
    html = html.replace('</style>', `${AUDIO_CSS}\n</style>`);
  }
  fs.writeFileSync(file, html, 'utf8');
}

/* ── Duration ────────────────────────────────────────────── */

function probeDuration(file, bytes) {
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    const d = parseFloat(out.toString().trim());
    if (Number.isFinite(d) && d > 0) return d;
  } catch { /* fall through to CBR estimate */ }
  return bytes * 8 / 128000; // mp3_44100_128 is CBR 128 kbps
}

/* ── Main ────────────────────────────────────────────────── */

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');

  if (args.includes('--feed-only')) {
    const episodes = readLedger();
    fs.writeFileSync(FEED_FILE, generateFeed(episodes), 'utf8');
    console.log(`podcast.xml rewritten from ledger (${episodes.length} episodes)`);
    return;
  }

  if (args.includes('--relink')) {
    for (const e of readLedger()) {
      const file = path.join(POSTS_DIR, e.filename);
      if (!fs.existsSync(file)) { console.log(`  skip (missing file): ${e.filename}`); continue; }
      injectPlayer(file, e.audioUrl, e.durationSec);
      console.log(`  relinked: ${e.filename}`);
    }
    return;
  }

  const postFile = resolvePostFile(args);
  const post = extractPost(postFile);
  console.log(`Post: ${post.slug}`);
  console.log(`  "${post.title}" (${post.paragraphs.length} paragraphs)`);

  const ledger = readLedger();
  if (!force && ledger.some(e => e.slug === post.slug)) {
    console.log('  already has audio (use --force to regenerate) — nothing to do');
    return;
  }

  console.log('Adapting to spoken script (Claude)...');
  const anthropic = new Anthropic();
  let paragraphs = await adaptToSpoken(anthropic, post);
  paragraphs = await fixOrthographyLines(anthropic, paragraphs);
  paragraphs = paragraphs.map(expandSpokenUnits);
  const script = paragraphs.join('\n\n');

  const monthChars = ledger
    .filter(e => e.pubDate && new Date(e.pubDate).toISOString().slice(0, 7) === new Date().toISOString().slice(0, 7))
    .reduce((sum, e) => sum + (e.chars || 0), 0);
  console.log(`  script: ${script.length} chars (month-to-date before this run: ${monthChars})`);

  if (script.length > AUDIO_MAX_CHARS) {
    console.log(`  SKIP: script exceeds AUDIO_MAX_CHARS=${AUDIO_MAX_CHARS} — post ships without audio`);
    return;
  }

  if (dryRun) {
    console.log('\n─── spoken script (dry run) ───\n');
    console.log(script);
    return;
  }

  fs.mkdirSync(WORK_DIR, { recursive: true });
  const mp3Path = path.join(WORK_DIR, `${post.slug}.mp3`);
  console.log(`TTS (${TTS_MODEL})...`);
  await tts(script, mp3Path, { modelId: TTS_MODEL });
  const bytes = fs.statSync(mp3Path).size;
  const durationSec = probeDuration(mp3Path, bytes);
  console.log(`  ${(bytes / 1024 / 1024).toFixed(1)} MB, ${formatDuration(durationSec)}`);

  console.log('Uploading to Vercel Blob...');
  const blob = await put(`podcast/${post.slug}.mp3`, fs.readFileSync(mp3Path), {
    access: 'public', addRandomSuffix: false, contentType: 'audio/mpeg', allowOverwrite: true
  });
  console.log(`  ${blob.url}`);

  const episode = {
    slug: post.slug,
    title: post.title,
    description: post.excerpt,
    postUrl: `${SITE_URL}/blog/posts/${post.slug}.html`,
    audioUrl: blob.url,
    bytes,
    durationSec: Math.round(durationSec),
    chars: script.length,
    pubDate: new Date(`${post.iso}T12:00:00Z`).toUTCString(),
    filename: `${post.slug}.html`,
  };
  // Newest first regardless of generation order (backfills run oldest posts last).
  const updated = [episode, ...ledger.filter(e => e.slug !== post.slug)]
    .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  fs.writeFileSync(LEDGER_FILE, JSON.stringify(updated, null, 2) + '\n', 'utf8');
  fs.writeFileSync(FEED_FILE, generateFeed(updated), 'utf8');
  injectPlayer(postFile, blob.url, durationSec);
  console.log(`Done: ledger + podcast.xml + player in ${path.basename(postFile)}`);
  console.log(`  month-to-date TTS chars incl. this run: ${monthChars + script.length}`);
}

main().catch(err => { console.error(err.message ?? err); process.exit(1); });
