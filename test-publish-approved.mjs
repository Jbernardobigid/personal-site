/* Tests for which caption the Instagram approval poller publishes. Importing
   publish-approved.mjs must not poll Notion: main() only runs as the entrypoint. */
import { chooseCaption, isSafeCardId } from './publish-approved.mjs';

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  if (!ok) console.log(`FAIL ${name}\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`);
};
const throws = (name, fn, re) => {
  try { fn(); fail++; console.log(`FAIL ${name}: did not throw`); }
  catch (e) { const ok = re.test(e.message); ok ? pass++ : fail++; if (!ok) console.log(`FAIL ${name}: threw "${e.message}"`); }
};

t('edited card wins over the staged file', chooseCaption('Legenda revisada no Notion.', 'Legenda original.'), 'Legenda revisada no Notion.');
t('unedited card publishes the same text', chooseCaption('Legenda original.', 'Legenda original.'), 'Legenda original.');
t('card whitespace trimmed', chooseCaption('  Legenda.\n\n', 'x'), 'Legenda.');
t('empty card falls back to the file', chooseCaption('', 'Legenda original.'), 'Legenda original.');
t('missing card caption falls back to the file', chooseCaption(undefined, 'Legenda original.'), 'Legenda original.');
t('card alone is enough when the file is gone', chooseCaption('Só no card.', ''), 'Só no card.');
throws('no caption anywhere is an error, not an empty post', () => chooseCaption('', ''), /caption/i);

/* Cards queued before the fix were written with richText(), which cut at 2000 chars.
   Publishing that card would silently drop the end of a long caption. */
const long = `${'a'.repeat(1990)} final da legenda com as hashtags #ciclismo #gravel`;
t('fixture is over the Notion limit', long.length > 2000, true);
t('legacy truncated card: the full file caption is used', chooseCaption(long.slice(0, 2000), long), long);
t('legacy truncation ending in a space still detected', chooseCaption(`${'a'.repeat(1999)} `, `${'a'.repeat(1999)} resto`), `${'a'.repeat(1999)} resto`);
const editedLong = `EDITADO ${'a'.repeat(1992)}`;   // 2000 chars, but not the file's first 2000
t('long card that was edited is NOT replaced by the file', chooseCaption(editedLong, long) === editedLong, true);
t('full-length card (longText) is used whole', chooseCaption(long, long), long);
t('short card that happens to prefix the file is still the card', chooseCaption('Legenda', 'Legenda original.'), 'Legenda');

/* The card title becomes social/<id>: it must not be able to leave that folder. */
t('id: real staged folder name', isSafeCardId('2026-11-13-photo-day_single.v2'), true);
for (const bad of ['../../.env', '..', 'a/b', 'a\\b', 'C:x', '', 'com espaço', undefined]) {
  t(`id refused: ${JSON.stringify(bad)}`, isSafeCardId(bad), false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
