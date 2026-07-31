/**
 * Sora 2 motion for the Odisseia Reel.
 *
 * Animates the STILLS we already generated (input_reference) rather than
 * generating scenes from scratch: the diptych composition IS the argument, so
 * it must survive intact. Sora only adds camera and atmosphere on top.
 *
 * Only beats with motion:true get a clip; the rest stay stills with a Ken Burns
 * move at assembly time. Audio is discarded (narration + score own the track).
 *
 *   node projects/odisseia/lib/motion.mjs [--force] [--model sora-2-pro]
 */
import '../../../load-env.mjs';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const ROOT = path.join(import.meta.dirname, '..');
const STILLS = path.join(ROOT, 'out', 'stills');
const OUT = path.join(ROOT, 'out', 'motion');
// Sora rejects an input_reference whose dimensions differ from the requested
// size ("Inpaint image must match the requested width and height"), so the
// 1024x1536 stills are pre-scaled and centre-cropped to exactly 720x1280.
const REF = path.join(ROOT, 'out', 'stills-916');
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(REF, { recursive: true });

function toRefSize(src, dest) {
  if (fs.existsSync(dest)) return dest;
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', src,
    '-vf', 'scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280', dest]);
  return dest;
}

const script = JSON.parse(fs.readFileSync(path.join(ROOT, 'script.json'), 'utf8'));
const { PANELS } = await import('../panels.mjs');
const KEY = process.env.OPENAI_API_KEY;
if (!KEY) { console.error('OPENAI_API_KEY missing'); process.exit(1); }

const args = process.argv.slice(2);
const force = args.includes('--force');
const model = args.includes('--model') ? args[args.indexOf('--model') + 1] : 'sora-2';
const SECONDS = '4';
const SIZE = '720x1280';

// Camera direction per beat. Deliberately restrained: a museum push-in and
// drifting dust, never a figure that moves or a face that animates.
const MOTION = {
  1: 'Extremely slow push-in on the sculpture. Fine dust drifts through the raking light. The stone does not move. Static locked-off feel, subtle only.',
  3: 'Very slow vertical drift downward across the two carved figures. Dust motes float. Nothing animates except light and dust.',
  4: 'Extremely slow push-in toward the writing tablet held by both figures. Dust drifts in the beam of light. The statues remain completely still.',
  5: 'Extremely slow push-in on the spiralling ram horns. Light shifts almost imperceptibly across the carved stone. Statues remain completely still.'
};

async function poll(id) {
  for (let i = 0; i < 150; i++) {
    await new Promise(r => setTimeout(r, 4000));
    const r = await fetch(`https://api.openai.com/v1/videos/${id}`, { headers: { Authorization: `Bearer ${KEY}` } });
    const j = await r.json();
    if (j.status === 'completed') return j;
    if (j.status === 'failed') throw new Error(JSON.stringify(j.error || j).slice(0, 250));
    process.stdout.write('.');
  }
  throw new Error('timeout');
}

for (const beat of script.beats.filter(b => b.motion)) {
  const dest = path.join(OUT, `beat-${beat.id}.mp4`);
  if (fs.existsSync(dest) && !force) { console.log(`skip  beat-${beat.id}`); continue; }
  const srcStill = path.join(STILLS, `${beat.panel}.png`);
  if (!fs.existsSync(srcStill)) { console.log(`MISS  ${srcStill}`); continue; }
  const still = toRefSize(srcStill, path.join(REF, `${beat.panel}.png`));

  const panel = PANELS.find(p => p.id === beat.panel);
  const prompt = `${MOTION[beat.id]} Preserve the existing composition, framing, lighting and colour grade exactly. ${panel?.concept ? '' : ''}No text, no letters, no watermark. No people move.`;

  process.stdout.write(`sora  beat-${beat.id} (${model}) `);
  const form = new FormData();
  form.append('model', model);
  form.append('prompt', prompt);
  form.append('seconds', SECONDS);
  form.append('size', SIZE);
  form.append('input_reference', new Blob([fs.readFileSync(still)], { type: 'image/png' }), `${beat.panel}.png`);

  try {
    const create = await fetch('https://api.openai.com/v1/videos', {
      method: 'POST', headers: { Authorization: `Bearer ${KEY}` }, body: form
    });
    const job = await create.json();
    if (!create.ok) { console.log(`FAIL ${create.status} ${JSON.stringify(job.error || job).slice(0, 220)}`); continue; }

    const done = await poll(job.id);
    const content = await fetch(`https://api.openai.com/v1/videos/${done.id}/content`, { headers: { Authorization: `Bearer ${KEY}` } });
    if (!content.ok) { console.log(` FAIL download ${content.status}`); continue; }
    fs.writeFileSync(dest, Buffer.from(await content.arrayBuffer()));
    console.log(` ok (${(fs.statSync(dest).size / 1024 / 1024).toFixed(1)} MB)`);
  } catch (e) {
    console.log(` FAIL ${e.message.slice(0, 200)}`);
  }
}
console.log(`\nmotion -> projects/odisseia/out/motion/`);
