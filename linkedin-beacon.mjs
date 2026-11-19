/**
 * linkedin-beacon.mjs
 * The news beacon for the LinkedIn cycling series (#EsportesNoLinkedIn).
 *
 * Reads linkedin-beacon.json: a set of "lenses" (Black cyclists, African cycling,
 * Latin-American cycling, cycling in Brazil, Black athletes in other sports) with Google
 * News queries in PT/EN/ES plus a few cycling outlets. Big general outlets only count
 * when an item matches a lens keyword, so the sport's daily churn does not drown
 * the angles this series exists for. Urban mobility / transport titles are dropped
 * outright: the beat is sport.
 *
 * Then: freshness window, dedupe against linkedin-ledger.json, a recency x tier x
 * lens-weight score with a mild balance boost for lenses not used lately, and a Haiku
 * screen (fails CLOSED) that rejects tragedy/gossip/duplicates/transport, rates how much
 * a Black Brazilian cyclist can add to each story, and tags its tone (win/barrier/
 * neutral). When the last post was not a win, wins lead the shortlist.
 *
 * Exports: buildShortlist({ ledger, limit }) -> { shortlist, gathered, winDue }
 */

import './load-env.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import { UTILITY_MODEL } from './claude-models.mjs';
import { fetchFeed, cleanText, titleKey, itemDate, withinFreshness } from './signals.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'linkedin-beacon.json');

const SCREEN_BATCH = 25;       // top-scored candidates sent to the screener
const MIN_RELEVANCE = 2;       // screener scale 0-3; below this the story is not for this series
const BALANCE_WINDOW = 6;      // recent posts considered when boosting under-used lenses
const WIN_EVERY = 2;           // at least one good-news post in every 2, when the beacon has one

// Google News matches loosely ("cycling" also finds "funding cycle" and cricket's "2032-35
// cycle"), so a news item must name the sport itself. Outlet feeds are cycling-only already.
const CYCLING_TERM = /(?<![\p{L}])(cycling|cyclists?|bikes?|bicycles?|e-?bikes?|bicicletas?|ciclis\p{L}*|ciclism\p{L}*|peloton|pelotón|uci|worldtour|gravel|pedal\p{L}*|velódromo|velodrome)(?![\p{L}])/iu;

// Lenses flagged anySport (Black athletes beyond the bike) need a sport, not a bicycle.
const SPORT_TERM = /(?<![\p{L}])(esportes?|esportiv\p{L}*|atletas?|campe[aã]o|campe[aã]s|campeonatos?|medalh\p{L}*|ol[ií]mpi\p{L}*|paral[ií]mpi\p{L}*|futebol|atletismo|maratonas?|t[eê]nis|boxe|surf\p{L}*|nata[cç][aã]o|gin[aá]stica|basquete|v[oô]lei|skate\p{L}*|sports?|athletes?|champions?|championships?|medals?|olympi\p{L}*|paralympi\p{L}*|marathons?|tennis|boxing|swimm\p{L}*|gymnast\p{L}*|basketball|football|soccer|athletics|coach(es)?|skating|skaters?|patina[cç][aã]o|treinador\p{L}*)(?![\p{L}])/iu;

// The series is SPORT. Urban mobility and transport stories mention bicycles but are off-beat
// (2026-11-19: posts on LA bike lanes and Santos e-bike fines came out as #MobilidadeUrbana
// #BicicletaEletrica). Checked on the title only: summaries mention a ciclovia in passing.
const OFF_BEAT = /(?<![\p{L}])(mobilidade|micromobilidade|mobility|micromobility|ciclovias?|ciclofaixas?|ciclorrotas?|bicicletas? el[eé]tricas?|e-?bikes?|autopropelidos?|ciclomotor(es)?|patinetes?|scooters?|tr[aâ]nsito|traffic|bike[- ]?lanes?|bike[- ]?paths?|cycle[- ]?lanes?|bike[- ]?shar\p{L}*|bicicletas? compartilhadas?|commut\p{L}*|entregador\p{L}*|delivery riders?)(?![\p{L}])/iu;

