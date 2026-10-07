/**
 * prompt-date.mjs
 * Tells Claude what day it is. The copy generators never sent a date, so the
 * model wrote from its training-era sense of "now": on 2026-10-07 bank idea
 * history-10 ("Kigali 2025: o primeiro Mundial ... em solo africano") came
 * back as "Em 2025, o Mundial de ciclismo de estrada vai acontecer", a year
 * after the race. The bank idea was accurate; the model just thought 2025 was
 * still ahead. Every prompt that writes publishable copy opens with this block.
 */

// The pipelines run on a UTC VPS for a Brazilian audience: a 22:00 BRT run on
// Dec 31 must still say Dec 31, not Jan 1.
const TZ = 'America/Sao_Paulo';

export function promptDateBlock(now = new Date()) {
  const day = now.toLocaleDateString('pt-BR', { timeZone: TZ, day: 'numeric', month: 'long', year: 'numeric' });
  const year = now.toLocaleDateString('pt-BR', { timeZone: TZ, year: 'numeric' });
  return `DATA DE HOJE: ${day}. O ano corrente é ${year}. Escreva a partir desta data, não da sua noção interna de "agora": todo evento com data anterior a hoje JÁ ACONTECEU e deve ser narrado no passado, nunca no futuro ("vai acontecer") nem como se fosse deste ano.`;
}
