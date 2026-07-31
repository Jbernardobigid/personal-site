/**
 * generate-report-images.mjs
 * Generates the split-panel artwork for a /reports dossier via gpt-image-2.
 *
 *   node generate-report-images.mjs                 (all panels, skips existing)
 *   node generate-report-images.mjs 01-thoth-hermes (specific panels)
 *   node generate-report-images.mjs --force 05-...  (regenerate over an existing file)
 *
 * Requires OPENAI_API_KEY in .env.
 */
import './load-env.mjs';
import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';
import { PANELS } from './relatorios/o-que-apagaram-dos-nossos-deuses/panels.mjs';

const OUT_DIR = path.join(import.meta.dirname, 'relatorios', 'o-que-apagaram-dos-nossos-deuses', 'images');
fs.mkdirSync(OUT_DIR, { recursive: true });

if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY missing from .env');
  process.exit(1);
}

const args = process.argv.slice(2);
const force = args.includes('--force');
const ids = args.filter(a => !a.startsWith('--'));
const queue = ids.length ? PANELS.filter(p => ids.includes(p.id)) : PANELS;

if (!queue.length) {
  console.error(`No panels matched: ${ids.join(', ')}`);
  process.exit(1);
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
let generated = 0;

for (const panel of queue) {
  const dest = path.join(OUT_DIR, `${panel.id}.png`);
  if (fs.existsSync(dest) && !force) {
    console.log(`skip  ${panel.id} (already exists)`);
    continue;
  }
  process.stdout.write(`gen   ${panel.id} ... `);
  try {
    const res = await openai.images.generate({
      model: 'gpt-image-2',
      prompt: panel.prompt,
      n: 1,
      size: '1536x1024',
      quality: 'medium'
    });
    const item = res.data[0];
    const buf = item.b64_json
      ? Buffer.from(item.b64_json, 'base64')
      : Buffer.from(await (await fetch(item.url)).arrayBuffer());
    fs.writeFileSync(dest, buf);
    generated++;
    console.log(`ok (${(buf.length / 1024).toFixed(0)} KB)`);
  } catch (err) {
    console.log(`FAIL: ${err.message}`);
  }
}

console.log(`\n${generated} image(s) written to relatorios/o-que-apagaram-dos-nossos-deuses/images/`);
