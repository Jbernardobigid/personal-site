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

/**
 * Publish a post. Returns the post URN.
 * @param {object} p
 * @param {string} p.text          commentary, <= 3000 chars
 * @param {Buffer} [p.imageBuffer] optional single image
 * @param {string} [p.imageTitle]
 */
export async function publishPost({ text, imageBuffer = null, imageTitle = '' }) {
  if (!text || !text.trim()) throw new PrePostError('empty commentary');
  if (text.length > MAX_COMMENTARY) throw new PrePostError(`commentary is ${text.length} chars, over ${MAX_COMMENTARY}`);

  // Everything before the create call is retry-safe: no post can exist yet.
  let personUrn;
  const share = { shareCommentary: { text }, shareMediaCategory: 'NONE' };
  try {
    personUrn = await getMemberUrn();
    if (imageBuffer) {
      const asset = await uploadImage(personUrn, imageBuffer);
      share.shareMediaCategory = 'IMAGE';
      share.media = [{ status: 'READY', media: asset, title: { text: imageTitle.slice(0, 200) } }];
    }
  } catch (e) {
    throw e instanceof PrePostError ? e : new PrePostError(`before posting: ${e.message}`);
  }

  // From here on a failure is ambiguous unless LinkedIn answered with a 4xx.
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
  const urn = res.headers.get('x-restli-id') || (await res.json()).id;
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
