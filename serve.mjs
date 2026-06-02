import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 3000;

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4',
};

// Pipeline artifacts and server-side scripts must not be served.
const BLOCKED_PATHS = [
  path.join(ROOT, '.env'),
  path.join(ROOT, 'post-meta.json'),
  path.join(ROOT, 'carousel-meta.json'),
  path.join(ROOT, 'post-caption.txt'),
  path.join(ROOT, 'temp'),
];

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://cdn.jsdelivr.net https://cdn.vercel-insights.com https://*.vercel-insights.com /_vercel/",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https: https://placehold.co",
    "connect-src 'self' https://*.vercel-insights.com",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
  ].join('; '),
};

http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  if (urlPath.endsWith('/')) urlPath += 'index.html';

  const filePath = path.resolve(ROOT, '.' + urlPath);

  // Guard: resolved path must stay inside ROOT
  if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) {
    res.writeHead(403, SECURITY_HEADERS);
    res.end('Forbidden');
    return;
  }

  // Guard: block pipeline artifacts and script files
  const isBlocked = BLOCKED_PATHS.some(b => filePath === b || filePath.startsWith(b + path.sep));
  const ext = path.extname(filePath).toLowerCase();
  if (isBlocked || ext === '.mjs' || ext === '.env') {
    res.writeHead(403, SECURITY_HEADERS);
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (statErr, stat) => {
    if (statErr || stat.isDirectory()) {
      res.writeHead(statErr ? 404 : 403, SECURITY_HEADERS);
      res.end(statErr ? 'Not found' : 'Forbidden');
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, SECURITY_HEADERS);
        res.end('Not found');
        return;
      }
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(data);
    });
  });
}).listen(PORT, () => {
  console.log(`Serving ${ROOT} at http://localhost:${PORT}`);
});
