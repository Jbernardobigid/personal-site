/**
 * generate-video.mjs
 * Turns a blog post into a dynamic, educational, ~45-55s, 9:16 Instagram video:
 * Portuguese voiceover, typographic b-roll behind every scene, staggered kinetic
 * text reveals, word-synced "karaoke" captions, and a subtle music bed. Faceless.
 *
 * DEFAULT b-roll is TYPOGRAPHIC (Direction A, 2026-07-06): each scene gets an
 * oversized canvas in the carousel design system (layered radial gradients, SVG
 * grain, diagonal watermark, giant ghost chapter numeral, gold rings) that ffmpeg
 * slowly pans/zooms across with living film grain — brand-pure and zero API cost.
 * Jorge rejected literal imagery (KIE AI clips and his own photos) for this format;
 * both remain available behind flags only.
 *
 * Pipeline: Claude script (5 scenes) -> ElevenLabs TTS per scene (Jorge's cloned
 * voice) -> Puppeteer renders each scene's design bg + 2 transparent text layers
 * (intro=chrome+label, headline) -> ffmpeg composites moving bg + staggered text
 * + audio per scene -> concat (fade open/close) -> Whisper WORD timestamps ->
 * karaoke ASS captions -> music bed mix -> videos/{date}-{slug}/video.mp4.
 *
 * Usage:
 *   node generate-video.mjs <post.html>               (typographic b-roll; default)
 *   node generate-video.mjs --topic-file <json>       (Reel from a cycling-topics.mjs concept, no blog post)
 *   node generate-video.mjs <post.html> --image-broll (gpt-image-2 stills, Ken Burns)
 *   node generate-video.mjs <post.html> --mixed-broll (real cycling photos interleaved with gpt-image-2 stills — Phase 4 cycling default)
 *   node generate-video.mjs <post.html> --kie-broll   (AI video b-roll via KIE — DROPPED from the plan 2026-07-07, flag kept)
 *   node generate-video.mjs <post.html> --real-broll  (real-footage photos only, Ken Burns)
 *   node generate-video.mjs <post.html> --seconds 50 | --dry-run
 *
 * Requires: ANTHROPIC_API_KEY, ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID (voiceover),
 * OPENAI_API_KEY (Whisper caption timestamps + gpt-image-2 stills). b-roll: kIE_API_KEY
 * only for --kie-broll. Music: assets/music/bed.mp3 (optional). ffmpeg+ffprobe on PATH.
 */

import './load-env.mjs';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME_PATH || 'C:/Users/Jorge Bernardo/.cache/puppeteer/chrome/win64-148.0.7778.167/chrome-win64/chrome.exe';
const SCENE_TEMPLATE = path.join(__dirname, 'templates', 'video', 'scene.html');
const SCENE_BG_TEMPLATE = path.join(__dirname, 'templates', 'video', 'scene-bg.html');
const VIDEOS_DIR = path.join(__dirname, 'videos');
const POSTS_DIR = path.join(__dirname, 'blog', 'posts');
const MUSIC_BED = path.join(__dirname, 'assets', 'music', 'bed.mp3');
const REAL_BROLL_PHOTOS_DIR = path.join(__dirname, 'assets', 'b-roll', 'photos');
// Below this, the library is mostly small reference/icon images mixed into the
// consolidated folder (named pro-cyclist portraits, generic fitness icons) rather
// than Jorge's own race photos — exclude them rather than manually tag 1,400+ files.
const REAL_BROLL_MIN_BYTES = 200_000;

