/**
 * ig-audit.mjs
 * One-time (re-runnable) historical audit of the Instagram account.
 * Pulls the latest posts with per-post insights (reach, saves, shares...),
 * classifies each by pillar (hashtag/keyword heuristics), aggregates, and
 * writes ig-audit-report.json + ig-audit-report.md. Downloads thumbnails of
 * the top performers for visual review.
 *
 * Usage:  node ig-audit.mjs [--posts 100]
 */

import './load-env.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { graphCall } from './post-to-instagram.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORT_JSON = path.join(__dirname, 'ig-audit-report.json');
const REPORT_MD = path.join(__dirname, 'ig-audit-report.md');
const THUMBS_DIR = path.join(__dirname, 'temporary screenshots', 'audit');
const TOP_N_VISUAL = 8;

const PILLAR_KEYWORDS = {
  cycling: ['ciclismo', 'pedal', 'bike', 'bicicleta', 'depretoprapreto', 'cycling', 'jersey', 'treino'],
  'black-identity': ['racismo', 'negr', 'preto', 'preta', 'representatividade', 'identidade', 'afro'],
  technology: ['tecnologia', ' ia ', '#ia', 'dados', 'privacidade', 'segurança', 'tech', 'automação', 'algoritmo'],
  entrepreneurship: ['empreend', 'marca', 'negócio', 'capibalas', 'feira preta', 'business'],
  fatherhood: ['paternidade', 'filho', 'filha', ' pai ', '#pai', 'família'],
  learning: ['aprend', 'educação', 'estud', 'curso', 'escola'],
  'career-growth': ['carreira', 'depois dos 40', 'após os 40', 'profissional', 'reinvenção'],
};

function classifyPillar(caption) {
  const text = ` ${(caption || '').toLowerCase()} `;
  let best = null;
  let bestScore = 0;
  for (const [pillar, words] of Object.entries(PILLAR_KEYWORDS)) {
    const score = words.reduce((n, w) => n + (text.includes(w) ? 1 : 0), 0);
    if (score > bestScore) { best = pillar; bestScore = score; }
  }
  return best || 'unclassified';
}

async function fetchMedia(maxPosts) {
  const token = process.env.INSTAGRAM_ACCESS_TOKEN;
  const fields = 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count';
  const posts = [];
  let after = null;
  while (posts.length < maxPosts) {
    const params = { fields, limit: '50', access_token: token };
    if (after) params.after = after;
    const page = await graphCall('GET', '/me/media', params);
    posts.push(...(page.data || []));
    after = page.paging && page.paging.cursors && page.paging.cursors.after;
    if (!after || !page.data || page.data.length === 0) break;
  }
  return posts.slice(0, maxPosts);
}

async function fetchInsights(mediaId) {
  const token = process.env.INSTAGRAM_ACCESS_TOKEN;
  const metricSets = [
    'reach,saved,shares,likes,comments,total_interactions',
    'reach,saved',
    'reach',
  ];
  for (const metric of metricSets) {
    try {
      const res = await graphCall('GET', `/${mediaId}/insights`, { metric, access_token: token });
      const out = {};
      for (const m of res.data || []) {
        out[m.name] = m.values && m.values.length ? m.values[0].value : (m.total_value ? m.total_value.value : null);
      }
      return out;
    } catch (_) { /* try the next, smaller metric set */ }
  }
  return {};
}

function aggregate(posts) {
  const byGroup = (keyFn) => {
    const groups = {};
    for (const p of posts) {
      const k = keyFn(p) || 'unknown';
      groups[k] = groups[k] || { count: 0, reach: 0, saved: 0, shares: 0, likes: 0, comments: 0, withInsights: 0 };
      const g = groups[k];
      g.count++;
      if (p.insights && p.insights.reach != null) {
        g.withInsights++;
        g.reach += p.insights.reach || 0;
        g.saved += p.insights.saved || 0;
        g.shares += p.insights.shares || 0;
        g.likes += p.insights.likes || p.like_count || 0;
        g.comments += p.insights.comments || p.comments_count || 0;
      }
    }
    for (const g of Object.values(groups)) {
      if (g.withInsights > 0) {
        g.avgReach = Math.round(g.reach / g.withInsights);
        g.avgSaved = +(g.saved / g.withInsights).toFixed(1);
        g.avgShares = +(g.shares / g.withInsights).toFixed(1);
      }
    }
    return groups;
  };

  return {
    byPillar: byGroup((p) => p.pillar),
    byType: byGroup((p) => p.media_type),
    byWeekday: byGroup((p) => new Date(p.timestamp).toLocaleDateString('en-US', { weekday: 'long' })),
  };
}

