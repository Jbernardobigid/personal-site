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
import Anthropic from '@anthropic-ai/sdk';

const TAVILY_URL = 'https://api.tavily.com/search';
const SYNTH_MODEL = 'gpt-4o-mini';                   // cheap + fast for JSON synthesis
const QUERY_MODEL = 'claude-haiku-4-5-20251001';     // cheap + fast for query derivation

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
  "stats": [{"value": "XX%", "context": "o que este número significa, em português do Brasil", "source": "publisher name or full URL — NEVER \"Source 1\" or \"Fonte 2\""}],
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

Use specific numbers, names, and facts from the research. Omit any stat or quote not clearly supported by the sources.

Write "context", "insights", "quotes" and "summary" in Brazilian Portuguese — they are handed to a pt-BR writer.
For every "source" field, give the publishing organisation or the full URL. The labels [Source 1], [Source 2] above are only positions in this prompt; echoing one back is useless to a reader and the stat will be discarded.`;

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
 * Turn a news signal into ONE focused, data-seeking search query.
 *
 * This is the Node counterpart of the newsletter's derive_research.py "chew" step, with
 * one difference: the newsletter derives its query from a FINISHED post, while the blog
 * derives it from the news item that will seed the post.
 *
 * Why it exists: the blog used to search Tavily for `"<headline>" <outlet> Brasil`, which
 * is a query for finding that article again, not for finding data. Appending the outlet
 * name actively steered results back to the outlet's own page. Measured across the 40
 * committed research artifacts, the headline query averaged 1.3 stats per file against
 * 3.1 for the newsletter's derived query, with identical search, truncation and synthesis
 * downstream. 52% of blog research files came back with zero stats and zero time-series.
 *
 * Best-effort: returns null on any failure, and the caller falls back to a plain query.
 */
export async function deriveResearchQuery({ title, summary = '', source = '', pillarLabel = '' } = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !title) return null;
  try {
    const client = new Anthropic({ apiKey });
    const res = await client.messages.create({
      model: QUERY_MODEL,
      max_tokens: 300,
      tools: [{
        name: 'derive_research',
        description: 'Return a focused web-research query to find real data around a news item.',
        input_schema: {
          type: 'object',
          properties: {
            research_query: {
              type: 'string',
              description:
                'ONE focused web search query likely to surface REAL data: statistics, studies, official reports, percentages, census or survey figures, historical or time-series numbers relevant to the ISSUE behind this news item. Target facts and numbers, not the article itself. Do NOT include the outlet name, and do NOT simply restate the headline. Write the query in Brazilian Portuguese and favour Brazilian sources (IBGE, IPEA, DIEESE, ministries, universities, Brazilian press) — the post is in pt-BR and cites sources its readers can open. Use English only when the subject is inherently international and no Brazilian data exists.'
            }
          },
          required: ['research_query']
        }
      }],
      tool_choice: { type: 'tool', name: 'derive_research' },
      messages: [{
        role: 'user',
        content: `A news item was chosen to seed a blog post${pillarLabel ? ` on "${pillarLabel}"` : ''}. Write the search query that will find the DATA behind the issue it raises, so the post can cite real numbers.

Headline: ${title}${source ? `\nOutlet: ${source}` : ''}${summary ? `\nSummary: ${summary}` : ''}

Think about what quantity a reader would want to know to judge this story, then write the query that finds it.`
      }]
    });
    const tool = res.content.find(b => b.type === 'tool_use');
    const q = tool?.input?.research_query;
    return typeof q === 'string' && q.trim() ? q.trim() : null;
  } catch (e) {
    console.warn(`[research] query derivation failed (${e.message}) — falling back to the headline`);
    return null;
  }
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

  // Deterministic backstop for placeholder attributions. The synthesis prompt labels each
  // source "[Source i]" (1-based, same order as `results`), and the model echoes that label
  // back into `stats[].source` about a third of the time. The post prompt requires every
  // number to be attributed, so "Source 1" reaches the writer as an uncitable stat and gets
  // dropped. Map the label back to the real URL rather than trusting the model to comply.
  const resolveSource = (value) => {
    const m = String(value || '').trim().match(/^(?:source|fonte)\s*(\d+)$/i);
    if (!m) return value;
    const r = results[Number(m[1]) - 1];
    return r?.url || r?.title || value;
  };
  for (const s of structured.stats || []) s.source = resolveSource(s.source);
  for (const q of structured.quotes || []) q.attribution = resolveSource(q.attribution);

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