const W = 1080, H = 1920, FPS = 30;
// Typographic bg canvas is rendered 1.2x oversize so zoompan has pan/zoom headroom.
const BG_W = 1296, BG_H = 2304, BG_MAX_ZOOM = 1.2;
const BG_COLOR = '0x18233E';
const KIE_BROLL_MODEL = process.env.KIE_BROLL_MODEL || 'bytedance/seedance-2-fast';
// 480p by default — b-roll sits darkened/blurred behind text, so resolution barely
// shows but costs ~55% less than 720p (~252 → ~115 credits/clip). Override if needed.
const BROLL_RES = process.env.KIE_BROLL_RES || '480p';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function ff(bin, args, opts = {}) {
  return execFileSync(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...opts });
}
function ffprobeDuration(file) {
  return parseFloat(ff('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]).toString().trim());
}

/* ── 1. Post -> script (Claude) ──────────────────────────── */

function readPost(file) {
  const html = fs.readFileSync(file, 'utf8');
  const title = (html.match(/<title>([^<]+)<\/title>/) ?? [])[1]?.replace(' — Jorge Bernardo', '').trim() ?? path.basename(file);
  const plain = html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return { title, plain, kind: 'post' };
}

// A cycling-topics.mjs concept file becomes the same {title, plain} shape the
// script generator consumes — the concept's hook/angle/beats serialized as text.
function readTopicFile(file) {
  const t = JSON.parse(fs.readFileSync(file, 'utf8'));
  const plain = [
    `Gancho: ${t.hook}`,
    `Ângulo: ${t.angle}`,
    ...(t.beats ?? []).map((b, i) => `Batida ${i + 1}: ${b}`),
    `Fechamento: ${t.close}`,
  ].join(' ');
  return { title: t.title, plain, kind: 'topic' };
}

function loadRealPhotoCatalog() {
  if (!fs.existsSync(REAL_BROLL_PHOTOS_DIR)) return [];
  // REEL_PHOTO_FILTER: optional regex against filenames, narrowing picks to a
  // themed subset for one run (e.g. 'DSC00(2[7-9]|[3-5]\d|6[0-4])\d' = the
  // Major Taylor jersey shoot). Falls back to the full catalog if it matches nothing.
  const filterRe = process.env.REEL_PHOTO_FILTER ? new RegExp(process.env.REEL_PHOTO_FILTER, 'i') : null;
  const all = fs.readdirSync(REAL_BROLL_PHOTOS_DIR)
    .filter(f => /\.(jpe?g|png)$/i.test(f))
    .filter(f => !filterRe || filterRe.test(f))
    .map(f => path.join(REAL_BROLL_PHOTOS_DIR, f))
    .filter(f => { try { return fs.statSync(f).size > REAL_BROLL_MIN_BYTES; } catch { return false; } });
  if (all.length === 0 && filterRe) {
    console.warn('  ! REEL_PHOTO_FILTER matched nothing — using full catalog');
    return loadRealPhotoCatalogUnfiltered();
  }
  return all;
}

function loadRealPhotoCatalogUnfiltered() {
  return fs.readdirSync(REAL_BROLL_PHOTOS_DIR)
    .filter(f => /\.(jpe?g|png)$/i.test(f))
    .map(f => path.join(REAL_BROLL_PHOTOS_DIR, f))
    .filter(f => { try { return fs.statSync(f).size > REAL_BROLL_MIN_BYTES; } catch { return false; } });
}

function pickRealPhotos(n) {
  const pool = loadRealPhotoCatalog();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return Array.from({ length: n }, (_, i) => pool[i % pool.length] || null);
}

async function generateScript(client, post, seconds) {
  const wordBudget = Math.round(seconds * 2.2);
  const res = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    system: `Você roteiriza vídeos educativos curtos para o Instagram na voz de Jorge Bernardo: homem negro brasileiro, ciclista, profissional de tecnologia e segurança de dados, fundador da DePretoPraPreto. Primeira pessoa, português do Brasil, direto e reflexivo, sem clichê motivacional, SEM travessões (—), sem emojis. Ortografia e acentuação IMPECÁVEIS em todos os campos (ã, ç, é, í, ó, ô etc.) — o texto vira narração de voz e legenda na tela.`,
    tools: [{
      name: 'create_video_script',
      description: 'Roteiro de um vídeo vertical educativo com narração e texto na tela.',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Título curto do vídeo (PT-BR)' },
          caption: { type: 'string', description: 'Legenda de Instagram em PT-BR, voz do Jorge, ~70 palavras, termina aberta, SEM hashtags' },
          scenes: {
            type: 'array',
            description: 'Exatamente 5 cenas: a primeira é o gancho, a última fecha com reflexão.',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: 'Eyebrow de 1 a 3 palavras (vira maiúsculas na tela)' },
                headline: { type: 'string', description: 'Frase-chave curta na tela, no máximo 8 palavras, PT-BR' },
                narration: { type: 'string', description: 'O que a locução fala nesta cena, 1 a 2 frases naturais em PT-BR' },
                broll: { type: 'string', description: 'Descrição visual em INGLÊS de um b-roll abstrato e faceless que combine com a cena (ex: "close-up of bicycle wheel spinning at dawn, warm light")' }
              },
              required: ['label', 'headline', 'narration', 'broll']
            }
          },
          hashtags: { type: 'array', items: { type: 'string' } }
        },
        required: ['title', 'caption', 'scenes', 'hashtags']
      }
    }],
    tool_choice: { type: 'tool', name: 'create_video_script' },
    messages: [{
      role: 'user',
      content: `A partir ${post.kind === 'topic' ? 'desta pauta de Reel' : 'deste post do blog'}, escreva o roteiro de um vídeo educativo vertical de ~${seconds}s.
Regras RÍGIDAS de tamanho (o vídeo NÃO pode passar de ~${seconds}s):
- Exatamente 5 cenas.
- Cada "narration": 1 ou 2 frases curtas, NO MÁXIMO ~22 palavras.
- A soma de TODAS as narrações deve ficar entre ${wordBudget - 15} e ${wordBudget + 10} palavras.
Conteúdo: cena 1 gancho concreto; cenas do meio ensinam uma ideia cada; última fecha com imagem ou pergunta aberta (não CTA). "headline" curto (máx 8 palavras). "broll" é uma descrição visual EM INGLÊS, abstrata e sem rostos. Nada de travessões.

${post.kind === 'topic' ? 'PAUTA' : 'POST'}:
${post.plain.slice(0, 4000)}`
    }]
  });
  const tool = res.content.find(b => b.type === 'tool_use');
  if (!tool) throw new Error('no script returned');
  return tool.input;
}

