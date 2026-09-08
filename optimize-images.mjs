/**
 * Build-time responsive image pipeline for the homepage.
 *
 * Exists because of a live SEO audit finding: index.html shipped 107 MB of
 * images. Every photo was served at camera resolution (up to 4128x5504,
 * 17.9 MB) and displayed at 360-959 CSS px. Measured on the live site with a
 * throttled headless Chrome, LCP was 101.1 s on Slow 4G and the page never
 * finished loading inside 180 s.
 *
 * This reads the untouched originals in images/ and writes a responsive ladder
 * of WebP + JPEG variants to images/opt/. Originals stay on disk and stay
 * deployed: they are the source of truth, and blog posts still reference two of
 * them as og:image. Nothing here mutates a source file.
 *
 * A second mode handles the blog art. Every post generates a ~1.94 MB PNG that was
 * referenced only as og:image and never rendered on the page, 105 MB across 54 posts.
 * --blog re-encodes each one to a JPEG (the og:image, because LinkedIn and WhatsApp
 * render WebP cards unreliably) plus a WebP sibling for the on-page <picture>.
 *
 * A third mode does the same for the relatórios, where the PNGs are worse: unlike the
 * blog art they ARE rendered on the page, twelve of them at 2.2-2.6 MB each, so a
 * reader of one dossier downloaded 29 MB. That is both the largest single block of
 * deploy weight after social/ and a real LCP problem on a page meant to be read.
 *
 *   node optimize-images.mjs              build missing/stale variants
 *   node optimize-images.mjs --blog       re-encode blog post art to jpg + webp
 *   node optimize-images.mjs --relatorios re-encode relatório art to jpg + webp
 *   node optimize-images.mjs --force      rebuild everything
 *   node optimize-images.mjs --report     report only, write nothing
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(__dirname, 'images');
const OUT_DIR = path.join(SRC_DIR, 'opt');

const FORCE  = process.argv.includes('--force');
const REPORT = process.argv.includes('--report');

/* Width ladder. 480/960 cover phones at 1-2x; 1440/1920 cover the two-column
 * mosaic tiles and the desktop hero; 2560 exists only for the full-bleed
 * cycling hero on a retina laptop. Variants wider than the source are skipped,
 * so a 3000px original simply stops at 1920. */
const WIDTHS = [480, 960, 1440, 1920, 2560];

const WEBP_QUALITY = 78;
const JPEG_QUALITY = 80;

/* The photos actually rendered by index.html, each capped at the widest variant
 * its layout slot can ever request. Only cycling-hero.jpg is full-bleed
 * (100vw), so it is the only image that can justify the 2560 tier; the mosaic
 * tops out at 66vw and the side photos at 46vw, and building 2560 variants for
 * those was 6.5 MB of deploy weight no browser would ever ask for.
 * Logos are excluded: at 17-136 KB they were never part of the problem. */
const SOURCES = [
  { file: 'hero.jpg',         maxWidth: 1920 },
  { file: 'about.jpg',        maxWidth: 1920 },
  { file: 'dppp-main.jpg',    maxWidth: 1440 },
  { file: 'feira-1.jpg',      maxWidth: 1440 },
  { file: 'feira-2.jpg',      maxWidth: 1440 },
  { file: 'cycling-hero.jpg', maxWidth: 2560 },
  { file: 'cycling-1.jpg',    maxWidth: 1920 },
  { file: 'cycling-2.jpg',    maxWidth: 1920 },
  { file: 'cycling-3.jpg',    maxWidth: 1920 },
  { file: 'cycling-4.jpg',    maxWidth: 1920 },
  { file: 'cycling-5.jpg',    maxWidth: 1920 },
  { file: 'cycling-6.jpg',    maxWidth: 1920 }
];

/* Open Graph card. The homepage previously advertised og:image as 1200x630
 * while pointing at a 3308x5094 portrait, so every social preview was cropped
 * by the platform in a way nobody had chosen. This renders the crop we want.
 * Anchored to the top because hero.jpg is a portrait and the face is up there,
 * matching the page's own `object-position: center top`. */
const OG_WIDTH  = 1200;
const OG_HEIGHT = 630;
const OG_CARDS = [
  // Portrait source: anchor to the top so the crop keeps the face.
  { source: 'hero.jpg',    out: 'og-home.jpg',  position: 'top' },
  // Two early posts predate per-post art and point at this photo as their og:image,
  // also while declaring 1200x630. Landscape source, so a centre crop is right.
  { source: 'feira-1.jpg', out: 'og-feira.jpg', position: 'centre' }
];

