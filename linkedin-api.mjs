/**
 * linkedin-api.mjs
 * Minimal member-posting client for the LinkedIn series: text-only or single-image
 * posts plus a first comment. Uses the legacy v2 assets + ugcPosts path, which is the
 * one this app is proven to have for images (post-to-linkedin.mjs; documents are the
 * exception and need /rest, see post-to-linkedin-document.mjs).
 *
 * Requires LINKEDIN_ACCESS_TOKEN (w_member_social + openid + profile). Member tokens
 * last 60 days and this app has no refresh grant, so expiry is a manual re-auth.
 */

import './load-env.mjs';

export const MAX_COMMENTARY = 3000;

// Every call gets a deadline: a hung request would leave n8n waiting and the card parked.
const TIMEOUT_MS = 60000;

/** The post provably never reached LinkedIn: safe to retry on the next slot. */
export class PrePostError extends Error {}
/** Token missing or rejected (always before a post exists). */
export class LinkedInAuthError extends PrePostError {}

function token() {
  const t = process.env.LINKEDIN_ACCESS_TOKEN;
  if (!t) throw new LinkedInAuthError('LINKEDIN_ACCESS_TOKEN is not set');
  return t;
}

function headers(extra = {}) {
  return { Authorization: `Bearer ${token()}`, 'X-Restli-Protocol-Version': '2.0.0', ...extra };
}

async function check(res, label) {
  if (res.ok) return res;
  const body = await res.text().catch(() => '');
  if (res.status === 401) {
    throw new LinkedInAuthError(`${label}: LinkedIn token rejected (401). Re-authorise and update LINKEDIN_ACCESS_TOKEN in the VPS .env. ${body.slice(0, 200)}`);
  }
  // A 4xx is a definite refusal; a 5xx may or may not have been applied.
  const Err = res.status < 500 ? PrePostError : Error;
  throw new Err(`${label} failed: ${res.status} ${body.slice(0, 500)}`);
}

const timed = (init = {}) => ({ ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });

/** urn:li:person:<id>. Doubles as the token health check. */
export async function getMemberUrn() {
  const res = await check(await fetch('https://api.linkedin.com/v2/userinfo', timed({ headers: { Authorization: `Bearer ${token()}` } })), 'userinfo');
  return `urn:li:person:${(await res.json()).sub}`;
}

/** true / false / null (no token configured). Never throws. */
export async function tokenIsValid() {
  if (!process.env.LINKEDIN_ACCESS_TOKEN) return null;
  try { await getMemberUrn(); return true; } catch { return false; }
}

async function uploadImage(personUrn, imageBuffer) {
  const reg = await check(await fetch('https://api.linkedin.com/v2/assets?action=registerUpload', timed({
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      registerUploadRequest: {
        recipes: ['urn:li:digitalmediaRecipe:feedshare-image'],
        owner: personUrn,
        serviceRelationships: [{ relationshipType: 'OWNER', identifier: 'urn:li:userGeneratedContent' }]
      }
    })
  })), 'registerUpload');
  const data = await reg.json();
  const uploadUrl = data.value.uploadMechanism['com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest'].uploadUrl;
  await check(await fetch(uploadUrl, timed({
    method: 'PUT',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/octet-stream' },
    body: imageBuffer
  })), 'image upload');
  return data.value.asset;
}

/* ── Versioned REST (multi-image, document, video) ───────── */

// LinkedIn retires versioned-API months on a rolling window and answers a stale one
// with 426 NONEXISTENT_VERSION. Probe with GET /rest/me: 403 = live, 426 = retired.
// 202607..202611 all probed live on 2026-11-13.
const LINKEDIN_VERSION = process.env.LINKEDIN_API_VERSION || '202610';
const VIDEO_READY_TIMEOUT_MS = 10 * 60 * 1000;
const VIDEO_POLL_MS = 10000;

const restHeaders = () => headers({ 'Content-Type': 'application/json', 'LinkedIn-Version': LINKEDIN_VERSION });

/** The Posts API parses commentary as "little text"; these characters must be escaped
 *  to render literally. '#' stays bare so hashtags resolve. Exported for tests. */
export function escapeLittleText(text) {
  return text.replace(/[\\|{}@[\]()<>*_~]/g, (ch) => `\\${ch}`);
}

async function restInit(kind, request) {
  const res = await check(await fetch(`https://api.linkedin.com/rest/${kind}?action=initializeUpload`, timed({
    method: 'POST', headers: restHeaders(), body: JSON.stringify({ initializeUploadRequest: request })
  })), `${kind} initializeUpload`);
  return (await res.json()).value;
}

async function putBytes(url, buffer, label) {
  const res = await check(await fetch(url, timed({
    method: 'PUT', headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/octet-stream' }, body: buffer
  })), label);
  return res.headers.get('etag');
}

/** urn:li:image:... */
export async function uploadRestImage(personUrn, buffer) {
  const v = await restInit('images', { owner: personUrn });
  await putBytes(v.uploadUrl, buffer, 'image upload');
  return v.image;
}

/** urn:li:document:... */
export async function uploadRestDocument(personUrn, buffer) {
  const v = await restInit('documents', { owner: personUrn });
  await putBytes(v.uploadUrl, buffer, 'document upload');
  return v.document;
}

/** urn:li:video:..., uploaded in the parts LinkedIn asks for, finalized, then waited on
 *  until processing finishes (a post on an unprocessed video is rejected). */
