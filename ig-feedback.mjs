/**
 * ig-feedback.mjs
 * Phase 4 Step 3: closes the performance loop. Pulls recent posts + insights
 * from the IG Graph API (same fetch pattern as ig-audit.mjs, which can't be
 * imported — it runs main() on import) and writes ig-performance.json: a
 * machine-readable ranking of pillars, formats, weekdays, and cycling-Reel
 * CATEGORIES (mapped to cycling-topics-bank.json categories via caption
 * keywords). Generators read it to bias toward what works; consumers must
 * fail soft when the file is missing or stale.
 *
 * Gitignored + regenerated in place (VPS-local state, survives git reset).
 * Runs before each cycling Reel build (n8n workflow) and can run ad-hoc.
 *
 * Usage: node ig-feedback.mjs [--posts 60]
 * Requires: INSTAGRAM_ACCESS_TOKEN.
 */

import './load-env.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { graphCall } from './post-to-instagram.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(__dirname, 'ig-performance.json');

// Caption keywords → cycling-topics-bank.json categories. A Reel matching no
// category still counts toward format/pillar aggregates.
const CATEGORY_KEYWORDS = {
  tips: ['dica', 'como ', 'erro', 'comece', 'aprenda', 'passo'],
  humor: ['😂', 'kkk', 'raro mas acontece', 'credo', 'personalidade', 'vício'],
  advocacy: ['respeite', 'ciclista na estrada', 'voltar pra casa', 'motorista', '1,5 metro'],
  history: ['major taylor', '1899', 'história', 'campeão mundial', 'girmay', 'pioneir'],
  identity: ['único preto', 'ciclista negro', 'representatividade', 'racismo', 'pelotão branco'],
  mind: ['cabeça', 'mente', 'paciência', 'se encontra', 'pensamento', 'sela ensina'],
  gear: ['pneu', 'equipamento', 'upgrade', 'bike usada', 'pressão', 'marcha'],
  community: ['grupo de pedal', 'comunidade', 'pertencimento', 'rede de apoio'],
};

function classifyCategory(caption) {
  const text = (caption || '').toLowerCase();
  let best = null, bestScore = 0;
  for (const [cat, words] of Object.entries(CATEGORY_KEYWORDS)) {
    const score = words.reduce((n, w) => n + (text.includes(w) ? 1 : 0), 0);
    if (score > bestScore) { best = cat; bestScore = score; }
  }
  return best;
}

const PILLAR_KEYWORDS = {
  cycling: ['ciclismo', 'pedal', 'bike', 'bicicleta', 'depretoprapreto', 'cycling', 'jersey', 'treino'],
  'black-identity': ['racismo', 'negr', 'preto', 'preta', 'representatividade', 'identidade', 'afro'],
  technology: ['tecnologia', ' ia ', '#ia', 'dados', 'privacidade', 'segurança', 'tech'],
  'career-growth': ['carreira', 'depois dos 40', 'após os 40', 'profissional', 'reinvenção'],
};

function classifyPillar(caption) {
  const text = ` ${(caption || '').toLowerCase()} `;
  let best = null, bestScore = 0;
  for (const [pillar, words] of Object.entries(PILLAR_KEYWORDS)) {
    const score = words.reduce((n, w) => n + (text.includes(w) ? 1 : 0), 0);
    if (score > bestScore) { best = pillar; bestScore = score; }
  }
  return best || 'other';
}

async function fetchMedia(maxPosts) {
  const token = process.env.INSTAGRAM_ACCESS_TOKEN;
  const fields = 'id,caption,media_type,permalink,timestamp,like_count,comments_count';
  const posts = [];
  let after = null;
  while (posts.length < maxPosts) {
    const params = { fields, limit: '50', access_token: token };
    if (after) params.after = after;
    const page = await graphCall('GET', '/me/media', params);
    posts.push(...(page.data || []));
    after = page.paging?.cursors?.after;
    if (!after || !page.data?.length) break;
  }
  return posts.slice(0, maxPosts);
}

