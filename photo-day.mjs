/**
 * photo-day.mjs
 * Orchestrator for the n8n "Instagram — Cycling photo day" workflow: the
 * non-Reel counterpart to prepare-video.mjs --cycling. Picks an idea from
 * cycling-topics-bank.json (photo-suited categories only — see
 * pick-photo-topic.mjs), builds a standalone photo post via
 * generate-carousel.mjs, then queues it through the same Notion approval rail
 * carousels already use (queue-to-notion.mjs).
 *
 * Shape follows the idea's theme (see photo-day-format.mjs), it is no longer
 * pinned to a single image: enumeration categories become a short list
 * carousel, photo-pinned jersey ideas stay single, and unpinned arguments go
 * through generate-carousel.mjs's own editorial filter. The publish rail is
 * already format-agnostic (post-to-instagram.mjs counts the staged PNGs), so
 * multi-slide photo days need no downstream change.
 *
 * Fills the days the cycling Reel workflow (Instagram — Cycling Reel, Tue/Wed/Fri)
 * doesn't cover, so the account posts daily without adding more Reels — real
 * photo + HTML/CSS text treatment, $0 cost, no AI image generation or editing
 * (see docs/audience-simulation-report.md §6: the account already rejected
 * literal AI imagery for Reels, and static IMAGE posts underperform VIDEO here,
 * so the bet is on humor/identity framing, not a new visual medium).
 *
 * Idea-to-photo pinning: jersey-specific ideas in the bank carry a "photo" field
 * (see brand_assets/Fotos/INVENTORY.md §3a) forcing that exact real photo via
 * JORGE_CAROUSEL_PHOTO — deterministic, not left to Claude's inventory judgment.
 * Always passes --photo-required to generate-carousel.mjs, which hard-fails the
 * build unless at least one slide lands on a template with a photo slot. That
 * guard matters more now that photo day can go multi-slide: the four reframe
 * templates are 100% typographic and only 3 of the 12 legacy carousel types
 * carry a photo, so without it a photo day could quietly render no photo.
 *
 * Usage:
 *   node photo-day.mjs            (pick + build + queue)
 *   node photo-day.mjs --dry-run  (pick + build for real, print, skip Notion queue
 *                                  and skip marking the bank idea used)
 */
import './load-env.mjs';
import fs from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { routeFormat, shapeOfFormat } from './photo-day-format.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOPIC_PATH = path.join(__dirname, 'photo-topic.json');
const USED_PATH = path.join(__dirname, 'cycling-topics-used.json');
const META_PATH = path.join(__dirname, 'carousel-meta.json');

function fail(msg, detail = '') {
  console.log(JSON.stringify({ success: false, error: msg, detail }));
  process.exit(1);
}

function run(args, extraEnv = {}) {
  execFileSync('node', args, { cwd: __dirname, stdio: 'inherit', env: { ...process.env, ...extraEnv }, timeout: 300000 });
}

// routeFormat and the shape classes now live in photo-day-format.mjs, because
// pick-photo-topic.mjs has to apply the same rules one step earlier to keep its
// diversity floor honest about shape. The photo pin is the tiebreaker for
// identity/history: a pinned idea exists to show that one specific jersey (see
// brand_assets/Fotos/INVENTORY.md §3a), so the photo IS the post and a single
// card serves it best. Unpinned ideas in the same categories carry an argument,
// which the filter is built to shape.

// When routeFormat defers to the editorial filter, the picker could only record
// null for this post's shape — so tomorrow's floor would have nothing to push
// away from and could hand us a second carousel in a row. generate-carousel.mjs
// has just written the real answer to carousel-meta.json, so correct the ledger
// entry the picker left open. Best-effort by design: a bad write here must never
// fail a post that already built and is about to queue.
function recordBuiltShape() {
  try {
    const built = JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
    const shape = shapeOfFormat(built.format);
    if (!shape) return;
    const used = JSON.parse(fs.readFileSync(USED_PATH, 'utf8'));
    if (!Array.isArray(used.recentShapes) || used.recentShapes.length === 0) return;
    if (used.recentShapes[used.recentShapes.length - 1] === shape) return;
    used.recentShapes[used.recentShapes.length - 1] = shape;
    fs.writeFileSync(USED_PATH, JSON.stringify(used, null, 2), 'utf8');
    console.log(`     Shape ledger corrected to "${shape}" (built format: ${built.format})`);
  } catch (err) {
    console.log(`     [warn] could not record built shape: ${err.message}`);
  }
}

function main() {
  const dryRun = process.argv.includes('--dry-run');

  console.log('1/3 Picking photo-day topic...');
  run(['pick-photo-topic.mjs', ...(dryRun ? ['--dry-run'] : [])]);

  const topic = JSON.parse(fs.readFileSync(TOPIC_PATH, 'utf8'));
  // pick-photo-topic.mjs already routed this idea (it needs the previous post's
  // shape, which the ledger no longer exposes once today's pick is recorded).
  // Recompute only as a fallback for a photo-topic.json written before that.
  const { format, why } = 'format' in topic
    ? { format: topic.format, why: topic.formatWhy ?? 'routed at pick time' }
    : routeFormat(topic);
  console.log(`\n2/3 Building post: "${topic.idea}"`);
  console.log(`     Shape: ${format ?? 'editorial filter decides'} (${why})`);
  const genEnv = topic.photo ? { JORGE_CAROUSEL_PHOTO: topic.photo } : {};
  const formatArgs = format ? ['--format', format] : [];
  run(['generate-carousel.mjs', '--topic', topic.idea, ...formatArgs, '--pillar', 'cycling', '--photo-required'], genEnv);
  if (!dryRun) recordBuiltShape();

  if (dryRun) {
    console.log('\n--- DRY RUN: built but NOT queued to Notion ---');
    console.log(`Category: ${topic.category} | Photo pin: ${topic.photo ?? '(none — Claude picks from inventory)'}`);
    console.log(JSON.stringify({ success: true, dryRun, bankId: topic.bankId, category: topic.category, shape: format ?? 'filter' }));
    return;
  }

  console.log('\n3/3 Queueing to Notion...');
  run(['queue-to-notion.mjs']);

  console.log(JSON.stringify({ success: true, bankId: topic.bankId, category: topic.category, shape: format ?? 'filter' }));
}

try {
  main();
} catch (err) {
  fail('unexpected error', String(err?.stack || err));
}