// Claude's constrained tool-use JSON reliably starts dropping PT-BR diacritics partway
// through longer scripts ("Médico"→"Medico", "é"→"e") — and the TTS pronounces what's
// written, so this corrupts the audio, not just the captions. This pass restores
// accents via a plain-text call, with a hard guard: a corrected line is only accepted
// if it matches the original once diacritics are stripped, so it can NEVER reword.
async function fixOrthography(client, script) {
  const fields = [[script, 'title'], [script, 'caption']];
  for (const s of script.scenes) fields.push([s, 'label'], [s, 'headline'], [s, 'narration']);
  const originals = fields.map(([obj, key]) => String(obj[key] || '').replace(/\s+/g, ' ').trim());
  const numbered = originals.map((v, i) => `${i + 1}. ${v}`).join('\n');
  const res = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    system: 'Você é um revisor ortográfico de português do Brasil. Corrija APENAS acentos e cedilhas faltando ou errados. NÃO altere palavras, ordem, pontuação ou conteúdo. Responda SOMENTE com as linhas numeradas corrigidas, uma por linha, no mesmo formato.',
    messages: [{ role: 'user', content: numbered }]
  });
  const text = res.content.find(b => b.type === 'text')?.text || '';
  const bare = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
  for (const m of text.matchAll(/^(\d+)\.\s*(.+)$/gm)) {
    const i = +m[1] - 1, fixed = m[2].trim();
    if (i >= 0 && i < fields.length && bare(fixed) === bare(originals[i])) {
      const [obj, key] = fields[i];
      obj[key] = fixed;
    }
  }
  return script;
}

/* ── 2. TTS (ElevenLabs — Jorge's cloned voice) ──────────── */

// Settings picked by Jorge from A/B test 2026-07-06 ("variant B"): lower stability +
// some style for a lively, less read-aloud delivery; 1.08x speed (his clone's default
// pace read slightly slower than his real voice).
const ELEVEN_VOICE_SETTINGS = { stability: 0.38, similarity_boost: 0.8, style: 0.3, use_speaker_boost: true, speed: 1.08 };

async function tts(text, outPath) {
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2', voice_settings: ELEVEN_VOICE_SETTINGS })
  });
  if (!res.ok) throw new Error(`ElevenLabs TTS failed (${res.status}): ${await res.text()}`);
  fs.writeFileSync(outPath, Buffer.from(await res.arrayBuffer()));
}

/* ── 3. Scene text layers (Puppeteer) ────────────────────── */

async function renderSceneLayers(scenes, outDir, withDesignBg) {
  const tpl = fs.readFileSync(SCENE_TEMPLATE, 'utf8');
  const bgTpl = withDesignBg ? fs.readFileSync(SCENE_BG_TEMPLATE, 'utf8') : null;
  const total = String(scenes.length).padStart(2, '0');
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
    const layers = [];
    for (let i = 0; i < scenes.length; i++) {
      const num = String(i + 1).padStart(2, '0');
      const base = tpl.replace(/{{LABEL}}/g, esc(scenes[i].label)).replace(/{{HEADLINE}}/g, esc(scenes[i].headline))
        .replace(/{{NUM}}/g, num).replace(/{{TOTAL}}/g, total);
      const out = {};
      for (const only of ['intro', 'headline']) {
        const htmlPath = path.join(outDir, `s${i + 1}-${only}.html`);
        fs.writeFileSync(htmlPath, base.replace(/{{ONLY}}/g, `only-${only}`), 'utf8');
        await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle0', timeout: 20000 });
        await sleep(200);
        const png = path.join(outDir, `s${i + 1}-${only}.png`);
        await page.screenshot({ path: png, omitBackground: true, clip: { x: 0, y: 0, width: W, height: H } });
        fs.unlinkSync(htmlPath);
        out[only] = png;
      }
      layers.push(out);
    }
    if (withDesignBg) {
      await page.setViewport({ width: BG_W, height: BG_H, deviceScaleFactor: 1 });
      for (let i = 0; i < scenes.length; i++) {
        const num = String(i + 1).padStart(2, '0');
        const htmlPath = path.join(outDir, `s${i + 1}-bg.html`);
        fs.writeFileSync(htmlPath, bgTpl.replace(/{{VARIANT}}/g, `v${(i % 5) + 1}`).replace(/{{NUM}}/g, num), 'utf8');
        await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle0', timeout: 20000 });
        await sleep(200);
        const png = path.join(outDir, `s${i + 1}-bg.png`);
        await page.screenshot({ path: png, clip: { x: 0, y: 0, width: BG_W, height: BG_H } });
        fs.unlinkSync(htmlPath);
        layers[i].bg = png;
      }
    }
    return layers;
  } finally {
    await browser.close();
  }
}