/** Exported for tests. */
export function isAboutCycling(text) {
  return CYCLING_TERM.test(text);
}

/** Exported for tests. */
export function isAboutSport(text) {
  return CYCLING_TERM.test(text) || SPORT_TERM.test(text);
}

/** Transport, commuting or city-infrastructure story. Exported for tests. */
export function isOffBeat(title) {
  return OFF_BEAT.test(title);
}

export function loadBeaconConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function googleNewsUrl(cfg, lang, query) {
  const tpl = cfg.googleNews[lang];
  const q = encodeURIComponent(`${query} ${cfg.googleNews.freshness || ''}`.trim());
  return tpl.replace('{q}', q);
}

/** Whole-word, accent-aware keyword matchers per lens, compiled once. */
function compileLensMatchers(lenses) {
  return Object.entries(lenses).map(([id, lens]) => ({
    id,
    regexes: (lens.keywords || []).map(kw => {
      const escaped = kw.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu');
    })
  }));
}

/** Lens with the most keyword hits, or null when nothing matches. Exported for tests. */
export function matchLens(text, matchers) {
  let best = null, bestHits = 0;
  for (const { id, regexes } of matchers) {
    const hits = regexes.filter(re => re.test(text)).length;
    if (hits > bestHits) { best = id; bestHits = hits; }
  }
  return best;
}

/** Google News titles arrive as "Headline - Publisher". */
function splitGoogleTitle(raw) {
  const parts = cleanText(raw).split(' - ');
  const source = parts.length > 1 ? parts.pop() : 'Google News';
  return { title: parts.join(' - ') || cleanText(raw), source };
}

async function gather(cfg) {
  const matchers = compileLensMatchers(cfg.lenses);
  const tasks = [];
  for (const feed of cfg.feeds || []) tasks.push({ kind: 'feed', feed, url: feed.url });
  for (const [lensId, lens] of Object.entries(cfg.lenses)) {
    for (const [lang, queries] of Object.entries(lens.googleNews || {})) {
      for (const q of [].concat(queries)) tasks.push({ kind: 'news', lensId, lang, url: googleNewsUrl(cfg, lang, q) });
    }
  }
  const results = await Promise.all(tasks.map(t => fetchFeed(t.url)));

  const out = [];
  results.forEach((items, i) => {
    const t = tasks[i];
    for (const it of items) {
      const date = itemDate(it);
      if (!withinFreshness(date, cfg.freshnessDays || 10)) continue;
      const summary = cleanText(it.contentSnippet || it.content || it.summary || '').slice(0, 400);
      if (t.kind === 'feed') {
        const title = cleanText(it.title);
        if (isOffBeat(title)) continue;
        const lens = t.feed.lens || matchLens(`${title} ${summary}`, matchers);
        if (!lens) continue; // general outlet, nothing on-lens
        out.push({ title, summary, url: it.link || '', source: t.feed.name, lens, date, tier: t.feed.tier || 2, lang: 'en' });
      } else {
        const { title, source } = splitGoogleTitle(it.title);
        if (isOffBeat(title)) continue;
        const onTopic = cfg.lenses[t.lensId]?.anySport ? isAboutSport : isAboutCycling;
        if (!onTopic(`${title} ${summary}`)) continue;
        out.push({ title, summary, url: it.link || '', source, lens: t.lensId, date, tier: 3, lang: t.lang });
      }
    }
  });
  return out;
}

function dedupe(candidates, ledger) {
  const usedKeys = new Set((ledger.posts || []).map(p => p.signal?.titleKey).filter(Boolean));
  const usedUrls = new Set((ledger.posts || []).map(p => p.signal?.url).filter(Boolean));
  const seen = new Set();
  return candidates.filter(c => {
    const key = titleKey(c.title);
    if (!key || seen.has(key) || usedKeys.has(key) || (c.url && usedUrls.has(c.url))) return false;
    seen.add(key);
    return true;
  });
}

