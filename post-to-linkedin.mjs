/**
 * post-to-linkedin.mjs
 * Reads post-meta.json written by generate-post.mjs, generates a DALL-E 3 image,
 * uploads it to LinkedIn, and publishes the post.
 *
 * Requires:
 *   LINKEDIN_ACCESS_TOKEN — OAuth 2.0 member token with w_member_social + openid + profile
 *   OPENAI_API_KEY        — for DALL-E 3 image generation
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LINKEDIN_ACCESS_TOKEN = process.env.LINKEDIN_ACCESS_TOKEN;
const OPENAI_API_KEY        = process.env.OPENAI_API_KEY;

if (!LINKEDIN_ACCESS_TOKEN) { console.error('Error: LINKEDIN_ACCESS_TOKEN is not set.'); process.exit(1); }
if (!OPENAI_API_KEY)        { console.error('Error: OPENAI_API_KEY is not set.');        process.exit(1); }

const IMAGE_PROMPTS = {
  'data-security':    'Editorial abstract photograph, glowing encrypted data streams and floating network nodes in deep dark space, deep amber and indigo tones, cinematic dramatic lighting, ultra-sharp, professional magazine cover aesthetic, no text, no people, no letters',
  'entrepreneurship': 'Editorial photograph, confident Black Brazilian professional in modern urban setting, warm golden hour light casting long shadows, São Paulo contemporary architecture in background, sophisticated and purposeful composition, no text, cinematic quality',
  'cycling':          'Editorial sports photograph, Black cyclist riding powerfully through urban streets at dawn, motion blur on background with subject sharp, warm amber sunrise light, determination and grace, no text, cinematic sports magazine quality',
  'brand':            'Editorial abstract, bold graphic identity system with color palettes and geometric forms arranged in dark space, warm terra cotta and black tones, sophisticated modernist composition, no text on elements, cinematic studio lighting',
  'wellness':         'Editorial photograph, lone athlete in focused stillness in minimalist dark environment, single warm amber spotlight, sense of discipline and inner power, clean architectural background, no text, cinematic wellness magazine quality'
};

const HASHTAGS = {
  'data-security':    '#SegurançaDeDados #Privacidade #LGPD #GovernançaDeDados #IA',
  'entrepreneurship': '#Empreendedorismo #NegóciosPretros #ImpactoSocial #FeiraPreta',
  'cycling':          '#Ciclismo #DePretoPraPreto #CiclistaNegro #Bicicleta',
  'brand':            '#Marca #Branding #Design #Estratégia #IdentidadeDeMarca',
  'wellness':         '#Wellness #Desempenho #SaúdeMental #Atleta #afterALL'
};

async function getMemberUrn() {
  const res = await fetch('https://api.linkedin.com/v2/userinfo', {
    headers: { Authorization: `Bearer ${LINKEDIN_ACCESS_TOKEN}` }
  });
  if (!res.ok) throw new Error(`LinkedIn userinfo failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return `urn:li:person:${data.sub}`;
}

async function generateImage(pillarId) {
  const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
  const prompt  = IMAGE_PROMPTS[pillarId] ?? IMAGE_PROMPTS['brand'];

  console.log('Generating DALL-E 3 image...');
  const response = await openai.images.generate({
    model: 'gpt-image-2',
    prompt,
    n: 1,
    size: '1536x1024',
    quality: 'medium'
  });

  const item = response.data[0];
  if (item.b64_json) {
    console.log('Image generated (base64).');
    return Buffer.from(item.b64_json, 'base64');
  }
  console.log('Image generated — downloading...');
  const imgRes = await fetch(item.url);
  if (!imgRes.ok) throw new Error(`Image download failed: ${imgRes.status}`);
  return Buffer.from(await imgRes.arrayBuffer());
}

async function registerUpload(personUrn) {
  const res = await fetch('https://api.linkedin.com/v2/assets?action=registerUpload', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${LINKEDIN_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'X-Restli-Protocol-Version': '2.0.0'
    },
    body: JSON.stringify({
      registerUploadRequest: {
        recipes: ['urn:li:digitalmediaRecipe:feedshare-image'],
        owner: personUrn,
        serviceRelationships: [{ relationshipType: 'OWNER', identifier: 'urn:li:userGeneratedContent' }]
      }
    })
  });
  if (!res.ok) throw new Error(`Register upload failed: ${res.status} ${await res.text()}`);
  const data     = await res.json();
  const uploadUrl = data.value.uploadMechanism['com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest'].uploadUrl;
  const assetUrn  = data.value.asset;
  return { uploadUrl, assetUrn };
}

async function uploadImage(uploadUrl, imageBuffer) {
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${LINKEDIN_ACCESS_TOKEN}`,
      'Content-Type': 'application/octet-stream'
    },
    body: imageBuffer
  });
  if (!res.ok) throw new Error(`Image upload failed: ${res.status} ${await res.text()}`);
  console.log('Image uploaded to LinkedIn.');
}

async function createPost({ personUrn, assetUrn, title, excerpt, pillarId, postUrl }) {
  const hashtags   = HASHTAGS[pillarId] ?? '';
  const commentary = `${title}\n\n${excerpt}\n\nLeia o artigo completo 👇\n${postUrl}\n\n${hashtags}`;

  const res = await fetch('https://api.linkedin.com/v2/ugcPosts', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${LINKEDIN_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'X-Restli-Protocol-Version': '2.0.0'
    },
    body: JSON.stringify({
      author: personUrn,
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: { text: commentary },
          shareMediaCategory: 'IMAGE',
          media: [{
            status: 'READY',
            description: { text: excerpt },
            media: assetUrn,
            title: { text: title }
          }]
        }
      },
      visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' }
    })
  });

  if (!res.ok) throw new Error(`Create post failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  console.log(`LinkedIn post published: ${data.id}`);
}

async function main() {
  const metaPath = path.join(__dirname, 'post-meta.json');
  if (!fs.existsSync(metaPath)) {
    console.error('Error: post-meta.json not found. Run generate-post.mjs first.');
    process.exit(1);
  }

  const { title, excerpt, pillarId, postUrl } = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  console.log(`Posting to LinkedIn: "${title}"`);

  const personUrn   = await getMemberUrn();
  console.log(`Member URN resolved.`);

  const imageBuffer = await generateImage(pillarId);
  const { uploadUrl, assetUrn } = await registerUpload(personUrn);
  await uploadImage(uploadUrl, imageBuffer);
  await createPost({ personUrn, assetUrn, title, excerpt, pillarId, postUrl });

  fs.unlinkSync(metaPath);
  console.log('Done.');
}

main().catch(err => { console.error(err); process.exit(1); });
