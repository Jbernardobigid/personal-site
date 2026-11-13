/**
 * publish-linkedin.mjs
 * Publishes ONE approved card from the Notion "LinkedIn Pipeline" database
 * (Status = "Approved For Publishing" and Publish Date today or earlier in Brazil
 * time, or unset), oldest Publish Date first, then posts the
 * First Comment (sources) and marks the card Published with the post link.
 * The card's Format decides the media: text, photo / ai-image (one image), photos
 * (every image in Preview), document (PDF), video (mp4).
 *
 * One per run on purpose: n8n fires this on the series slots (Tue/Thu 08:30 BRT), so
 * a batch of late approvals still goes out one slot at a time instead of flooding
 * the feed. Caption and First Comment are read from the card, so Jorge's edits in
 * Notion are what gets published.
 *
 * Exit 1 (with a one-line JSON reason) on any failure, including an expired token,
 * so the n8n guard node turns red instead of reporting success.
 *
 * Usage: node publish-linkedin.mjs [--dry-run]
 */

import './load-env.mjs';
import path from 'path';
import { fileURLToPath } from 'url';
import { queryDatabase, updatePage, prop, getTitle, getRichText, getUrl, getSelect } from './notion-api.mjs';
import { publishPost, postComment, postUrl, LinkedInAuthError, PrePostError } from './linkedin-api.mjs';

const MAX_BYTES = { image: 8 * 1024 * 1024, document: 100 * 1024 * 1024, video: 500 * 1024 * 1024 };
const KIND_BY_FORMAT = { text: 'none', photo: 'image', 'ai-image': 'image', photos: 'images', document: 'document', video: 'video' };
let stuckCard = null;

// Report by setting exitCode, never process.exit(): exiting while undici sockets are
// still closing trips a libuv assertion on Windows and turns a success into exit 127.
function report(obj, code = 0) {
  console.log(JSON.stringify(obj));
  process.exitCode = code;
  return obj;
}

/** Card content as it will be published. Exported for tests. */
export function cardPayload(page) {
  const text = getRichText(page, 'Caption').trim();
  const comment = getRichText(page, 'First Comment').trim();
  if (!text) throw new Error('card has an empty Caption');
  if (/[–—]/.test(text)) throw new Error('Caption contains an en/em dash (voice rules); edit the card');
  const format = getSelect(page, 'Format') || 'text';
  const kind = KIND_BY_FORMAT[format];
  if (!kind) throw new Error(`unknown Format "${format}"`);
  const mediaUrl = getUrl(page, 'Media URL');
  const previewUrls = (page.properties.Preview?.files || []).map(f => f.external?.url || f.file?.url).filter(Boolean);
  const mediaUrls = kind === 'images' ? previewUrls : (mediaUrl ? [mediaUrl] : []);
  if (kind !== 'none' && !mediaUrls.length) throw new Error(`Format "${format}" needs media but the card has none`);
  if (kind === 'images' && mediaUrls.length < 2) throw new Error(`Format "photos" needs at least 2 images in Preview, found ${mediaUrls.length}`);
  return { id: getTitle(page), text, comment, format, kind, mediaUrls };
}

