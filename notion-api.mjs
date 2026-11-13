/**
 * notion-api.mjs
 * Minimal Notion REST helper shared by the IG pipeline scripts.
 * Uses NOTION_API_KEY from .env; pinned to the stable 2022-06-28 API version.
 */

import './load-env.mjs';

const NOTION = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

export function requireNotionEnv() {
  const key = process.env.NOTION_API_KEY;
  if (!key) {
    console.error('Missing NOTION_API_KEY in .env — see docs/setup-meta-and-notion.md Part B.');
    process.exit(1);
  }
  return key;
}

export async function notionRequest(method, apiPath, body) {
  const key = requireNotionEnv();
  const res = await fetch(`${NOTION}${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Notion API ${method} ${apiPath} failed — ${data.code || res.status}: ${data.message || 'no detail'}`);
  }
  return data;
}

// Notion returns at most 100 rows per call. This used to return only the first page,
// so the recyclers (which read the whole DB) treated card #101 onwards as "no card".
const MAX_QUERY_PAGES = 50;

export async function queryDatabase(databaseId, filter, sorts) {
  const results = [];
  let cursor;
  for (let page = 0; page < MAX_QUERY_PAGES; page++) {
    const body = { page_size: 100 };
    if (filter) body.filter = filter;
    if (sorts) body.sorts = sorts;
    if (cursor) body.start_cursor = cursor;
    const data = await notionRequest('POST', `/databases/${databaseId}/query`, body);
    results.push(...data.results);
    if (!data.has_more) return results;
    cursor = data.next_cursor;
  }
  throw new Error(`Notion query exceeded ${MAX_QUERY_PAGES} pages; refusing to return a partial result`);
}

export async function createPage(databaseId, properties) {
  return notionRequest('POST', '/pages', {
    parent: { database_id: databaseId },
    properties,
  });
}

export async function updatePage(pageId, properties) {
  return notionRequest('PATCH', `/pages/${pageId}`, { properties });
}

/* ── property value builders ───────────────────────────────── */

// Split into pieces of at most `max` UTF-16 units (Notion's unit), walking by code
// point so an emoji's surrogate pair is never cut in half.
function chunkText(text, max) {
  const chunks = [];
  let current = '';
  for (const ch of text) {
    if (current.length + ch.length > max) { chunks.push(current); current = ''; }
    current += ch;
  }
  chunks.push(current);
  return chunks;
}

export const prop = {
  title: (text) => ({ title: [{ type: 'text', text: { content: String(text).slice(0, 2000) } }] }),
  richText: (text) => ({ rich_text: [{ type: 'text', text: { content: String(text).slice(0, 2000) } }] }),
  // Notion caps one text object at 2000 characters; richText() truncates there. Long
  // captions (a LinkedIn post runs to 3000) are split across objects instead, which
  // getRichText() joins back losslessly.
  longText: (text) => ({
    rich_text: chunkText(String(text), 2000).map((content) => ({ type: 'text', text: { content } })),
  }),
  select: (name) => ({ select: { name } }),
  url: (u) => ({ url: u }),
  date: (isoDate) => ({ date: { start: isoDate } }),
  number: (n) => ({ number: n }),
  files: (urls) => ({
    files: urls.map((u, i) => ({ name: `file-${i + 1}`, type: 'external', external: { url: u } })),
  }),
};

/* ── plain-text getters ────────────────────────────────────── */

export function getTitle(page) {
  const t = Object.values(page.properties).find((p) => p.type === 'title');
  return t ? t.title.map((x) => x.plain_text).join('') : '';
}

export function getSelect(page, name) {
  const p = page.properties[name];
  return p && p.select ? p.select.name : null;
}

export function getRichText(page, name) {
  const p = page.properties[name];
  return p && Array.isArray(p.rich_text) ? p.rich_text.map((x) => x.plain_text).join('') : '';
}

export function getUrl(page, name) {
  const p = page.properties[name];
  return p && p.url ? p.url : null;
}
