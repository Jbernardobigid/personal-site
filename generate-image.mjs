/**
 * generate-image.mjs
 * Shared image generation module used by generate-post.mjs and post-to-linkedin.mjs.
 * Generates a pillar-themed editorial image via gpt-image-2.
 */

import OpenAI from 'openai';

export const IMAGE_PROMPTS = {
  'data-security':    'Editorial abstract photograph, glowing encrypted data streams and floating network nodes in deep dark space, deep amber and indigo tones, cinematic dramatic lighting, ultra-sharp, professional magazine cover aesthetic, no text, no people, no letters',
  'entrepreneurship': 'Editorial photograph, confident Black Brazilian professional in modern urban setting, warm golden hour light casting long shadows, São Paulo contemporary architecture in background, sophisticated and purposeful composition, no text, cinematic quality',
  'cycling':          'Editorial sports photograph, Black cyclist riding powerfully through urban streets at dawn, motion blur on background with subject sharp, warm amber sunrise light, determination and grace, no text, cinematic sports magazine quality',
  'brand':            'Editorial abstract, bold graphic identity system with color palettes and geometric forms arranged in dark space, warm terra cotta and black tones, sophisticated modernist composition, no text on elements, cinematic studio lighting',
  'wellness':         'Editorial photograph, lone athlete in focused stillness in minimalist dark environment, single warm amber spotlight, sense of discipline and inner power, clean architectural background, no text, cinematic wellness magazine quality'
};

export async function generatePostImage(pillarId, apiKey) {
  const openai = new OpenAI({ apiKey });
  const prompt  = IMAGE_PROMPTS[pillarId] ?? IMAGE_PROMPTS['brand'];

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