const mb = (bytes) => (bytes / 1048576).toFixed(2);
const kb = (bytes) => Math.round(bytes / 1024);

function isStale(srcPath, outPath) {
  if (FORCE) return true;
  if (!fs.existsSync(outPath)) return true;
  return fs.statSync(srcPath).mtimeMs > fs.statSync(outPath).mtimeMs;
}

async function buildVariants({ file, maxWidth }) {
  const srcPath = path.join(SRC_DIR, file);
  const base = path.basename(file, path.extname(file));
  const meta = await sharp(srcPath).metadata();
  const written = [];

  for (const width of WIDTHS) {
    // Never upscale, and never exceed what this image's layout slot can request.
    if (width > meta.width) continue;
    if (width > maxWidth) continue;

    for (const [ext, options] of [
      ['webp', { quality: WEBP_QUALITY }],
      ['jpg',  { quality: JPEG_QUALITY, progressive: true, mozjpeg: true }]
    ]) {
      const outPath = path.join(OUT_DIR, `${base}-${width}.${ext}`);
      if (!isStale(srcPath, outPath)) {
        written.push({ outPath, size: fs.statSync(outPath).size, skipped: true });
        continue;
      }
      if (REPORT) continue;

      const pipeline = sharp(srcPath).resize({ width, withoutEnlargement: true });
      await (ext === 'webp' ? pipeline.webp(options) : pipeline.jpeg(options)).toFile(outPath);
      written.push({ outPath, size: fs.statSync(outPath).size, skipped: false });
    }
  }

  return { base, srcSize: fs.statSync(srcPath).size, meta, written };
}

async function buildOgCards() {
  const built = [];
  for (const card of OG_CARDS) {
    const srcPath = path.join(SRC_DIR, card.source);
    const outPath = path.join(OUT_DIR, card.out);
    if (isStale(srcPath, outPath) && !REPORT) {
      await sharp(srcPath)
        .resize({ width: OG_WIDTH, height: OG_HEIGHT, fit: 'cover', position: card.position })
        .jpeg({ quality: 82, progressive: true, mozjpeg: true })
        .toFile(outPath);
    }
    built.push({ name: card.out, size: fs.existsSync(outPath) ? fs.statSync(outPath).size : 0 });
  }
  return built;
}

/* ── Editorial art: PNG → jpg + webp pair ────────────────── */

/* Both the blog and the relatórios generate split-panel PNGs at the same size and
 * use them the same way: a JPEG as the og:image (LinkedIn and WhatsApp render WebP
 * cards unreliably) plus a WebP sibling for the on-page <picture>. Same conversion,
 * same quality settings, so one function serves both. */
const ART_WIDTH = 1536;    // the dimensions the pages already declare
const ART_HEIGHT = 1024;

/** Convert every PNG in one directory to a jpg + webp pair. Returns byte totals. */
async function convertArtDir(dir) {
  const pngs = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.png'));
  let before = 0, after = 0, converted = 0;

  for (const png of pngs) {
    const srcPath = path.join(dir, png);
    const base = path.basename(png, '.png');
    const jpgPath  = path.join(dir, `${base}.jpg`);
    const webpPath = path.join(dir, `${base}.webp`);
    before += fs.statSync(srcPath).size;

    if (isStale(srcPath, jpgPath) && !REPORT) {
      await sharp(srcPath)
        .resize({ width: ART_WIDTH, height: ART_HEIGHT, fit: 'cover' })
        .jpeg({ quality: 82, progressive: true, mozjpeg: true })
        .toFile(jpgPath);
      converted++;
    }
    if (isStale(srcPath, webpPath) && !REPORT) {
      await sharp(srcPath)
        .resize({ width: ART_WIDTH, height: ART_HEIGHT, fit: 'cover' })
        .webp({ quality: 80 })
        .toFile(webpPath);
    }

    if (fs.existsSync(jpgPath))  after += fs.statSync(jpgPath).size;
    if (fs.existsSync(webpPath)) after += fs.statSync(webpPath).size;
  }
  return { count: pngs.length, before, after, converted };
}

function reportArt(label, { count, before, after, converted }) {
  console.log(`${label}: ${count} PNG(s), ${converted} converted this run`);
  console.log(`  before (png):        ${mb(before).padStart(7)} MB`);
  console.log(`  after  (jpg+webp):   ${mb(after).padStart(7)} MB`);
  console.log(`  reduction:           ${(100 - (after / before) * 100).toFixed(1)}%`);
}

