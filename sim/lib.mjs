/**
 * sim/lib.mjs — shared helpers for the MiroFish-style audience simulation.
 * Provider abstraction (Kimi K3 default, Haiku 4.5 fallback via SIM_AGENT_MODEL=haiku),
 * personas/variants loaders, and the sim-state.json round ledger.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PERSONAS_PATH = path.join(__dirname, 'personas.json');
export const VARIANTS_PATH = path.join(__dirname, 'content-variants.json');
export const STATE_PATH = path.join(__dirname, 'sim-state.json');
export const PREDICTIONS_PATH = path.join(path.dirname(__dirname), 'sim-predictions.json');
export const REPORT_PATH = path.join(path.dirname(__dirname), 'docs', 'audience-simulation-report.md');

const KIMI_ENDPOINT = 'https://api.moonshot.ai/v1/chat/completions';
const KIMI_MODEL = 'kimi-k3';
const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

export function loadPersonas() {
  return JSON.parse(fs.readFileSync(PERSONAS_PATH, 'utf8'));
}

export function loadVariants() {
  return JSON.parse(fs.readFileSync(VARIANTS_PATH, 'utf8'));
}

export function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    return { rounds: s.rounds ?? [], converged: !!s.converged };
  } catch {
    return { rounds: [], converged: false };
  }
}

export function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

// Agent responses are asked to return raw JSON; this tolerates a ```json fence
// or stray prose around the object, which both providers occasionally add
// despite instructions.
export function parseJsonLoose(text) {
  const cleaned = String(text || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`agent did not return parseable JSON: ${cleaned.slice(0, 300)}`);
  }
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function callKimi({ system, user, maxTokens }) {
  const apiKey = process.env.KIMIK3_API_KEY;
  if (!apiKey) throw new Error('KIMIK3_API_KEY not set');
  const res = await fetch(KIMI_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: KIMI_MODEL,
      // kimi-k3 is a reasoning model and only accepts the default temperature (1).
      max_tokens: maxTokens,
      // Stable content first (system), persona-specific content last (user) —
      // maximizes the shared prefix Moonshot can cache-hit within a round.
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Kimi K3 ${res.status}: ${body.slice(0, 500)}`);
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? '';
  return parseJsonLoose(text);
}

async function callHaiku({ system, user, maxTokens }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set (required for SIM_AGENT_MODEL=haiku fallback)');
  const client = new Anthropic({ apiKey });
  const res = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  });
  const text = res.content.find(b => b.type === 'text')?.text ?? '';
  return parseJsonLoose(text);
}

// Provider is a config switch: SIM_AGENT_MODEL=haiku falls back to the cheap
// iteration path; default is Kimi K3 for higher-fidelity persona reasoning.
export async function callAgent({ system, user, maxTokens = 2200 }) {
  const provider = process.env.SIM_AGENT_MODEL === 'haiku' ? 'haiku' : 'kimi';
  return provider === 'haiku' ? callHaiku({ system, user, maxTokens }) : callKimi({ system, user, maxTokens });
}

export function weightedAvg(entries) {
  // entries: [{ weight, value }]
  const totalWeight = entries.reduce((s, e) => s + e.weight, 0);
  if (totalWeight === 0) return 0;
  return entries.reduce((s, e) => s + e.weight * e.value, 0) / totalWeight;
}

export function clamp01to10(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(10, v));
}
