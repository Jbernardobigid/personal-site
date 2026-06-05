/**
 * signals.mjs
 * Fetches recent news "signals" from curated Afro-Brazilian/Brazilian press RSS
 * feeds and from Google News RSS search feeds (keyless, per-pillar queries),
 * tags each item to a content pillar, filters by freshness + a Claude safety/
 * quality check, deduplicates against the used-signals ledger, scores with a
 * recency × source-tier × pillar-balance heuristic, and returns the single best
 * signal to seed a blog post.
 *
 * The blog cycle is "signal-led with a balance guardrail": the chosen signal sets
 * the pillar/angle, but under-posted pillars get a scoring boost so coverage stays
 * balanced. If no safe, on-brand signal is found, callers fall back to evergreen.
 *
 * Exports: selectSignal({ forcePillar }) -> { signal, pillar, candidates }
 *
 * Requires: ANTHROPIC_API_KEY (safety check). Reads signal-sources.json + used-signals.json.
 */

import './load-env.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Parser from 'rss-parser';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POSTS_DIR    = path.join(__dirname, 'blog', 'posts');
const SOURCES_PATH = path.join(__dirname, 'signal-sources.json');
const LEDGER_PATH  = path.join(__dirname, 'used-signals.json');

const FRESHNESS_DAYS = 14;   // ignore anything older than this
const DEDUP_DAYS     = 60;   // don't re-ground a story used within this window
const SAFETY_BATCH   = 8;    // run the Claude safety/quality check on the top-N scored candidates
const SAFETY_MODEL   = 'claude-haiku-4-5-20251001';

const parser = new Parser({
  timeout: 15000,
  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JorgeBernardoSignals/1.0; +https://jorgebernardo.tech)' }
});

/* ── Config + ledger ─────────────────────────────────────── */

function loadSources() {
  return JSON.parse(fs.readFileSync(SOURCES_PATH, 'utf8'));
}

function loadLedger() {
  try {
    const l = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
    return Array.isArray(l?.used) ? l : { used: [] };
  } catch {
    return { used: [] };
  }
}

/** Append a chosen signal to the dedup ledger and prune entries older than DEDUP_DAYS. */
export function recordUsedSignal(signal) {
  const ledger = loadLedger();
  const cutoff = Date.now() - DEDUP_DAYS * 86400_000;
  const kept = ledger.used.filter(u => {
    const t = new Date(u.recordedAt || u.date || 0).getTime();
    return !isNaN(t) && t >= cutoff;
  });
  kept.push({
    titleKey: titleKey(signal.title),
    url: signal.url || '',
    pillar: signal.pillar,
    title: signal.title,
    recordedAt: new Date().toISOString()
  });
  fs.writeFileSync(LEDGER_PATH, JSON.stringify({ used: kept }, null, 2), 'utf8');
}

/* ── Helpers ─────────────────────────────────────────────── */

function cleanText(s) {
  return (s || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
}

function titleKey(t) {
  return (t || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function itemDate(it) {
  const d = it.isoDate || it.pubDate;
  if (!d) return null;
  const t = new Date(d).getTime();
  return isNaN(t) ? null : new Date(t).toISOString();
}

function withinFreshness(isoDate, days = FRESHNESS_DAYS) {
  if (!isoDate) return true; // keep when date unknown rather than silently dropping
  return (Date.now() - new Date(isoDate).getTime()) <= days * 86400_000;
}

/** Count existing posts per pillar by scanning blog/posts/*.html for data-pillar. */
function pillarCounts(pillarIds) {
  const counts = Object.fromEntries(pillarIds.map(id => [id, 0]));
  if (!fs.existsSync(POSTS_DIR)) return counts;
  for (const f of fs.readdirSync(POSTS_DIR)) {
    if (!f.endsWith('.html')) continue;
    const m = fs.readFileSync(path.join(POSTS_DIR, f), 'utf8').match(/data-pillar="([^"]+)"/);
    if (m && counts[m[1]] !== undefined) counts[m[1]]++;
  }
  return counts;
}

function buildGoogleNewsUrl(query, lang, cfg) {
  const tpl = lang === 'en' ? cfg.googleNews.enTemplate : cfg.googleNews.ptTemplate;
  const q = encodeURIComponent(`${query} ${cfg.googleNews.freshness || ''}`.trim());
  return tpl.replace('{q}', q);
}

// Fetch the feed XML ourselves (native fetch follows redirects and lets us send
// a real browser User-Agent + Accept header), then parse the string. rss-parser's
// own HTTP client gets served bot-detection HTML by some outlets (e.g. Alma Preta).
async function fetchFeed(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*'
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) { console.warn(`  ! feed HTTP ${res.status}: ${url}`); return []; }
    const xml = await res.text();
    const feed = await parser.parseString(xml);
    return feed.items || [];
  } catch (e) {
    console.warn(`  ! feed failed (${e.message}): ${url}`);
    return [];
  }
}