export async function uploadRestVideo(personUrn, buffer) {
  const v = await restInit('videos', { owner: personUrn, fileSizeBytes: buffer.length, uploadCaptions: false, uploadThumbnail: false });
  const partIds = [];
  for (const part of v.uploadInstructions) {
    partIds.push(await putBytes(part.uploadUrl, buffer.subarray(part.firstByte, part.lastByte + 1), 'video part upload'));
  }
  await check(await fetch('https://api.linkedin.com/rest/videos?action=finalizeUpload', timed({
    method: 'POST', headers: restHeaders(),
    body: JSON.stringify({ finalizeUploadRequest: { video: v.video, uploadToken: v.uploadToken || '', uploadedPartIds: partIds } })
  })), 'video finalizeUpload');
  await waitForVideo(v.video);
  return v.video;
}

async function waitForVideo(videoUrn) {
  const deadline = Date.now() + VIDEO_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const res = await fetch(`https://api.linkedin.com/rest/videos/${encodeURIComponent(videoUrn)}`, timed({ headers: restHeaders() }));
    if (!res.ok) throw new Error(`video status ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const { status } = await res.json();
    if (status === 'AVAILABLE') return;
    if (status === 'PROCESSING_FAILED') throw new Error('LinkedIn failed to process the video');
    await new Promise(r => setTimeout(r, VIDEO_POLL_MS));
  }
  throw new Error('video still processing after 10 minutes');
}

async function restCreatePost({ personUrn, text, content }) {
  const res = await check(await fetch('https://api.linkedin.com/rest/posts', timed({
    method: 'POST',
    headers: restHeaders(),
    body: JSON.stringify({
      author: personUrn,
      commentary: escapeLittleText(text),
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      content,
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false
    })
  })), 'rest/posts');
  const urn = res.headers.get('x-restli-id');
  if (!urn) throw new Error('rest/posts returned no x-restli-id; the post may be live');
  return urn;
}

async function legacyCreatePost({ personUrn, share }) {
  const res = await check(await fetch('https://api.linkedin.com/v2/ugcPosts', timed({
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      author: personUrn,
      lifecycleState: 'PUBLISHED',
      specificContent: { 'com.linkedin.ugc.ShareContent': share },
      visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' }
    })
  })), 'ugcPosts');
  return res.headers.get('x-restli-id') || (await res.json()).id;
}

/**
 * Upload the media and describe how to create the post. Runs entirely BEFORE any post
 * exists, so every failure in here is retry-safe.
 * media.kind: 'none' | 'image' | 'images' | 'document' | 'video'
 */
async function stageMedia(personUrn, text, media) {
  const { kind = 'none', buffers = [], title = '', altTexts = [] } = media;
  if (kind === 'none') return () => legacyCreatePost({ personUrn, share: { shareCommentary: { text }, shareMediaCategory: 'NONE' } });
  if (kind === 'image') {
    // Single images stay on the legacy path: it is the one proven for this app since June.
    const asset = await uploadImage(personUrn, buffers[0]);
    const share = { shareCommentary: { text }, shareMediaCategory: 'IMAGE', media: [{ status: 'READY', media: asset, title: { text: title.slice(0, 200) } }] };
    return () => legacyCreatePost({ personUrn, share });
  }
  if (kind === 'images') {
    if (buffers.length < 2 || buffers.length > 20) throw new PrePostError(`multi-image needs 2-20 images, got ${buffers.length}`);
    const images = [];
    for (const [i, b] of buffers.entries()) images.push({ id: await uploadRestImage(personUrn, b), altText: (altTexts[i] || '').slice(0, 4000) });
    return () => restCreatePost({ personUrn, text, content: { multiImage: { images } } });
  }
  if (kind === 'document') {
    const id = await uploadRestDocument(personUrn, buffers[0]);
    return () => restCreatePost({ personUrn, text, content: { media: { id, title: title.slice(0, 200) || 'Documento' } } });
  }
  if (kind === 'video') {
    const id = await uploadRestVideo(personUrn, buffers[0]);
    return () => restCreatePost({ personUrn, text, content: { media: { id, title: title.slice(0, 200) } } });
  }
  throw new PrePostError(`unknown media kind ${kind}`);
}

/**
 * Publish a post. Returns { urn, personUrn }.
 * @param {object} p
 * @param {string} p.text   commentary, <= 3000 chars
 * @param {object} [p.media] { kind, buffers, title, altTexts }; omitted = text only
 */
export async function publishPost({ text, media = { kind: 'none' } }) {
  if (!text || !text.trim()) throw new PrePostError('empty commentary');
  if (text.length > MAX_COMMENTARY) throw new PrePostError(`commentary is ${text.length} chars, over ${MAX_COMMENTARY}`);

  // Everything before the create call is retry-safe: no post can exist yet.
  let personUrn, create;
  try {
    personUrn = await getMemberUrn();
    create = await stageMedia(personUrn, text, media);
  } catch (e) {
    throw e instanceof PrePostError ? e : new PrePostError(`before posting: ${e.message}`);
  }

  // From here on a failure is ambiguous unless LinkedIn answered with a 4xx.
  const urn = await create();
  return { urn, personUrn };
}

/** Comment as the author. Returns true on success; never throws (the post already exists). */
export async function postComment(personUrn, postUrn, text) {
  try {
    const res = await fetch(`https://api.linkedin.com/v2/socialActions/${encodeURIComponent(postUrn)}/comments`, timed({
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ actor: personUrn, object: postUrn, message: { text } })
    }));
    if (!res.ok) {
      console.warn(`First comment failed (post is live): ${res.status} ${(await res.text()).slice(0, 300)}`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn(`First comment failed (post is live): ${e.message}`);
    return false;
  }
}

export const postUrl = (urn) => `https://www.linkedin.com/feed/update/${urn}/`;
