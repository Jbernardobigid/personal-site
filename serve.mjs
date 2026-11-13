/**
 * serve.mjs — local preview server for the site.
 *
 *   node serve.mjs                 http://localhost:3000, loopback only
 *   HOST=0.0.0.0 node serve.mjs    opt in to the LAN (e.g. to test on a phone)
 *
 * The project root also holds .env, .git, pipeline ledgers and private strategy
 * folders, so this serves an ALLOWLIST of public entries rather than blocking known
 * bad names. A blocklist compared case-sensitively let /.ENV and /.git/HEAD through on
 * Windows, where the filesystem is case-insensitive, while the server listened on
 * every interface.
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = fs.realpathSync.native(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.PORT) || 3000;
export const HOST = process.env.HOST || '127.0.0.1';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const IS_LOOPBACK_ONLY = LOOPBACK_HOSTS.has(HOST);

// What Vercel deploys (see .vercelignore) plus the local work surfaces that get
// previewed in a browser. Everything else at the root is refused. Compared lowercase.
const PUBLIC_ROOT_FILES = new Set([
  'index.html', 'favicon.png', 'apple-touch-icon.png', 'sitemap.xml', 'robots.txt',
  'feed.xml', 'podcast.xml', 'podcast-cover.jpg',
]);
const PUBLIC_DIRS = new Set([
  'blog', 'privacidade', 'relatorios', 'images', 'social',                      // deployed
  'templates', 'carousels', 'linkedin', 'linkedin-newsletter', 'projects',      // local previews
  'assets', 'brand_assets', 'videos',
]);
const BLOCKED_SEGMENTS = new Set(['node_modules']);
const BLOCKED_EXTENSIONS = new Set(['.mjs', '.env']);

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.xml': 'application/xml',
  '.txt': 'text/plain',
  '.pdf': 'application/pdf',
};

const FORBIDDEN = Object.freeze({ status: 403 });
const NOT_FOUND = Object.freeze({ status: 404 });

/** True when `target` is ROOT itself or lives under it. Case-insensitive, because the
 *  comparison must not be stricter than the filesystem it protects. */
function isInsideRoot(target) {
  const root = ROOT.toLowerCase();
  const candidate = target.toLowerCase();
  return candidate === root || candidate.startsWith(root + path.sep);
}

/** Allowlist check on a path relative to ROOT. */
function isPublicPath(relativePath) {
  const segments = relativePath.split(/[\\/]+/).filter(Boolean).map((s) => s.toLowerCase());
  if (segments.length === 0) return false;
  // Dotfiles and dot-directories (.env, .git, .github, .claude) are never public.
  if (segments.some((s) => s.startsWith('.') || BLOCKED_SEGMENTS.has(s))) return false;
  if (BLOCKED_EXTENSIONS.has(path.extname(segments[segments.length - 1]))) return false;
  return segments.length === 1 ? PUBLIC_ROOT_FILES.has(segments[0]) : PUBLIC_DIRS.has(segments[0]);
}

/**
 * Map a request URL to a file that may be served.
 * @param {string} rawUrl request URL, query string included
 * @returns {{ status: 200, filePath: string } | { status: 403 } | { status: 404 }}
 */
export function resolveServable(rawUrl) {
  let urlPath;
  try { urlPath = decodeURIComponent(String(rawUrl).split('?')[0]); }
  catch { return FORBIDDEN; }
  // NUL truncates paths in native calls; ':' addresses NTFS alternate data streams
  // (/.env::$DATA reads .env) and is never part of a legitimate site URL.
  if (urlPath.includes('\0') || urlPath.includes(':')) return FORBIDDEN;
  if (urlPath === '' || urlPath.endsWith('/')) urlPath += 'index.html';

  const requested = path.resolve(ROOT, '.' + path.sep + urlPath);
  if (!isInsideRoot(requested)) return FORBIDDEN;
  // Checked as requested first, so a refused name never reveals whether it exists.
  if (!isPublicPath(path.relative(ROOT, requested))) return FORBIDDEN;

  // Then checked again as it really is on disk. Windows resolves "post-meta.json.",
  // 8.3 short names and symlinks to files the lexical check never saw.
  let real;
  try { real = fs.realpathSync.native(requested); }
  catch { return NOT_FOUND; }
  if (!isInsideRoot(real) || !isPublicPath(path.relative(ROOT, real))) return FORBIDDEN;

  let stat;
  try { stat = fs.statSync(real); }
  catch { return NOT_FOUND; }
  if (!stat.isFile()) return FORBIDDEN;
  return { status: 200, filePath: real };
}

/** Refuse foreign Host headers on a loopback bind: without this a web page could reach
 *  the server through DNS rebinding and read whatever it serves. */
export function isAllowedHost(hostHeader) {
  if (!IS_LOOPBACK_ONLY) return true;
  if (!hostHeader) return false;
  const hostname = String(hostHeader).toLowerCase().replace(/:\d+$/, '');
  return LOOPBACK_HOSTS.has(hostname);
}

function handleRequest(req, res) {
  const deny = (status, message) => { res.writeHead(status, SECURITY_HEADERS); res.end(message); };
  if (!isAllowedHost(req.headers.host)) return deny(403, 'Forbidden');
  if (req.method !== 'GET' && req.method !== 'HEAD') return deny(405, 'Method not allowed');

  const result = resolveServable(req.url);
  if (result.status !== 200) return deny(result.status, result.status === 404 ? 'Not found' : 'Forbidden');

  fs.readFile(result.filePath, (err, data) => {
    if (err) return deny(404, 'Not found');
    const ext = path.extname(result.filePath).toLowerCase();
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  http.createServer(handleRequest).listen(PORT, HOST, () => {
    const shown = IS_LOOPBACK_ONLY ? 'localhost' : HOST;
    console.log(`Serving ${ROOT} at http://${shown}:${PORT}${IS_LOOPBACK_ONLY ? ' (loopback only)' : ' (LAN-reachable)'}`);
  });
}
