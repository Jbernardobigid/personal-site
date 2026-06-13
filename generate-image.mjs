/**
 * generate-image.mjs
 * Shared image generation module used by generate-post.mjs and post-to-linkedin.mjs.
 * Generates a pillar-themed editorial image via gpt-image-2.
 */

import OpenAI from 'openai';

// INVARIANT: any human depicted in a generated image must be a Black Brazilian person.
// Image models default to white subjects when ethnicity is unspecified, so every
// people-bearing prompt states it explicitly. ('technology' intentionally has no people.)
export const IMAGE_PROMPTS = {
  'black-identity':   'Editorial portrait photograph, proud Black Brazilian man in a confident contemplative pose, warm amber and terra cotta lighting, rich skin tones beautifully lit, sophisticated dark background, sense of dignity strength and ancestry, no text, cinematic magazine cover quality',
  'cycling':          'Editorial sports photograph, Black cyclist riding powerfully through urban streets at dawn, motion blur on background with subject sharp, warm amber sunrise light, determination and grace, no text, cinematic sports magazine quality',
  'technology':       'Editorial abstract photograph, glowing AI neural networks and encrypted data streams floating in deep dark space, deep amber and indigo tones, cinematic dramatic lighting, ultra-sharp, professional tech magazine aesthetic, no text, no people, no letters',
  'entrepreneurship': 'Editorial photograph, confident Black Brazilian professional in modern urban setting, warm golden hour light casting long shadows, São Paulo contemporary architecture in background, sophisticated and purposeful composition, no text, cinematic quality',
  'fatherhood':       'Editorial photograph, Black Brazilian father and child sharing a warm tender moment, soft golden hour light, intimate and genuine, blurred warm background, sense of legacy and love, no text, cinematic quality',
  'learning':         'Editorial photograph, focused Black Brazilian man surrounded by books and a laptop in a warm-lit modern study at night, single amber desk lamp glow, sense of discipline and curiosity, sophisticated composition, no text, cinematic quality',
  'career-growth':    'Editorial photograph, confident Black Brazilian professional in his forties standing in modern São Paulo architecture, warm golden hour light, long shadows, sense of accomplishment and purpose, sophisticated composition, no text, cinematic quality'
};

export async function generatePostImage(pillarId, apiKey) {
  const openai = new OpenAI({ apiKey });
  const prompt  = IMAGE_PROMPTS[pillarId] ?? IMAGE_PROMPTS['technology'];

  console.log(`Generating image for pillar: ${pillarId}...`);
  const response = await openai.images.generate({
    model: 'gpt-image-2',
    prompt,
    n: 1,
    size: '1536x1024',
    quality: 'medium'
  });

  const item = response.data[0];
  if (item.b64_json) {
    return Buffer.from(item.b64_json, 'base64');
  }
  const imgRes = await fetch(item.url);
  if (!imgRes.ok) throw new Error(`Image download failed: ${imgRes.status}`);
  return Buffer.from(await imgRes.arrayBuffer());
}