async function fetchMedia(url, kind) {
  const max = MAX_BYTES[kind === 'images' ? 'image' : kind];
  const res = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!res.ok) throw new Error(`media download ${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > max) throw new Error(`media is ${buf.length} bytes, over ${max}`);
  return buf;
}

/** Document title shown on the carousel: the post's first line, trimmed. */
const documentTitle = (text) => text.split(/\r?\n/)[0].slice(0, 100);

const PUBLISH_TIMEZONE = 'America/Sao_Paulo';

/** Today as YYYY-MM-DD in Brazil time, the timezone prepare-linkedin.mjs writes Publish Date in. */
const todayInBrazil = (now = new Date()) => now.toLocaleDateString('en-CA', { timeZone: PUBLISH_TIMEZONE });

/**
 * Whether a card's slot has arrived. Publish Date is the slot the post was written for
 * (and the writer is told that date), so an early approval must wait for it. A card with
 * no date has no slot to wait for. Exported for tests.
 */
export function isDue(page, now = new Date()) {
  const start = page.properties['Publish Date']?.date?.start;
  return !start || start.slice(0, 10) <= todayInBrazil(now);
}

/** Approved cards whose Publish Date is today or earlier (Brazil time), or unset. Exported for tests. */
export function dueCardsFilter(now = new Date()) {
  return {
    and: [
      { property: 'Status', select: { equals: 'Approved For Publishing' } },
      {
        or: [
          { property: 'Publish Date', date: { on_or_before: todayInBrazil(now) } },
          { property: 'Publish Date', date: { is_empty: true } },
        ],
      },
    ],
  };
}

/**
 * The oldest approved card that is due. Sorting by Publish Date alone picked a card
 * dated for a later slot whenever it was approved early. The Notion filter does the
 * work; isDue() repeats it locally so a filter mistake cannot publish ahead of schedule.
 * Exported for tests, which pass their own `query`.
 */
export async function nextApprovedCard(dbId, now = new Date(), query = queryDatabase) {
  const cards = await query(dbId, dueCardsFilter(now), [{ property: 'Publish Date', direction: 'ascending' }]);
  return cards.find(card => isDue(card, now)) || null;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const dbId = process.env.NOTION_LINKEDIN_DB_ID;
  if (!dbId) return report({ success: false, error: 'NOTION_LINKEDIN_DB_ID not set' }, 1);

  const page = await nextApprovedCard(dbId);
  if (!page) return report({ success: true, published: 0, reason: 'nothing approved' });

  stuckCard = getTitle(page);
  const card = cardPayload(page);
  if (dryRun) return report({ success: true, dryRun: true, id: card.id, format: card.format, chars: card.text.length, media: card.mediaUrls.length, hasComment: !!card.comment });

  const buffers = [];
  for (const url of card.mediaUrls) buffers.push(await fetchMedia(url, card.kind));
  const media = { kind: card.kind, buffers, title: card.kind === 'document' ? documentTitle(card.text) : card.id };

  // In-flight lock: park the card in "Produced" before posting. If LinkedIn accepts the
  // post but the final Notion write fails, the card must not still read Approved, or the
  // next slot would publish it a second time. A missed post is recoverable; a duplicate
  // on the feed is not.
  await updatePage(page.id, { Status: prop.select('Produced') });
  let published;
  try {
    published = await publishPost({ text: card.text, media });
  } catch (e) {
    // Re-approve ONLY when LinkedIn provably never received the post. A timeout, a 5xx or
    // an unreadable response to the create call may hide a live post, so the card stays
    // parked in "Produced" for a human to check the profile.
    if (e instanceof PrePostError) {
      await updatePage(page.id, { Status: prop.select('Approved For Publishing') })
        .catch(() => console.warn(`could not re-approve ${card.id}; it is parked in "Produced"`));
    } else {
      console.warn(`${card.id} parked in "Produced": the post MAY be live, check the profile before re-approving`);
    }
    throw e;
  }
  const { urn, personUrn } = published;
  // Print the link before any further write, so a later Notion failure cannot lose it.
  console.log(`LIVE: ${postUrl(urn)}`);
  const commented = card.comment ? await postComment(personUrn, urn, card.comment) : false;

  const notes = getRichText(page, 'Notes');
  await updatePage(page.id, {
    Status: prop.select('Published'),
    'Post URL': prop.url(postUrl(urn)),
    Notes: prop.longText(`${notes}\n\nPublicado: ${postUrl(urn)}${card.comment && !commented ? '\nPrimeiro comentário FALHOU: publique as fontes à mão.' : ''}`)
  });
  return report({ success: true, published: 1, id: card.id, url: postUrl(urn), commented });
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  // stuckCard names the card that failed: only the oldest approved card is tried per run,
  // so a card that keeps failing blocks every card queued behind it until it is fixed.
  main().catch(e => report({ success: false, error: e instanceof LinkedInAuthError ? 'linkedin-token-expired' : 'publish-failed', card: stuckCard, detail: String(e?.message || e).slice(0, 500) }, 1));
}
