/**
 * research.mjs
 * Node port of the newsletter's Python research tool (research_topic.py).
 * Given a topic/query, runs a two-pass Tavily web search (main + historical) and
 * synthesizes the results into structured, citation-backed research with OpenAI —
 * "never invent numbers, only what the sources state". Output schema matches the
 * Python tool exactly so the newsletter can consume it via `--research`.
 *
 * Module:  import { researchTopic } from './research.mjs'  → { success, data, error }
 * CLI:     node research.mjs "<topic>" [--slug <slug>]
 *
 * Requires: TAVILY_API_KEY (web search) + OPENAI_API_KEY (synthesis).
 */

import './load-env.mjs';
import { pathToFileURL } from 'url';
import OpenAI from 'openai';

const TAVILY_URL = 'https://api.tavily.com/search';
const SYNTH_MODEL = 'gpt-4o-mini'; // cheap + fast for JSON synthesis

function slugify(text) {
  return text.toLowerCase().trim()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60).replace(/^-+|-+$/g, '');
}

async function searchTavily(query, maxResults = 8) {
  const key = process.env.TAVILY_API_KEY;
  if (!key || key === 'your_tavily_key_here') {
    return { success: false, results: [], answer: '', error: 'TAVILY_API_KEY not set' };
  }
  try {
    const res = await fetch(TAVILY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        api_key: key, // legacy-compatible; harmless alongside the Bearer header
        query,
        search_depth: 'advanced',
        max_results: maxResults,
        include_answer: true,
        include_raw_content: false
      }),
      signal: AbortSignal.timeout(30000)
    });
    if (!res.ok) return { success: false, results: [], answer: '', error: `Tavily HTTP ${res.status}` };
    const data = await res.json();
    return { success: true, results: data.results || [], answer: data.answer || '', error: null };
  } catch (e) {
    return { success: false, results: [], answer: '', error: e.message };
  }
}

async function synthesize(topic, results, answer) {
  const parts = [];
  if (answer) parts.push(`Summary from web search:\n${answer}`);
  results.slice(0, 10).forEach((r, i) => {
    parts.push(`[Source ${i + 1}] ${r.title || ''}\nURL: ${r.url || ''}\n${(r.content || '').slice(0, 1000)}`);
  });
  const context = parts.join('\n\n---\n\n');

  const prompt = `Based on this web research about "${topic}", extract and structure the following.
Respond ONLY with valid JSON — no markdown, no code fences.

Research content:
${context}

Required JSON format:
{
  "insights": ["Specific insight 1 with concrete detail", "...up to 5..."],
  "stats": [{"value": "XX%", "context": "what this number means", "source": "source name or URL"}],
  "quotes": [{"text": "meaningful quote or key finding", "attribution": "Source or person"}],
  "time_series": [{"year": 2004, "value": 0.0, "unit": "% or thousands", "label": "what is being measured"}],
  "summary": "2-3 sentence overview of the topic landscape right now, based on the research"
}

IMPORTANT for time_series:
- Look hard for any year-by-year, decade-by-decade, or before/after data points in the research
- Include every distinct year/period that has a concrete number attached to it
- If no time-series data exists at all, return an empty array []
- Never invent numbers — only include data clearly stated in the sources
- time_series is the most valuable field for creating meaningful charts

Use specific numbers, names, and facts from the research. Omit any stat or quote not clearly supported by the sources.`;

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const resp = await client.chat.completions.create({
    model: SYNTH_MODEL,
    messages: [
      { role: 'system', content: 'You extract and structure research findings. Respond only with valid JSON.' },
      { role: 'user', content: prompt }
    ],
    max_tokens: 1500,
    temperature: 0.1
  });

  let raw = (resp.choices[0].message.content || '').trim();
  if (raw.startsWith('```')) raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  // safety net: slice to the outermost JSON object
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start !== -1 && end !== -1) raw = raw.slice(start, end + 1);
  return JSON.parse(raw);
}

/**
 * Research a topic. Returns { success, data, error } where data carries the same
 * shape as the Python research_topic.py payload.
 */
export async function researchTopic(topic, { slug = null } = {}) {
  const main = await searchTavily(topic, 7);
  const results = main.success ? [...main.results] : [];
  const answer = main.success ? main.answer : '';
  if (!main.success) console.warn(`[research] Tavily main search failed: ${main.error} — proceeding with no live web data`);

  // Second pass targeting historical / time-series data (PT-leaning, matches Python).
  const hist = await searchTavily(`${topic} dados históricos percentual evolução por ano série temporal`, 5);
  if (hist.success) {
    const seen = new Set(results.map(r => r.url));
    for (const r of hist.results) if (!seen.has(r.url)) results.push(r);
  }

  const sources = results.map(r => r.url).filter(Boolean);

  let structured;
  try {
    structured = await synthesize(topic, results, answer);
  } catch (e) {
    return { success: false, data: null, error: `synthesis failed: ${e.message}` };
  }

  const data = {
    topic,
    slug: slug || slugify(topic),
    generated_at: new Date().toISOString(),
    sources,
    insights: structured.insights || [],
    stats: structured.stats || [],
    quotes: structured.quotes || [],
    time_series: structured.time_series || [],
    summary: structured.summary || ''
  };
  return { success: true, data, error: null };
}

/* ── CLI ─────────────────────────────────────────────────── */

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = process.argv.slice(2);
  const slugIdx = args.indexOf('--slug');
  const slug = slugIdx !== -1 ? args[slugIdx + 1] : null;
  const topic = args.filter((a, i) => a !== '--slug' && args[i - 1] !== '--slug').join(' ').trim();
  if (!topic) { console.error('Usage: node research.mjs "<topic>" [--slug <slug>]'); process.exit(1); }

  const outcome = await researchTopic(topic, { slug });
  console.log(JSON.stringify(outcome, null, 2));
  process.exit(outcome.success ? 0 : 1);
}