/* ── 4. KIE b-roll (parallel, per scene) ─────────────────── */

async function generateBroll(prompt, outPath) {
  const key = process.env.kIE_API_KEY;
  if (!key) throw new Error('kIE_API_KEY not set');
  const create = await fetch('https://api.kie.ai/api/v1/jobs/createTask', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: KIE_BROLL_MODEL, input: { prompt, aspect_ratio: '9:16', resolution: BROLL_RES, duration: 8, generate_audio: false } })
  });
  const cj = await create.json();
  if (cj.code !== 200 || !cj.data?.taskId) throw new Error(`createTask failed: ${JSON.stringify(cj).slice(0, 160)}`);
  const taskId = cj.data.taskId;
  const start = Date.now();
  while (Date.now() - start < 480000) {
    const r = await (await fetch(`https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, { headers: { Authorization: `Bearer ${key}` } })).json();
    const st = r.data?.state;
    if (st === 'success') {
      const url = JSON.parse(r.data.resultJson || '{}').resultUrls?.[0];
      if (!url) throw new Error('no result url');
      fs.writeFileSync(outPath, Buffer.from(await (await fetch(url)).arrayBuffer()));
      return outPath;
    }
    if (st === 'fail') throw new Error(r.data?.failMsg || 'fail');
    await sleep(10000);
  }
  throw new Error('timed out');
}

function brollPrompt(scene) {
  return `Cinematic faceless vertical b-roll, atmospheric and premium, deep navy and warm amber tones, soft slow camera motion, shallow depth of field, film grain. Subject: ${scene.broll || scene.headline}. No human faces, no text, no logos.`;
}

async function generateBrollAll(scenes, outDir) {
  return Promise.all(scenes.map((s, i) => {
    const bp = path.join(outDir, `broll-${i + 1}.mp4`);
    return generateBroll(brollPrompt(s), bp).then(() => bp).catch(e => { console.warn(`  ! b-roll ${i + 1}: ${e.message}`); return null; });
  }));
}

/* ── 4b. gpt-image-2 still b-roll (parallel, per scene) ──── */

// Editorial still per scene, Ken Burns'd by the existing 'photo' branch in
// buildSceneClip. Faceless by prompt: when mixed with Jorge's REAL photos, an
// AI-generated identifiable rider would read as a different person — riders
// appear from behind / silhouette / detail only, and (house invariant, see
// generate-image.mjs) any human depicted is a Black Brazilian person.
function imageBrollPrompt(scene) {
  return `Editorial vertical photograph, cinematic and premium, deep navy and warm amber dawn tones, shallow depth of field, subtle film grain. Subject: ${scene.broll || scene.headline}. If any person appears they are a Black Brazilian cyclist seen from behind or in silhouette, never an identifiable face. No text, no logos, no watermarks.`;
}

async function generateImageStill(prompt, outPath, openai) {
  const res = await openai.images.generate({ model: 'gpt-image-2', prompt, n: 1, size: '1024x1536', quality: 'medium' });
  const item = res.data[0];
  const buf = item.b64_json
    ? Buffer.from(item.b64_json, 'base64')
    : Buffer.from(await (await fetch(item.url)).arrayBuffer());
  fs.writeFileSync(outPath, buf);
  return outPath;
}

async function generateImageBrollAll(scenes, outDir, openai, indices = null) {
  const wanted = indices ?? scenes.map((_, i) => i);
  const out = new Array(scenes.length).fill(null);
  await Promise.all(wanted.map(i => {
    const p = path.join(outDir, `img-${i + 1}.png`);
    return generateImageStill(imageBrollPrompt(scenes[i]), p, openai)
      .then(() => { out[i] = p; })
      .catch(e => { console.warn(`  ! image ${i + 1}: ${e.message}`); });
  }));
  return out;
}

/* ── 5. ffmpeg: one clip per scene ───────────────────────── */

// Camera moves over the typographic canvas, one per scene, chosen so the drift
// REVEALS that variant's ghost numeral (v1 numeral bottom-left -> zoom-in shows
// it; v2 top-right -> pan-up lands on it; etc.).
const DESIGN_MOTIONS = ['zoom-in', 'pan-up', 'pan-down', 'zoom-out', 'zoom-in-slow'];

function designMotionFilter(kind, duration) {
  const N = Math.max(1, Math.round(duration * FPS));
  const cx = `x='iw/2-(iw/zoom/2)'`, cy = `y='ih/2-(ih/zoom/2)'`;
  const tail = `d=1:s=${W}x${H}:fps=${FPS}`;
  switch (kind) {
    case 'pan-up': return `zoompan=z=${BG_MAX_ZOOM}:${cx}:y='(ih-ih/zoom)*max(1-on/${N},0)':${tail}`;
    case 'pan-down': return `zoompan=z=${BG_MAX_ZOOM}:${cx}:y='(ih-ih/zoom)*min(on/${N},1)':${tail}`;
    case 'zoom-out': return `zoompan=z='if(lte(on,1),${BG_MAX_ZOOM},max(zoom-0.0008,1.0))':${cx}:${cy}:${tail}`;
    case 'zoom-in-slow': return `zoompan=z='min(zoom+0.0005,${BG_MAX_ZOOM})':${cx}:${cy}:${tail}`;
    default: return `zoompan=z='min(zoom+0.0008,${BG_MAX_ZOOM})':${cx}:${cy}:${tail}`;
  }
}

function buildSceneClip({ intro, headline, audioPath, duration, broll, fadeIn, fadeOut, outPath }) {
  const d = duration.toFixed(3);
  const args = ['-y'];
  if (broll?.type === 'video') args.push('-stream_loop', '-1', '-t', d, '-i', broll.path);
  else if (broll?.type === 'photo' || broll?.type === 'design') args.push('-loop', '1', '-framerate', String(FPS), '-t', d, '-i', broll.path);
  else args.push('-f', 'lavfi', '-t', d, '-i', `color=c=${BG_COLOR}:s=${W}x${H}:r=${FPS}`);
  args.push('-loop', '1', '-t', d, '-i', intro);
  args.push('-loop', '1', '-t', d, '-i', headline);
  args.push('-i', audioPath);

  let bg;
  if (broll?.type === 'video') {
    bg = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},eq=brightness=-0.24:saturation=0.95,vignette=PI/4.2[bg]`;
  } else if (broll?.type === 'photo') {
    // Still photo has no inherent motion — a slow Ken Burns creep (z 1.00->1.08 over
    // the scene) keeps it from feeling frozen behind several seconds of moving text.
    bg = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},zoompan=z='min(zoom+0.0006,1.08)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=${FPS},eq=brightness=-0.24:saturation=0.95,vignette=PI/4.2[bg]`;
  } else if (broll?.type === 'design') {
    // Designed canvas is already graded — no darkening. Camera drift + temporal
    // noise (living film grain, bg only so text/captions stay crisp) sell motion.
    bg = `[0:v]${designMotionFilter(broll.motion, duration)},noise=alls=5:allf=t,vignette=PI/5[bg]`;
  } else {
    bg = `[0:v]vignette=PI/4.5[bg]`;
  }
  let post = 'format=yuv420p';
  if (fadeOut) post = `fade=t=out:st=${Math.max(0, duration - 0.6).toFixed(2)}:d=0.6,${post}`;
  if (fadeIn) post = `fade=t=in:st=0:d=0.5,${post}`;
  const filter = [
    bg,
    `[1:v]fade=t=in:st=0:d=0.5:alpha=1[intro]`,
    `[2:v]fade=t=in:st=0.45:d=0.5:alpha=1[head]`,
    `[bg][intro]overlay=0:'16*(1-clip(t/0.6\\,0\\,1))'[b1]`,
    `[b1][head]overlay=0:'50*(1-clip((t-0.45)/0.7\\,0\\,1))'[ov]`,
    `[ov]${post}[v]`
  ].join(';');

  args.push(
    '-filter_complex', filter, '-map', '[v]', '-map', '3:a',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-preset', 'veryfast', '-crf', '21',
    '-maxrate', '6M', '-bufsize', '12M', '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
    '-movflags', '+faststart', '-shortest', outPath
  );
  ff('ffmpeg', args);
}

