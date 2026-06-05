/**
 * fetch-signals.mjs
 * Standalone CLI around signals.mjs — fetch, score, safety-check, and print the
 * ranked signal candidates (and the winner) for manual testing / local dev.
 * Also caches the run to signals/{date}.json.
 *
 * Usage:
 *   node fetch-signals.mjs            (all pillars)
 *   node fetch-signals.mjs cycling    (restrict to one pillar)
 *
 * Requires: ANTHROPIC_API_KEY (safety check).
 */

import './load-env.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { selectSignal } from './signals.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SIGNALS_DIR = path.join(__dirname, 'signals');

function isoDate() {
  return new Date().toISOString().slice(0, 10);
}

const forcePillar = process.argv[2] || null;

console.log(`Fetching signals${forcePillar ? ` for pillar: ${forcePillar}` : ' (all pillars)'}...\n`);

const { signal, pillar, candidates } = await selectSignal({ forcePillar });

console.log(`Gathered ${candidates.length} fresh, de-duplicated candidate(s).\n`);

const ranked = candidates.slice(0, 12);
ranked.forEach((c, i) => {
  const safeTag = c.safe === true ? '✅' : c.safe === false ? `⛔ (${c.safetyReason})` : '· ';
  console.log(`${String(i + 1).padStart(2)}. ${safeTag} [${c.pillar}] (${c.score?.toFixed(3)}) ${c.title}`);
  console.log(`        ${c.source}${c.date ? ` · ${c.date.slice(0, 10)}` : ''}`);
});

console.log('\n──────────────────────────────────────────────');
if (signal) {
  console.log(`WINNER → [${pillar}] ${signal.title}`);
  console.log(`Source: ${signal.source}${signal.date ? ` · ${signal.date.slice(0, 10)}` : ''}`);
  console.log(`URL:    ${signal.url}`);
} else {
  console.log('No safe, on-brand signal found → blog would fall back to evergreen rotation.');
}
console.log('──────────────────────────────────────────────');

fs.mkdirSync(SIGNALS_DIR, { recursive: true });
const outPath = path.join(SIGNALS_DIR, `${isoDate()}.json`);
fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), forcePillar, winner: signal, pillar, candidates }, null, 2), 'utf8');
console.log(`\nSaved → signals/${path.basename(outPath)}`);
