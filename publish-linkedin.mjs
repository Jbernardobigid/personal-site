/**
 * publish-linkedin.mjs
 * Publishes ONE approved LinkedIn card from the Notion pipeline (Type = LinkedIn,
 * Status = "Approved For Publishing"), oldest Publish Date first, then posts the
 * First Comment (sources) and marks the card Published with the post link.
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
import { queryDatabase, updatePage, prop, getTitle, getRichText, getUrl } from './notion-api.mjs';
import { publishPost, postComment, postUrl, LinkedInAuthError, PrePostError } from './linkedin-api.mjs';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
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
  return { id: getTitle(page), text, comment, mediaUrl: getUrl(page, 'Media URL') };
}

async function fetchImage(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`image download ${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_IMAGE_BYTES) throw new Error(`image is ${buf.length} bytes, over ${MAX_IMAGE_BYTES}`);
  return buf;
}

async function nextApprovedCard(dbId) {
  const cards = await queryDatabase(dbId, {
    and: [
      { property: 'Status', select: { equals: 'Approved For Publishing' } },
      { property: 'Type', select: { equals: 'LinkedIn' } }
    ]
  }, [{ property: 'Publish Date', direction: 'ascending' }]);
  return cards[0] || null;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const dbId = process.env.NOTION_IG_DB_ID;
  if (!dbId) return report({ success: false, error: 'NOTION_IG_DB_ID not set' }, 1);

  const page = await nextApprovedCard(dbId);
  if (!page) return report({ success: true, published: 0, reason: 'nothing approved' });

  stuckCard = getTitle(page);
  const card = cardPayload(page);
  if (dryRun) return report({ success: true, dryRun: true, id: card.id, chars: card.text.length, hasImage: !!card.mediaUrl, hasComment: !!card.comment });

  const imageBuffer = card.mediaUrl ? await fetchImage(card.mediaUrl) : null;

  // In-flight lock: park the card in "Produced" before posting. If LinkedIn accepts the
  // post but the final Notion write fails, the card must not still read Approved, or the
  // next slot would publish it a second time. A missed post is recoverable; a duplicate
  // on the feed is not.
  await updatePage(page.id, { Status: prop.select('Produced') });
  let published;
  try {
    published = await publishPost({ text: card.text, imageBuffer, imageTitle: card.id });
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
