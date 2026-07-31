/**
 * ElevenLabs narration for the Odisseia Reel.
 *
 * Per-beat TTS with REQUEST STITCHING: each call is conditioned on its
 * neighbours (previous_text / next_text / previous_request_ids) so the read
 * builds across the six cuts instead of restarting flat on every beat. That
 * technique is lifted from tts.mjs; the voice and settings are NOT — this uses
 * Andréa (native pt-BR) at speed 1.0, whereas the shared ELEVEN_VOICE_SETTINGS
 * are tuned to Jorge's clone at 1.08 and would sound rushed here.
 *
 *   node projects/odisseia/lib/voice.mjs [--force]
 */
import '../../../load-env.mjs';
import fs from 'fs';
import path from 'path';

const ROOT = path.join(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, 'out', 'audio');
fs.mkdirSync(OUT_DIR, { recursive: true });

const script = JSON.parse(fs.readFileSync(path.join(ROOT, 'script.json'), 'utf8'));
const { voiceId, model, settings } = script.voice;
const force = process.argv.includes('--force');

if (!process.env.ELEVENLABS_API_KEY) { console.error('ELEVENLABS_API_KEY missing'); process.exit(1); }

const MAX_PREV_IDS = 3; // API limit
const prevIds = [];

for (let i = 0; i < script.beats.length; i++) {
  const beat = script.beats[i];
  const dest = path.join(OUT_DIR, `beat-${beat.id}.mp3`);
  if (fs.existsSync(dest) && !force) { console.log(`skip  beat-${beat.id}`); continue; }

  const body = {
    text: beat.narration,
    model_id: model,
    voice_settings: settings,
    ...(i > 0 ? { previous_text: script.beats[i - 1].narration } : {}),
    ...(i < script.beats.length - 1 ? { next_text: script.beats[i + 1].narration } : {}),
    ...(prevIds.length ? { previous_request_ids: prevIds.slice(-MAX_PREV_IDS) } : {})
  };

  process.stdout.write(`tts   beat-${beat.id} ... `);
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) { console.log(`FAIL ${res.status} ${(await res.text()).slice(0, 200)}`); break; }

  // Read the request id before the body: conditioning the next call on this one
  // requires it to have fully processed, which writing the buffer guarantees.
  const rid = res.headers.get('request-id');
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  if (rid) prevIds.push(rid);
  console.log('ok');
}

console.log(`\nnarration -> projects/odisseia/out/audio/`);
