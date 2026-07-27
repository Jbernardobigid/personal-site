/**
 * sim/run-round.mjs
 * MiroFish-style cycling-audience simulation — runs ONE round of the 3-round
 * social simulation and appends the result to sim/sim-state.json.
 *
 *   R1 (--round 1): follower clusters react to all 30 content variants
 *                    (like/save/share/comment/follow propensity 0-10).
 *   R2 (--round 2): influencer clusters react to R1's top-10 variants
 *                    (reshare/collab propensity — emergent amplification).
 *   R3 (--round 3): influencer/brand-scout clusters rate partnership fit
 *                    on the same top-10 variants (sponsorship propensity + why).
 *
 * Agent engine: Kimi K3 (Moonshot, OpenAI-compatible) by default; set
 * SIM_AGENT_MODEL=haiku to fall back to Claude Haiku 4.5 for cheap iteration.
 *
 * Usage:
 *   node sim/run-round.mjs --round 1 [--dry-run]
 *
 * Requires: KIMIK3_API_KEY (default) or ANTHROPIC_API_KEY (--haiku fallback).
 */
import '../load-env.mjs';
import {
  loadPersonas, loadVariants, loadState, saveState,
  callAgent, weightedAvg, clamp01to10,
} from './lib.mjs';

const TOP_N_FOR_AMPLIFICATION = 10;
const CONCURRENCY = 8;
// kimi-k3 reasons before answering (always-on thinking — the reason it was
// picked over Haiku) and reasoning tokens count against max_tokens, so the
// budget has to cover ~5-6k reasoning tokens on top of the JSON content
// itself or long responses get cut off mid-array. Measured empirically: a
// 30-item persona response ate ~5.7k reasoning + ~2k content tokens.

function fail(msg) {
  console.log(JSON.stringify({ success: false, error: msg }));
  process.exit(1);
}

async function runPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        console.warn(`  ! ${items[i].id ?? i} failed: ${e.message}`);
        results[i] = null;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/* ── Round 1: follower reactions ─────────────────────────── */

function r1SystemPrompt(variants) {
  const list = variants.map(v => `- [${v.id}] (${v.type} / ${v.format}) ${v.brief}`).join('\n');
  return `Você simula a reação de um segmento (cluster) de seguidores do Instagram de Jorge Bernardo, ciclista amador brasileiro e profissional de tecnologia, a uma lista de possíveis conteúdos futuros.

Para CADA item da lista abaixo, dê notas de propensão de 0 a 10 (0 = ignoraria completamente, 10 = reagiria com certeza) para cinco ações: like, save, share (compartilhar), comment (comentar), follow (seguir, relevante só se ainda não seguisse). Adicione uma nota qualitativa curta (1 frase, em português) explicando a reação típica desse segmento a esse conteúdo específico.

LISTA DE VARIANTES DE CONTEÚDO SOB TESTE:
${list}

Responda APENAS com um objeto JSON válido, sem texto antes ou depois, no formato:
{"reactions":[{"id":"v01","like":0,"save":0,"share":0,"comment":0,"follow":0,"note":"..."}, ... um item para CADA variante listada, na mesma ordem]}`;
}

function r1UserPrompt(persona) {
  return `PERFIL DO SEGMENTO DE SEGUIDOR:
${persona.profile}

Disposições:
${persona.dispositions.map(d => `- ${d}`).join('\n')}

Objetivos ao seguir contas de ciclismo:
${persona.goals.map(g => `- ${g}`).join('\n')}

Simule a reação DESTE segmento específico a cada variante da lista, uma por uma.`;
}

