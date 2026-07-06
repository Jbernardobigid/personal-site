/**
 * publish-approved.mjs
 * Polls the Notion IG Pipeline for cards with Status = "Approved For Publishing",
 * publishes them to Instagram via the Graph API, and marks them Published with
 * the IG media id. Handles carousels/singles (staged in social/) and Reels
 * (published straight from the card's Media URL — Vercel Blob, no staging).
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

async function publishCard(page) {
  const id = getTitle(page);
  const type = getSelect(page, 'Type');

  // Import lazily so a Notion-only failure doesn't require IG env
  const { cmdPublishCarousel, cmdPublishReel } = await import('./post-to-instagram.mjs');

  if (type === 'Reel') {
    const videoUrl = getUrl(page, 'Media URL');
    if (!videoUrl) throw new Error('Reel card has no Media URL');
    const caption = getRichText(page, 'Caption');
    return cmdPublishReel({ videoUrl, caption });
  }

  const stagedDir = path.join(__dirname, 'social', id);
  if (!fs.existsSync(stagedDir)) {
    throw new Error(`social/${id} not found on disk — was it staged on this machine?`);
  }
  return cmdPublishCarousel(id, {});
}

async function main() {
  const dbId = process.env.NOTION_IG_DB_ID;
  if (!dbId) {
    console.error('Missing NOTION_IG_DB_ID in .env.');
    process.exit(1);
  }

  const approved = await queryDatabase(dbId, {
    property: 'Status',
    select: { equals: 'Approved For Publishing' },
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

main().catch((err) => {
  console.error(`\nFailed: ${err.message}`);
  process.exit(1);
});
