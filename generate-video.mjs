/**
 * generate-video.mjs
 * Turns a blog post into a dynamic, educational, ~45-55s, 9:16 Instagram video:
 * Portuguese voiceover, AI b-roll behind every scene, staggered kinetic text
 * reveals, word-synced "karaoke" captions, and a subtle music bed. Faceless.
 *
 * Pipeline: Claude script (5 scenes) -> OpenAI TTS per scene -> KIE b-roll per
 * scene (parallel) -> Puppeteer renders each scene's text as 2 transparent layers
 * (intro=label+divider, headline) -> ffmpeg composites darkened b-roll + staggered
 * text + audio per scene -> concat (fade open/close) -> Whisper WORD timestamps ->
 * karaoke ASS captions -> music bed mix -> videos/{date}-{slug}/video.mp4.
 *
 * Usage:
 *   node generate-video.mjs <post.html>             (b-roll on every scene; default)
 *   node generate-video.mjs <post.html> --no-broll  (procedural navy bg, no KIE cost)
 *   node generate-video.mjs <post.html> --seconds 50 | --dry-run
 *
 * Requires: ANTHROPIC_API_KEY, OPENAI_API_KEY. b-roll: kIE_API_KEY (+ KIE_BROLL_MODEL,
 * default bytedance/seedance-2-fast). Music: assets/music/bed.mp3 (optional). ffmpeg+ffprobe on PATH.
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
const CHROME = 'C:/Users/Jorge Bernardo/.cache/puppeteer/chrome/win64-148.0.7778.167/chrome-win64/chrome.exe';
const SCENE_TEMPLATE = path.join(__dirname, 'templates', 'video', 'scene.html');
const VIDEOS_DIR = path.join(__dirname, 'videos');
const POSTS_DIR = path.join(__dirname, 'blog', 'posts');
const MUSIC_BED = path.join(__dirname, 'assets', 'music', 'bed.mp3');

const W = 1080, H = 1920, FPS = 30;
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
  return { title, plain };
}

async function generateScript(client, post, seconds) {
  const wordBudget = Math.round(seconds * 2.2);
  const res = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    system: `Você roteiriza vídeos educativos curtos para o Instagram na voz de Jorge Bernardo: homem negro brasileiro, ciclista, profissional de tecnologia e segurança de dados, fundador da DePretoPraPreto. Primeira pessoa, português do Brasil, direto e reflexivo, sem clichê motivacional, SEM travessões (—), sem emojis.`,
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
      content: `A partir deste post do blog, escreva o roteiro de um vídeo educativo vertical de ~${seconds}s.
Regras RÍGIDAS de tamanho (o vídeo NÃO pode passar de ~${seconds}s):
- Exatamente 5 cenas.
- Cada "narration": 1 ou 2 frases curtas, NO MÁXIMO ~22 palavras.
- A soma de TODAS as narrações deve ficar entre ${wordBudget - 15} e ${wordBudget + 10} palavras.
Conteúdo: cena 1 gancho concreto; cenas do meio ensinam uma ideia cada; última fecha com imagem ou pergunta aberta (não CTA). "headline" curto (máx 8 palavras). "broll" é uma descrição visual EM INGLÊS, abstrata e sem rostos. Nada de travessões.

POST:
${post.plain.slice(0, 4000)}`
    }]
  });
  const tool = res.content.find(b => b.type === 'tool_use');
  if (!tool) throw new Error('no script returned');
  return tool.input;
}

/* ── 2. TTS (OpenAI) ─────────────────────────────────────── */

async function tts(openai, text, outPath) {
  const res = await openai.audio.speech.create({
    model: 'gpt-4o-mini-tts', voice: 'onyx', input: text,
    instructions: 'Narração calma, confiante e reflexiva, ritmo pausado, português do Brasil. Tom de quem ensina com serenidade.'
  });
  fs.writeFileSync(outPath, Buffer.from(await res.arrayBuffer()));
}

/* ── 3. Scene text layers (Puppeteer) ────────────────────── */