async function runRound1(personas, variants) {
  const followers = personas.followers;
  console.log(`R1: ${followers.length} follower clusters x ${variants.length} variants...`);
  const system = r1SystemPrompt(variants);

  const responses = await runPool(followers, CONCURRENCY, async (persona) => {
    const out = await callAgent({ system, user: r1UserPrompt(persona), maxTokens: 12000 });
    if (!Array.isArray(out.reactions)) throw new Error('missing reactions array');
    return { persona, reactions: out.reactions };
  });

  const valid = responses.filter(Boolean);
  if (valid.length === 0) fail('R1: every persona call failed — aborting');
  console.log(`  ${valid.length}/${followers.length} clusters responded`);

  const scoresByVariant = {};
  for (const v of variants) {
    const perPersona = valid.map(({ persona, reactions }) => {
      const r = reactions.find(x => x.id === v.id);
      return r ? { persona, r } : null;
    }).filter(Boolean);

    const metric = (key) => weightedAvg(perPersona.map(({ persona, r }) => ({ weight: persona.weight, value: clamp01to10(r[key]) })));
    const like = metric('like'), save = metric('save'), share = metric('share'), comment = metric('comment'), follow = metric('follow');
    // Weighted toward saves/shares/follows — the actions that compound reach
    // and audience growth, mirroring what the real ig-audit data rewards.
    const engagementIndex = +(like * 1 + save * 2.5 + share * 3 + comment * 1.5 + follow * 2).toFixed(2);

    scoresByVariant[v.id] = { like: +like.toFixed(2), save: +save.toFixed(2), share: +share.toFixed(2), comment: +comment.toFixed(2), follow: +follow.toFixed(2), engagementIndex };
  }

  const ranked = variants.map(v => ({ v, score: scoresByVariant[v.id].engagementIndex })).sort((a, b) => b.score - a.score);
  const notes = [];
  for (const { v } of ranked.slice(0, 3)) {
    const best = valid.map(({ persona, reactions }) => ({ persona, r: reactions.find(x => x.id === v.id) }))
      .filter(x => x.r).sort((a, b) => b.persona.weight - a.persona.weight)[0];
    if (best?.r?.note) notes.push(`[top] ${v.id} (${v.type}/${v.format}): "${best.r.note}" — ${best.persona.id}`);
  }
  for (const { v } of ranked.slice(-2)) {
    const worst = valid.map(({ persona, reactions }) => ({ persona, r: reactions.find(x => x.id === v.id) }))
      .filter(x => x.r).sort((a, b) => b.persona.weight - a.persona.weight)[0];
    if (worst?.r?.note) notes.push(`[bottom] ${v.id} (${v.type}/${v.format}): "${worst.r.note}" — ${worst.persona.id}`);
  }

  return { scoresByVariant, notes, topVariantIds: ranked.slice(0, TOP_N_FOR_AMPLIFICATION).map(x => x.v.id) };
}

/* ── Round 2: influencer amplification ───────────────────── */

function r2SystemPrompt(topVariants) {
  const list = topVariants.map(v => `- [${v.id}] (${v.type} / ${v.format}) ${v.brief}`).join('\n');
  return `Você simula a reação de um segmento de criadores/influenciadores/contas de ciclismo à decisão de amplificar (repostar, fazer dueto, propor collab) conteúdos de Jorge Bernardo, ciclista amador brasileiro e profissional de tecnologia.

Estas são as variantes de conteúdo COM MELHOR DESEMPENHO na rodada anterior de reação de seguidores (já filtradas para o top 10):
${list}

Para CADA item, dê notas de propensão de 0 a 10 para: reshare (repostar/mencionar/citar) e collab (propor parceria de conteúdo, dueto, menção cruzada). Adicione uma nota curta (1 frase) sobre o ângulo de amplificação ou collab que esse segmento enxergaria.

Responda APENAS com JSON válido:
{"reactions":[{"id":"v07","reshare":0,"collab":0,"note":"..."}, ... um item para CADA variante listada]}`;
}

function r2UserPrompt(persona) {
  return `PERFIL DO SEGMENTO DE INFLUENCIADOR/CRIADOR:
${persona.profile}

Disposições:
${persona.dispositions.map(d => `- ${d}`).join('\n')}

Objetivos:
${persona.goals.map(g => `- ${g}`).join('\n')}

Simule a propensão DESTE segmento a amplificar cada variante da lista.`;
}

