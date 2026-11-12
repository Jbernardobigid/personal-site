/**
 * image-model.mjs
 * The one OpenAI image model every generator uses (blog OG image, Reel b-roll stills,
 * relatórios artwork). Change it here when OpenAI deprecates the current one.
 *
 * gpt-image-2 was deprecated 2026-11-10 (removed from the API 2027-02-10); OpenAI's
 * replacement is gpt-image-2.6-sunburst (detailed work) or -flare (fast iteration).
 * See https://developers.openai.com/api/docs/deprecations
 */
export const OPENAI_IMAGE_MODEL = 'gpt-image-2.6-sunburst';