async function renderSceneLayers(scenes, outDir) {
  const tpl = fs.readFileSync(SCENE_TEMPLATE, 'utf8');
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
    const layers = [];
    for (let i = 0; i < scenes.length; i++) {
      const base = tpl.replace(/{{LABEL}}/g, esc(scenes[i].label)).replace(/{{HEADLINE}}/g, esc(scenes[i].headline));
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

/* ── 5. ffmpeg: one clip per scene ───────────────────────── */

function buildSceneClip({ intro, headline, audioPath, duration, brollPath, fadeIn, fadeOut, outPath }) {
  const d = duration.toFixed(3);
  const args = ['-y'];
  if (brollPath) args.push('-stream_loop', '-1', '-t', d, '-i', brollPath);
  else args.push('-f', 'lavfi', '-t', d, '-i', `color=c=${BG_COLOR}:s=${W}x${H}:r=${FPS}`);
  args.push('-loop', '1', '-t', d, '-i', intro);
  args.push('-loop', '1', '-t', d, '-i', headline);
  args.push('-i', audioPath);

  const bg = brollPath
    ? `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},eq=brightness=-0.24:saturation=0.95,vignette=PI/4.2[bg]`
    : `[0:v]vignette=PI/4.5[bg]`;
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

async function burnCaptions(openai, videoNoCap, outDir, outPath) {
  const master = path.join(outDir, 'master.mp3');
  ff('ffmpeg', ['-y', '-i', videoNoCap, '-vn', '-c:a', 'libmp3lame', '-q:a', '4', master]);
  const tr = await openai.audio.transcriptions.create({
    file: fs.createReadStream(master), model: 'whisper-1', response_format: 'verbose_json', timestamp_granularities: ['word', 'segment']
  });
  const ass = (tr.words && tr.words.length) ? buildKaraokeAss(tr.words) : buildSegmentAss(tr.segments || []);
  fs.writeFileSync(path.join(outDir, 'subs.ass'), ass, 'utf8');
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
  const useBroll = !args.includes('--no-broll');
  const seconds = args.includes('--seconds') ? parseInt(args[args.indexOf('--seconds') + 1], 10) : 50;
  const postArg = args.find(a => a.endsWith('.html'));
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');

  let postFile = postArg ? (path.isAbsolute(postArg) ? postArg : path.join(__dirname, postArg)) : null;
  if (!postFile) {
    const files = fs.readdirSync(POSTS_DIR).filter(f => f.endsWith('.html')).sort();
    postFile = path.join(POSTS_DIR, files[files.length - 1]);
  }
  const post = readPost(postFile);
  console.log(`Post: ${post.title}`);

  console.log('1/7 Scripting (Claude)...');
  const script = await generateScript(new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }), post, seconds);
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

  console.log('2/7 Voiceover (OpenAI TTS)...');
  const audios = [], durations = [];
  for (let i = 0; i < script.scenes.length; i++) {
    const a = path.join(outDir, `audio-${i + 1}.mp3`);
    await tts(openai, script.scenes[i].narration, a);
    audios.push(a); durations.push(ffprobeDuration(a));
  }
  console.log(`     total VO ~${durations.reduce((x, y) => x + y, 0).toFixed(1)}s`);

  let brolls = new Array(script.scenes.length).fill(null);
  if (useBroll) {
    console.log(`3/7 b-roll ×${script.scenes.length} (${KIE_BROLL_MODEL}, parallel)...`);
    brolls = await generateBrollAll(script.scenes, outDir);
    console.log(`     ${brolls.filter(Boolean).length}/${brolls.length} clips ready`);
  } else {
    console.log('3/7 b-roll skipped (procedural bg).');
  }

  console.log('4/7 Rendering text layers (Puppeteer)...');
  const layers = await renderSceneLayers(script.scenes, outDir);

  console.log('5/7 Assembling scene clips (ffmpeg)...');
  const clips = [];
  for (let i = 0; i < script.scenes.length; i++) {
    const clip = path.join(outDir, `clip-${i + 1}.mp4`);
    buildSceneClip({
      intro: layers[i].intro, headline: layers[i].headline, audioPath: audios[i],
      duration: durations[i], brollPath: brolls[i],
      fadeIn: i === 0, fadeOut: i === script.scenes.length - 1, outPath: clip
    });
    clips.push(clip);
  }
  const noCap = path.join(outDir, 'video_nocap.mp4');
  concatScenes(clips, outDir, noCap);

  console.log('6/7 Captions (Whisper word-level → karaoke)...');
  const capPath = path.join(outDir, 'video_cap.mp4');
  await burnCaptions(openai, noCap, outDir, capPath);

  console.log('7/7 Music bed...');
  const finalPath = path.join(outDir, 'video.mp4');
  if (fs.existsSync(MUSIC_BED)) { mixMusic(capPath, finalPath); fs.unlinkSync(capPath); }
  else { fs.renameSync(capPath, finalPath); console.log('     (no assets/music/bed.mp3 — voiceover only)'); }
  const durationSec = ffprobeDuration(finalPath);

  const tags = (script.hashtags || []).map(h => (h.startsWith('#') ? h : '#' + h.replace(/^#*/, ''))).join(' ');
  fs.writeFileSync(path.join(outDir, 'video-meta.json'), JSON.stringify({
    date: isoDate(), slug, title: script.title, caption: `${script.caption}\n\n${tags}`, videoPath: finalPath.replace(/\\/g, '/'), durationSec
  }, null, 2), 'utf8');

  for (const f of [...audios, ...brolls.filter(Boolean), ...layers.flatMap(l => [l.intro, l.headline]), ...clips, noCap]) { try { fs.unlinkSync(f); } catch {} }
  console.log(`\nDone. ${durationSec.toFixed(1)}s → ${path.relative(__dirname, finalPath)}`);
  console.log(JSON.stringify({ slug, durationSec: +durationSec.toFixed(1), video: finalPath.replace(/\\/g, '/') }, null, 2));
}

main().catch(e => { console.error('ERROR:', e.message); if (e.stderr) console.error(String(e.stderr).slice(-2000)); process.exit(1); });