async function runRound2(personas, variants, round1) {
  if (!round1) fail('R2 requires round 1 to have run first');
  const topIds = round1.topVariantIds;
  const topVariants = variants.filter(v => topIds.includes(v.id));
  const influencers = personas.influencers;
  console.log(`R2: ${influencers.length} influencer clusters x ${topVariants.length} top variants...`);
  const system = r2SystemPrompt(topVariants);

  const responses = await runPool(influencers, CONCURRENCY, async (persona) => {
    const out = await callAgent({ system, user: r2UserPrompt(persona), maxTokens: 6000 });
    if (!Array.isArray(out.reactions)) throw new Error('missing reactions array');
    return { persona, reactions: out.reactions };
  });

  const valid = responses.filter(Boolean);
  if (valid.length === 0) fail('R2: every persona call failed — aborting');
  console.log(`  ${valid.length}/${influencers.length} clusters responded`);

  const scoresByVariant = {};
  for (const v of topVariants) {
    const perPersona = valid.map(({ persona, reactions }) => {
      const r = reactions.find(x => x.id === v.id);
      return r ? { persona, r } : null;
    }).filter(Boolean);
    const metric = (key) => weightedAvg(perPersona.map(({ persona, r }) => ({ weight: persona.weight, value: clamp01to10(r[key]) })));
    const reshare = metric('reshare'), collab = metric('collab');
    const amplificationIndex = +(reshare * 1.5 + collab * 2).toFixed(2);
    scoresByVariant[v.id] = { reshare: +reshare.toFixed(2), collab: +collab.toFixed(2), amplificationIndex };
  }

  const ranked = topVariants.map(v => ({ v, score: scoresByVariant[v.id].amplificationIndex })).sort((a, b) => b.score - a.score);
  const notes = [];
  for (const { v } of ranked.slice(0, 3)) {
    const best = valid.map(({ persona, reactions }) => ({ persona, r: reactions.find(x => x.id === v.id) }))
      .filter(x => x.r).sort((a, b) => b.persona.weight - a.persona.weight)[0];
    if (best?.r?.note) notes.push(`[top] ${v.id} (${v.type}/${v.format}): "${best.r.note}" — ${best.persona.id}`);
  }

  return { scoresByVariant, notes, topVariantIds: topIds };
}

/* ── Round 3: brand/partnership fit ──────────────────────── */

function r3SystemPrompt(topVariants) {
  const list = topVariants.map(v => `- [${v.id}] (${v.type} / ${v.format}) ${v.brief}`).join('\n');
  return `Você simula a avaliação de um segmento de marca/parceiro comercial sobre patrocinar ou propor parceria de conteúdo com Jorge Bernardo, ciclista amador brasileiro e profissional de tecnologia, com base em conteúdos que já performaram bem com seguidores e com criadores.

Variantes de conteúdo sob avaliação (top do funil de engajamento + amplificação):
${list}

Para CADA item, dê uma nota de "fitScore" de 0 a 10 (o quanto esse conteúdo se encaixaria numa parceria/patrocínio da SUA categoria de marca) e uma justificativa curta (1 frase) do porquê.

Responda APENAS com JSON válido:
{"reactions":[{"id":"v07","fitScore":0,"why":"..."}, ... um item para CADA variante listada]}`;
}

function r3UserPrompt(persona) {
  return `PERFIL DO SEGMENTO DE MARCA/PARCEIRO:
${persona.profile}
Categorias de marca representadas: ${(persona.brandCategories ?? []).join(', ')}

Disposições:
${persona.dispositions.map(d => `- ${d}`).join('\n')}

Objetivos:
${persona.goals.map(g => `- ${g}`).join('\n')}

Avalie o fit de parceria DESTE segmento de marca para cada variante da lista.`;
}

