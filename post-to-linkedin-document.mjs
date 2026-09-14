/**
 * post-to-linkedin-document.mjs
 * Publishes a text post with a PDF document attached (LinkedIn renders it as a
 * swipeable carousel in the feed). Complements post-to-linkedin.mjs, which is
 * blog-specific and image-only.
 *
 * Two upload paths, tried in order:
 *   1. Legacy v2 assets + ugcPosts. Same path the image poster already uses, and
 *      its commentary field takes raw text with no escaping.
 *   2. Versioned REST (/rest/documents + /rest/posts) when the app has lost the
 *      legacy document recipe. Its commentary field needs characters escaped.
 *
 * Requires:
 *   LINKEDIN_ACCESS_TOKEN - member token with w_member_social + openid + profile
 *
 * Usage:
 *   node post-to-linkedin-document.mjs --pdf <path> --caption <path> --title "..."
 *   node post-to-linkedin-document.mjs ... --dry-run
 */

import './load-env.mjs';
import fs from 'fs';
import path from 'path';

const LINKEDIN_ACCESS_TOKEN = process.env.LINKEDIN_ACCESS_TOKEN;
// LinkedIn retires versioned-API months on a rolling window and answers a stale
// one with 426 NONEXISTENT_VERSION. Probe with GET /rest/me when this goes cold:
// a 403 means the version is live, a 426 means it is not.
const LINKEDIN_VERSION = process.env.LINKEDIN_API_VERSION || '202608';

// LinkedIn rejects commentary over 3000 characters outright.
const MAX_COMMENTARY = 3000;
// LinkedIn caps feed documents at 100 MB.
const MAX_PDF_BYTES = 100 * 1024 * 1024;

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--dry-run') { args.dryRun = true; continue; }
    const value = argv[i + 1];
    if (flag === '--pdf') { args.pdf = value; i++; }
    else if (flag === '--caption') { args.caption = value; i++; }
    else if (flag === '--title') { args.title = value; i++; }
  }
  return args;
}

/**
 * The voice rules in generate-post.mjs treat the em dash as the primary AI tell
 * and ban it outright. A hand-written caption skips sanitizeEmDashes, so check
 * here rather than trust the author.
 */
function assertNoEmDashes(text) {
  const offenders = [...text.matchAll(/[–—]/g)];
  if (offenders.length) {
    throw new Error(`Caption contains ${offenders.length} em/en dash(es), which the voice rules ban. Rewrite with commas.`);
  }
}

function readCaption(captionPath) {
  if (!fs.existsSync(captionPath)) throw new Error(`Caption file not found: ${captionPath}`);
  const text = fs.readFileSync(captionPath, 'utf8').trim();
  if (!text) throw new Error('Caption file is empty.');
  assertNoEmDashes(text);
  if (text.length > MAX_COMMENTARY) {
    throw new Error(`Caption is ${text.length} characters, over the LinkedIn limit of ${MAX_COMMENTARY}.`);
  }
  return text;
}

function readPdf(pdfPath) {
  if (!fs.existsSync(pdfPath)) throw new Error(`PDF not found: ${pdfPath}`);
  const buffer = fs.readFileSync(pdfPath);
  if (buffer.length > MAX_PDF_BYTES) {
    throw new Error(`PDF is ${buffer.length} bytes, over the LinkedIn document limit of 100 MB.`);
  }
  if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new Error(`File is not a PDF (missing %PDF- header): ${pdfPath}`);
  }
  return buffer;
}

function authHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${LINKEDIN_ACCESS_TOKEN}`,
    'X-Restli-Protocol-Version': '2.0.0',
    ...extra
  };
}

async function getMemberUrn() {
  const res = await fetch('https://api.linkedin.com/v2/userinfo', {
    headers: { Authorization: `Bearer ${LINKEDIN_ACCESS_TOKEN}` }
  });
  if (!res.ok) throw new Error(`LinkedIn userinfo failed: ${res.status} ${await res.text()}`);
  return `urn:li:person:${(await res.json()).sub}`;
}

async function putBinary(uploadUrl, buffer, label) {
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: authHeaders({ 'Content-Type': 'application/octet-stream' }),
    body: buffer
  });
  if (!res.ok) throw new Error(`${label} upload failed: ${res.status} ${await res.text()}`);
}

/* ── Path 1: legacy v2 assets + ugcPosts ─────────────────── */

async function publishLegacy({ personUrn, pdfBuffer, commentary, title }) {
  const registerRes = await fetch('https://api.linkedin.com/v2/assets?action=registerUpload', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      registerUploadRequest: {
        recipes: ['urn:li:digitalmediaRecipe:feedshare-document'],
        owner: personUrn,
        serviceRelationships: [{ relationshipType: 'OWNER', identifier: 'urn:li:userGeneratedContent' }]
      }
    })
  });
  if (!registerRes.ok) {
    throw new Error(`legacy registerUpload failed: ${registerRes.status} ${await registerRes.text()}`);
  }

  const registered = await registerRes.json();
  const uploadUrl = registered.value.uploadMechanism['com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest'].uploadUrl;
  const assetUrn = registered.value.asset;
  await putBinary(uploadUrl, pdfBuffer, 'Document');
  console.log('Document uploaded (legacy assets API).');

  const postRes = await fetch('https://api.linkedin.com/v2/ugcPosts', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      author: personUrn,
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: { text: commentary },
          shareMediaCategory: 'DOCUMENT',
          media: [{ status: 'READY', media: assetUrn, title: { text: title } }]
        }
      },
      visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' }
    })
  });
  if (!postRes.ok) throw new Error(`legacy ugcPosts failed: ${postRes.status} ${await postRes.text()}`);
  return postRes.headers.get('x-restli-id') || (await postRes.json()).id;
}

/* ── Path 2: versioned REST documents + posts ────────────── */

// The Posts API parses commentary as "little text", where these characters carry
// markup meaning and must be backslash-escaped to render literally. '#' is left
// alone on purpose so hashtags still resolve.
function escapeLittleText(text) {
  return text.replace(/[\\|{}@[\]()<>*_~]/g, (ch) => `\\${ch}`);
}

async function publishVersioned({ personUrn, pdfBuffer, commentary, title }) {
  const versionHeaders = authHeaders({
    'Content-Type': 'application/json',
    'LinkedIn-Version': LINKEDIN_VERSION
  });

  const initRes = await fetch('https://api.linkedin.com/rest/documents?action=initializeUpload', {
    method: 'POST',
    headers: versionHeaders,
    body: JSON.stringify({ initializeUploadRequest: { owner: personUrn } })
  });
  if (!initRes.ok) throw new Error(`documents initializeUpload failed: ${initRes.status} ${await initRes.text()}`);

  const { value } = await initRes.json();
  await putBinary(value.uploadUrl, pdfBuffer, 'Document');
  console.log('Document uploaded (versioned REST API).');

  const postRes = await fetch('https://api.linkedin.com/rest/posts', {
    method: 'POST',
    headers: versionHeaders,
    body: JSON.stringify({
      author: personUrn,
      commentary: escapeLittleText(commentary),
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      content: { media: { title, id: value.document } },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false
    })
  });
  if (!postRes.ok) throw new Error(`rest/posts failed: ${postRes.status} ${await postRes.text()}`);
  return postRes.headers.get('x-restli-id');
}

async function main() {
  if (!LINKEDIN_ACCESS_TOKEN) {
    console.error('Error: LINKEDIN_ACCESS_TOKEN is not set.');
    process.exit(1);
  }

  const args = parseArgs(process.argv.slice(2));
  if (!args.pdf || !args.caption) {
    console.error('Usage: node post-to-linkedin-document.mjs --pdf <path> --caption <path> [--title "..."] [--dry-run]');
    process.exit(1);
  }

  const title = args.title || path.basename(args.pdf, path.extname(args.pdf));
  const commentary = readCaption(args.caption);
  const pdfBuffer = readPdf(args.pdf);

  console.log(`Document : ${args.pdf} (${(pdfBuffer.length / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`Title    : ${title}`);
  console.log(`Caption  : ${commentary.length} characters, no em dashes`);

  if (args.dryRun) {
    console.log('\n--- commentary as it will post ---\n');
    console.log(commentary);
    console.log('\n--- dry run, nothing published ---');
    return;
  }

  const personUrn = await getMemberUrn();
  console.log('Member URN resolved.');

  let postId;
  try {
    postId = await publishLegacy({ personUrn, pdfBuffer, commentary, title });
  } catch (err) {
    // The legacy document recipe is withdrawn for newer apps. Fall back rather
    // than fail, but say why, so a real auth problem is not mistaken for it.
    console.warn(`Legacy path unavailable, falling back to versioned REST.\n  reason: ${err.message}`);
    postId = await publishVersioned({ personUrn, pdfBuffer, commentary, title });
  }

  console.log(`\nLinkedIn post published: ${postId}`);
}

main().catch((err) => { console.error(err.message || err); process.exit(1); });