/** Exported for tests: pure function of the candidate, config and recent lens use. */
export function scoreCandidate(c, cfg, recentLenses = []) {
  const days = cfg.freshnessDays || 10;
  const recency = c.date ? Math.max(0, 1 - (Date.now() - new Date(c.date).getTime()) / (days * 86400_000)) : 0.4;
  const tierW = c.tier === 1 ? 1.0 : c.tier === 2 ? 0.8 : 0.7;
  const lensW = cfg.lenses[c.lens]?.weight ?? 0.5;
  const usedLately = recentLenses.filter(l => l === c.lens).length;
  const balance = 1 - Math.min(usedLately, 3) * 0.1;
  return (recency * 0.45 + tierW * 0.2 + lensW * 0.35) * balance;
}

const SCREEN_TOOL = {
  name: 'screen_items',
  description: 'Verdict for every news item, in the order given.',
  input_schema: {
    type: 'object',
    properties: {
      verdicts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer' },
            ok: { type: 'boolean' },
            relevance: { type: 'integer', description: '0-3: how much this story speaks to Black, African or Latin-American athletes in the sport.' },
            tone: { type: 'string', enum: ['win', 'barrier', 'neutral'] },
            reason: { type: 'string' }
          },
          required: ['index', 'ok', 'relevance', 'tone', 'reason']
        }
      }
    },
    required: ['verdicts']
  }
};

async function screen(items, recentHooks) {
  if (items.length === 0) return [];
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const list = items.map((c, i) => `${i}. [${c.lens}] ${c.title} (${c.source}, ${c.lang})${c.summary ? `: ${c.summary.slice(0, 240)}` : ''}`).join('\n');
  const recent = recentHooks.length ? `\n\nALREADY POSTED on LinkedIn recently (reject items that would make substantially the same post):\n${recentHooks.map(h => `- ${h}`).join('\n')}` : '';

  try {
    const res = await client.messages.create({
      model: UTILITY_MODEL,
      max_tokens: 3000,
      tools: [SCREEN_TOOL],
      tool_choice: { type: 'tool', name: 'screen_items' },
      messages: [{
        role: 'user',
        content: `You screen sports news for a LinkedIn series by Jorge Bernardo, a Black Brazilian amateur cyclist and data/AI professional who writes in Portuguese for a professional audience. The series is about SPORT: mostly cycling as a sport (road, track, gravel, MTB, racing, teams, clubs, amateur events, the pro peloton), occasionally other sports, with a focus on Black, African and Latin-American athletes. It covers their wins as much as their barriers: victories, firsts, records, milestones, new teams, sponsors and growing clubs are core material, not filler.

For each item:
- ok=false for urban mobility and transport: bike lanes, commuting, e-bike or scooter rules, traffic, fines, city infrastructure, bike-share, delivery riders. These are off-beat even when a bicycle is in the story.
- ok=false for tragedy, deaths, crashes, crime, doping scandals as gossip, transfer rumours with nothing to say, product/gear promotions, bare race results with no story behind them (a win by a Black, African or Latin-American rider IS a story), and anything where commentary would be insensitive.
- ok=false for items about the same story as anything already posted.
- Brazilians ARE Latin-American. An African team (Team Amani, an African federation or race) counts as African athletes.
- relevance 3: centred on Black, African or Latin-American athletes or teams in cycling: a win, a first, a milestone, a sponsor, a career, a team, a club, or racism and representation in the sport. 2: a cycling story where that angle is clearly present, a milestone of the Brazilian cycling scene (a Brazilian rider's result that means something, a record field at a Brazilian event), or a Black athlete's milestone in another sport. 1: general sport with a stretch of an angle. 0: none.
- tone: "win" for a victory, record, first, milestone, debut, contract, new team or sponsor, or a community that grew; "barrier" for racism, exclusion, cuts, closures, visa denials, lack of funding; "neutral" otherwise.
- ok=true only when the story gives a professional audience something to think about: a win, a milestone, a barrier, a business decision, data, a career, a community.

Items:
${list}${recent}`
      }]
    });
    const verdicts = res.content.find(b => b.type === 'tool_use')?.input?.verdicts || [];
    return items.map((_, i) => {
      const v = verdicts.find(x => x.index === i);
      return { ok: !!v?.ok, relevance: v?.relevance ?? 0, tone: v?.tone || 'neutral', reason: v?.reason || 'no-verdict' };
    });
  } catch (e) {
    console.warn(`  ! screen failed (${e.message}); failing closed`);
    return items.map(() => ({ ok: false, relevance: 0, tone: 'neutral', reason: 'screen-error' }));
  }
}