/**
 * Precompile per-pillar keyword regexes ONCE (avoids recompiling a RegExp per
 * keyword per item across hundreds of candidates). Whole-word, Unicode-aware: the
 * keyword must be flanked by non-letter/non-digit chars, so short tokens like "ia"
 * (IA/AI) or "dados" don't spuriously match inside "notícia" or "cuidados".
 */
function compilePillarMatchers(pillarsCfg) {
  return Object.entries(pillarsCfg).map(([pid, cfg]) => ({
    pid,
    regexes: (cfg.keywords || []).map(kw => {
      const escaped = kw.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu');
    })
  }));
}

/** Best pillar for a press item by keyword hit count; null if no match. */
function matchPillar(text, matchers) {
  const lower = text.toLowerCase();
  let best = null, bestHits = 0;
  for (const { pid, regexes } of matchers) {
    let hits = 0;
    for (const re of regexes) if (re.test(lower)) hits++;
    if (hits > bestHits) { bestHits = hits; best = pid; }
  }
  return bestHits > 0 ? best : null;
}

/* ── Candidate gathering ─────────────────────────────────── */

async function gatherCandidates(cfg) {
  const matchers = compilePillarMatchers(cfg.pillars);

  // Build every feed-fetch task up front and run them CONCURRENTLY (was sequential).
  // Press feeds: pillar inferred from keywords. Google News: pillar known per query.
  const tasks = [];
  for (const feed of cfg.pressFeeds || []) {
    tasks.push({ kind: 'press', feed });
  }
  for (const [pid, pc] of Object.entries(cfg.pillars)) {
    for (const lang of ['pt', 'en']) {
      const query = pc.googleNews?.[lang];
      if (query) tasks.push({ kind: 'news', pid, lang, url: buildGoogleNewsUrl(query, lang, cfg) });
    }
  }
  const feeds = await Promise.all(tasks.map(t => fetchFeed(t.url || t.feed.url)));

  const out = [];
  feeds.forEach((items, i) => {
    const t = tasks[i];
    for (const it of items) {
      const date = itemDate(it);
      if (!withinFreshness(date)) continue;
      if (t.kind === 'press') {
        const title = cleanText(it.title);
        const summary = cleanText(it.contentSnippet || it.content || it.summary || '');
        const pillar = matchPillar(`${title} ${summary}`, matchers);
        if (!pillar) continue;
        out.push({ title, summary: summary.slice(0, 400), url: it.link || '', source: t.feed.name, pillar, date, tier: t.feed.tier || 2 });
      } else {
        // Google News titles are "Headline - Publisher"
        const rawTitle = cleanText(it.title);
        const parts = rawTitle.split(' - ');
        const source = parts.length > 1 ? parts.pop() : 'Google News';
        const title = parts.join(' - ') || rawTitle;
        out.push({ title, summary: cleanText(it.contentSnippet || it.content || '').slice(0, 400), url: it.link || '', source, pillar: t.pid, date, tier: 3, lang: t.lang });
      }
    }
  });

  return out;
}

/* ── Dedup + scoring ─────────────────────────────────────── */

function dedupe(candidates, ledger) {
  const usedKeys = new Set((ledger.used || []).map(u => u.titleKey).filter(Boolean));
  const usedUrls = new Set((ledger.used || []).map(u => u.url).filter(Boolean));
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    if (!c.title) continue;
    const key = titleKey(c.title);
    if (!key || seen.has(key)) continue;          // dup within this run
    if (usedKeys.has(key) || (c.url && usedUrls.has(c.url))) continue; // grounded before
    seen.add(key);
    out.push(c);
  }
  return out;
}

