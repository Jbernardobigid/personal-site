/**
 * tts.mjs
 * Shared ElevenLabs voice + spoken-PT-BR text prep, used by both the Reels
 * pipeline (generate-video.mjs) and the podcast pipeline (generate-audio-post.mjs).
 * Extracted from generate-video.mjs so both speak with the same cloned voice
 * and the same text-fix guarantees.
 */

import fs from 'fs';

// TTS reads unit abbreviations literally ("32 km/h" → letter-by-letter, caught on
// the first VPS cycling Reel 2026-07-07), so spoken text is expanded to spoken
// PT-BR before synthesis. Order matters: km/h before km, min before bare m.
export function expandSpokenUnits(text) {
  return String(text || '')
    .replace(/(\d+)\s*h\s*(\d{1,2})\b/g, '$1 horas e $2 minutos')  // 4h51
    .replace(/(\d+(?:[.,]\d+)?)\s*km\/h/gi, '$1 quilômetros por hora')
    .replace(/(\d+(?:[.,]\d+)?)\s*km\b/gi, '$1 quilômetros')
    .replace(/(\d+(?:[.,]\d+)?)\s*min\b/gi, '$1 minutos')
    .replace(/(\d+(?:[.,]\d+)?)\s*m\b(?![\w/])/g, '$1 metros')
    .replace(/(\d+(?:[.,]\d+)?)\s*%/g, '$1 por cento');
}

// Claude's constrained tool-use JSON reliably starts dropping PT-BR diacritics partway
// through longer outputs ("Médico"→"Medico", "é"→"e") — and the TTS pronounces what's
// written, so this corrupts the audio, not just the captions. This pass restores
// accents via a plain-text call, with a hard guard: a corrected line is only accepted
// if it matches the original once diacritics are stripped, so it can NEVER reword.
// Takes an array of strings, returns a same-length array of corrected strings.
export async function fixOrthographyLines(client, lines) {
  const originals = lines.map(v => String(v || '').replace(/\s+/g, ' ').trim());
  const numbered = originals.map((v, i) => `${i + 1}. ${v}`).join('\n');
  const res = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: Math.min(16000, Math.max(1500, Math.ceil(numbered.length / 2))),
    system: 'Você é um revisor ortográfico de português do Brasil. Corrija APENAS acentos e cedilhas faltando ou errados. NÃO altere palavras, ordem, pontuação ou conteúdo. Responda SOMENTE com as linhas numeradas corrigidas, uma por linha, no mesmo formato.',
    messages: [{ role: 'user', content: numbered }]
  });
  const text = res.content.find(b => b.type === 'text')?.text || '';
  const bare = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
  const out = [...originals];
  for (const m of text.matchAll(/^(\d+)\.\s*(.+)$/gm)) {
    const i = +m[1] - 1, fixed = m[2].trim();
    if (i >= 0 && i < out.length && bare(fixed) === bare(originals[i])) out[i] = fixed;
  }
  return out;
}

/* ── ElevenLabs TTS (Jorge's cloned voice) ───────────────── */

// Settings picked by Jorge from A/B test 2026-07-06 ("variant B"): lower stability +
// some style for a lively, less read-aloud delivery; 1.08x speed (his clone's default
// pace read slightly slower than his real voice).
export const ELEVEN_VOICE_SETTINGS = { stability: 0.38, similarity_boost: 0.8, style: 0.3, use_speaker_boost: true, speed: 1.08 };

export async function tts(text, outPath, { modelId = 'eleven_multilingual_v2' } = {}) {
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: modelId, voice_settings: ELEVEN_VOICE_SETTINGS })
  });
  if (!res.ok) throw new Error(`ElevenLabs TTS failed (${res.status}): ${await res.text()}`);
  fs.writeFileSync(outPath, Buffer.from(await res.arrayBuffer()));
}