const BLOG_IMAGES_DIR = path.join(__dirname, 'blog', 'posts', 'images');
const RELATORIOS_DIR = path.join(__dirname, 'relatorios');

async function convertBlogImages() {
  if (!fs.existsSync(BLOG_IMAGES_DIR)) {
    console.error(`Blog image directory not found: ${BLOG_IMAGES_DIR}`);
    process.exit(1);
  }
  const stats = await convertArtDir(BLOG_IMAGES_DIR);
  if (!stats.count) {
    console.log('No PNG blog art left to convert.');
    return;
  }
  reportArt('blog art', stats);
  console.log('\n  The PNGs are now unreferenced. Delete them once the posts point at');
  console.log('  the .jpg/.webp pair and the feed has been regenerated.');
}

/* The relatórios keep their art beside the dossier rather than in one shared folder,
 * so this walks each relatorios/<slug>/images/ it finds instead of taking a fixed path.
 * New dossiers are picked up without touching this file. */
async function convertRelatorioImages() {
  if (!fs.existsSync(RELATORIOS_DIR)) {
    console.error(`Relatórios directory not found: ${RELATORIOS_DIR}`);
    process.exit(1);
  }
  const dirs = fs.readdirSync(RELATORIOS_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => path.join(RELATORIOS_DIR, e.name, 'images'))
    .filter(d => fs.existsSync(d));

  if (!dirs.length) {
    console.log('No relatório image directories found.');
    return;
  }

  const total = { count: 0, before: 0, after: 0, converted: 0 };
  for (const dir of dirs) {
    const stats = await convertArtDir(dir);
    if (!stats.count) continue;
    reportArt(path.relative(__dirname, dir).replace(/\\/g, '/'), stats);
    for (const k of Object.keys(total)) total[k] += stats[k];
  }
  if (!total.count) {
    console.log('No PNG relatório art left to convert.');
    return;
  }
  console.log('');
  reportArt('relatórios total', total);
  console.log('\n  The PNGs stay on disk as the source of truth but are excluded from the');
  console.log('  deployment by .vercelignore once the pages point at the .jpg/.webp pair.');
}

async function main() {
  if (process.argv.includes('--blog')) {
    await convertBlogImages();
    return;
  }
  if (process.argv.includes('--relatorios')) {
    await convertRelatorioImages();
    return;
  }

  if (!fs.existsSync(SRC_DIR)) {
    console.error(`Source directory not found: ${SRC_DIR}`);
    process.exit(1);
  }
  if (!REPORT) fs.mkdirSync(OUT_DIR, { recursive: true });

  const missing = SOURCES.filter(s => !fs.existsSync(path.join(SRC_DIR, s.file)));
  if (missing.length) {
    console.error(`Missing source image(s): ${missing.map(s => s.file).join(', ')}`);
    process.exit(1);
  }

  let srcTotal = 0;
  let builtCount = 0;
  const perImage = [];

  for (const source of SOURCES) {
    const result = await buildVariants(source);
    srcTotal += result.srcSize;
    builtCount += result.written.filter(w => !w.skipped).length;
    perImage.push(result);
    const largest = result.written.length
      ? Math.max(...result.written.filter(w => w.outPath.endsWith('.webp')).map(w => w.size))
      : 0;
    console.log(
      `${source.file.padEnd(20)} ${String(result.meta.width).padStart(4)}x${result.meta.height}` +
      `  ${mb(result.srcSize).padStart(6)} MB  ->  ${result.written.length} variants, ` +
      `largest webp ${kb(largest)} KB`
    );
  }

  for (const card of await buildOgCards()) {
    console.log(`\n${card.name.padEnd(20)} ${OG_WIDTH}x${OG_HEIGHT}  ${kb(card.size)} KB (Open Graph card)`);
  }

  /* What the browser actually downloads is one variant per image, not the whole
   * ladder. Compare the originals against the widest WebP the desktop layout
   * can request, which is the honest before/after for the page payload. */
  const worstCaseNew = perImage.reduce((sum, r) => {
    const webps = r.written.filter(w => w.outPath.endsWith('.webp')).map(w => w.size);
    return sum + (webps.length ? Math.max(...webps) : 0);
  }, 0);

  console.log(`\n  originals on page:        ${mb(srcTotal).padStart(7)} MB`);
  console.log(`  widest webp per image:    ${mb(worstCaseNew).padStart(7)} MB`);
  console.log(`  reduction:                ${(100 - (worstCaseNew / srcTotal) * 100).toFixed(1)}%`);
  console.log(`  variants written this run: ${builtCount}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
