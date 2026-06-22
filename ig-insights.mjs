/**
 * ig-insights.mjs
 * Weekly Instagram + newsletter metrics: pulls follower/post counts and reach
 * from the Instagram API, subscriber count from Resend, appends a row to the
 * Notion IG Metrics database and metrics-history.json, and emails a digest.
 *
 * KPI lens (from jorge_ai_reels_clone_studio/PRODUCTION_WORKFLOW.md):
 * saves = useful · shares = resonance · comments = conversation ·
 * follows = positioning · DMs = trust.
 *
 * Usage:  node ig-insights.mjs
 */

import './load-env.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { graphCall } from './post-to-instagram.mjs';
import { createPage, prop } from './notion-api.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HISTORY_PATH = path.join(__dirname, 'metrics-history.json');
const DIGEST_TO = 'jorge.mbernardo@gmail.com';

async function fetchIgMetrics() {
  const token = process.env.INSTAGRAM_ACCESS_TOKEN;
  const me = await graphCall('GET', '/me', {
    fields: 'username,followers_count,media_count',
    access_token: token,
  });

  let reach = null;
  let profileViews = null;
  try {
    const igUserId = process.env.INSTAGRAM_USER_ID;
    const insights = await graphCall('GET', `/${igUserId}/insights`, {
      metric: 'reach',
      period: 'week',
      access_token: token,
    });
    const reachMetric = insights.data && insights.data.find((m) => m.name === 'reach');
    if (reachMetric && reachMetric.values && reachMetric.values.length) {
      reach = reachMetric.values[reachMetric.values.length - 1].value;
    }
  } catch (err) {
    console.warn(`Reach insights unavailable (${err.message}) — continuing without.`);
  }
  try {
    const igUserId = process.env.INSTAGRAM_USER_ID;
    const insights = await graphCall('GET', `/${igUserId}/insights`, {
      metric: 'profile_views',
      period: 'week',
      metric_type: 'total_value',
      access_token: token,
    });
    const pv = insights.data && insights.data.find((m) => m.name === 'profile_views');
    if (pv && pv.total_value) profileViews = pv.total_value.value;
  } catch (err) {
    console.warn(`Profile views unavailable (${err.message}) — continuing without.`);
  }

  return { username: me.username, followers: me.followers_count, posts: me.media_count, reach, profileViews };
}

async function fetchNewsletterSubs() {
  const key = process.env.RESEND_API_KEY;
  const audienceId = process.env.RESEND_AUDIENCE_ID;
  if (!key || !audienceId) return null;
  try {
    const res = await fetch(`https://api.resend.com/audiences/${audienceId}/contacts`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const contacts = body.data || [];
    return contacts.filter((c) => !c.unsubscribed).length;
  } catch (err) {
    console.warn(`Newsletter subs unavailable (${err.message}) — continuing without.`);
    return null;
  }
}

function appendHistory(entry) {
  const history = fs.existsSync(HISTORY_PATH) ? JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8')) : [];
  history.push(entry);
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2), 'utf8');
  return history;
}

function formatDelta(curr, prev) {
  if (prev === null || prev === undefined || curr === null) return '';
  const d = curr - prev;
  return d === 0 ? ' (=)' : d > 0 ? ` (+${d})` : ` (${d})`;
}

async function sendDigest(entry, prev) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return;
  const lines = [
    `Semana de ${entry.date} — @${entry.username}`,
    '',
    `Seguidores: ${entry.followers}${formatDelta(entry.followers, prev && prev.followers)}`,
    `Posts: ${entry.posts}${formatDelta(entry.posts, prev && prev.posts)}`,
    `Alcance (7d): ${entry.reach ?? 'n/d'}${formatDelta(entry.reach, prev && prev.reach)}`,
    `Visitas ao perfil (7d): ${entry.profileViews ?? 'n/d'}${formatDelta(entry.profileViews, prev && prev.profileViews)}`,
    `Newsletter: ${entry.newsletterSubs ?? 'n/d'} inscritos${formatDelta(entry.newsletterSubs, prev && prev.newsletterSubs)}`,
    '',
    'Lente de KPIs: saves = útil · shares = ressonância · comments = conversa · follows = posicionamento · DMs = confiança.',
    '',
    'Detalhe por post: Notion → IG Metrics / IG Pipeline.',
  ];
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'IG Pipeline <onboarding@resend.dev>',
      to: [DIGEST_TO],
      subject: `📊 IG semanal: ${entry.followers} seguidores${formatDelta(entry.followers, prev && prev.followers)}`,
      text: lines.join('\n'),
    }),
  });
  if (!res.ok) console.error(`Digest email failed: HTTP ${res.status}`);
  else console.log('Digest email sent.');
}

async function main() {
  const dbId = process.env.NOTION_METRICS_DB_ID;
  const date = new Date().toISOString().slice(0, 10);

  console.log('Fetching Instagram metrics...');
  const ig = await fetchIgMetrics();
  console.log('Fetching newsletter subscribers...');
  const newsletterSubs = await fetchNewsletterSubs();

  const entry = { date, ...ig, newsletterSubs };
  const history = appendHistory(entry);
  const prev = history.length > 1 ? history[history.length - 2] : null;
  console.log(`Metrics: ${JSON.stringify(entry)}`);

  if (dbId) {
    try {
      const properties = {
        'Week Of': prop.title(`Semana de ${date}`),
        Date: prop.date(date),
        Followers: prop.number(ig.followers),
        'Posts Total': prop.number(ig.posts),
        'Newsletter Subs': prop.number(newsletterSubs),
      };
      if (ig.reach !== null) properties['Reach (7d)'] = prop.number(ig.reach);
      if (ig.profileViews !== null) properties['Profile Views (7d)'] = prop.number(ig.profileViews);
      await createPage(dbId, properties);
      console.log('Notion metrics row created.');
    } catch (err) {
      console.error(`Notion metrics row failed (continuing to send digest): ${err.message}`);
    }
  }

  await sendDigest(entry, prev);
}

main().catch((err) => {
  console.error(`\nFailed: ${err.message}`);
  process.exit(1);
});
