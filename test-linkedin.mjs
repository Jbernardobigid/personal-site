/* Unit tests for the LinkedIn series: beacon matching/scoring, post assembly and
   policing, format rotation, slot dates, and the publisher's card reader. No network. */
import { matchLens, isAboutCycling, scoreCandidate } from './linkedin-beacon.mjs';
import { ridesBlock, normaliseDashes, normaliseHashtag, assembleCommentary, policeFirstComment, citableUrl, SERIES_TAG } from './linkedin-writer.mjs';
import { pickFormat, nextSlotDate } from './prepare-linkedin.mjs';
import { cardPayload } from './publish-linkedin.mjs';

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

/* beacon */
const matchers = [
  { id: 'africa', regexes: [/(?<![\p{L}\p{N}])girmay(?![\p{L}\p{N}])/iu, /(?<![\p{L}\p{N}])africa(?![\p{L}\p{N}])/iu] },
  { id: 'latin', regexes: [/(?<![\p{L}\p{N}])colombia(?![\p{L}\p{N}])/iu] }
];
t('lens: keyword hit', matchLens('girmay wins in africa', matchers), 'africa');
t('lens: whole words only', matchLens('south african sprinter', matchers), null);
t('lens: no hit', matchLens('pogacar wins again', matchers), null);
t('cycling gate: cricket "cycle" rejected', isAboutCycling('ICC draws up schedule for 2032-35 cycle'), false);
t('cycling gate: funding cycle rejected', isAboutCycling('NLC awards grants under 2024/25 funding cycle'), false);
t('cycling gate: ciclismo accepted', isAboutCycling('Quintana alerta por el futuro del ciclismo colombiano'), true);
t('cycling gate: rider story accepted', isAboutCycling('Team Amani shuts down its men\'s road team, bike sponsor stays'), true);

const cfg = { freshnessDays: 10, lenses: { a: { weight: 1 }, b: { weight: 0.5 } } };
const fresh = new Date().toISOString();
t('score: heavier lens wins', scoreCandidate({ lens: 'a', tier: 1, date: fresh }, cfg) > scoreCandidate({ lens: 'b', tier: 1, date: fresh }, cfg), true);
t('score: overused lens is damped', scoreCandidate({ lens: 'a', tier: 1, date: fresh }, cfg, ['a', 'a']) < scoreCandidate({ lens: 'a', tier: 1, date: fresh }, cfg), true);

/* writer helpers */
t('hashtag: accents and spaces', normaliseHashtag('ciclismo colombiano'), '#CiclismoColombiano');
t('hashtag: keeps camel', normaliseHashtag('#AcessoAoEsporte'), '#AcessoAoEsporte');
t('hashtag: strips accents', normaliseHashtag('#Representação'), '#Representacao');
t('hashtag: junk dropped', normaliseHashtag('#'), null);