function concatScenes(clipPaths, outDir, outPath) {
  const list = path.join(outDir, 'concat.txt');
  fs.writeFileSync(list, clipPaths.map(p => `file '${p.replace(/\\/g, '/')}'`).join('\n'), 'utf8');
  ff('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', outPath]);
  fs.unlinkSync(list);
}

/* ── 6. captions (Whisper word-level → karaoke ASS) ──────── */

function assTime(s) {
  const cs = Math.round((s % 1) * 100), t = Math.floor(s);
  return `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

const ASS_HEADER = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,Arial,50,&H00FFFFFF,&H00A0A0A0,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,3,12,0,2,90,90,170,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

function cleanWord(w) { return String(w || '').trim().replace(/[{}\\]/g, ''); }

function buildKaraokeAss(words) {
  // PrimaryColour = sung (white), SecondaryColour = unsung (grey); {\kN} per word.
  const lines = [];
  let cur = [];
  const flush = () => {
    if (!cur.length) return;
    const start = cur[0].start, end = cur[cur.length - 1].end + 0.25;
    let text = '';
    for (let i = 0; i < cur.length; i++) {
      const next = cur[i + 1] ? cur[i + 1].start : cur[i].end;
      const k = Math.max(1, Math.round((next - cur[i].start) * 100));
      text += `{\\k${k}}${cleanWord(cur[i].word ?? cur[i].text)} `;
    }
    lines.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Cap,,0,0,0,,${text.trim()}`);
    cur = [];
  };
  for (const w of words) {
    if (cur.length && (cur.length >= 6 || (w.start - cur[cur.length - 1].end) > 0.7)) flush();
    cur.push(w);
  }
  flush();
  return ASS_HEADER + lines.join('\n') + '\n';
}

