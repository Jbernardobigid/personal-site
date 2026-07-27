/**
 * pick-photo-topic.mjs
 * Picks one idea from cycling-topics-bank.json for a "photo day" post — the
 * single-image counterpart to cycling-topics.mjs's Reel picks. Shares the SAME
 * bank and usage ledger (cycling-topics-used.json) so photo-day and Reel picks
 * never repeat each other's ideas, and the diversity floor sees both streams.
 * Restricted to categories suited to a single still image (humor, identity,
 * history, gear) rather than the narrated multi-beat categories Reels use.
 *
 * No LLM call here — the creative extraction happens in generate-carousel.mjs's
 * own Claude call. This script is a deterministic, $0 selector.
 *
 * Output: photo-topic.json (root, gitignored) — { idea, category, photo, bankId } —
 * consumed by photo-day.mjs.
 *
 * Usage:
 *   node pick-photo-topic.mjs            (pick, mark used, write photo-topic.json)
 *   node pick-photo-topic.mjs --dry-run  (pick + write photo-topic.json, but don't mark used)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BANK_PATH = path.join(__dirname, 'cycling-topics-bank.json');
const USED_PATH = path.join(__dirname, 'cycling-topics-used.json');
const OUT_PATH = path.join(__dirname, 'photo-topic.json');

// Categories suited to a single still image: personal, visual, punchy — not the
// narrated multi-beat categories (tips/advocacy/mind/community/strava) Reels use.
const PHOTO_DAY_CATEGORIES = ['humor', 'identity', 'history', 'gear'];
const RECENT_TITLES_KEPT = 12;

function fail(msg) {
  console.log(JSON.stringify({ success: false, error: msg }));
  process.exit(1);
}

function loadBank() {
  const bank = JSON.parse(fs.readFileSync(BANK_PATH, 'utf8'));
  if (!Array.isArray(bank.ideas) || bank.ideas.length === 0) fail('idea bank empty');
  return bank.ideas;
}

function loadUsed() {
  try {
    const u = JSON.parse(fs.readFileSync(USED_PATH, 'utf8'));
    return { usedIds: u.usedIds ?? [], recentTitles: u.recentTitles ?? [], recentCategories: u.recentCategories ?? [] };
  } catch { return { usedIds: [], recentTitles: [], recentCategories: [] }; }
}

function saveUsed(used, pickedId, title, category) {
  const usedIds = [...used.usedIds, pickedId];
  const recentTitles = [...used.recentTitles, title].slice(-RECENT_TITLES_KEPT);
  const recentCategories = [...used.recentCategories, category].slice(-4);
  fs.writeFileSync(USED_PATH, JSON.stringify({ usedIds, recentTitles, recentCategories }, null, 2), 'utf8');
}

// Same diversity-floor philosophy as cycling-topics.mjs's pickCandidates: the
// previous pick's category is excluded when alternatives exist, so the photo-day
// + Reel streams together can't collapse onto one winning category. Spreads
// evenly across categories (not a uniform pick over the pool) so identity's
// larger idea count doesn't dominate every draw.
function pickIdea(ideas, usedIds, lastCategory) {
  let pool = ideas.filter(i => PHOTO_DAY_CATEGORIES.includes(i.category) && !usedIds.includes(i.id));
  let cycled = false;
  if (pool.length === 0) {
    pool = ideas.filter(i => PHOTO_DAY_CATEGORIES.includes(i.category));
    cycled = true;
  }
  if (lastCategory) {
    const withoutLast = pool.filter(i => i.category !== lastCategory);
    if (withoutLast.length > 0) pool = withoutLast;
  }
  const byCategory = new Map();
  for (const idea of pool) {
    const list = byCategory.get(idea.category) ?? [];
    byCategory.set(idea.category, [...list, idea]);
  }
  const categories = [...byCategory.keys()];
  const category = categories[Math.floor(Math.random() * categories.length)];
  const options = byCategory.get(category);
  const idea = options[Math.floor(Math.random() * options.length)];
  return { idea, cycled };
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const ideas = loadBank();
  const used = loadUsed();
  const lastCategory = used.recentCategories[used.recentCategories.length - 1] ?? null;

  const { idea, cycled } = pickIdea(ideas, used.usedIds, lastCategory);
  console.log(`Picked: [${idea.id}] (${idea.category}) ${idea.idea}${cycled ? ' (photo-day pool cycled — restarted)' : ''}`);
  if (idea.photo) console.log(`  Photo pin: ${idea.photo}`);

  fs.writeFileSync(OUT_PATH, JSON.stringify({ idea: idea.idea, category: idea.category, photo: idea.photo ?? null, bankId: idea.id }, null, 2), 'utf8');
  if (!dryRun) saveUsed(used, idea.id, idea.idea, idea.category);

  console.log(`\nWritten: photo-topic.json${dryRun ? ' (dry run — bank id NOT marked used)' : ` (bank id ${idea.id} marked used)`}`);
  console.log(JSON.stringify({ success: true, dryRun, bankId: idea.id, category: idea.category }));
}

main();
