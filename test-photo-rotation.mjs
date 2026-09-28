/* Unit tests for photo rotation in generate-carousel.mjs (pickPhoto + photoLedger).
   Safe to import: main() only runs when the module is invoked directly. */
import { pickPhoto, photoLedger } from './generate-carousel.mjs';

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  if (!ok) console.log(`FAIL ${name}\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`);
};

const range = (prefix, from, to) =>
  Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${String(from + i).padStart(5, '0')}.jpg`);
const files = [...range('DSC', 400, 450), '7B7A0105.jpg', 'race-medal.jpg'];

t('fresh pick is honored', pickPhoto(files, 'DSC00412', []), 'DSC00412.jpg');
t('used pick moves off the burst', pickPhoto(files, 'DSC00412', ['DSC00412.jpg']), 'DSC00409.jpg');
t('burst neighbour of a used frame is also spent', pickPhoto(files, 'DSC00413', ['DSC00412.jpg']), 'DSC00415.jpg');
t('frame outside the burst window is fresh', pickPhoto(files, 'DSC00415', ['DSC00412.jpg']), 'DSC00415.jpg');

// Every frame in the scene (425±20) used: take the least recently used, never jump shoots.
const scene = range('DSC', 400, 450);
t('spent scene falls back to least recently used', pickPhoto(scene, 'DSC00425', scene), 'DSC00405.jpg');

t('unnumbered used pick falls back to a fresh photo',
  pickPhoto(['race-medal.jpg', 'x.jpg'], 'race-medal', ['race-medal.jpg']), 'x.jpg');
t('empty library', pickPhoto([], 'DSC00412', []), null);

t('ledger seeded from legacy posts', photoLedger({ posts: [{ photo: 'a.jpg' }, { photo: null }, { photo: 'b.jpg' }] }), ['a.jpg', 'b.jpg']);
t('ledger field wins once present', photoLedger({ posts: [{ photo: 'a.jpg' }], photos: ['z.jpg'] }), ['z.jpg']);

// Replay of Jul 30 – Sep 14 2026: Claude kept asking for the same FAST PICK
// hero frames. With the ledger, none of 20 consecutive picks may repeat.
const lib = [...range('DSC', 298, 562)];
const heroes = ['DSC00412', 'DSC00445', 'DSC00436', 'DSC00521', 'DSC00553', 'DSC00524', 'DSC00499', 'DSC00476', 'DSC00559', 'DSC00328'];
let ledger = [];
const chosen = [];
for (let i = 0; i < 20; i++) {
  const got = pickPhoto(lib, heroes[i % heroes.length], ledger);
  chosen.push(got);
  ledger = [...ledger, got].slice(-40);
}
t('20 hero-biased picks are all distinct', new Set(chosen).size, 20);
const nums = chosen.map(f => parseInt(f.slice(3), 10)).sort((a, b) => a - b);
t('no two picks are burst duplicates', nums.every((n, i) => i === 0 || n - nums[i - 1] > 2), true);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
