/**
 * ElevenLabs Music + SFX for the Odisseia Reel.
 * These endpoints are live on the Creator tier and were unused by the repo.
 *
 *   node projects/odisseia/lib/audio.mjs music
 *   node projects/odisseia/lib/audio.mjs sfx
 *   node projects/odisseia/lib/audio.mjs both [--force]
 */
import '../../../load-env.mjs';
import fs from 'fs';
import path from 'path';

const ROOT = path.join(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'out', 'audio');
fs.mkdirSync(OUT, { recursive: true });

const script = JSON.parse(fs.readFileSync(path.join(ROOT, 'script.json'), 'utf8'));
const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) { console.error('ELEVENLABS_API_KEY missing'); process.exit(1); }

const args = process.argv.slice(2);
const what = args.find(a => !a.startsWith('--')) || 'both';
const force = args.includes('--force');

async function post(url, body, dest, label) {
  if (fs.existsSync(dest) && !force) { console.log(`skip  ${label}`); return; }
  process.stdout.write(`gen   ${label} ... `);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'xi-api-key': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) { console.log(`FAIL ${res.status} ${(await res.text()).slice(0, 220)}`); return; }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  console.log(`ok (${(buf.length / 1024).toFixed(0)} KB)`);
}

if (what === 'music' || what === 'both') {
  await post(
    'https://api.elevenlabs.io/v1/music',
    { prompt: script.music.prompt, music_length_ms: script.music.lengthMs },
    path.join(OUT, 'score.mp3'),
    'score'
  );
}

if (what === 'sfx' || what === 'both') {
  for (const beat of script.beats) {
    if (!beat.sfx) continue;
    await post(
      'https://api.elevenlabs.io/v1/sound-generation',
      { text: beat.sfx, duration_seconds: 5, prompt_influence: 0.4 },
      path.join(OUT, `sfx-${beat.id}.mp3`),
      `sfx-${beat.id}`
    );
  }
}

console.log(`\naudio -> projects/odisseia/out/audio/`);
