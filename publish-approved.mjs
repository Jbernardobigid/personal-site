/**
 * publish-approved.mjs
 * Polls the Notion IG Pipeline for cards with Status = "Approved For Publishing",
 * publishes them to Instagram via the Graph API, and marks them Published with
 * the IG media id. Handles carousels/singles (staged in social/) and Reels
 * (published straight from the card's Media URL — Vercel Blob, no staging).
 * The caption comes from the card for every type, so what Jorge edited and approved in
 * Notion is what goes live; the staged caption.txt is only a fallback.
 * Run by n8n on a short schedule — safe no-op when queue is empty.
 *
 * Usage:  node publish-approved.mjs
 */

import './load-env.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { queryDatabase, updatePage, prop, getTitle, getSelect, getRichText, getUrl } from './notion-api.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// prop.richText() cuts at this length. Cards queued before captions moved to
// prop.longText() hold at most this much of a longer caption.
const NOTION_TEXT_LIMIT = 2000;

/**
 * The caption to publish for a carousel or single image.
 *
 * The card wins: carousels used to be published from the staged caption.txt, so an edit
 * made in Notion during review never reached Instagram. The file is used only when the
 * card is empty, or when the card is a legacy copy that Notion truncated (it equals the
 * first 2000 characters of a longer file caption), where publishing the card would drop
 * the end of the post.
 * @param {string|undefined} cardCaption Caption property of the approved card
 * @param {string} fileCaption caption.txt from the staged folder, '' if absent
 * @returns {string}
 */
export function chooseCaption(cardCaption, fileCaption) {
  const card = (cardCaption || '').trim();
  const file = (fileCaption || '').trim();
  const isLegacyTruncation = file.length > NOTION_TEXT_LIMIT
    && card === file.slice(0, NOTION_TEXT_LIMIT).trim();
  const caption = card && !isLegacyTruncation ? card : file;
  if (!caption) throw new Error('no caption on the card or in the staged caption.txt');
  return caption;
}

/** A staged folder name under social/: letters, digits, dot, dash, underscore. */
export function isSafeCardId(id) {
  return typeof id === 'string' && /^[\w.-]+$/.test(id) && !id.includes('..');
}

async function publishCard(page) {
  const id = getTitle(page);
  const type = getSelect(page, 'Type');

  // Import lazily so a Notion-only failure doesn't require IG env
  const { cmdPublishCarousel, cmdPublishReel, readCaption } = await import('./post-to-instagram.mjs');

  if (type === 'Reel') {
    const videoUrl = getUrl(page, 'Media URL');
    if (!videoUrl) throw new Error('Reel card has no Media URL');
    const caption = getRichText(page, 'Caption');
    return cmdPublishReel({ videoUrl, caption });
  }

  // The id is a Notion card title and becomes a directory name, so it must be a plain
  // folder name: no separators, no "..".
  if (!isSafeCardId(id)) throw new Error(`card title "${id}" is not a valid staged folder name`);
  const stagedDir = path.join(__dirname, 'social', id);
  if (!fs.existsSync(stagedDir)) {
    throw new Error(`social/${id} not found on disk — was it staged on this machine?`);
  }
  // readCaption() exits the process when the file is missing, so check first: a card
  // that carries its caption does not need the file at all.
  const hasCaptionFile = fs.existsSync(path.join(stagedDir, 'caption.txt'));
  const caption = chooseCaption(getRichText(page, 'Caption'), hasCaptionFile ? readCaption(stagedDir) : '');
  return cmdPublishCarousel(id, { caption });
}

async function main() {
  const dbId = process.env.NOTION_IG_DB_ID;
  if (!dbId) {
    console.error('Missing NOTION_IG_DB_ID in .env.');
    process.exit(1);
  }

  // LinkedIn cards share this database and the same approval status, but belong to
  // publish-linkedin.mjs. Without this filter an approved LinkedIn card would be pushed
  // to Instagram as a carousel.
  const approved = await queryDatabase(dbId, {
    and: [
      { property: 'Status', select: { equals: 'Approved For Publishing' } },
      { property: 'Type', select: { does_not_equal: 'LinkedIn' } },
    ],
  });

  if (approved.length === 0) {
    console.log('No cards approved for publishing.');
    return;
  }

  for (const page of approved) {
    const id = getTitle(page);
    console.log(`Publishing approved card: ${id} (${getSelect(page, 'Type') || 'Carousel'})`);
    try {
      const mediaId = await publishCard(page);
      const props = {
        Status: prop.select('Published'),
        'Publish Date': prop.date(new Date().toISOString().slice(0, 10)),
      };
      if (mediaId) props['IG Media ID'] = prop.richText(mediaId);
      await updatePage(page.id, props);
      console.log(`${id} → Published${mediaId ? ` (media ${mediaId})` : ''}`);
    } catch (err) {
      console.error(`${id} failed: ${err.message}`);
      await updatePage(page.id, {
        Status: prop.select('Needs Edit'),
        Notes: prop.richText(`Publish failed ${new Date().toISOString()}: ${err.message}`),
      });
    }
  }
}

// Entrypoint guard: importing this module (tests) must not poll Notion or publish.
const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  main().catch((err) => {
    console.error(`\nFailed: ${err.message}`);
    process.exit(1);
  });
}