/**
 * Good news has to show up, not only struggle: at least one post in every WIN_EVERY is a
 * win when the beacon has one. Posts from before tones existed count as not-win.
 * Exported for tests.
 */
export function winIsDue(posts, winEvery = WIN_EVERY) {
  return !posts.slice(-(winEvery - 1)).some(p => p.signal?.tone === 'win');
}

/**
 * The n items sent to the screener, taken round-robin across lenses in score order, so a
 * lens that returns 30+ items cannot take every slot. Input must be sorted best first.
 * Exported for tests.
 */
export function diverseBatch(sorted, n) {
  const byLens = new Map();
  for (const c of sorted) byLens.set(c.lens, [...(byLens.get(c.lens) || []), c]);
  const queues = [...byLens.values()];
  const out = [];
  for (let round = 0; out.length < n && queues.some(q => q.length > round); round++) {
    for (const q of queues) if (q[round] && out.length < n) out.push(q[round]);
  }
  return out;
}

/** Screened items worth writing, best first; wins lead when one is due. Exported for tests. */
export function rankShortlist(items, preferWin) {
  const winFirst = (c) => (preferWin && c.tone === 'win' ? 1 : 0);
  return items
    .filter(c => c.ok && c.relevance >= MIN_RELEVANCE)
    .sort((a, b) => winFirst(b) - winFirst(a) || b.relevance - a.relevance || b.score - a.score);
}

/**
 * Candidates worth writing about, best first.
 * @param {object} opts
 * @param {object} opts.ledger  linkedin-ledger.json contents ({ posts: [...] })
 * @param {number} [opts.limit] shortlist size handed to the writer
 */
export async function buildShortlist({ ledger, limit = 6 } = {}) {
  const cfg = loadBeaconConfig();
  const recent = (ledger.posts || []).slice(-BALANCE_WINDOW);
  const recentLenses = recent.map(p => p.signal?.lens).filter(Boolean);

  const gathered = dedupe(await gather(cfg), ledger);
  for (const c of gathered) c.score = scoreCandidate(c, cfg, recentLenses);
  gathered.sort((a, b) => b.score - a.score);

  const top = diverseBatch(gathered, SCREEN_BATCH);
  const verdicts = await screen(top, recent.map(p => p.hook).filter(Boolean));
  top.forEach((c, i) => Object.assign(c, verdicts[i]));

  const winDue = winIsDue(ledger.posts || []);
  const shortlist = rankShortlist(top, winDue).slice(0, limit);
  return { shortlist, gathered, winDue };
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  const ledgerPath = path.join(__dirname, 'linkedin-ledger.json');
  const ledger = fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) : { posts: [] };
  buildShortlist({ ledger }).then(({ shortlist, gathered, winDue }) => {
    console.log(`gathered ${gathered.length} on-lens candidates`);
    for (const c of gathered.filter(c => c.ok !== undefined)) {
      console.log(`${c.ok ? 'OK ' : '-- '} r${c.relevance ?? '?'} ${(c.tone || '?').padEnd(7)} ${c.score.toFixed(2)} [${c.lens}] ${c.title.slice(0, 80)} (${c.source}) :: ${c.reason || ''}`);
    }
    console.log(`\nwin due: ${winDue}\nshortlist (${shortlist.length}):`);
    for (const c of shortlist) console.log(`  r${c.relevance} ${c.tone} [${c.lens}] ${c.title.slice(0, 90)}`);
  }).catch(e => { console.error(e); process.exit(1); });
}
