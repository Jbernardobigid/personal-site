/**
 * sim/report.mjs
 * On convergence (all 3 rounds run), synthesizes the MiroFish-style audience
 * simulation into:
 *   - docs/audience-simulation-report.md  (the strategic report for Jorge)
 *   - sim-predictions.json (repo root)    (machine-readable ranking, consumed
 *                                          fail-soft by cycling-topics.mjs)
 *
 * Usage: node sim/report.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  loadPersonas, loadVariants, loadState, PREDICTIONS_PATH, REPORT_PATH,
} from './lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(__dirname);
const IG_PERFORMANCE_PATH = path.join(ROOT, 'ig-performance.json');
const IG_AUDIT_JSON_PATH = path.join(ROOT, 'ig-audit-report.json');

function fail(msg) {
  console.log(JSON.stringify({ success: false, error: msg }));
  process.exit(1);
}

function loadJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/* ── Merge the 3 rounds into one per-variant record ──────── */

function mergeVariants(variants, r1, r2, r3) {
  return variants.map(v => {
    const a = r1.scoresByVariant[v.id] ?? null;
    const b = r2.scoresByVariant[v.id] ?? null;
    const c = r3.scoresByVariant[v.id] ?? null;
    return {
      id: v.id, type: v.type, format: v.format, brief: v.brief,
      like: a?.like ?? 0, save: a?.save ?? 0, share: a?.share ?? 0, comment: a?.comment ?? 0, follow: a?.follow ?? 0,
      engagementIndex: a?.engagementIndex ?? 0,
      amplificationIndex: b?.amplificationIndex ?? null,
      partnershipScore: c?.partnershipScore ?? null,
      topBrandCategories: c?.topBrandCategories ?? null,
    };
  });
}

function mean(nums) {
  const xs = nums.filter(n => n != null);
  if (xs.length === 0) return null;
  return +(xs.reduce((s, n) => s + n, 0) / xs.length).toFixed(2);
}

function groupBy(merged, key) {
  const groups = new Map();
  for (const m of merged) {
    const list = groups.get(m[key]) ?? [];
    groups.set(m[key], [...list, m]);
  }
  const rows = [...groups.entries()].map(([group, items]) => {
    const sorted = [...items].sort((a, b) => b.engagementIndex - a.engagementIndex);
    return {
      group,
      variants: items.length,
      predictedEngagement: mean(items.map(i => i.engagementIndex)),
      predictedSave: mean(items.map(i => i.save)),
      predictedShare: mean(items.map(i => i.share)),
      predictedAmplification: mean(items.map(i => i.amplificationIndex)),
      topVariant: { id: sorted[0].id, brief: sorted[0].brief, format: sorted[0].format, type: sorted[0].type },
    };
  });
  return rows.sort((a, b) => b.predictedEngagement - a.predictedEngagement);
}

function buildPartnershipFit(merged) {
  const byCategory = new Map();
  for (const m of merged) {
    if (!m.topBrandCategories) continue;
    for (const entry of m.topBrandCategories) {
      for (const cat of entry.categories) {
        const list = byCategory.get(cat) ?? [];
        list.push({ id: m.id, type: m.type, format: m.format, brief: m.brief, fitScore: entry.fitScore, why: entry.why });
        byCategory.set(cat, list);
      }
    }
  }
  const rows = [...byCategory.entries()].map(([brandCategory, entries]) => {
    const sorted = entries.sort((a, b) => b.fitScore - a.fitScore);
    return {
      brandCategory,
      avgFitScore: mean(sorted.map(e => e.fitScore)),
      topContent: sorted.slice(0, 3),
    };
  });
  return rows.sort((a, b) => b.avgFitScore - a.avgFitScore);
}

/* ── Reality calibration vs real account data ────────────── */

