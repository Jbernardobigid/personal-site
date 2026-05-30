/**
 * build-montages.mjs
 * Builds labeled contact-sheet montages of every photo in brand_assets/Fotos
 * so the catalog (brand_assets/Fotos/INVENTORY.md) can be reviewed/refreshed
 * by viewing a handful of grids instead of hundreds of individual photos.
 * Each thumbnail is EXIF-auto-rotated and labeled with its filename.
 *
 * Usage: node build-montages.mjs
 * Output: brand_assets/Fotos/_inventory_montages/montage-<group>-NN.png  (temp — safe to delete)
 */
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, 'brand_assets', 'Fotos');
const OUT = path.join(DIR, '_inventory_montages');
fs.mkdirSync(OUT, { recursive: true });

const CELL_W = 320, IMG_H = 300, LABEL_H = 36, CELL_H = IMG_H + LABEL_H;
const COLS = 5, PER = 20;

function labelSvg(text) {
  return Buffer.from(
    `<svg width="${CELL_W}" height="${LABEL_H}">
       <rect width="100%" height="100%" fill="#101010"/>
       <text x="${CELL_W / 2}" y="${LABEL_H / 2 + 6}" font-family="monospace" font-size="17" fill="#ffffff" text-anchor="middle">${text}</text>
     </svg>`
  );
}

async function makeCell(file) {
  const name = path.basename(file).replace(/\.(jpg|jpeg|png)$/i, '');
  const img = await sharp(path.join(DIR, file))
    .rotate() // auto EXIF orientation
    .resize(CELL_W, IMG_H, { fit: 'contain', background: '#000' })
    .toBuffer();
  return sharp({ create: { width: CELL_W, height: CELL_H, channels: 3, background: '#000' } })
    .composite([
      { input: img, top: 0, left: 0 },
      { input: labelSvg(name), top: IMG_H, left: 0 },
    ])
    .png().toBuffer();
}

async function montage(files, outName) {
  const cells = [];
  for (const f of files) cells.push(await makeCell(f));
  const rows = Math.ceil(cells.length / COLS);
  const W = COLS * CELL_W, H = rows * CELL_H;
  const comp = cells.map((c, i) => ({
    input: c,
    left: (i % COLS) * CELL_W,
    top: Math.floor(i / COLS) * CELL_H,
  }));
  await sharp({ create: { width: W, height: H, channels: 3, background: '#000' } })
    .composite(comp).png().toFile(outName);
  console.log(`  ${path.basename(outName)} (${files.length} photos)`);
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function main() {
  const all = fs.readdirSync(DIR).filter(f => /\.(jpg|jpeg|png)$/i.test(f));
  const groups = {
    phone: all.filter(f => f.startsWith('20221203_')).sort(),
    cam7B7A: all.filter(f => f.startsWith('7B7A')).sort(),
    dsc: all.filter(f => f.startsWith('DSC')).sort(),
  };

  for (const [key, files] of Object.entries(groups)) {
    if (files.length === 0) continue;
    console.log(`\n${key}: ${files.length} photos`);
    const batches = chunk(files, PER);
    for (let i = 0; i < batches.length; i++) {
      await montage(batches[i], path.join(OUT, `montage-${key}-${String(i + 1).padStart(2, '0')}.png`));
    }
  }
  console.log('\nDone. View montages in _inventory_montages/, then delete the folder.');
}

main().catch(e => { console.error(e); process.exit(1); });
