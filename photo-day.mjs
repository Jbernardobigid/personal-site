/**
 * photo-day.mjs
 * Orchestrator for the n8n "Instagram — Cycling photo day" workflow: the
 * non-Reel counterpart to prepare-video.mjs --cycling. Picks an idea from
 * cycling-topics-bank.json (photo-suited categories only — see
 * pick-photo-topic.mjs), builds a standalone photo post via
 * generate-carousel.mjs, then queues it through the same Notion approval rail
 * carousels already use (queue-to-notion.mjs).
 *
 * Shape follows the idea's theme (see routeFormat below), it is no longer
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOPIC_PATH = path.join(__dirname, 'photo-topic.json');

function fail(msg, detail = '') {
  console.log(JSON.stringify({ success: false, error: msg, detail }));
  process.exit(1);
}

function run(args, extraEnv = {}) {
  execFileSync('node', args, { cwd: __dirname, stdio: 'inherit', env: { ...process.env, ...extraEnv }, timeout: 300000 });
}

// Categories whose ideas in cycling-topics-bank.json are enumerations by
// construction ("Sinais de que…", "as 4 estações…", "o que priorizar quando o
// orçamento é curto"). All 5 humor ideas and 2 of 3 gear ideas are lists, and
// flattening a list onto one card throws away the joke's timing — the swipe is
// the punchline pacing. These get the shorter enumeration carousel cut.
const LIST_SHAPED_CATEGORIES = ['humor', 'gear'];

// Picks the post shape from the idea's theme instead of pinning every photo day
// to one format. Returns { format, why }; a null format means "pass no --format
// flag and let generate-carousel.mjs's editorial filter decide" (reframe when
// the idea passes the three tests, single when it doesn't).
//
// Why this beats the old hardcoded --format single: that override doesn't just
// choose a shape, it SKIPS the editorial filter entirely, so ideas that are
// textbook flips ("a estampa não é decoração, é declaração") could never become
// the reframe carousel they were written as.
//
// The photo pin is the tiebreaker for identity/history: a pinned idea exists to
// show that one specific jersey (see brand_assets/Fotos/INVENTORY.md §3a), so
// the photo IS the post and a single card serves it best. Unpinned ideas in the
// same categories carry an argument, which the filter is built to shape.
function routeFormat(topic) {
  if (LIST_SHAPED_CATEGORIES.includes(topic.category)) {
    return { format: 'list', why: `${topic.category} ideas are enumerations` };
  }
  if (topic.photo) {
    return { format: 'single', why: 'photo-pinned idea, the jersey is the post' };
  }
  return { format: null, why: 'unpinned argument, let the three-test filter choose' };
}

function main() {
  const dryRun = process.argv.includes('--dry-run');

  console.log('1/3 Picking photo-day topic...');
  run(['pick-photo-topic.mjs', ...(dryRun ? ['--dry-run'] : [])]);

  const topic = JSON.parse(fs.readFileSync(TOPIC_PATH, 'utf8'));
  const { format, why } = routeFormat(topic);
  console.log(`\n2/3 Building post: "${topic.idea}"`);
  console.log(`     Shape: ${format ?? 'editorial filter decides'} (${why})`);
  const genEnv = topic.photo ? { JORGE_CAROUSEL_PHOTO: topic.photo } : {};
  const formatArgs = format ? ['--format', format] : [];
  run(['generate-carousel.mjs', '--topic', topic.idea, ...formatArgs, '--pillar', 'cycling', '--photo-required'], genEnv);

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