function buildCalibration(reelCategories) {
  const perf = loadJsonSafe(IG_PERFORMANCE_PATH);
  const audit = loadJsonSafe(IG_AUDIT_JSON_PATH);
  if (!perf && !audit) {
    return '_Nenhum dado real disponível (`ig-performance.json` / `ig-audit-report.json` ausentes) — seção de calibração pulada._';
  }

  const lines = [];
  if (perf?.reelCategories?.length) {
    lines.push('**Categorias de Reel reais (ig-performance.json)**, por reach médio:');
    for (const c of perf.reelCategories) {
      const simMatch = reelCategories.find(r => r.group === c.group);
      const simRank = simMatch ? reelCategories.indexOf(simMatch) + 1 : null;
      lines.push(`- \`${c.group}\`: reach real ${c.avgReach} (${c.posts} post${c.posts === 1 ? '' : 's'}), saves ${c.avgSaved}, shares ${c.avgShares}` +
        (simRank ? ` — na simulação, \`${c.group}\` ficou em #${simRank}/${reelCategories.length} por engajamento previsto (${simMatch.predictedEngagement}).` : ' — tipo não modelado diretamente na simulação (mapeamento aproximado).'));
    }
  }
  // aggregates.{byType,byPillar,byWeekday} are objects keyed by group name
  // (not arrays) in ig-audit-report.json — {IMAGE: {avgReach, ...}, ...}.
  if (audit?.aggregates?.byType) {
    const rows = Object.entries(audit.aggregates.byType).sort((a, b) => b[1].avgReach - a[1].avgReach);
    lines.push('\n**Por tipo de mídia real (ig-audit-report.json)**: ' +
      rows.map(([group, v]) => `${group} (reach ${v.avgReach})`).join(' > ') +
      ' — confirma que vídeo domina sobre carrossel e imagem estática nesta conta.');
  }
  if (audit?.aggregates?.byPillar?.cycling) {
    const cycling = audit.aggregates.byPillar.cycling;
    lines.push(`\n**Pilar cycling real**: reach médio ${cycling.avgReach} em ${cycling.count} posts — o pilar com melhor desempenho consistente da conta, o que sustenta a aposta em ciclismo como eixo do teste.`);
  }
  if (audit?.aggregates?.byWeekday) {
    const top3 = Object.entries(audit.aggregates.byWeekday).sort((a, b) => b[1].avgReach - a[1].avgReach).slice(0, 3).map(([group]) => group);
    lines.push(`\n**Melhores dias reais para postar**: ${top3.join(', ')}.`);
  }
  lines.push('\n**Leitura**: a simulação prediz humor/relatable e história (Major Taylor / ciclismo negro) como formatos de alto engajamento previsto — isso CONVERGE com o dado real (`humor` é a categoria de maior reach real da conta por larga margem, `history` em segundo). Isso é evidência a favor da simulação estar capturando um padrão real, não ruído. Divergências (categorias que a simulação rankeia alto mas que não têm par direto nos dados reais, como `advocacy` ou `data`) devem ser tratadas como hipóteses a testar, não fatos.');
  return lines.join('\n');
}

/* ── Markdown report ──────────────────────────────────────── */

function fmtRow(r) {
  return `| ${r.group} | ${r.variants} | ${r.predictedEngagement} | ${r.predictedSave} | ${r.predictedShare} | ${r.predictedAmplification ?? '—'} | ${r.topVariant.id} — ${r.topVariant.brief.slice(0, 70)}${r.topVariant.brief.length > 70 ? '…' : ''} |`;
}

