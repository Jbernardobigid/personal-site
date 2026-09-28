/**
 * topic-rotation.mjs
 * Shared rotation rule for the cycling idea bank (cycling-topics.mjs for Reels,
 * pick-photo-topic.mjs for photo days — both append to the same usedIds ledger).
 *
 * Unused ideas always come first. Once a pool is exhausted, the old "cycled"
 * fallback reopened the WHOLE pool with no memory, so a random pick could
 * return an idea used days earlier: history-02 went out on 2026-09-12, 09-21
 * and 09-28, because the per-category spread gives the small history category
 * (6 ideas) a quarter of all photo-day draws. Now only the stalest half of the
 * pool is eligible, so an idea waits for at least half the pool to go by
 * before it can return.
 */

// Position of each idea's most recent use in the ledger (-1 = never used).
function lastUseIndex(usedIds) {
  const last = new Map();
  usedIds.forEach((id, i) => last.set(id, i));
  return last;
}

export function stalestIdeas(pool, usedIds) {
  const last = lastUseIndex(usedIds);
  const fresh = pool.filter(i => !last.has(i.id));
  if (fresh.length > 0) return { eligible: fresh, cycled: false };
  const byAge = [...pool].sort((a, b) => last.get(a.id) - last.get(b.id));
  return { eligible: byAge.slice(0, Math.ceil(pool.length / 2)), cycled: true };
}