async function runRound3(personas, variants, round2) {
  if (!round2) fail('R3 requires round 2 to have run first');
  const topIds = round2.topVariantIds;
  const topVariants = variants.filter(v => topIds.includes(v.id));
  const influencers = personas.influencers;
  console.log(`R3: ${influencers.length} brand-scout clusters x ${topVariants.length} top variants...`);
  const system = r3SystemPrompt(topVariants);

  const responses = await runPool(influencers, CONCURRENCY, async (persona) => {
    const out = await callAgent({ system, user: r3UserPrompt(persona), maxTokens: 6000 });
    if (!Array.isArray(out.reactions)) throw new Error('missing reactions array');
    return { persona, reactions: out.reactions };
  });

  const valid = responses.filter(Boolean);
  if (valid.length === 0) fail('R3: every persona call failed — aborting');
  console.log(`  ${valid.length}/${influencers.length} clusters responded`);

  const scoresByVariant = {};
  for (const v of topVariants) {
    const perPersona = valid.map(({ persona, reactions }) => {
      const r = reactions.find(x => x.id === v.id);
      return r ? { persona, r } : null;
    }).filter(Boolean);
    const metric = weightedAvg(perPersona.map(({ persona, r }) => ({ weight: persona.weight, value: clamp01to10(r.fitScore) })));
    const topBrandCategories = perPersona
      .map(({ persona, r }) => ({ categories: persona.brandCategories ?? [], cluster: persona.id, fitScore: clamp01to10(r.fitScore), why: r.why }))
      .sort((a, b) => b.fitScore - a.fitScore)
      .slice(0, 3);
    scoresByVariant[v.id] = { partnershipScore: +metric.toFixed(2), topBrandCategories };
  }

  const ranked = topVariants.map(v => ({ v, score: scoresByVariant[v.id].partnershipScore })).sort((a, b) => b.score - a.score);
  const notes = ranked.slice(0, 3).map(({ v }) => {
    const top = scoresByVariant[v.id].topBrandCategories[0];
    return top ? `[top] ${v.id} (${v.type}/${v.format}): "${top.why}" — ${top.cluster} (${top.categories.join('/')})` : null;
  }).filter(Boolean);

  return { scoresByVariant, notes };
}

/* ── Main ─────────────────────────────────────────────────── */

async function main() {
  const args = process.argv.slice(2);
  const roundIdx = args.indexOf('--round');
  const round = roundIdx !== -1 ? Number(args[roundIdx + 1]) : NaN;
  const dryRun = args.includes('--dry-run');
  if (![1, 2, 3].includes(round)) fail('--round must be 1, 2, or 3');

  const personas = loadPersonas();
  const { variants } = loadVariants();
  console.log(`Loaded ${personas.followers.length} follower clusters, ${personas.influencers.length} influencer clusters, ${variants.length} content variants.`);

  const state = loadState();
  const existing = state.rounds.find(r => r.n === round);
  if (existing) fail(`round ${round} already ran — see sim/sim-state.json`);
  if (round > 1 && !state.rounds.find(r => r.n === round - 1)) fail(`round ${round} requires round ${round - 1} to run first`);

  if (dryRun) {
    console.log(`Dry run — round ${round} shape check only, no agent calls, no state written.`);
    console.log(`Provider: ${process.env.SIM_AGENT_MODEL === 'haiku' ? 'Haiku 4.5' : 'Kimi K3'}`);
    if (round === 1) console.log(`Would call ${personas.followers.length} agents, each scoring ${variants.length} variants x 5 actions.`);
    if (round === 2) console.log(`Would call ${personas.influencers.length} agents on round 1's top ${TOP_N_FOR_AMPLIFICATION} variants (round 1 not yet run, so top set unknown until then).`);
    if (round === 3) console.log(`Would call ${personas.influencers.length} agents on round 2's top variant subset.`);
    return;
  }

  let result;
  if (round === 1) result = await runRound1(personas, variants);
  else if (round === 2) result = await runRound2(personas, variants, state.rounds.find(r => r.n === 1));
  else result = await runRound3(personas, variants, state.rounds.find(r => r.n === 2));

  const kind = round === 1 ? 'follower-reactions' : round === 2 ? 'influencer-amplification' : 'brand-partnership-fit';
  const roundRecord = { n: round, kind, generatedAt: new Date().toISOString(), ...result };
  state.rounds.push(roundRecord);
  state.converged = round === 3;
  saveState(state);

  console.log(`\nRound ${round} (${kind}) written to sim/sim-state.json.`);
  console.log(JSON.stringify({ success: true, round, kind, converged: state.converged }));
}

main().catch(e => fail(`unexpected: ${e?.stack || e}`));
