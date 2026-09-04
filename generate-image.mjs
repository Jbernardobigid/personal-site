/**
 * generate-image.mjs
 * Shared image generation module used by generate-post.mjs and post-to-linkedin.mjs.
 *
 * Builds a content-aware editorial image prompt in three layers:
 *   1. PILLAR_VISUALS  - a distinct visual language per pillar (medium, light, palette,
 *                        lens, composition). These are deliberately NOT variations of one
 *                        recipe: different times of day, different distances, different
 *                        palettes, and three of the seven do not show a full face.
 *   2. TREATMENTS      - a framing variation chosen deterministically from the post slug,
 *                        so two posts in the SAME pillar still differ in form.
 *   3. the derived scene - Claude reads the post's title + excerpt and returns one
 *                        concrete, photographable scene specific to that post.
 *
 * Before 2026-09, step 3 did not exist and step 1 was seven near-identical
 * "warm golden hour / cinematic quality" strings keyed only on pillar id. Fifty posts
 * shared seven prompts, five of which produced the same picture, which is why the blog
 * and the newsletter that reuses its OG image both looked like one recycled image.
 */

import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

// INVARIANT: any human depicted in a generated image must be a Black Brazilian person.
// Image models default to white subjects when ethnicity is unspecified, so every
// people-bearing prompt states it explicitly. Frames with no people are fine and welcome
// (two treatments below are deliberately people-free); the rule binds only when a
// person appears.
const PEOPLE_INVARIANT =
  'Any person visible in the frame must be a Black Brazilian person with rich, beautifully lit skin tones.';

const NO_TEXT = 'No text, no letters, no numbers, no logos, no watermarks anywhere in the image.';

/**
 * One visual language per pillar. Each fixes a medium, a light source, a palette drawn
 * from the "Futuro Preto" brand colours, a lens and a distance - the things that make two
 * photographs look like different photographs.
 */
export const PILLAR_VISUALS = {
  'black-identity': {
    look: 'High-contrast studio portraiture on medium format. A single hard key light from one side, deep pure-black background, sculptural shadow across the frame. Palette: black and cool neutral grey with one warm terracotta accent. 85mm lens, tight crop, skin texture and detail preserved.',
    subject: 'a Black Brazilian person photographed with the gravity of a museum portrait'
  },
  'cycling': {
    look: 'Documentary street reportage on a 28mm lens, shot from low down at road level. Flat overcast daylight, no sun flare, slight motion blur in the background. Palette: desaturated slate, dark green and wet asphalt grey. The grain of pushed colour negative film.',
    subject: 'cyclists and the ordinary Brazilian street they move through'
  },
  'technology': {
    look: 'Cold still-life photography on a macro lens. Physical objects on a seamless dark surface lit by the blue glow of a screen just out of frame, long exposure, precise geometry, hard edges. Palette: deep night blue, black, and a single pale cyan highlight. No people at all.',
    subject: 'the physical objects through which a system touches a person: cables, card readers, terminals, sensors, server light'
  },
  'entrepreneurship': {
    look: 'Environmental portraiture on a 50mm lens in a real workplace. Broad soft mid-morning light through a large window, the room visible and lived-in around the subject. Palette: terracotta, warm putty neutral, aged wood. Medium-wide with generous negative space on one side.',
    subject: 'a Black Brazilian person inside the small business or workshop they actually run'
  },
  'fatherhood': {
    look: 'Intimate domestic photography on 35mm film with visible grain. Soft indoor window light, shallow focus, hands and gestures rather than posed faces, slight overexposure in the highlights. Palette: muted warm neutral, faded brick, soft white.',
    subject: 'the small unposed gestures between a Black Brazilian parent and child'
  },
  'learning': {
    look: 'Overhead flat-lay still life on a tripod, shot straight down. One warm desk lamp as the only light source, deep pooled shadow at the edges, objects arranged with deliberate asymmetry. Palette: dark green, ink black, paper neutral. No face in frame.',
    subject: 'the physical residue of study: annotated pages, a cold cup, a worn notebook, a hand at the edge of frame'
  },
  'career-growth': {
    look: 'Wide architectural photography at blue hour on a 24mm tilt-shift lens. Cool ambient dusk light with warm interior windows glowing, the human figure small within a large built frame, strict verticals. Palette: night blue, concrete grey, distant terracotta window light.',
    subject: 'one person at human scale inside Brazilian architecture much larger than they are'
  }
};

