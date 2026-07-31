/**
 * cycling-topics.mjs
 * Phase 4 Step 1: produces ONE cycling-pillar Reel concept per run, without
 * needing a blog post. Draws from the committed idea bank
 * (cycling-topics-bank.json), tracks usage in cycling-topics-used.json
 * (gitignored — survives the VPS `git reset --hard`) so ideas don't repeat
 * until the bank cycles, and optionally grounds the concept in Jorge's real
 * recent rides via Strava (activates when STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET
 * / STRAVA_REFRESH_TOKEN are set in .env; fails soft otherwise).
 *
 * Output: cycling-topic.json (root, gitignored) — consumed by
 * generate-video.mjs --topic-file. Tone: personal-Jorge (DePretoPraPreto may be
 * mentioned, its visual identity is never imported).
 *
 * Usage:
 *   node cycling-topics.mjs              (pick + develop a concept, mark used)
 *   node cycling-topics.mjs --dry-run    (print concept, don't mark used)
 *   node cycling-topics.mjs --seed "..." (develop this idea instead of the bank's)
 *
 * Requires: ANTHROPIC_API_KEY. Optional: STRAVA_* trio.
 */

import './load-env.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BANK_PATH = path.join(__dirname, 'cycling-topics-bank.json');
const USED_PATH = path.join(__dirname, 'cycling-topics-used.json');
const OUT_PATH = path.join(__dirname, 'cycling-topic.json');
const PERF_PATH = path.join(__dirname, 'ig-performance.json');
const PERF_MAX_AGE_DAYS = 30;
// sim-predictions.json (sim/report.mjs) is a one-off strategic artifact, not a
// continuously-refreshed feed like ig-performance.json, so it gets a much
// longer shelf life before being treated as stale.
const SIM_PATH = path.join(__dirname, 'sim-predictions.json');
const SIM_MAX_AGE_DAYS = 180;

const CANDIDATE_COUNT = 8;   // unused bank ideas offered to Claude per run
const RECENT_TITLES_KEPT = 12; // produced titles fed back as "don't repeat"

function fail(msg, detail = '') {
  console.log(JSON.stringify({ success: false, error: msg, detail }));
  process.exit(1);
}

/* ── Bank + usage ledger ─────────────────────────────────── */

function loadBank() {
  const bank = JSON.parse(fs.readFileSync(BANK_PATH, 'utf8'));
  if (!Array.isArray(bank.ideas) || bank.ideas.length === 0) fail('idea bank empty');
  return bank.ideas;
}

function loadUsed() {
  try {
    const u = JSON.parse(fs.readFileSync(USED_PATH, 'utf8'));
    return { usedIds: u.usedIds ?? [], recentTitles: u.recentTitles ?? [], recentCategories: u.recentCategories ?? [] };
  } catch { return { usedIds: [], recentTitles: [], recentCategories: [] }; }
}

function saveUsed(used, pickedId, title, category) {
  const usedIds = pickedId ? [...used.usedIds, pickedId] : used.usedIds;
  const recentTitles = [...used.recentTitles, title].slice(-RECENT_TITLES_KEPT);
  const recentCategories = [...used.recentCategories, category ?? 'seed'].slice(-4);
  fs.writeFileSync(USED_PATH, JSON.stringify({ usedIds, recentTitles, recentCategories }, null, 2), 'utf8');
}

// Performance loop (Phase 4 Step 3): ig-feedback.mjs writes ig-performance.json;
// this biases concept selection toward what actually works on the account.
// Fail-soft: no file / stale file → no bias.
function loadPerformance() {
  try {
    const p = JSON.parse(fs.readFileSync(PERF_PATH, 'utf8'));
    const ageDays = (Date.now() - new Date(p.generatedAt).getTime()) / 86_400_000;
    if (ageDays > PERF_MAX_AGE_DAYS) {
      console.log(`  (ig-performance.json is ${Math.round(ageDays)}d old — ignoring)`);
      return null;
    }
    return p;
  } catch { return null; }
}

