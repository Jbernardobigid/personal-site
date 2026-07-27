/**
 * photo-day.mjs
 * Orchestrator for the n8n "Instagram — Cycling photo day" workflow: the
 * single-image counterpart to prepare-video.mjs --cycling. Picks an idea from
 * cycling-topics-bank.json (photo-suited categories only — see
 * pick-photo-topic.mjs), builds a standalone single-image post via
 * generate-carousel.mjs, then queues it through the same Notion approval rail
 * carousels already use (queue-to-notion.mjs).
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
 * Always passes --photo-required to generate-carousel.mjs so the post can't
 * land on the one single-type ("quote") that renders no photo at all.
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

function main() {
  const dryRun = process.argv.includes('--dry-run');

  console.log('1/3 Picking photo-day topic...');
  run(['pick-photo-topic.mjs', ...(dryRun ? ['--dry-run'] : [])]);

  const topic = JSON.parse(fs.readFileSync(TOPIC_PATH, 'utf8'));
  console.log(`\n2/3 Building single-image post: "${topic.idea}"...`);
  const genEnv = topic.photo ? { JORGE_CAROUSEL_PHOTO: topic.photo } : {};
  run(['generate-carousel.mjs', '--topic', topic.idea, '--format', 'single', '--pillar', 'cycling', '--photo-required'], genEnv);

  if (dryRun) {
    console.log('\n--- DRY RUN: built but NOT queued to Notion ---');
    console.log(`Category: ${topic.category} | Photo pin: ${topic.photo ?? '(none — Claude picks from inventory)'}`);
    console.log(JSON.stringify({ success: true, dryRun, bankId: topic.bankId, category: topic.category }));
    return;
  }

  console.log('\n3/3 Queueing to Notion...');
  run(['queue-to-notion.mjs']);

  console.log(JSON.stringify({ success: true, bankId: topic.bankId, category: topic.category }));
}

try {
  main();
} catch (err) {
  fail('unexpected error', String(err?.stack || err));
}
