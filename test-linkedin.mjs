/* Unit tests for the LinkedIn series: beacon matching/scoring, post assembly and
   policing, format rotation, slot dates, and the publisher's card reader. No network. */
import { matchLens, isAboutCycling, isAboutSport, isOffBeat, rankShortlist, identityIsResting, feedLens, diverseBatch, scoreCandidate } from './linkedin-beacon.mjs';
import { ridesBlock, normaliseDashes, normaliseHashtag, assembleCommentary, policeFirstComment, citableUrl, SERIES_TAG } from './linkedin-writer.mjs';
import { pickFormat, nextSlotDate } from './prepare-linkedin.mjs';
import { cardPayload, isDue, dueCardsFilter, nextApprovedCard } from './publish-linkedin.mjs';
import { postComment } from './linkedin-api.mjs';

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

/* beat: sport, not urban mobility (2026-11-19: the series drifted into LA bike lanes and Santos e-bike fines) */
t('off-beat: e-bike fines rejected', isOffBeat('Santos reforça fiscalização e multas para bicicletas elétricas, ciclomotores e autopropelidos'), true);
t('off-beat: bike lane plan rejected', isOffBeat("Nithya Raman's Bike Lane Plan Could Change How Latino Workers Get Around Los Angeles"), true);
t('off-beat: mobilidade urbana rejected', isOffBeat('Pesquisa mostra avanço da mobilidade urbana por bicicleta na periferia'), true);
t('off-beat: ciclovia rejected', isOffBeat('Prefeitura entrega nova ciclovia na zona leste'), true);
t('off-beat: delivery riders rejected', isOffBeat('Entregadores de aplicativo protestam em São Paulo'), true);
t('off-beat: race story kept', isOffBeat('Girmay wins stage, the first Black African to take the green jersey'), false);
t('off-beat: velodrome story kept', isOffBeat('One Final Lap: Honouring the Enduring Legacy of the Bellville Velodrome'), false);
t('off-beat: e-MTB race kept (sport, not transport)', isOffBeat('Brazilian rider takes e-MTB world cup podium'), false);
t('sport gate: athletics accepted', isAboutSport('Primeira atleta negra a ganhar medalha no salto'), true);
t('sport gate: cycling accepted', isAboutSport('Ciclista brasileira vence Gran Fondo'), true);
t('sport gate: politics rejected', isAboutSport('Primeira deputada negra assume comissão'), false);

// Not every post is about race: identity stories (racism, representation, being a minority)
// get at most one post in IDENTITY_EVERY; the rest is the sport itself (2026-11-19, Jorge).
const it = (title, relevance, theme, score) => ({ title, relevance, theme, score, ok: true });
const pool = [it('identity r3', 3, 'identity', 0.9), it('sport r2', 2, 'sport', 0.5), it('identity r3b', 3, 'identity', 0.8), it('sport r3', 3, 'sport', 0.4)];
t('rank: relevance then score by default', rankShortlist(pool, false).map(c => c.title), ['identity r3', 'identity r3b', 'sport r3', 'sport r2']);
t('rank: identity stories go last while they rest', rankShortlist(pool, true).map(c => c.title), ['sport r3', 'sport r2', 'identity r3', 'identity r3b']);
t('rank: drops not-ok and low relevance', rankShortlist([{ ...it('x', 3, 'sport', 1), ok: false }, it('y', 1, 'sport', 1)], true), []);
t('identity rest: empty ledger', identityIsResting([]), false);
t('identity rest: identity post last', identityIsResting([{ signal: { theme: 'sport' } }, { signal: { theme: 'identity' } }]), true);
t('identity rest: identity two posts ago', identityIsResting([{ signal: { theme: 'identity' } }, { signal: { theme: 'sport' } }]), true);
t('identity rest: identity three posts ago is fine', identityIsResting([{ signal: { theme: 'identity' } }, { signal: { theme: 'sport' } }, { signal: { theme: 'sport' } }]), false);
t('identity rest: untagged old posts do not count', identityIsResting([{ signal: { lens: 'access-equity' } }]), false);

