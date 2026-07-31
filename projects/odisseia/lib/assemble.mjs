/**
 * Assembles the Odisseia Reel: stills -> Ken Burns -> text -> captions -> mix.
 *
 * Sora was dropped for this cut: input_reference collapsed every stacked
 * diptych into a single figure, deleting the comparison the video argues from.
 * Ken Burns on the real stills guarantees both halves stay on screen.
 *
 *   node projects/odisseia/lib/assemble.mjs [--no-captions]
 */
import '../../../load-env.mjs';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import OpenAI from 'openai';
import puppeteer from 'puppeteer-core';

const ROOT = path.join(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'out');
const WORK = path.join(OUT, 'work');
fs.mkdirSync(WORK, { recursive: true });

const script = JSON.parse(fs.readFileSync(path.join(ROOT, 'script.json'), 'utf8'));
const CHROME = process.env.CHROME_PATH || 'C:/Users/Jorge Bernardo/.cache/puppeteer/chrome/win64-148.0.7778.167/chrome-win64/chrome.exe';
const W = 1080, H = 1920, FPS = 30;
const GAP = 0.5;               // silence between beats
const noCaptions = process.argv.includes('--no-captions');

const ff = (args) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
const dur = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', f]).toString().trim());

/* ── 1. beat timings from the narration ──────────────────── */
const beats = script.beats.map(b => {
  const audio = path.join(OUT, 'audio', `beat-${b.id}.mp3`);
  return { ...b, audio, len: dur(audio) };
});
let t = 0;
for (const b of beats) { b.start = t; b.total = b.len + GAP; t += b.total; }
const TOTAL = t;
console.log(`1/6  ${beats.length} beats, ${TOTAL.toFixed(2)}s total`);

/* ── 2. text layers (Puppeteer, transparent PNG) ─────────── */
console.log('2/6  rendering text layers...');
const tpl = fs.readFileSync(path.join(ROOT, 'templates', 'scene.html'), 'utf8');
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
{
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--allow-file-access-from-files'] });
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  for (const b of beats) {
    const html = tpl.replace(/{{LABEL}}/g, esc(b.label)).replace(/{{HEADLINE}}/g, esc(b.headline));
    const f = path.join(WORK, `text-${b.id}.html`);
    fs.writeFileSync(f, html, 'utf8');
    await page.goto('file:///' + f.replace(/\\/g, '/'), { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 300)); // let webfonts settle
    await page.screenshot({ path: path.join(WORK, `text-${b.id}.png`), omitBackground: true });
  }
  await browser.close();
}

/* ── 3. per-beat video: Ken Burns + text ─────────────────── */
// zoompan resets `zoom` on every input frame, so a looped still restarts the
// move each frame. Feed ONE frame and drive the motion off `on/d` instead.
console.log('3/6  ken burns + text...');
const segs = [];
beats.forEach((b, i) => {
  const still = path.join(OUT, 'stills', `${b.panel}.png`);
  const text = path.join(WORK, `text-${b.id}.png`);
  const seg = path.join(WORK, `seg-${b.id}.mp4`);
  const fadeOut = Math.max(0, b.total - 0.4);

  // zoompan is single-threaded and rescales every output frame, which cost
  // ~10 min per segment. A crop-based pan over a once-scaled canvas is an
  // order of magnitude faster AND reads better here: the move travels down
  // the diptych, from the Egyptian half to the Greek one, which is the
  // comparison the narration is making. Direction alternates so six beats
  // don't feel mechanical.
  const CW = 1440, CH = 2160;            // scaled canvas: 240px of vertical travel
  const TRAVEL = CH - H;                  // 240
  const down = i % 2 === 0;
  const yExpr = down
    ? `(${TRAVEL})*t/${b.total.toFixed(3)}`
    : `(${TRAVEL})*(1-t/${b.total.toFixed(3)})`;

  ff(['-loop', '1', '-t', String(b.total), '-i', still,
      '-loop', '1', '-t', String(b.total), '-i', text,
      '-filter_complex',
      `[0:v]scale=${CW}:${CH}:force_original_aspect_ratio=increase,crop=${CW}:${CH},` +
      `crop=${W}:${H}:x='(in_w-${W})/2':y='${yExpr}',` +
      `eq=saturation=0.96:contrast=1.04,` +
      `fade=t=in:st=0:d=0.4,fade=t=out:st=${fadeOut.toFixed(2)}:d=0.4[bg];` +
      `[1:v]scale=${W}:${H},fade=t=in:st=0.35:d=0.5:alpha=1,fade=t=out:st=${fadeOut.toFixed(2)}:d=0.4:alpha=1[tx];` +
      `[bg][tx]overlay=0:0:format=auto[v]`,
      '-map', '[v]', '-r', String(FPS), '-c:v', 'libx264', '-preset', 'ultrafast',
      '-pix_fmt', 'yuv420p', '-crf', '16', seg]);
  segs.push(seg);
});