// MiroFish-style synthetic-audience simulation (sim/report.mjs, one-off run —
// see docs/audience-simulation-report.md). Predictive, not real account data;
// folded into the same "wind, not rail" perfBlock as ig-performance.json.
// Fail-soft: no file / stale file → no bias.
function loadSimPredictions() {
  try {
    const s = JSON.parse(fs.readFileSync(SIM_PATH, 'utf8'));
    const ageDays = (Date.now() - new Date(s.generatedAt).getTime()) / 86_400_000;
    if (ageDays > SIM_MAX_AGE_DAYS) {
      console.log(`  (sim-predictions.json is ${Math.round(ageDays)}d old — ignoring)`);
      return null;
    }
    return s;
  } catch { return null; }
}

// Unused ideas, spread across categories so one category can't dominate a run's
// candidate list. When the whole bank has been used, the cycle restarts clean.
// Diversity floor: the previous run's category is excluded outright (when
// alternatives exist) so the feed can't collapse into one winning category —
// same philosophy as the old carousel anti-streak guard, applied upstream.
function pickCandidates(ideas, usedIds, lastCategory = null) {
  let pool = ideas.filter(i => !usedIds.includes(i.id));
  if (pool.length === 0) {
    console.log('  (bank fully cycled — restarting usage)');
    pool = ideas;
  }
  if (lastCategory) {
    const withoutLast = pool.filter(i => i.category !== lastCategory);
    if (withoutLast.length > 0) pool = withoutLast;
  }
  const byCategory = new Map();
  for (const idea of pool) {
    const list = byCategory.get(idea.category) ?? [];
    byCategory.set(idea.category, [...list, idea]);
  }
  const categories = [...byCategory.keys()].sort(() => Math.random() - 0.5);
  const picked = [];
  let rank = 0;
  while (picked.length < Math.min(CANDIDATE_COUNT, pool.length)) {
    for (const cat of categories) {
      const list = byCategory.get(cat);
      if (list[rank]) picked.push(list[rank]);
      if (picked.length >= Math.min(CANDIDATE_COUNT, pool.length)) break;
    }
    rank++;
  }
  return { candidates: picked, cycled: pool === ideas };
}

/* ── Strava (optional, fail-soft) ────────────────────────── */

async function stravaRecentRides() {
  const { STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, STRAVA_REFRESH_TOKEN } = process.env;
  if (!STRAVA_CLIENT_ID || !STRAVA_CLIENT_SECRET || !STRAVA_REFRESH_TOKEN) return null;
  try {
    const tokenRes = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: STRAVA_CLIENT_ID,
        client_secret: STRAVA_CLIENT_SECRET,
        refresh_token: STRAVA_REFRESH_TOKEN,
        grant_type: 'refresh_token',
      }),
    });
    if (!tokenRes.ok) throw new Error(`token refresh ${tokenRes.status}`);
    const { access_token } = await tokenRes.json();
    const actRes = await fetch('https://www.strava.com/api/v3/athlete/activities?per_page=10', {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    if (!actRes.ok) throw new Error(`activities ${actRes.status}`);
    const activities = await actRes.json();
    const rides = activities
      .filter(a => /ride/i.test(a.type || a.sport_type || ''))
      .slice(0, 6)
      .map(a => ({
        name: a.name,
        date: (a.start_date_local || '').slice(0, 10),
        km: +(a.distance / 1000).toFixed(1),
        elevationM: Math.round(a.total_elevation_gain || 0),
        movingMin: Math.round((a.moving_time || 0) / 60),
        avgKmh: a.average_speed ? +(a.average_speed * 3.6).toFixed(1) : null,
      }));
    return rides.length ? rides : null;
  } catch (e) {
    console.warn(`  ! Strava unavailable (${e.message}) — continuing without ride data`);
    return null;
  }
}

/* ── Claude: develop the concept ─────────────────────────── */

