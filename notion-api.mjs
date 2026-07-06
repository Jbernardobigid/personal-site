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

export async function queryDatabase(databaseId, filter) {
  const body = filter ? { filter } : {};
  const data = await notionRequest('POST', `/databases/${databaseId}/query`, body);
  return data.results;
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

export const prop = {
  title: (text) => ({ title: [{ type: 'text', text: { content: String(text).slice(0, 2000) } }] }),
  richText: (text) => ({ rich_text: [{ type: 'text', text: { content: String(text).slice(0, 2000) } }] }),
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
