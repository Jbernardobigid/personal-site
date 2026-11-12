/**
 * claude-models.mjs
 * The Claude models every content script uses, plus the two call shapes they share.
 * Change a model here, not in the scripts.
 *
 *   WRITER_MODEL   publishable copy (blog, Reels, carousels, podcast) and the dev-time
 *                  template tools. Chosen 2026-11-12 from the Arena creative-writing
 *                  board (https://arena.ai/leaderboard/text/creative-writing), where
 *                  Opus 5.5 ranked #2 vs #42 for the Sonnet 4.6 it replaced.
 *   UTILITY_MODEL  short, cheap, non-published calls (image brief, research query,
 *                  safety screen, simulator fallback).
 *
 * Opus 5.5 differences the helpers absorb:
 *   - Thinking is always on and counts toward max_tokens, so responses can open with
 *     (empty) thinking blocks: read text via responseText(), never content[0].
 *   - A forced tool_choice returns 400, so structured data comes back as
 *     schema-constrained JSON (writeJson) instead of a forced tool call.
 *   - Default effort is `medium`; callers pass it explicitly.
 *   - `fallbacks: 'default'` re-runs a request a safety classifier declines on a
 *     fallback model inside the same call.
 * SDK 0.39 has no types for output_config/fallbacks; plain JS forwards them unchanged.
 */

export const WRITER_MODEL = 'claude-opus-5-5';
export const UTILITY_MODEL = 'claude-haiku-5-5';

// SDK 0.39 refuses a non-streaming request whose max_tokens implies more than
// ten minutes (~21k tokens). 16k leaves room for thinking plus a long answer.
export const WRITER_MAX_TOKENS = 16000;

const FALLBACK_HEADERS = { headers: { 'anthropic-beta': 'server-side-fallback-2026-07-01' } };

/** Concatenated text blocks of a response (skips thinking/fallback blocks). */
export function responseText(res) {
  return res.content.filter(b => b.type === 'text').map(b => b.text).join('');
}

function assertComplete(res, label) {
  if (res.stop_reason === 'refusal') {
    throw new Error(`${label}: Claude declined the request (category: ${res.stop_details?.category ?? 'unknown'})`);
  }
  if (res.stop_reason === 'max_tokens') {
    throw new Error(`${label}: hit max_tokens before finishing (output truncated)`);
  }
}

/**
 * Free-text call on the writer model. Returns { res, text } so callers that keep a
 * conversation going can append res.content (thinking blocks included) as history.
 */
export async function writeText(client, { label, effort = 'high', max_tokens = WRITER_MAX_TOKENS, ...params }) {
  const res = await client.messages.create(
    { model: WRITER_MODEL, max_tokens, fallbacks: 'default', output_config: { effort }, ...params },
    FALLBACK_HEADERS
  );
  assertComplete(res, label);
  return { res, text: responseText(res) };
}

/**
 * Structured-output call on the writer model: the reply is JSON matching `schema`
 * (every object in it needs additionalProperties: false). Returns the parsed object.
 */
export async function writeJson(client, { label, schema, effort = 'high', max_tokens = WRITER_MAX_TOKENS, ...params }) {
  const res = await client.messages.create(
    {
      model: WRITER_MODEL,
      max_tokens,
      fallbacks: 'default',
      output_config: { effort, format: { type: 'json_schema', schema } },
      ...params
    },
    FALLBACK_HEADERS
  );
  assertComplete(res, label);
  try {
    return JSON.parse(responseText(res));
  } catch (e) {
    throw new Error(`${label}: Claude did not return valid JSON (${e.message})`);
  }
}