async function fetchInsights(mediaId) {
  const token = process.env.INSTAGRAM_ACCESS_TOKEN;
  for (const metric of ['reach,saved,shares,likes,comments', 'reach,saved', 'reach']) {
    try {
      const res = await graphCall('GET', `/${mediaId}/insights`, { metric, access_token: token });
      const out = {};
      for (const m of res.data || []) {
        out[m.name] = m.values?.length ? m.values[0].value : (m.total_value ? m.total_value.value : null);
      }
      return out;
    } catch { /* smaller metric set */ }
  }
  return {};
}

function groupStats(posts, keyFn) {
  const groups = {};
  for (const p of posts) {
    const k = keyFn(p);
    if (k == null) continue;
    const g = groups[k] ?? (groups[k] = { posts: 0, reach: 0, saved: 0, shares: 0 });
    g.posts++;
    g.reach += p.insights.reach || 0;
    g.saved += p.insights.saved || 0;
    g.shares += p.insights.shares || 0;
  }
  return Object.fromEntries(Object.entries(groups).map(([k, g]) => [k, {
    posts: g.posts,
    avgReach: Math.round(g.reach / g.posts),
    avgSaved: +(g.saved / g.posts).toFixed(1),
    avgShares: +(g.shares / g.posts).toFixed(1),
  }]));
}

function ranked(stats) {
  return Object.entries(stats)
    .sort(([, a], [, b]) => (b.avgReach + 50 * (b.avgSaved + b.avgShares)) - (a.avgReach + 50 * (a.avgSaved + a.avgShares)))
    .map(([k, v]) => ({ group: k, ...v }));
}

async function main() {
  if (!process.env.INSTAGRAM_ACCESS_TOKEN) {
    console.log(JSON.stringify({ success: false, error: 'INSTAGRAM_ACCESS_TOKEN not set' }));
    process.exit(1);
  }
  const argIdx = process.argv.indexOf('--posts');
  const maxPosts = argIdx > -1 ? parseInt(process.argv[argIdx + 1], 10) : 60;

  console.log(`Fetching last ${maxPosts} posts...`);
  const all = await fetchMedia(maxPosts);
  console.log(`Got ${all.length}. Fetching insights...`);
  for (const p of all) {
    p.pillar = classifyPillar(p.caption);
    p.insights = await fetchInsights(p.id);
  }
  const posts = all.filter(p => p.insights?.reach != null);
  console.log(`Insights for ${posts.length}/${all.length}.`);

  const reels = posts.filter(p => p.media_type === 'VIDEO');
  const cyclingReels = reels.filter(p => p.pillar === 'cycling' || classifyCategory(p.caption));

  const perf = {
    generatedAt: new Date().toISOString(),
    windowPosts: posts.length,
    byPillar: ranked(groupStats(posts, p => p.pillar)),
    byType: ranked(groupStats(posts, p => p.media_type)),
    byWeekday: ranked(groupStats(posts, p => new Date(p.timestamp).toLocaleDateString('en-US', { weekday: 'long' }))),
    reelCategories: ranked(groupStats(cyclingReels, p => classifyCategory(p.caption))),
    recentReels: reels.slice(0, 12).map(p => ({
      date: p.timestamp.slice(0, 10),
      category: classifyCategory(p.caption),
      reach: p.insights.reach ?? 0,
      saved: p.insights.saved ?? 0,
      shares: p.insights.shares ?? 0,
      caption: (p.caption || '').slice(0, 120).replace(/\n/g, ' '),
    })),
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(perf, null, 2), 'utf8');
  console.log(`Written: ig-performance.json (${posts.length} posts, ${reels.length} reels, ${perf.reelCategories.length} ranked categories)`);
  console.log(JSON.stringify({ success: true, posts: posts.length, reels: reels.length }));
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