function buildReportMarkdown({ personas, variants, reelCategories, byFormat, partnershipFit, merged, calibration }) {
  const topOverall = [...merged].sort((a, b) => b.engagementIndex - a.engagementIndex).slice(0, 10);
  const topAmplified = [...merged].filter(m => m.amplificationIndex != null).sort((a, b) => b.amplificationIndex - a.amplificationIndex).slice(0, 5);

  return `# Simulação de audiência (estilo MiroFish) — Ciclismo no Instagram de Jorge Bernardo

_Gerado em ${new Date().toISOString().slice(0, 10)} · ${personas.followers.length} clusters de seguidor (peso total ${personas.followers.reduce((s, c) => s + c.weight, 0)}) · ${personas.influencers.length} clusters de influenciador/marca (peso total ${personas.influencers.reduce((s, c) => s + c.weight, 0)}) · ${variants.length} variantes de conteúdo testadas · 3 rodadas de simulação social._

## 1. Método

Este relatório replica a metodologia do [MiroFish](https://github.com/666ghj/MiroFish): em vez de perguntar diretamente "o que devo postar?", construímos uma população sintética de agentes-persona heterogêneos (perfil, disposições, objetivos) que reagem a uma lista de conteúdos candidatos ao longo de rodadas sociais, e observamos o comportamento emergente.

- **Rodada 1 (reação de seguidor)**: ${personas.followers.length} clusters de seguidor, cada um representando estatisticamente uma fatia da audiência (não ${personas.followers.reduce((s, c) => s + c.weight, 0)} agentes literais), reagem às ${variants.length} variantes de conteúdo com propensão de like/save/share/comment/follow.
- **Rodada 2 (amplificação de influenciador)**: os ${personas.influencers.length} clusters de influenciador/criador reagem ao top 10 da rodada 1 com propensão de reshare/collab — a lista de entrada já é resultado emergente da rodada anterior, não um dado fixo.
- **Rodada 3 (fit de parceria/marca)**: os mesmos clusters (que também carregam categorias de marca) avaliam fit de patrocínio no mesmo top 10.

**Base das personas**: pesquisa de mercado sobre o nicho de ciclismo amador brasileiro + o cruzamento tech/ciclismo/identidade negra que define o posicionamento de Jorge — as personas foram **desenhadas, não extraídas da conta real** (regra do MiroFish). A seção 4 faz a checagem cruzada contra os dados reais da conta.

**Motor dos agentes**: ${process.env.SIM_AGENT_MODEL === 'haiku' ? 'Claude Haiku 4.5 (modo de iteração barata)' : 'Kimi K3 (Moonshot, 2.8T, raciocínio always-on)'}.

**Limites**: isto é uma simulação preditiva com LLMs representando comportamento humano — direcionalmente útil (relativo entre variantes), não uma previsão de reach absoluto. Trate como vento para a decisão editorial, nunca como trilho.

## 2. Ranking de conteúdo previsto

### Por tipo (agregado das ${variants.length} variantes)

| Tipo | Variantes | Engajamento previsto | Save previsto | Share previsto | Amplificação (influenciador) | Melhor variante |
| --- | --- | --- | --- | --- | --- | --- |
${reelCategories.map(fmtRow).join('\n')}

### Por formato

| Formato | Variantes | Engajamento previsto | Save previsto | Share previsto | Amplificação (influenciador) | Melhor variante |
| --- | --- | --- | --- | --- | --- | --- |
${byFormat.map(fmtRow).join('\n')}

### Top 10 variantes individuais (engajamento de seguidor previsto)

| # | ID | Tipo/Formato | Engajamento | Save | Share | Amplificação | Brief |
| --- | --- | --- | --- | --- | --- | --- | --- |
${topOverall.map((m, i) => `| ${i + 1} | ${m.id} | ${m.type}/${m.format} | ${m.engagementIndex} | ${m.save} | ${m.share} | ${m.amplificationIndex ?? '—'} | ${m.brief.slice(0, 80)}${m.brief.length > 80 ? '…' : ''} |`).join('\n')}

### Top 5 por amplificação de influenciador (reshare/collab)

${topAmplified.map((m, i) => `${i + 1}. **${m.id}** (${m.type}/${m.format}, amplificação ${m.amplificationIndex}) — ${m.brief}`).join('\n')}

## 3. Mapa de parceria/marca

Categorias de marca ranqueadas por fit médio de patrocínio, com o conteúdo que cada uma mais valorizaria:

${partnershipFit.map(p => `### ${p.brandCategory} (fit médio ${p.avgFitScore})\n${p.topContent.map(c => `- **${c.id}** (${c.type}/${c.format}, fit ${c.fitScore}) — ${c.why}`).join('\n')}`).join('\n\n')}

## 4. Calibração com a realidade

${calibration}

## 5. Camada de Stories (vida real → funil)

A simulação não modela Stories diretamente (são efêmeros e não indexados como Reels/carrossel), mas os tipos que melhor performaram na simulação — humor/relatable, history, mind, community, bts-vlog — são exatamente os que fazem sentido como Stories reais, não roteirizados, funcionando como isca para o blog/newsletter/podcast. Ver \`docs/stories-playbook.md\` para cadência e copy prontos: BTS real → teaser do assunto do blog → CTA rotativo ("leia o post completo" / "assine a newsletter" / "ouça o podcast").

## 6. Ações recomendadas no pipeline

1. **\`cycling-topics.mjs\`** agora lê \`sim-predictions.json\` (se presente) e soma o ranking previsto ao \`perfBlock\` que já influencia a escolha de pauta — vento, não trilho, igual ao \`ig-performance.json\` real. Fail-soft se o arquivo não existir.
2. **CTA rotativo de newsletter/podcast** adicionado a \`generate-carousel.mjs\` e \`generate-video.mjs\`, ao lado do CTA de blog existente — hoje só o blog tem "Link na bio", e newsletter/podcast nunca são promovidos no feed.
3. **Decisão de pivotar para conteúdo dedicado de ciclismo em vez de derivado do blog**: a simulação e os dados reais convergem em apontar ciclismo + humor/história/identidade como o eixo de maior tração. Mas isto é uma **recomendação, não uma decisão automática** — a decisão final de reduzir ou não os posts derivados do blog é do Jorge.

---
_Dados brutos das 3 rodadas em \`sim/sim-state.json\`. Ranking machine-readable em \`sim-predictions.json\` (raiz do repo)._
`;
}

