/**
 * post-to-linkedin.mjs
 * Reads post-meta.json written by generate-post.mjs, uses the pre-generated
 * OG image (falling back to generating a fresh one), and publishes to LinkedIn.
 *
 * Requires:
 *   LINKEDIN_ACCESS_TOKEN — OAuth 2.0 member token with w_member_social + openid + profile
 * Optional:
 *   OPENAI_API_KEY        — only needed if no pre-generated image is found
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { generatePostImage } from './generate-image.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LINKEDIN_ACCESS_TOKEN = process.env.LINKEDIN_ACCESS_TOKEN;

if (!LINKEDIN_ACCESS_TOKEN) { console.error('Error: LINKEDIN_ACCESS_TOKEN is not set.'); process.exit(1); }

// Owned-list funnel: the feed post keeps its single "read the article" CTA;
// the newsletter ask rides along as the first comment so it doesn't cannibalize click-through.
// Public subscribe link is the brand domain, NOT the SITE_URL preview the pipeline may use.
const NEWSLETTER_URL = (process.env.NEWSLETTER_URL || 'https://jorgebernardo.tech/#newsletter');
const NEWSLETTER_CTA = `📩 Gostou? Assine A Interseção e receba os próximos artigos direto no seu email, sem algoritmo no meio: ${NEWSLETTER_URL}`;

const HASHTAGS = {
  'black-identity':   '#IdentidadeNegra #OrgulhoNegro #Representatividade #BlackExcellence',
  'cycling':          '#Ciclismo #DePretoPraPreto #CiclistaNegro #Bicicleta',
  'technology':       '#Tecnologia #IA #SegurançaDeDados #GovernançaDeIA #Inovação',
  'entrepreneurship': '#Empreendedorismo #NegóciosPretos #ImpactoSocial #FeiraPreta',
  'fatherhood':       '#Paternidade #PaiPresente #Família #Legado',
  'learning':         '#Aprendizado #EducaçãoContinuada #Crescimento #Educação',
  'career-growth':    '#Carreira #CrescimentoProfissional #Reinvenção #Desenvolvimento'
};

async function getImageBuffer(imagePath, pillarId) {
  if (imagePath && fs.existsSync(imagePath)) {
    console.log('Using pre-generated OG image.');
    return fs.readFileSync(imagePath);
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('No pre-generated image found and OPENAI_API_KEY is not set.');
  return generatePostImage(pillarId, apiKey);
}

async function getMemberUrn() {
  const res = await fetch('https://api.linkedin.com/v2/userinfo', {
    headers: { Authorization: `Bearer ${LINKEDIN_ACCESS_TOKEN}` }
  });
  if (!res.ok) throw new Error(`LinkedIn userinfo failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return `urn:li:person:${data.sub}`;
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
  return data.id; // post URN, e.g. urn:li:share:... or urn:li:ugcPost:...
}

// Posts the newsletter CTA as the first comment on the just-published share.
// Best-effort: the post already succeeded, so a comment failure must not fail the run.
async function postNewsletterComment(personUrn, postUrn) {
  const res = await fetch(`https://api.linkedin.com/v2/socialActions/${encodeURIComponent(postUrn)}/comments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${LINKEDIN_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'X-Restli-Protocol-Version': '2.0.0'
    },
    body: JSON.stringify({
      actor: personUrn,
      object: postUrn,
      message: { text: NEWSLETTER_CTA }
    })
  });
  if (!res.ok) {
    console.warn(`Newsletter CTA comment failed (post still published): ${res.status} ${await res.text()}`);
    return;
  }
  console.log('Newsletter CTA posted as first comment.');
}

async function main() {
  const metaPath = path.join(__dirname, 'post-meta.json');
  if (!fs.existsSync(metaPath)) {
    console.error('Error: post-meta.json not found. Run generate-post.mjs first.');
    process.exit(1);
  }

  const { title, excerpt, pillarId, postUrl, imagePath } = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  console.log(`Posting to LinkedIn: "${title}"`);

  const IMAGES_DIR = path.resolve(__dirname, 'blog', 'posts', 'images');
  if (imagePath && !path.resolve(imagePath).startsWith(IMAGES_DIR + path.sep)) {
    throw new Error(`imagePath outside allowed directory: ${imagePath}`);
  }

  const personUrn   = await getMemberUrn();
  console.log('Member URN resolved.');

  const imageBuffer = await getImageBuffer(imagePath, pillarId);
  const { uploadUrl, assetUrn } = await registerUpload(personUrn);
  await uploadImage(uploadUrl, imageBuffer);
  const postUrn = await createPost({ personUrn, assetUrn, title, excerpt, pillarId, postUrl });
  await postNewsletterComment(personUrn, postUrn);

  fs.unlinkSync(metaPath);
  console.log('Done.');
}

main().catch(err => { console.error(err); process.exit(1); });
