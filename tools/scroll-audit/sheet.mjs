/**
 * Contact sheet assembly.
 *
 * The whole point of shooting contiguously is looking at the frames side by
 * side. A folder of numbered PNGs never gets read that way.
 */

import sharp from 'sharp';
import path from 'path';

const COLUMNS = 6;
const TILE_WIDTH = 320;
const GUTTER = 6;
const SHEET_BG = { r: 12, g: 10, b: 8, alpha: 1 };

/**
 * Compose every captured frame into one grid image.
 *
 * @param {{file: string}[]} frames captured frames, in scroll order
 * @param {string} outPath where to write the sheet
 * @returns {Promise<string|null>} the sheet path, or null when there is nothing to draw
 */
export async function buildContactSheet(frames, outPath) {
  if (!frames.length) return null;

  const first = await sharp(frames[0].file).metadata();
  const tileHeight = Math.round(TILE_WIDTH * (first.height / first.width));

  const columns = Math.min(COLUMNS, frames.length);
  const rows = Math.ceil(frames.length / columns);
  const sheetWidth = columns * TILE_WIDTH + (columns + 1) * GUTTER;
  const sheetHeight = rows * tileHeight + (rows + 1) * GUTTER;

  const tiles = await Promise.all(
    frames.map(async (frame, i) => ({
      input: await sharp(frame.file).resize(TILE_WIDTH, tileHeight, { fit: 'fill' }).png().toBuffer(),
      left: GUTTER + (i % columns) * (TILE_WIDTH + GUTTER),
      top: GUTTER + Math.floor(i / columns) * (tileHeight + GUTTER),
    }))
  );

  await sharp({
    create: { width: sheetWidth, height: sheetHeight, channels: 4, background: SHEET_BG },
  })
    .composite(tiles)
    .png()
    .toFile(outPath);

  return outPath;
}

/** Short label for a frame file, used in the console index under the sheet. */
export function frameLabel(frame) {
  return `${path.basename(frame.file)}  ${frame.act} @ ${frame.scrollY}px`;
}
