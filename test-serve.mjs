/* Unit tests for the preview server's path guard. No socket is opened: importing
   serve.mjs must not start listening, and resolveServable() is pure apart from stat. */
import { resolveServable, isAllowedHost, HOST } from './serve.mjs';

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  if (!ok) console.log(`FAIL ${name}\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`);
};
const status = (url) => resolveServable(url).status;

/* secrets and pipeline state: refused whatever the spelling */
for (const url of [
  '/.env', '/.ENV', '/.Env', '/.env.', '/.env%20', '/%2eenv', '/.env::$DATA',
  '/.git/HEAD', '/.GIT/config', '/.github/workflows/blog-post.yml', '/.claude/settings.json',
  '/post-meta.json', '/POST-META.JSON', '/ig-queue-state.json', '/package.json', '/package-lock.json',
  '/generate-post.mjs', '/GENERATE-POST.MJS', '/CLAUDE.md', '/post-caption.txt',
  '/infra/vps/create-workflows.mjs', '/brainstorms/', '/docs/PRODUCT.md', '/temp/x.png',
  '/node_modules/sharp/package.json', '/api/subscribe.js', '/relatorios/o-topo-e-branco/panels.mjs',
]) {
  t(`refused: ${url}`, status(url) === 403 || status(url) === 404, true);
  t(`never 200: ${url}`, status(url) !== 200, true);
}

/* traversal out of the root */
for (const url of ['/../secret.txt', '/..%2f..%2fWindows/win.ini', '/blog/../../x', '/blog/..%5c..%5c.env', '/%00', '/blog/%E0%A4%A']) {
  t(`traversal refused: ${url}`, status(url) !== 200, true);
}

/* the site itself still serves */
t('root serves index.html', status('/'), 200);
t('root index resolves to a file', resolveServable('/').filePath.toLowerCase().endsWith('index.html'), true);
t('blog index', status('/blog/'), 200);
t('query string ignored', status('/blog/?x=1'), 200);
t('favicon', status('/favicon.png'), 200);
t('robots.txt', status('/robots.txt'), 200);
t('sitemap', status('/sitemap.xml'), 200);
t('report page', status('/relatorios/o-topo-e-branco/'), 200);
t('missing public file is 404', status('/blog/nope.html'), 404);
t('directory without index is not listed', status('/images') !== 200, true);

/* loopback by default, and no DNS-rebinding through a foreign Host header */
t('binds loopback by default', process.env.HOST ? true : HOST === '127.0.0.1', true);
t('host: localhost', isAllowedHost('localhost:3000'), true);
t('host: 127.0.0.1', isAllowedHost('127.0.0.1:3000'), true);
t('host: foreign name refused', isAllowedHost('evil.example:3000'), false);
t('host: missing refused', isAllowedHost(undefined), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