async function developConcept(client, { candidates, seed, rides, recentTitles, perf, sim }) {
  const source = seed
    ? `IDEIA-SEMENTE (obrigatória — desenvolva ESTA ideia):\n${seed}`
    : `BANCO DE IDEIAS (escolha UMA — a que rende o melhor Reel HOJE, considerando o material do Strava e o desempenho real se houver):\n${candidates.map(c => `- [${c.id}] (${c.category}) ${c.idea}`).join('\n')}`;

  const stravaBlock = rides
    ? `\nPEDAIS REAIS RECENTES DO JORGE (Strava — use como material concreto quando encaixar; números reais valem mais que generalidades):\n${rides.map(r => `- ${r.date} "${r.name}": ${r.km}km, ${r.elevationM}m de subida, ${r.movingMin}min${r.avgKmh ? `, ${r.avgKmh}km/h média` : ''}`).join('\n')}\n`
    : '';

  const perfBlock = perf
    ? `\nDESEMPENHO REAL DA CONTA (ig-performance.json, ${perf.generatedAt.slice(0, 10)}):\n` +
      (perf.reelCategories?.length
        ? `Categorias de Reel rankeadas (melhor primeiro): ${perf.reelCategories.map(c => `${c.group} (reach ${c.avgReach}, saves ${c.avgSaved}, shares ${c.avgShares})`).join(' · ')}\n`
        : '') +
      (perf.recentReels?.length
        ? `Últimos Reels: ${perf.recentReels.slice(0, 5).map(r => `[${r.category ?? '—'}] reach ${r.reach}: "${r.caption.slice(0, 60)}"`).join(' | ')}\n`
        : '') +
      `Use isto como VENTO, não como trilho: entre duas ideias igualmente fortes, prefira a categoria que performa melhor — mas uma ideia concreta e viva SEMPRE vence uma categoria vencedora com ideia fraca.\n`
    : '';

  const simBlock = sim?.reelCategories?.length
    ? `\nSIMULAÇÃO PREDITIVA DE AUDIÊNCIA (sim-predictions.json, ${sim.generatedAt.slice(0, 10)} — NÃO é dado real da conta, é uma estimativa de agentes sintéticos; use com ainda mais cautela que o desempenho real acima):\n` +
      `Tipos de conteúdo com maior engajamento previsto: ${sim.reelCategories.slice(0, 5).map(c => `${c.group} (engajamento previsto ${c.predictedEngagement})`).join(' · ')}\n` +
      `Isto é só mais um vento, mais fraco que o desempenho real da conta acima — nunca vença uma ideia concreta e viva, e nunca vença o desempenho real quando os dois discordarem.\n`
    : '';

  const res = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1200,
    system: `Você desenvolve pautas de Reels de ciclismo para o Instagram pessoal de Jorge Bernardo: homem negro brasileiro, ciclista amador dedicado, profissional de tecnologia, fundador da DePretoPraPreto (pode ser citada naturalmente, mas o tom é PESSOAL, nunca institucional). Voz: primeira pessoa, direto, reflexivo, zero clichê motivacional, SEM travessões (—), sem emojis. Ortografia impecável.`,
    tools: [{
      name: 'create_reel_concept',
      description: 'Uma pauta de Reel de ciclismo pronta para roteirização.',
      input_schema: {
        type: 'object',
        properties: {
          bankId: { type: 'string', description: 'O [id] da ideia escolhida do banco, ou "seed" se veio da ideia-semente' },
          title: { type: 'string', description: 'Título curto da pauta (PT-BR)' },
          hook: { type: 'string', description: 'O gancho dos 2 primeiros segundos: uma frase concreta que para o dedo' },
          angle: { type: 'string', description: 'O ângulo específico: qual é A ideia deste Reel em uma frase (não o tema, o ponto de vista)' },
          beats: {
            type: 'array',
            description: '3 a 4 batidas do meio: o que cada trecho do vídeo entrega, uma frase cada',
            items: { type: 'string' }
          },
          close: { type: 'string', description: 'O fechamento: imagem final ou pergunta aberta (não CTA)' },
          usesStrava: { type: 'boolean', description: 'true se a pauta usa números/fatos dos pedais reais listados' }
        },
        required: ['bankId', 'title', 'hook', 'angle', 'beats', 'close', 'usesStrava']
      }
    }],
    tool_choice: { type: 'tool', name: 'create_reel_concept' },
    messages: [{
      role: 'user',
      content: `Desenvolva UMA pauta de Reel vertical de ciclismo (~45-50s) para hoje.

${source}
${stravaBlock}${perfBlock}${simBlock}
PAUTAS RECENTES (não repita tema nem estrutura):
${recentTitles.length ? recentTitles.map(t => `- ${t}`).join('\n') : '(nenhuma ainda)'}

Regras:
- Concretude vence generalidade: cena, número, situação específica.
- O gancho NUNCA é uma pergunta genérica ("você sabia...?"); é uma afirmação ou cena que gera reconhecimento imediato.
- Se houver dados do Strava e a ideia escolhida combinar, ancore a pauta neles.
- Fechamento abre reflexão, não pede like/follow.
- Precisão factual é inegociável: para pautas de história/ciclismo real (ex: outros ciclistas, provas, recordes, datas), NUNCA invente ou adicione fatos específicos (nome de prova, ano, resultado, idade) que não estejam já na ideia do banco acima. Use apenas o que está escrito ali; se quiser mais detalhe, fique no vago ("uma corrida importante", "há alguns anos") em vez de arriscar um dado errado.`
    }],
  });

  const tool = res.content.find(b => b.type === 'tool_use');
  if (!tool) fail('no concept returned');
  return tool.input;
}