/* ── 4. concat video ─────────────────────────────────────── */
console.log('4/6  concat...');
const listFile = path.join(WORK, 'segs.txt');
fs.writeFileSync(listFile, segs.map(s => `file '${s.replace(/\\/g, '/')}'`).join('\n'), 'utf8');
const videoOnly = path.join(WORK, 'video-only.mp4');
ff(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', videoOnly]);

/* ── 5. audio: narration bed + score + sfx ───────────────── */
console.log('5/6  audio mix...');
const narration = path.join(WORK, 'narration.wav');
{
  // place each beat's mp3 at its absolute start on a silent bed
  const inputs = [];
  const filters = [];
  beats.forEach((b, i) => {
    inputs.push('-i', b.audio);
    filters.push(`[${i}:a]aresample=48000,adelay=${Math.round(b.start * 1000)}|${Math.round(b.start * 1000)}[n${i}]`);
  });
  const mix = beats.map((_, i) => `[n${i}]`).join('');
  ff([...inputs, '-filter_complex',
      `${filters.join(';')};${mix}amix=inputs=${beats.length}:duration=longest:normalize=0,apad,atrim=0:${TOTAL}[a]`,
      '-map', '[a]', '-c:a', 'pcm_s16le', narration]);
}

const sfxArgs = [];
const sfxFilters = [];
let sfxN = 0;
beats.forEach(b => {
  const f = path.join(OUT, 'audio', `sfx-${b.id}.mp3`);
  if (!fs.existsSync(f)) return;
  sfxArgs.push('-i', f);
  sfxFilters.push(`[${2 + sfxN}:a]aresample=48000,volume=0.16,adelay=${Math.round(b.start * 1000)}|${Math.round(b.start * 1000)}[s${sfxN}]`);
  sfxN++;
});

const mixed = path.join(WORK, 'mixed.wav');
{
  const scoreDucked = `[1:a]aresample=48000,volume=0.13,atrim=0:${TOTAL},afade=t=in:st=0:d=1.5,afade=t=out:st=${(TOTAL - 2).toFixed(2)}:d=2[sc]`;
  const sfxLabels = Array.from({ length: sfxN }, (_, i) => `[s${i}]`).join('');
  ff(['-i', narration, '-i', path.join(OUT, 'audio', 'score.mp3'), ...sfxArgs,
      '-filter_complex',
      `[0:a]aresample=48000,volume=1.0[nv];${scoreDucked};${sfxFilters.join(';')}${sfxFilters.length ? ';' : ''}` +
      `[nv][sc]${sfxLabels}amix=inputs=${2 + sfxN}:duration=first:normalize=0,` +
      `acompressor=threshold=0.09:ratio=4:attack=12:release=260,alimiter=limit=0.95[a]`,
      '-map', '[a]', '-c:a', 'pcm_s16le', mixed]);
}

/* ── 6. captions + final mux ─────────────────────────────── */
let assPath = null;
if (!noCaptions && process.env.OPENAI_API_KEY) {
  console.log('6/6  whisper captions...');
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const tr = await openai.audio.transcriptions.create({
      file: fs.createReadStream(narration),
      model: 'whisper-1',
      language: 'pt',
      response_format: 'verbose_json',
      timestamp_granularities: ['word']
    });
    const words = (tr.words || []).filter(w => w.word && w.end > w.start);
    if (words.length) {
      // Group into short phrases, breaking at BEAT boundaries as well as at
      // punctuation/length. Without the beat check a group spans the cut and
      // renders the tail of one beat beside the head of the next ("africano
      // Os gregos admitiram"), over the wrong panel.
      const beatOf = (t) => {
        for (let i = beats.length - 1; i >= 0; i--) if (t >= beats[i].start) return i;
        return 0;
      };
      const lines = [];
      let cur = [];
      for (const w of words) {
        if (cur.length && beatOf(w.start) !== beatOf(cur[0].start)) { lines.push(cur); cur = []; }
        cur.push(w);
        const text = cur.map(x => x.word).join(' ');
        if (text.length >= 26 || /[.!?]$/.test(w.word)) { lines.push(cur); cur = []; }
      }
      if (cur.length) lines.push(cur);

      const ts = s => {
        const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = (s % 60);
        return `${h}:${String(m).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}`;
      };
      const head = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 2

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Cap,IBM Plex Mono,54,&H00D6E7F1,&H0000A0C6,&H00000000,&H96000000,-1,0,0,0,100,100,0,0,1,4,3,2,90,90,250,1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text`;
      const events = lines.map(g => {
        const st = g[0].start, en = g[g.length - 1].end;
        const txt = g.map(w => `{\\k${Math.max(1, Math.round((w.end - w.start) * 100))}}${w.word} `).join('');
        return `Dialogue: 0,${ts(st)},${ts(en)},Cap,,0,0,0,,${txt.trim()}`;
      });
      assPath = path.join(WORK, 'captions.ass');
      fs.writeFileSync(assPath, `${head}\n${events.join('\n')}\n`, 'utf8');
      console.log(`     ${lines.length} caption lines`);
    }
  } catch (e) {
    console.log(`     captions skipped: ${e.message.slice(0, 140)}`);
  }
}

const final = path.join(OUT, 'video.mp4');
// The ass filter's own parser splits on ':' and chokes on a Windows drive letter
// and on the space in the repo path, whatever escaping is applied. Running the
// final mux with cwd=WORK lets the filter take a bare relative filename instead.
const vf = assPath ? ['-vf', 'ass=captions.ass'] : [];
execFileSync('ffmpeg', ['-y', '-loglevel', 'error',
    '-i', videoOnly, '-i', mixed, ...vf,
    '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '19', '-preset', 'medium',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-shortest', final],
  { cwd: WORK, stdio: ['ignore', 'pipe', 'pipe'] });

console.log(`\ndone -> ${final}  (${dur(final).toFixed(2)}s, ${(fs.statSync(final).size / 1024 / 1024).toFixed(1)} MB)`);