function scoreCandidate(c, counts, maxCount) {
  let recency = 0.5;
  if (c.date) {
    const ageDays = (Date.now() - new Date(c.date).getTime()) / 86400_000;
    recency = Math.max(0, 1 - ageDays / FRESHNESS_DAYS);
  }
  const tierW = c.tier === 1 ? 1.0 : c.tier === 2 ? 0.8 : 0.7;
  // under-posted pillars get up to +0.5 boost
  const balance = maxCount > 0 ? 1 + ((maxCount - (counts[c.pillar] || 0)) / maxCount) * 0.5 : 1;
  return recency * 0.5 + tierW * 0.3 + balance * 0.2;
}

/* ── Claude safety / quality / on-brand check ────────────── */

async function safetyCheck(items) {
  if (items.length === 0) return [];
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('  ! ANTHROPIC_API_KEY not set — skipping safety check (treating all as OK)');
    return items.map(() => ({ ok: true, reason: 'no-key' }));
  }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const list = items.map((c, i) => `${i}. [${c.pillar}] ${c.title} — ${c.source}${c.summary ? `: ${c.summary}` : ''}`).join('\n');

  const prompt = `You screen news items as potential seeds for blog posts by Jorge Bernardo — a Black Brazilian man, cyclist, data-security/AI professional, and founder (DePretoPraPreto, afterALL). He writes thoughtful, constructive commentary in Brazilian Portuguese on identity, cycling, technology, entrepreneurship, fatherhood, learning, and career.

For EACH item below decide ok=true only if it is a SAFE, ON-BRAND, COMMENTARY-WORTHY seed:
- REJECT items centered on tragedy, violence, death, crime victims, abuse, explicit hate/racist attacks, lawsuits-as-tragedy, disasters, or anything where commentary would be insensitive.
- REJECT pure advertising/promotions, listicles with no substance, celebrity gossip, and items clearly off-brand for the pillars above.
- ACCEPT items with a constructive angle he can add perspective to: achievements, milestones, policy/data/studies, cultural trends, business/tech developments, education, sport.
When in doubt, REJECT (the blog auto-publishes with no human review).

Items:
${list}

Return ONLY a JSON array, one object per item in order: [{"index":0,"ok":true|false,"reason":"<short>"}]`;

  try {
    const res = await client.messages.create({
      model: SAFETY_MODEL,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }]
    });
    const text = res.content.map(b => b.text || '').join('');
    const json = text.slice(text.indexOf('['), text.lastIndexOf(']') + 1);
    const verdicts = JSON.parse(json);
    return items.map((_, i) => {
      const v = verdicts.find(x => x.index === i);
      return { ok: !!v?.ok, reason: v?.reason || 'no-verdict' };
    });
  } catch (e) {
    console.warn(`  ! safety check failed (${e.message}) — treating top candidates as NOT ok (fail closed)`);
    return items.map(() => ({ ok: false, reason: 'safety-error' }));
  }
}

/* ── Public API ──────────────────────────────────────────── */

export async function selectSignal({ forcePillar = null } = {}) {
  const cfg = loadSources();
  const pillarIds = Object.keys(cfg.pillars);
  const ledger = loadLedger();

  let candidates = await gatherCandidates(cfg);
  if (forcePillar) candidates = candidates.filter(c => c.pillar === forcePillar);
  candidates = dedupe(candidates, ledger);

  if (candidates.length === 0) {
    return { signal: null, pillar: forcePillar || null, candidates: [] };
  }

  const counts = pillarCounts(pillarIds);
  const maxCount = Math.max(1, ...Object.values(counts));
  for (const c of candidates) c.score = scoreCandidate(c, counts, maxCount);
  candidates.sort((a, b) => b.score - a.score);

  // Safety/quality gate on the strongest candidates; pick the first that passes.
  const topK = candidates.slice(0, SAFETY_BATCH);
  const verdicts = await safetyCheck(topK);
  topK.forEach((c, i) => { c.safe = verdicts[i]?.ok; c.safetyReason = verdicts[i]?.reason; });
  const winner = topK.find(c => c.safe) || null;

  return { signal: winner, pillar: winner?.pillar || forcePillar || null, candidates };
}