function topBy(posts, metric, n = 10) {
  return posts
    .filter((p) => p.insights && p.insights[metric] != null)
    .sort((a, b) => b.insights[metric] - a.insights[metric])
    .slice(0, n)
    .map((p) => ({
      id: p.id,
      date: p.timestamp.slice(0, 10),
      type: p.media_type,
      pillar: p.pillar,
      [metric]: p.insights[metric],
      reach: p.insights.reach,
      saved: p.insights.saved,
      shares: p.insights.shares,
      permalink: p.permalink,
      caption: (p.caption || '').slice(0, 140).replace(/\n/g, ' '),
    }));
}

function mdTable(rows, cols) {
  if (!rows.length) return '_no data_\n';
  const header = `| ${cols.join(' | ')} |`;
  const sep = `| ${cols.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${cols.map((c) => String(r[c] ?? '')).join(' | ')} |`);
  return [header, sep, ...body].join('\n') + '\n';
}

async function downloadThumbs(posts) {
  fs.mkdirSync(THUMBS_DIR, { recursive: true });
  const top = posts
    .filter((p) => p.insights && p.insights.reach != null)
    .sort((a, b) => (b.insights.saved || 0) + (b.insights.shares || 0) - (a.insights.saved || 0) - (a.insights.shares || 0))
    .slice(0, TOP_N_VISUAL);
  for (let i = 0; i < top.length; i++) {
    const p = top[i];
    const url = p.thumbnail_url || p.media_url;
    if (!url) continue;
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      const file = path.join(THUMBS_DIR, `top-${i + 1}-${p.timestamp.slice(0, 10)}-${p.pillar}.jpg`);
      fs.writeFileSync(file, buf);
      p.thumbFile = file;
    } catch (_) { /* thumbnail is best-effort */ }
  }
  return top.length;
}

async function main() {
  const argIdx = process.argv.indexOf('--posts');
  const maxPosts = argIdx > -1 ? parseInt(process.argv[argIdx + 1], 10) : 100;

  console.log(`Fetching last ${maxPosts} posts...`);
  const posts = await fetchMedia(maxPosts);
  console.log(`Got ${posts.length} posts. Fetching per-post insights (this takes a minute)...`);

  let done = 0;
  for (const p of posts) {
    p.pillar = classifyPillar(p.caption);
    p.insights = await fetchInsights(p.id);
    done++;
    if (done % 20 === 0) console.log(`  ${done}/${posts.length}`);
  }

  const withInsights = posts.filter((p) => p.insights && p.insights.reach != null).length;
  console.log(`Insights available for ${withInsights}/${posts.length} posts.`);

  const agg = aggregate(posts);
  const report = {
    generatedAt: new Date().toISOString(),
    postsAnalyzed: posts.length,
    withInsights,
    aggregates: agg,
    topBySaved: topBy(posts, 'saved'),
    topByShares: topBy(posts, 'shares'),
    topByReach: topBy(posts, 'reach'),
    posts,
  };
  fs.writeFileSync(REPORT_JSON, JSON.stringify(report, null, 2), 'utf8');

  const aggRows = (groups) => Object.entries(groups)
    .map(([k, g]) => ({ group: k, posts: g.count, avgReach: g.avgReach ?? '-', avgSaved: g.avgSaved ?? '-', avgShares: g.avgShares ?? '-' }))
    .sort((a, b) => (b.avgReach === '-' ? 0 : b.avgReach) - (a.avgReach === '-' ? 0 : a.avgReach));

  const md = [
    `# Instagram Audit — ${new Date().toISOString().slice(0, 10)}`,
    `Posts analyzed: ${posts.length} · with insights: ${withInsights}`,
    '',
    '## By pillar', mdTable(aggRows(agg.byPillar), ['group', 'posts', 'avgReach', 'avgSaved', 'avgShares']),
    '## By media type', mdTable(aggRows(agg.byType), ['group', 'posts', 'avgReach', 'avgSaved', 'avgShares']),
    '## By weekday', mdTable(aggRows(agg.byWeekday), ['group', 'posts', 'avgReach', 'avgSaved', 'avgShares']),
    '## Top 10 by saves', mdTable(report.topBySaved, ['date', 'type', 'pillar', 'saved', 'shares', 'reach', 'caption']),
    '## Top 10 by shares', mdTable(report.topByShares, ['date', 'type', 'pillar', 'shares', 'saved', 'reach', 'caption']),
    '## Top 10 by reach', mdTable(report.topByReach, ['date', 'type', 'pillar', 'reach', 'saved', 'shares', 'caption']),
  ].join('\n');
  fs.writeFileSync(REPORT_MD, md, 'utf8');

  const thumbs = await downloadThumbs(posts);
  console.log(`Reports written: ig-audit-report.md / .json · ${thumbs} top-post thumbnails in temporary screenshots/audit/`);
}

main().catch((err) => {
  console.error(`\nFailed: ${err.message}`);
  process.exit(1);
});