/* ── Main ────────────────────────────────────────────────── */

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) fail('ANTHROPIC_API_KEY not set');
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const seedIdx = args.indexOf('--seed');
  const seed = seedIdx !== -1 ? args[seedIdx + 1] : null;

  const ideas = loadBank();
  const used = loadUsed();
  const lastCategory = used.recentCategories[used.recentCategories.length - 1] ?? null;
  const { candidates } = seed ? { candidates: [] } : pickCandidates(ideas, used.usedIds, lastCategory);

  console.log(seed ? `Seed: ${seed}` : `Candidates: ${candidates.map(c => c.id).join(', ')}${lastCategory ? ` (category "${lastCategory}" excluded — diversity floor)` : ''}`);
  console.log('Checking Strava...');
  const rides = await stravaRecentRides();
  console.log(rides ? `  ${rides.length} recent rides loaded` : '  (no Strava data — bank-only concept)');

  const perf = loadPerformance();
  console.log(perf ? `  Performance data loaded (${perf.generatedAt.slice(0, 10)})` : '  (no ig-performance.json — unbiased pick)');

  const sim = loadSimPredictions();
  console.log(sim ? `  Sim predictions loaded (${sim.generatedAt.slice(0, 10)})` : '  (no sim-predictions.json — unbiased pick)');

  console.log('Developing concept (Claude)...');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const concept = await developConcept(client, { candidates, seed, rides, recentTitles: used.recentTitles, perf, sim });

  console.log(`\n  Title: ${concept.title}`);
  console.log(`  Hook:  ${concept.hook}`);
  console.log(`  Angle: ${concept.angle}`);
  concept.beats.forEach((b, i) => console.log(`  Beat ${i + 1}: ${b}`));
  console.log(`  Close: ${concept.close}`);
  console.log(`  Strava-grounded: ${concept.usesStrava}`);

  if (dryRun) {
    console.log('\nDry run — nothing written.');
    return;
  }

  fs.writeFileSync(OUT_PATH, JSON.stringify({ ...concept, pillar: 'cycling', generatedAt: new Date().toISOString() }, null, 2), 'utf8');
  const pickedId = seed ? null : concept.bankId;
  const category = ideas.find(i => i.id === concept.bankId)?.category ?? null;
  saveUsed(used, pickedId && pickedId !== 'seed' ? pickedId : null, concept.title, category);
  console.log(`\nWritten: cycling-topic.json${pickedId && pickedId !== 'seed' ? ` (bank id ${pickedId} marked used)` : ''}`);
  console.log(JSON.stringify({ success: true, title: concept.title, bankId: concept.bankId, usesStrava: concept.usesStrava }));
}

main().catch(e => fail('unexpected', String(e?.stack || e)));