function buildSegmentAss(segs) {
  const lines = segs.map(s => `Dialogue: 0,${assTime(s.start)},${assTime(s.end)},Cap,,0,0,0,,${cleanWord(s.text).replace(/\s+/g, ' ')}`);
  return ASS_HEADER + lines.join('\n') + '\n';
}

function normWord(w) {
  return String(w || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
}

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// Whisper transcribes by ear, so it misspells what it can't hear precisely ("não" →
// "nau", "doença" → "doenca", "Cida" → "Sida") — but the narration text is known
// verbatim, so Whisper is only trusted for TIMING. Align its timed words against the
// script (Needleman-Wunsch, accent-insensitive fuzzy match) and take the script's
// spelling wherever the two line up.
function snapWordsToScript(words, narration) {
  const script = narration.split(/\s+/)
    .map(raw => ({ raw: raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''), norm: normWord(raw) }))
    .filter(t => t.norm);
  const heard = words.map(w => normWord(w.word));
  const sim = (a, b) => {
    if (!a || !b) return -1;
    if (a === b) return 2;
    return editDistance(a, b) <= Math.max(1, Math.floor(Math.max(a.length, b.length) / 3)) ? 1 : -1;
  };
  const GAP = -0.6;
  const dp = Array.from({ length: heard.length + 1 }, (_, i) => { const r = new Array(script.length + 1).fill(0); r[0] = i * GAP; return r; });
  for (let j = 1; j <= script.length; j++) dp[0][j] = j * GAP;
  for (let i = 1; i <= heard.length; i++) {
    for (let j = 1; j <= script.length; j++) {
      dp[i][j] = Math.max(dp[i - 1][j - 1] + sim(heard[i - 1], script[j - 1].norm), dp[i - 1][j] + GAP, dp[i][j - 1] + GAP);
    }
  }
  const out = words.map(w => ({ ...w }));
  for (let i = heard.length, j = script.length; i > 0 && j > 0;) {
    const s = sim(heard[i - 1], script[j - 1].norm);
    if (dp[i][j] === dp[i - 1][j - 1] + s) {
      if (s > 0) out[i - 1].word = script[j - 1].raw;
      i--; j--;
    } else if (dp[i][j] === dp[i - 1][j] + GAP) i--;
    else j--;
  }
  return out;
}

async function burnCaptions(openai, videoNoCap, outDir, outPath, narration) {
  const master = path.join(outDir, 'master.mp3');
  ff('ffmpeg', ['-y', '-i', videoNoCap, '-vn', '-c:a', 'libmp3lame', '-q:a', '4', master]);
  // NOTE: never pass the narration as `prompt` — Whisper treats a prompt as the
  // transcript of PRECEDING audio, so a full-script prompt makes it skip transcribing
  // the opening entirely (observed: first 27s of a render came back with zero words).
  // Spelling is fixed downstream by snapWordsToScript instead.
  const tr = await openai.audio.transcriptions.create({
    file: fs.createReadStream(master), model: 'whisper-1', response_format: 'verbose_json',
    timestamp_granularities: ['word', 'segment'], language: 'pt'
  });
  const snapped = (tr.words && tr.words.length) ? snapWordsToScript(tr.words, narration) : null;
  const ass = snapped ? buildKaraokeAss(snapped) : buildSegmentAss(tr.segments || []);
  fs.writeFileSync(path.join(outDir, 'subs.ass'), ass, 'utf8');
  // Kept for debugging caption spelling/timing (why did a word render the way it did).
  fs.writeFileSync(path.join(outDir, 'captions-debug.json'), JSON.stringify({ narration, whisperWords: tr.words || [], snappedWords: snapped }, null, 2), 'utf8');
  ff('ffmpeg', ['-y', '-i', videoNoCap, '-vf', 'subtitles=subs.ass', '-c:a', 'copy', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '21', '-maxrate', '6M', '-bufsize', '12M', '-movflags', '+faststart', path.basename(outPath)], { cwd: outDir });
  fs.unlinkSync(master);
}