const base = { hook: 'Duas vitórias.', body: 'Parágrafo um.\n\nParágrafo dois.', closing_question: 'Quem paga a formação?', hashtags: ['Ciclismo Colombiano', 'esportesnolinkedin', 'Extra', 'Mais'] };
const text = assembleCommentary(base);
t('assemble: series tag first', text.endsWith(`${SERIES_TAG} #CiclismoColombiano #Extra`), true);
t('assemble: tag deduped case-insensitively, capped at 3', (text.match(/#/g) || []).length, 3);
t('assemble: em dash sanitised', assembleCommentary({ ...base, body: 'Um ponto — outro ponto.' }).includes('Um ponto, outro ponto.'), true);
throws('assemble: link in body rejected', () => assembleCommentary({ ...base, body: 'Veja https://x.com/a' }), /link/);
throws('assemble: www link rejected', () => assembleCommentary({ ...base, body: 'Veja www.site.com' }), /link/);
t('dashes: numeric range keeps a hyphen', normaliseDashes('de 2020–2026'), 'de 2020-2026');
t('dashes: clause en dash becomes a comma', normaliseDashes('um ponto – outro'), 'um ponto, outro');
t('assemble: en dash range normalised, not fatal', assembleCommentary({ ...base, body: 'De 2020–2026.' }).includes('De 2020-2026.'), true);
throws('assemble: over 3000 rejected', () => assembleCommentary({ ...base, body: 'a'.repeat(3100) }), /3000/);
t('assemble: second call after a rejected link still works (regex state)', assembleCommentary(base) === text, true);

const allowed = ['https://www.infobae.com/a', 'https://cyclingnews.com/b'];
t('comment: allowed link kept', policeFirstComment('Fonte: https://www.infobae.com/a', allowed), 'Fonte: https://www.infobae.com/a');
t('comment: invented link removed', policeFirstComment('Fonte: https://made.up/x\nOutra: https://cyclingnews.com/b', allowed), 'Fonte:\nOutra: https://cyclingnews.com/b');
t('comment: trailing period tolerated', policeFirstComment('Leia https://cyclingnews.com/b.', allowed), 'Leia https://cyclingnews.com/b.');
t('citable: google news dropped', citableUrl('https://news.google.com/rss/articles/abc'), null);
t('citable: outlet kept', citableUrl('https://www.cyclingnews.com/x'), 'https://www.cyclingnews.com/x');

const rides = [{ date: '2026-11-12', km: 35.1, elevationM: 0, movingMin: 61, avgKmh: 34.4 }, { date: '2026-11-06', km: 46.6, elevationM: 403, movingMin: 102, avgKmh: 27.5 }];
const rb = ridesBlock(rides);
t('rides: absolute dates', rb.includes('quinta-feira, 12 de novembro: 35.1 km'), true);
t('rides: no relative day labels in the list', /há \d+ dias|, ontem:|, hoje:/.test(rb), false);
t('rides: precomputed total and window', rb.includes('Total of these 2 rides, sexta-feira, 6 de novembro to quinta-feira, 12 de novembro: 82 km, 403 m de subida.'), true);
t('rides: none', ridesBlock(null).startsWith('RIDE DATA: none'), true);

/* rotation + slots */
t('format: empty ledger starts with text', pickFormat([]), 'text');
t('format: least recent next', pickFormat([{ format: 'text' }, { format: 'photo' }]), 'ai-image');
t('format: cycles back to oldest', pickFormat([{ format: 'text' }, { format: 'photo' }, { format: 'ai-image' }]), 'text');
t('format: forced wins', pickFormat([], 'photo'), 'photo');
t('format: unavailable format skipped', pickFormat([{ format: 'text' }], null, f => f !== 'photo'), 'ai-image');
t('format: failed attempt counts as use', pickFormat([{ format: 'text' }, { format: 'photo', failed: true }]), 'ai-image');
t('format: nothing available falls back to text', pickFormat([], null, () => false), 'text');
t('slot: Monday evening build -> Tuesday', nextSlotDate(new Date('2026-11-16T22:00:00Z')), '2026-11-17');
t('slot: Wednesday build -> Thursday', nextSlotDate(new Date('2026-11-18T22:00:00Z')), '2026-11-19');
t('slot: Thursday -> next Tuesday', nextSlotDate(new Date('2026-11-19T12:00:00Z')), '2026-11-24');
t('slot: 01:00 UTC Wed is still Tue in Brazil -> Thursday', nextSlotDate(new Date('2026-11-18T01:00:00Z')), '2026-11-19');

/* publisher card reader */
const page = (caption, comment = '', url = null) => ({
  id: 'p1',
  properties: {
    Name: { type: 'title', title: [{ plain_text: '2026-11-13-linkedin-x' }] },
    Caption: { type: 'rich_text', rich_text: caption.match(/[\s\S]{1,2000}/g).map(plain_text => ({ plain_text })) },
    'First Comment': { type: 'rich_text', rich_text: comment ? [{ plain_text: comment }] : [] },
    'Media URL': { type: 'url', url }
  }
});
const long = 'x'.repeat(2500);
t('card: long caption rejoined from chunks', cardPayload(page(long)).text.length, 2500);
t('card: comment and media read', cardPayload(page('ok', 'fonte', 'https://b/x.jpg')), { id: '2026-11-13-linkedin-x', text: 'ok', comment: 'fonte', mediaUrl: 'https://b/x.jpg' });
throws('card: edited-in em dash blocked', () => cardPayload(page('um — dois')), /dash/);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
