/**
 * gpt-image-2 still generation for the Odisseia Reel.
 * Portrait 1024x1536 (padded to 1080x1920 at assembly time).
 *
 *   node projects/odisseia/lib/images.mjs            all, skips existing
 *   node projects/odisseia/lib/images.mjs 01-helena  specific ids
 *   node projects/odisseia/lib/images.mjs --force …  regenerate
 */
import '../../../load-env.mjs';
import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';
import { PANELS } from '../panels.mjs';

const OUT_DIR = path.join(import.meta.dirname, '..', 'out', 'stills');
fs.mkdirSync(OUT_DIR, { recursive: true });

if (!process.env.OPENAI_API_KEY) { console.error('OPENAI_API_KEY missing'); process.exit(1); }

const args = process.argv.slice(2);
const force = args.includes('--force');
const ids = args.filter(a => !a.startsWith('--'));
const queue = ids.length ? PANELS.filter(p => ids.includes(p.id)) : PANELS;
if (!queue.length) { console.error(`no panels matched: ${ids.join(', ')}`); process.exit(1); }

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
let made = 0;

for (const panel of queue) {
  const dest = path.join(OUT_DIR, `${panel.id}.png`);
  if (fs.existsSync(dest) && !force) { console.log(`skip  ${panel.id}`); continue; }
  process.stdout.write(`gen   ${panel.id} ... `);
  try {
    const res = await openai.images.generate({
      model: 'gpt-image-2',
      prompt: panel.prompt,
      n: 1,
      size: '1024x1536',
      quality: 'high'
    });
    const item = res.data[0];
    const buf = item.b64_json
      ? Buffer.from(item.b64_json, 'base64')
      : Buffer.from(await (await fetch(item.url)).arrayBuffer());
    fs.writeFileSync(dest, buf);
    made++;
    console.log(`ok (${(buf.length / 1024).toFixed(0)} KB)`);
  } catch (err) {
    console.log(`FAIL: ${err.message.slice(0, 160)}`);
  }
}
console.log(`\n${made} still(s) -> projects/odisseia/out/stills/`);
