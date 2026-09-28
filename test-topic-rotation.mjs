/* Unit tests for topic-rotation.mjs (stalestIdeas), the shared idea-bank rule
   behind cycling-topics.mjs and pick-photo-topic.mjs. */
import { stalestIdeas } from './topic-rotation.mjs';

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  if (!ok) console.log(`FAIL ${name}\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`);
};
const ids = (r) => r.eligible.map(i => i.id).sort();
const pool = ['a', 'b', 'c', 'd', 'e', 'f'].map(id => ({ id }));

t('unused ideas come first', ids(stalestIdeas(pool, ['a', 'b', 'c', 'd'])), ['e', 'f']);
t('not cycled while unused remain', stalestIdeas(pool, ['a']).cycled, false);

// All used; last uses in order b, c, f, a, e, d → stalest half is b, c, f.
const r = stalestIdeas(pool, ['a', 'b', 'c', 'd', 'e', 'f', 'a', 'e', 'd']);
t('exhausted pool keeps only the stalest half', ids(r), ['b', 'c', 'f']);
t('flags the cycle', r.cycled, true);
t('ignores ledger ids outside the pool', ids(stalestIdeas(pool.slice(0, 2), ['a', 'b', 'x', 'a'])), ['b']);

// Replay the 2026-09 failure: 6-idea history category drawn a quarter of the
// time from a 41-idea pool. Simulate 80 picks and assert no idea returns
// within 20 picks (half the pool) of its previous use.
const bank = Array.from({ length: 41 }, (_, i) => ({ id: `idea-${i}` }));
let ledger = bank.map(i => i.id);
let minGap = Infinity;
for (let n = 0; n < 80; n++) {
  const { eligible } = stalestIdeas(bank, ledger);
  const pick = eligible[Math.floor(Math.random() * eligible.length)].id;
  const prev = ledger.lastIndexOf(pick);
  minGap = Math.min(minGap, ledger.length - prev);
  ledger = [...ledger, pick];
}
t('no idea repeats within half the pool', minGap >= 20, true);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