/**
 * Framing variations. Picked deterministically from the post slug so the choice is stable
 * for a given post but differs across posts within one pillar. Two of the five remove
 * people from the frame entirely, which is the strongest available diversity lever.
 */
const TREATMENTS = [
  'Composition: tight close crop with shallow depth of field, the subject filling most of the frame.',
  'Composition: wide establishing frame, the subject small and off-centre, generous empty space carrying the mood.',
  'Composition: shot from behind or over the shoulder, the environment dominant and the face unseen.',
  'Composition: still life with no people in frame at all, objects alone carrying the story.',
  'Composition: a reflection, a silhouette or a cast shadow is the primary subject rather than the thing itself.'
];

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function pickTreatment(seed) {
  if (!seed) return TREATMENTS[0];
  return TREATMENTS[hashString(seed) % TREATMENTS.length];
}

/**
 * Ask Claude for ONE concrete, photographable scene rooted in this specific post.
 * Best-effort: any failure returns null and the caller falls back to the pillar's
 * generic subject, which is still better than the old fixed string.
 */
async function deriveScene({ title, excerpt, pillarId, apiKey }) {
  if (!apiKey || !title) return null;
  const visual = PILLAR_VISUALS[pillarId] || PILLAR_VISUALS['technology'];
  try {
    const client = new Anthropic({ apiKey });
    const res = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      tools: [{
        name: 'describe_scene',
        description: 'Describe one concrete photographable scene for this article.',
        input_schema: {
          type: 'object',
          properties: {
            scene: {
              type: 'string',
              description:
                'ONE sentence in English describing a single concrete, physically photographable scene that carries this article idea. Name real objects, a place, an action and a moment. It must be specific to THIS article, not a generic illustration of the topic. Do not mention text, signs, writing, charts, logos or brands. Do not describe emotions or abstractions, only what a camera would see.'
            }
          },
          required: ['scene']
        }
      }],
      tool_choice: { type: 'tool', name: 'describe_scene' },
      messages: [{
        role: 'user',
        content: `Article title (Brazilian Portuguese): ${title}
${excerpt ? `Summary: ${excerpt}\n` : ''}
The photograph accompanying it is in this register: ${visual.look}
It usually shows: ${visual.subject}

Give one concrete scene for THIS article, set in Brazil. Avoid the obvious stock illustration of the topic; pick a specific detail or moment that a photo editor would find surprising but apt.`
      }]
    });
    const tool = res.content.find(b => b.type === 'tool_use');
    const scene = tool?.input?.scene;
    return typeof scene === 'string' && scene.trim() ? scene.trim() : null;
  } catch (e) {
    console.warn(`  ! scene derivation failed (${e.message}) - using the pillar generic subject`);
    return null;
  }
}

/** Assemble the final image prompt from the three layers. Exported for inspection/testing. */
export function buildImagePrompt({ pillarId, scene, seed }) {
  const visual = PILLAR_VISUALS[pillarId] || PILLAR_VISUALS['technology'];
  return [
    `Editorial photograph for a magazine feature. ${visual.look}`,
    pickTreatment(seed),
    `Subject: ${scene || visual.subject}.`,
    PEOPLE_INVARIANT,
    NO_TEXT
  ].join(' ');
}

/**
 * @param {string} pillarId
 * @param {string} apiKey            OpenAI key (image generation)
 * @param {object} [opts]
 * @param {string} [opts.title]      post title - drives the derived scene
 * @param {string} [opts.excerpt]    post excerpt
 * @param {string} [opts.seed]       stable seed (slug) for the framing variation
 * @param {string} [opts.anthropicApiKey] defaults to process.env.ANTHROPIC_API_KEY
 */
export async function generatePostImage(pillarId, apiKey, opts = {}) {
  const { title, excerpt, seed, anthropicApiKey = process.env.ANTHROPIC_API_KEY } = opts;

  const scene = await deriveScene({ title, excerpt, pillarId, apiKey: anthropicApiKey });
  const prompt = buildImagePrompt({ pillarId, scene, seed: seed || title });

  console.log(`Generating image for pillar: ${pillarId}${scene ? ' (scene derived from post)' : ' (generic pillar subject)'}...`);

  const openai = new OpenAI({ apiKey });
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

// Back-compat: the old flat map of pillar id -> prompt string, now derived from
// PILLAR_VISUALS so there is a single source of truth.
export const IMAGE_PROMPTS = Object.fromEntries(
  Object.keys(PILLAR_VISUALS).map(id => [id, buildImagePrompt({ pillarId: id })])
);
