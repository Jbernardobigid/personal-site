/**
 * Rebuild sitemap.xml, feed.xml and robots.txt from what is on disk, without
 * generating a post.
 *
 * generate-post.mjs owns these three artifacts, but the only way to refresh them used
 * to be a full run, which writes a new post and spends a paid API call. Any change to
 * the archive that was not itself a new post (a backfill, a retitle, an image format
 * migration) therefore left the feed stale. This imports the builders and runs them.
 *
 *   node regen-feed-sitemap.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getAllPostMeta, generateSitemap, generateFeed, generateRobotsTxt } from './generate-post.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const posts = getAllPostMeta();
if (!posts.length) {
  console.error('No posts found — refusing to write an empty sitemap or feed.');
  process.exit(1);
}

const targets = [
  ['sitemap.xml', generateSitemap(posts)],
  ['feed.xml',    generateFeed(posts)],
  ['robots.txt',  generateRobotsTxt()]
];

for (const [name, content] of targets) {
  fs.writeFileSync(path.join(__dirname, name), content, 'utf8');
  console.log(`${name.padEnd(12)} rewritten (${content.length} bytes)`);
}
console.log(`\n${posts.length} post(s) indexed.`);
