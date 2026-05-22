/**
 * remove-bg.mjs
 * Removes the background from a logo JPG using edge flood-fill,
 * so only pixels connected to the image border are erased.
 * Usage: node remove-bg.mjs <input.jpg> <output.png>
 */

import { Jimp, intToRGBA } from 'jimp';

const [,, input, output] = process.argv;
if (!input || !output) {
  console.error('Usage: node remove-bg.mjs <input.jpg> <output.png>');
  process.exit(1);
}

const TOLERANCE = 45;

const img = await Jimp.read(input);
const { width, height, data } = img.bitmap;

// Sample background color from top-left corner
const bgColor = intToRGBA(img.getPixelColor(2, 2));
const { r: bgR, g: bgG, b: bgB } = bgColor;
console.log(`Detected background color: rgb(${bgR}, ${bgG}, ${bgB})`);

function colorDist(idx) {
  const r = data[idx];
  const g = data[idx + 1];
  const b = data[idx + 2];
  return Math.sqrt((r - bgR) ** 2 + (g - bgG) ** 2 + (b - bgB) ** 2);
}

function pixelIdx(x, y) {
  return (y * width + x) * 4;
}

// BFS flood-fill from all edge pixels
const visited = new Uint8Array(width * height);
const queue = [];

function enqueue(x, y) {
  const i = y * width + x;
  if (x < 0 || x >= width || y < 0 || y >= height) return;
  if (visited[i]) return;
  if (colorDist(pixelIdx(x, y)) > TOLERANCE) return;
  visited[i] = 1;
  queue.push(x, y);
}

// Seed from all four edges
for (let x = 0; x < width; x++) {
  enqueue(x, 0);
  enqueue(x, height - 1);
}
for (let y = 0; y < height; y++) {
  enqueue(0, y);
  enqueue(width - 1, y);
}

// BFS
let head = 0;
while (head < queue.length) {
  const x = queue[head++];
  const y = queue[head++];
  // Make pixel transparent
  const idx = pixelIdx(x, y);
  data[idx + 3] = 0;
  // Expand to 4-connected neighbours
  enqueue(x + 1, y);
  enqueue(x - 1, y);
  enqueue(x, y + 1);
  enqueue(x, y - 1);
}

await img.write(output);
console.log(`Saved: ${output}`);