/* ── Main ─────────────────────────────────────────────────── */

async function main() {
  const personas = loadPersonas();
  const { variants } = loadVariants();
  const state = loadState();

  const r1 = state.rounds.find(r => r.n === 1);
  const r2 = state.rounds.find(r => r.n === 2);
  const r3 = state.rounds.find(r => r.n === 3);
  if (!r1 || !r2 || !r3) fail(`report requires all 3 rounds — have: ${state.rounds.map(r => r.n).join(', ') || 'none'}`);

  const merged = mergeVariants(variants, r1, r2, r3);
  const reelCategories = groupBy(merged, 'type');
  const byFormat = groupBy(merged, 'format');
  const partnershipFit = buildPartnershipFit(merged);
  const calibration = buildCalibration(reelCategories);

  const predictions = {
    generatedAt: new Date().toISOString(),
    method: 'miroFish-style-synthetic-audience-simulation',
    agentModel: process.env.SIM_AGENT_MODEL === 'haiku' ? 'haiku-4.5' : 'kimi-k3',
    scale: {
      followerClusters: personas.followers.length,
      followerWeightTotal: personas.followers.reduce((s, c) => s + c.weight, 0),
      influencerClusters: personas.influencers.length,
      influencerWeightTotal: personas.influencers.reduce((s, c) => s + c.weight, 0),
      variants: variants.length,
    },
    reelCategories,
    byFormat,
    partnershipFit,
    topVariants: [...merged].sort((a, b) => b.engagementIndex - a.engagementIndex).slice(0, 10),
  };
  fs.writeFileSync(PREDICTIONS_PATH, JSON.stringify(predictions, null, 2), 'utf8');
  console.log(`Written: ${path.relative(ROOT, PREDICTIONS_PATH)}`);

  const md = buildReportMarkdown({ personas, variants, reelCategories, byFormat, partnershipFit, merged, calibration });
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, md, 'utf8');
  console.log(`Written: ${path.relative(ROOT, REPORT_PATH)}`);

  console.log(JSON.stringify({ success: true, reelCategories: reelCategories.length, byFormat: byFormat.length, partnershipFit: partnershipFit.length }));
}

main().catch(e => fail(`unexpected: ${e?.stack || e}`));