const lensMatchers = [{ id: 'africa-cycling', regexes: [/(?<![p{L}p{N}])girmay(?![p{L}p{N}])/iu] }];
t('feed lens: fixed lens wins', feedLens({ lens: 'x', tier: 1 }, 'girmay', lensMatchers, 'ciclismo'), 'x');
t('feed lens: keyword match', feedLens({ tier: 1 }, 'girmay sprints', lensMatchers, 'ciclismo'), 'africa-cycling');
t('feed lens: tier-1 outlet falls back to general cycling', feedLens({ tier: 1 }, 'tour de france route revealed', lensMatchers, 'ciclismo'), 'ciclismo');
t('feed lens: tier-2 outlet has no fallback', feedLens({ tier: 2 }, 'tour de france route revealed', lensMatchers, 'ciclismo'), null);

t('sport gate: figure skating accepted', isAboutSport('Alexa Gasparotto Becomes First Black Woman To Land Triple Axel in figure skating'), true);
t('sport gate: head coach accepted', isAboutSport('Yolanda Thomas promoted to head coach of the Pride'), true);

// A lens returning 30+ items (latin, africa) must not take every screening slot (2026-11-19:
// the Gran Fondo Brasil record never reached the screener).
const flood = [...Array(5)].map((_, i) => ({ lens: 'latin', title: `l${i}`, score: 0.9 - i * 0.01 }));
const quiet = [{ lens: 'brasil', title: 'b0', score: 0.5 }, { lens: 'black', title: 'k0', score: 0.4 }];
t('diverse batch: every lens gets a turn', diverseBatch([...flood, ...quiet], 4).map(c => c.title), ['l0', 'b0', 'k0', 'l1']);
t('diverse batch: fills from the deep lens when others run out', diverseBatch([...flood, ...quiet], 6).map(c => c.title), ['l0', 'b0', 'k0', 'l1', 'l2', 'l3']);

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
const mobilityTags = assembleCommentary({ ...base, hashtags: ['#MobilidadeUrbana', '#BicicletaEletrica', '#Ciclismo'] });
t('assemble: mobility hashtags dropped', mobilityTags.endsWith(`${SERIES_TAG} #Ciclismo`), true);
t('assemble: ciclovia/transito tags dropped', /#Ciclovia|#Transito/.test(assembleCommentary({ ...base, hashtags: ['Ciclovia', 'Trânsito'] })), false);
t('assemble: sport tags kept', assembleCommentary({ ...base, hashtags: ['AtletasNegros', 'CiclismoDeEstrada'] }).endsWith('#AtletasNegros #CiclismoDeEstrada'), true);

const allowed = ['https://www.infobae.com/a', 'https://cyclingnews.com/b'];
t('comment: allowed link kept', policeFirstComment('Fonte: https://www.infobae.com/a', allowed), 'Fonte: https://www.infobae.com/a');
t('comment: invented link removed', policeFirstComment('Fonte: https://made.up/x\nOutra: https://cyclingnews.com/b', allowed), 'Fonte:\nOutra: https://cyclingnews.com/b');
t('comment: trailing period tolerated', policeFirstComment('Leia https://cyclingnews.com/b.', allowed), 'Leia https://cyclingnews.com/b.');
const many = ['https://a.com/1','https://a.com/2','https://a.com/3','https://a.com/4','https://a.com/5'];
t('comment: at most 3 links kept', (policeFirstComment('Fontes: ' + many.join(' '), many).match(/https:/g) || []).length, 3);
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
t('format: never-used formats in FORMATS order', pickFormat([{ format: 'text' }, { format: 'photo' }]), 'document');
const allSix = ['text', 'photo', 'document', 'video', 'photos', 'ai-image'].map(format => ({ format }));
t('format: cycles back to oldest', pickFormat(allSix), 'text');
t('format: oldest after a full cycle plus one', pickFormat([...allSix, { format: 'text' }]), 'photo');
t('format: forced wins', pickFormat([], 'photo'), 'photo');
t('format: unavailable format skipped', pickFormat([{ format: 'text' }], null, f => f !== 'photo'), 'document');
t('format: failed attempt counts as use', pickFormat([{ format: 'text' }, { format: 'photo', failed: true }]), 'document');
t('format: nothing available falls back to text', pickFormat([], null, () => false), 'text');
t('slot: Monday evening build -> Tuesday', nextSlotDate(new Date('2026-11-16T22:00:00Z')), '2026-11-17');
t('slot: Wednesday build -> Thursday', nextSlotDate(new Date('2026-11-18T22:00:00Z')), '2026-11-19');
t('slot: Thursday -> next Tuesday', nextSlotDate(new Date('2026-11-19T12:00:00Z')), '2026-11-24');
t('slot: 01:00 UTC Wed is still Tue in Brazil -> Thursday', nextSlotDate(new Date('2026-11-18T01:00:00Z')), '2026-11-19');

/* publisher card reader */
const page = (caption, { comment = '', url = null, format = null, preview = [] } = {}) => ({
  id: 'p1',
  properties: {
    Name: { type: 'title', title: [{ plain_text: '2026-11-13-linkedin-x' }] },
    Caption: { type: 'rich_text', rich_text: caption.match(/[\s\S]{1,2000}/g).map(plain_text => ({ plain_text })) },
    'First Comment': { type: 'rich_text', rich_text: comment ? [{ plain_text: comment }] : [] },
    'Media URL': { type: 'url', url },
    Format: { type: 'select', select: format ? { name: format } : null },
    Preview: { type: 'files', files: preview.map(u => ({ type: 'external', external: { url: u } })) }
  }
});
const long = 'x'.repeat(2500);
t('card: long caption rejoined from chunks', cardPayload(page(long)).text.length, 2500);
t('card: missing Format means text, no media', cardPayload(page('ok')), { id: '2026-11-13-linkedin-x', text: 'ok', comment: '', format: 'text', kind: 'none', mediaUrls: [] });
t('card: photo reads Media URL', cardPayload(page('ok', { comment: 'fonte', url: 'https://b/x.jpg', format: 'photo' })).mediaUrls, ['https://b/x.jpg']);
t('card: photos read every Preview file', cardPayload(page('ok', { url: 'https://b/1.jpg', format: 'photos', preview: ['https://b/1.jpg', 'https://b/2.jpg', 'https://b/3.jpg'] })).mediaUrls.length, 3);
t('card: document kind', cardPayload(page('ok', { url: 'https://b/c.pdf', format: 'document' })).kind, 'document');
t('card: video kind', cardPayload(page('ok', { url: 'https://b/v.mp4', format: 'video' })).kind, 'video');
throws('card: photos with one image blocked', () => cardPayload(page('ok', { url: 'https://b/1.jpg', format: 'photos', preview: ['https://b/1.jpg'] })), /at least 2/);
throws('card: media format without media blocked', () => cardPayload(page('ok', { format: 'video' })), /needs media/);
throws('card: unknown format blocked', () => cardPayload(page('ok', { format: 'gif' })), /unknown Format/);
throws('card: edited-in em dash blocked', () => cardPayload(page('um — dois')), /dash/);

/* publisher: a card is only eligible once its Publish Date has arrived (Brazil time).
   Sorting by date alone published a Thursday card on Tuesday if it was approved early. */
const dated = (name, date) => ({ id: name, properties: {
  Name: { type: 'title', title: [{ plain_text: name }] },
  'Publish Date': { type: 'date', date: date ? { start: date } : null },
} });
const tuesday = new Date('2026-11-17T11:30:00Z');   // 08:30 BRT, the publish slot
t('due: today', isDue(dated('a', '2026-11-17'), tuesday), true);
t('due: past date (late approval)', isDue(dated('a', '2026-11-12'), tuesday), true);
t('due: future date is not', isDue(dated('a', '2026-11-19'), tuesday), false);
t('due: tomorrow is not', isDue(dated('a', '2026-11-18'), tuesday), false);
t('due: no date means publish when approved', isDue(dated('a', null), tuesday), true);
t('due: datetime value compared by its day', isDue(dated('a', '2026-11-19T08:30:00.000-03:00'), tuesday), false);
t('due: 01:00 UTC Wed is still Tue in Brazil', isDue(dated('a', '2026-11-18'), new Date('2026-11-18T01:00:00Z')), false);
t('due: 03:00 UTC Wed is Wed in Brazil', isDue(dated('a', '2026-11-18'), new Date('2026-11-18T03:00:00Z')), true);

const filter = dueCardsFilter(tuesday);
t('filter: still requires approval', filter.and[0], { property: 'Status', select: { equals: 'Approved For Publishing' } });
t('filter: date on or before today in Brazil, or empty', filter.and[1], { or: [
  { property: 'Publish Date', date: { on_or_before: '2026-11-17' } },
  { property: 'Publish Date', date: { is_empty: true } },
] });

// Notion returns ascending by date; the fake ignores the filter on purpose, so this
// also proves the client-side check holds if the server-side filter ever misbehaves.
const queue = [dated('late', '2026-11-12'), dated('today', '2026-11-17'), dated('thursday', '2026-11-19')];
const pick = async (cards, now) => (await nextApprovedCard('db', now, async () => cards))?.id ?? null;
t('next: oldest due card first', await pick(queue, tuesday), 'late');
t('next: future-only queue publishes nothing', await pick([dated('thursday', '2026-11-19')], tuesday), null);
t('next: future card skipped for a due one behind it', await pick([dated('thursday', '2026-11-19'), dated('undated', null)], tuesday), 'undated');
t('next: empty queue', await pick([], tuesday), null);

/* first comment (2026-11-19: the first REST document post's comment 404'd on v2 socialActions) */
// Always a fake token: load-env loaded the real one, and a test must never be able to post.
process.env.LINKEDIN_ACCESS_TOKEN = 'test-token';
const fakeFetch = (statuses) => {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, version: init.headers['LinkedIn-Version'] || null });
    const s = statuses[calls.length - 1];
    if (s === 'throw') throw new Error('timeout');
    return { ok: s >= 200 && s < 300, status: s, text: async () => 'body' };
  };
  return { fn, calls };
};
const noSleep = async () => {};
const urn = 'urn:li:ugcPost:1';
let ff = fakeFetch([201]);
t('comment: v2 success first try', await postComment('urn:li:person:x', urn, 'oi', { fetchImpl: ff.fn, sleep: noSleep }), true);
t('comment: v2 success uses one call', ff.calls.length, 1);
ff = fakeFetch([404, 201]);
t('comment: v2 404 falls back to rest', await postComment('urn:li:person:x', urn, 'oi', { fetchImpl: ff.fn, sleep: noSleep }), true);
t('comment: rest fallback is versioned', ff.calls[1].url.includes('/rest/socialActions/') && !!ff.calls[1].version, true);
ff = fakeFetch([404, 404, 404, 201]);
t('comment: retries after a pause when both 404', await postComment('urn:li:person:x', urn, 'oi', { fetchImpl: ff.fn, sleep: noSleep }), true);
ff = fakeFetch(Array(20).fill(404));
t('comment: gives up after every round', await postComment('urn:li:person:x', urn, 'oi', { fetchImpl: ff.fn, sleep: noSleep, delays: [0, 1, 2] }), false);
t('comment: two endpoints per round', ff.calls.length, 6);
ff = fakeFetch([400, 400, 201]);
t('comment: definite refusal is not retried', await postComment('urn:li:person:x', urn, 'oi', { fetchImpl: ff.fn, sleep: noSleep }), false);
t('comment: refusal stops after both endpoints', ff.calls.length, 2);
ff = fakeFetch(['throw', 201]);
t('comment: ambiguous network error never retried (no duplicate comment)', await postComment('urn:li:person:x', urn, 'oi', { fetchImpl: ff.fn, sleep: noSleep }), false);
t('comment: ambiguous error stops at one call', ff.calls.length, 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