/* ── 7. music bed ────────────────────────────────────────── */

function mixMusic(videoIn, outPath) {
  const dur = ffprobeDuration(videoIn);
  const fadeStart = Math.max(0, dur - 2).toFixed(2);
  ff('ffmpeg', ['-y', '-i', videoIn, '-stream_loop', '-1', '-i', MUSIC_BED,
    '-filter_complex', `[1:a]volume=0.10,afade=t=out:st=${fadeStart}:d=2[m];[0:a][m]amix=inputs=2:duration=first:normalize=0[a]`,
    '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart', outPath]);
}

/* ── Main ────────────────────────────────────────────────── */

function slugify(t) {
  return t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 60);
}
function isoDate() { return new Date().toISOString().slice(0, 10); }

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const forceKie = args.includes('--kie-broll');
  const forceReal = args.includes('--real-broll');
  const forceImage = args.includes('--image-broll');
  const forceMixed = args.includes('--mixed-broll');
  const topicFileArg = args.includes('--topic-file') ? args[args.indexOf('--topic-file') + 1] : null;
  const seconds = args.includes('--seconds') ? parseInt(args[args.indexOf('--seconds') + 1], 10) : 50;
  const postArg = args.find(a => a.endsWith('.html'));
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  if (!dryRun) {
    if (!process.env.ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY not set');
    if (!process.env.ELEVENLABS_VOICE_ID) throw new Error('ELEVENLABS_VOICE_ID not set');
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set (needed for Whisper captions)');
  }

  let post;
  if (topicFileArg) {
    const topicFile = path.isAbsolute(topicFileArg) ? topicFileArg : path.join(__dirname, topicFileArg);
    post = readTopicFile(topicFile);
    console.log(`Topic: ${post.title}`);
  } else {
    let postFile = postArg ? (path.isAbsolute(postArg) ? postArg : path.join(__dirname, postArg)) : null;
    if (!postFile) {
      const files = fs.readdirSync(POSTS_DIR).filter(f => f.endsWith('.html')).sort();
      postFile = path.join(POSTS_DIR, files[files.length - 1]);
    }
    post = readPost(postFile);
    console.log(`Post: ${post.title}`);
  }

  // Typographic is the default (Direction A) — everything else only when forced.
  // 'mixed' = real cycling photos interleaved with gpt-image-2 stills (Phase 4).
  const brollMode = forceKie ? 'kie' : forceReal ? 'real' : forceMixed ? 'mixed' : forceImage ? 'image' : 'design';
  console.log(`b-roll mode: ${brollMode}`);

  console.log('1/7 Scripting (Claude)...');
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const script = await generateScript(anthropic, post, seconds);
  await fixOrthography(anthropic, script);
  console.log(`     ${script.scenes.length} scenes`);

  if (dryRun) {
    script.scenes.forEach((s, i) => console.log(`\n  [${i + 1}] ${s.label.toUpperCase()} — "${s.headline}"\n      VO: ${s.narration}\n      b-roll: ${s.broll}`));
    console.log(`\n  Caption: ${script.caption}`);
    console.log('\nDry run — nothing rendered.');
    return;
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const slug = slugify(script.title);
  const outDir = path.join(VIDEOS_DIR, `${isoDate()}-${slug}`);
  fs.mkdirSync(outDir, { recursive: true });

  console.log('2/7 Voiceover (ElevenLabs voice clone)...');
  const audios = [], durations = [];
  for (let i = 0; i < script.scenes.length; i++) {
    const a = path.join(outDir, `audio-${i + 1}.mp3`);
    await tts(script.scenes[i].narration, a);
    audios.push(a); durations.push(ffprobeDuration(a));
  }
  console.log(`     total VO ~${durations.reduce((x, y) => x + y, 0).toFixed(1)}s`);

  let brolls = new Array(script.scenes.length).fill(null);
  if (brollMode === 'kie') {
    console.log(`3/7 b-roll ×${script.scenes.length} (${KIE_BROLL_MODEL}, parallel)...`);
    const paths = await generateBrollAll(script.scenes, outDir);
    brolls = paths.map(p => p ? { type: 'video', path: p, temp: true } : null);
    console.log(`     ${brolls.filter(Boolean).length}/${brolls.length} clips ready`);
  } else if (brollMode === 'real') {
    console.log(`3/7 b-roll: real footage (${script.scenes.length} photos from assets/b-roll)...`);
    brolls = pickRealPhotos(script.scenes.length).map(p => p ? { type: 'photo', path: p, temp: false } : null);
    console.log(`     ${brolls.filter(Boolean).length}/${brolls.length} photos selected`);
  } else if (brollMode === 'image') {
    console.log(`3/7 b-roll: gpt-image-2 stills ×${script.scenes.length} (parallel)...`);
    const imgs = await generateImageBrollAll(script.scenes, outDir, openai);
    brolls = imgs.map(p => p ? { type: 'photo', path: p, temp: true } : null);
    console.log(`     ${brolls.filter(Boolean).length}/${brolls.length} stills ready`);
  } else if (brollMode === 'mixed') {
    // Real photos carry the human presence (scenes 1,3,5 — hook opens on real
    // footage); gpt-image-2 fills the alternating scenes with faceless editorial
    // stills so an AI-generated "someone" never sits next to the real Jorge.
    const realIdx = script.scenes.map((_, i) => i).filter(i => i % 2 === 0);
    const aiIdx = script.scenes.map((_, i) => i).filter(i => i % 2 === 1);
    console.log(`3/7 b-roll: mixed — ${realIdx.length} real photos + ${aiIdx.length} gpt-image-2 stills...`);
    const realPicks = pickRealPhotos(realIdx.length);
    const haveReal = realPicks.some(Boolean);
    const imgs = await generateImageBrollAll(script.scenes, outDir, openai, haveReal ? aiIdx : script.scenes.map((_, i) => i));
    brolls = script.scenes.map((_, i) => {
      if (haveReal && i % 2 === 0) {
        const p = realPicks[realIdx.indexOf(i)];
        return p ? { type: 'photo', path: p, temp: false } : (imgs[i] ? { type: 'photo', path: imgs[i], temp: true } : null);
      }
      return imgs[i] ? { type: 'photo', path: imgs[i], temp: true } : null;
    });
    console.log(`     ${brolls.filter(Boolean).length}/${brolls.length} visuals ready`);
  } else {
    console.log('3/7 b-roll: typographic canvases (rendered with text layers below).');
  }

  console.log('4/7 Rendering text + background layers (Puppeteer)...');
  const layers = await renderSceneLayers(script.scenes, outDir, brollMode === 'design');
  if (brollMode === 'design') {
    brolls = layers.map((l, i) => ({ type: 'design', path: l.bg, motion: DESIGN_MOTIONS[i % DESIGN_MOTIONS.length], temp: true }));
  }

  console.log('5/7 Assembling scene clips (ffmpeg)...');
  const clips = [];
  for (let i = 0; i < script.scenes.length; i++) {
    const clip = path.join(outDir, `clip-${i + 1}.mp4`);
    buildSceneClip({
      intro: layers[i].intro, headline: layers[i].headline, audioPath: audios[i],
      duration: durations[i], broll: brolls[i],
      fadeIn: i === 0, fadeOut: i === script.scenes.length - 1, outPath: clip
    });
    clips.push(clip);
  }
  const noCap = path.join(outDir, 'video_nocap.mp4');
  concatScenes(clips, outDir, noCap);

  console.log('6/7 Captions (Whisper word-level → karaoke)...');
  const capPath = path.join(outDir, 'video_cap.mp4');
  await burnCaptions(openai, noCap, outDir, capPath, script.scenes.map(s => s.narration).join(' '));

  console.log('7/7 Music bed...');
  const finalPath = path.join(outDir, 'video.mp4');
  if (fs.existsSync(MUSIC_BED)) { mixMusic(capPath, finalPath); fs.unlinkSync(capPath); }
  else { fs.renameSync(capPath, finalPath); console.log('     (no assets/music/bed.mp3 — voiceover only)'); }
  const durationSec = ffprobeDuration(finalPath);

  const tags = (script.hashtags || []).map(h => (h.startsWith('#') ? h : '#' + h.replace(/^#*/, ''))).join(' ');
  fs.writeFileSync(path.join(outDir, 'video-meta.json'), JSON.stringify({
    date: isoDate(), slug, title: script.title, caption: `${script.caption}\n\n${tags}`, videoPath: finalPath.replace(/\\/g, '/'), durationSec
  }, null, 2), 'utf8');

  const tempBrolls = brolls.filter(b => b && b.temp).map(b => b.path);
  for (const f of [...audios, ...tempBrolls, ...layers.flatMap(l => [l.intro, l.headline]), ...clips, noCap]) { try { fs.unlinkSync(f); } catch {} }
  console.log(`\nDone. ${durationSec.toFixed(1)}s → ${path.relative(__dirname, finalPath)}`);
  console.log(JSON.stringify({ slug, durationSec: +durationSec.toFixed(1), video: finalPath.replace(/\\/g, '/') }, null, 2));
}

main().catch(e => { console.error('ERROR:', e.message); if (e.stderr) console.error(String(e.stderr).slice(-2000)); process.exit(1); });
