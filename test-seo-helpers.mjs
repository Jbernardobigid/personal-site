/* Unit tests for the pure SEO helpers in generate-post.mjs.
   The module is NEVER imported: its main() runs unconditionally and would fire a
   paid API call and write a real post. Functions are sliced out as text instead. */
import fs from 'fs';
const src = fs.readFileSync('generate-post.mjs', 'utf8');
/* Marker-based, not line-based: line numbers drift on every edit and a stale
   offset silently slices the file mid-expression. */
const between = (startMarker, endMarker) => {
  const a = src.indexOf(startMarker);
  const b = src.indexOf(endMarker, a);
  if (a < 0 || b < 0) throw new Error(`marker not found: ${startMarker} .. ${endMarker}`);
  return src.slice(a, b);
};

const code = [
  between('const SLUG_MAX', 'function formatDate'),
  between('const RELATED_COUNT', 'function buildRelatedHtml'),
  'export { slugify, deriveSeoTitle, buildPageTitle, clampDescription, selectRelatedPosts, SEO_TITLE_MAX, META_DESC_MAX };'
].join('\n').replace(/const PILLAR_LABELS[^\n]*\n/, "const PILLAR_LABELS = { 'black-identity':'Identidade Negra','cycling':'Ciclismo','tech':'Tecnologia' };\n");

fs.writeFileSync('_gen-pure.mjs', code);
const M = await import('./_gen-pure.mjs');

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  if (!ok) console.log(`FAIL ${name}\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`);
};
const le = (name, got, max) => {
  const ok = got.length <= max; ok ? pass++ : fail++;
  if (!ok) console.log(`FAIL ${name}: ${got.length} > ${max} :: ${JSON.stringify(got)}`);
};

/* --- slug: the real regression, cutting mid-word --- */
t('slug short', M.slugify('Um título curto'), 'um-titulo-curto');
const s1 = M.slugify('O dado que você ignora hoje pode ser o processo que te destrói amanhã');
t('slug cuts on hyphen', s1, 'o-dado-que-voce-ignora-hoje-pode-ser-o-processo-que-te');
le('slug length', s1, 60);
t('slug no trailing dash', /-$/.test(s1), false);
t('slug accents', M.slugify('Ação, coração & São Paulo'), 'acao-coracao-sao-paulo');

/* --- seo title --- */
t('seo uses model title when it fits', M.deriveSeoTitle('Editorial longo demais para caber', 'Título curto'), 'Título curto');
// A complete title that already fits the 60-char tag is kept whole: cutting it to the
// colon would discard descriptive keywords and buy nothing, since it never truncates.
const dFits = M.deriveSeoTitle('Pedalar Enquanto Negro: O Ato Político que Ninguém Me Contou', '');
t('seo keeps a complete title that already fits', dFits, 'Pedalar Enquanto Negro: O Ato Político que Ninguém Me Contou');
le('seo kept title within tag budget', dFits, 60);
// Over budget, it falls back to the structural boundary.
const d1 = M.deriveSeoTitle('Pedalar Enquanto Negro: O Ato Político que Ninguém Jamais Me Contou Naquele Ano', '');
t('seo cuts at colon when over budget', d1, 'Pedalar Enquanto Negro');
const d2 = M.deriveSeoTitle('Maioria no mercado, minoria na renda: o que os dados de Pernambuco revelam sobre o abismo racial brasileiro', '');
le('seo derived length', d2, M.SEO_TITLE_MAX);
const d3 = M.deriveSeoTitle('Uma frase longa sem nenhuma pontuação estrutural que precisa ser cortada na palavra', '');
le('seo no-boundary length', d3, M.SEO_TITLE_MAX);
t('seo no mid-word cut', /\s$|[a-zà-ú]-$/i.test(d3), false);
t('seo drops dangling word', /\b(de|da|do|que|para|com|e|o|a)$/i.test(d3.trim()), false);

/* --- page title 60-char budget incl. suffix --- */
le('page title short', M.buildPageTitle('Pedalar Enquanto Negro'), 60);
t('page title keeps suffix', M.buildPageTitle('Pedalar Enquanto Negro').includes('— Jorge Bernardo'), true);
const long55 = 'x'.repeat(55);
le('page title at max', M.buildPageTitle(long55), 60);
t('page title drops suffix when it would overflow', M.buildPageTitle(long55), long55);

/* --- description --- */
const shortDesc = 'Uma descrição curta que já cabe.';
t('desc passthrough', M.clampDescription(shortDesc), shortDesc);
const longDesc = 'Quando Nova York atualizou o currículo de cosmetologia para incluir cabelos crespos e cacheados, revelou algo maior sobre o que forma um profissional e sobre aquilo que nunca entrou na sala de aula de ninguém.';
const c1 = M.clampDescription(longDesc);
le('desc length', c1, M.META_DESC_MAX);
t('desc no mid-word', /[a-zà-ú]…$/i.test(c1) === false || c1.endsWith('…'), true);
t('desc not ending on preposition', /\b(de|da|do|que|para|com|sobre|e|o|a)…?$/i.test(c1.replace(/…$/,'').trim()), false);
t('desc empty safe', M.clampDescription(''), '');
t('desc null safe', M.clampDescription(null), '');

/* --- related posts --- */
const posts = [
  {filename:'a.html', title:'A', pillar:'black-identity'},
  {filename:'b.html', title:'B', pillar:'cycling'},
  {filename:'c.html', title:'C', pillar:'black-identity'},
  {filename:'d.html', title:'D', pillar:'tech'},
];
const rel = M.selectRelatedPosts(posts, 'black-identity', 'a.html');
t('related count', rel.length, 3);
t('related excludes self', rel.some(p=>p.filename==='a.html'), false);
t('related same-pillar first', rel[0].filename, 'c.html');
t('related empty when too few', M.selectRelatedPosts(posts.slice(0,2), 'cycling', 'a.html'), []);
t('related skips unknown pillar', M.selectRelatedPosts([...posts,{filename:'e.html',title:'E',pillar:'nope'}],'tech','d.html').every(p=>p.pillar!=='nope'), true);

console.log(`\n${pass} passed, ${fail} failed`);
fs.unlinkSync('_gen-pure.mjs');
process.exit(fail ? 1 : 0);
