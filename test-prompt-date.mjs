/* Unit tests for prompt-date.mjs (promptDateBlock), the "what day is it"
   line every copy generator puts in front of Claude. */
import { describeDay, promptDateBlock } from './prompt-date.mjs';

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  if (!ok) console.log(`FAIL ${name}\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`);
};

// The 2026-10-07 Reel run (10:00 BRT = 13:00 UTC).
const reelDay = promptDateBlock(new Date('2026-10-07T13:00:00Z'));
t('states the full date in pt-BR', reelDay.includes('DATA DE HOJE: 7 de outubro de 2026.'), true);
t('states the current year', reelDay.includes('O ano corrente é 2026.'), true);
t('tells the model past events are past', reelDay.includes('JÁ ACONTECEU'), true);

// 02:00 UTC on Jan 1 is still Dec 31 in São Paulo.
const newYearsEve = promptDateBlock(new Date('2027-01-01T02:00:00Z'));
t('uses São Paulo time, not UTC (date)', newYearsEve.includes('31 de dezembro de 2026'), true);
t('uses São Paulo time, not UTC (year)', newYearsEve.includes('O ano corrente é 2026.'), true);

t('defaults to now', promptDateBlock(), promptDateBlock(new Date()));

// The rides Strava returned for that run.
const reelRun = new Date('2026-10-07T13:00:00Z');
t('ride days ago: the 93 km Saturday', describeDay('2026-10-03', reelRun), 'sábado, há 4 dias');
t('ride days ago: same day', describeDay('2026-10-07', reelRun), 'quarta-feira, hoje');
t('ride days ago: yesterday', describeDay('2026-10-06', reelRun), 'terça-feira, ontem');
t('ride days ago: across a month', describeDay('2026-09-28', reelRun), 'segunda-feira, há 9 dias');
// 01:00 UTC Oct 8 is still Oct 7 in São Paulo, so an Oct 7 ride is "hoje".
t('ride days ago: São Paulo day, not UTC', describeDay('2026-10-07', new Date('2026-10-08T01:00:00Z')), 'quarta-feira, hoje');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
