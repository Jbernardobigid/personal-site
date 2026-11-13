/**
 * linkedin-writer.mjs
 * Writer for the LinkedIn cycling series (#EsportesNoLinkedIn), in two Opus calls:
 *   1. chooseStory  - pick one shortlisted news item and the angle Jorge can own
 *   2. writePost    - write the PT-BR post for the format of the day, grounded in the
 *                     item plus Tavily research
 * plus pure helpers that assemble and police the final text (exported for tests).
 *
 * Format rules come from the LinkedIn editorial workshop Jorge attended (2026-11-12):
 * consistency, value over self-promotion, an open question, reply to comments, and
 * content at the crossing of audience, expertise and perspective.
 */

import { writeJson } from './claude-models.mjs';
import { promptDateBlock, describeDay } from './prompt-date.mjs';
import { JORGE_CONTEXT, sanitizeEmDashes } from './generate-post.mjs';
import { MAX_COMMENTARY } from './linkedin-api.mjs';

export const SERIES_TAG = '#EsportesNoLinkedIn';
export const TARGET_MAX_CHARS = 1900;   // room under LinkedIn's 3000 for Jorge's own edits
const HOOK_MAX_CHARS = 210;             // roughly what the feed shows before "...ver mais"

const SERIES_BRIEF = `THE SERIES: a LinkedIn series in Brazilian Portuguese about cycling news, with a focus on Black, African and Latin-American people in the sport and on who gets access to the bike. Jorge is an amateur road cyclist, not a pro, a journalist or a coach. His standing is that of a Black Brazilian who rides seriously, works in data and AI governance, and reads the sport through the lens of representation, access and careers. The goal is to become a reference voice on this beat, which LinkedIn rewards for originality, expertise and real conversation, not volume.`;

const FORMAT_BRIEFS = {
  text: 'TEXT ONLY. No image. The words carry the whole post, so the hook and the rhythm matter more than ever.',
  photo: 'REAL PHOTO OF JORGE riding (chosen by you from the inventory). The photo makes the post personal: connect the news to his own riding or perspective in at least one paragraph. Never claim the photo shows something it does not (if the photo is from a 2026 race, do not say it is from the event in the news).',
  'ai-image': 'AI-GENERATED ILLUSTRATION. Describe one editorial scene that illustrates the idea, not the news event itself. Never depict a real, identifiable person (no likeness of any named rider), no logos, no text, no team kits.'
};

const VOICE_RULES = `VOICE AND FORMAT (LinkedIn, mobile first):
- First person, pointed outward. The post is about the story and what it means for the reader, not a biography.
- HOOK: the first one or two lines must stand alone and earn the "ver mais" tap, at most ${HOOK_MAX_CHARS} characters. A specific fact, number, scene or tension from the story, never a broad statement, never a question like "Você sabia que...".
- Then 4 to 7 very short paragraphs (1 to 3 sentences each), blank line between them.
- Bring VALUE to a professional audience: connect the sport story to something people recognise from work, careers, talent pipelines, sponsorship, leadership, or who gets a seat at the table. Earn the bridge, never force a corporate moral.
- End with ONE specific, open question that invites people to answer from their own experience. Not "Concorda?", not "O que você acha?".
- Total post at most ${TARGET_MAX_CHARS} characters including hashtags.
- Facts: use ONLY facts from the news item and the research given. Name the outlet in the text when you use its reporting ("segundo o Cyclingnews"). Translate quotes from Spanish or English and mark them as "em tradução livre". Never invent numbers, quotes, people, or anything about Jorge's life beyond the background and the ride data given.
- Every statistic carries its year and who measured it ("em 2020, pela PNAD Covid do IBGE"). An old number presented as current is a false claim. If the research does not give the year, leave the number out.
- Allegations about named people stay allegations: report what was reported and by whom, add no judgement of the person.
- NO links in the post body (LinkedIn suppresses posts with external links). Sources go in the first comment.
- Never use the em dash or en dash. Never use "Além disso", "Portanto", "Vale ressaltar", "Em suma", "Nesse contexto", "No entanto", "O fato é que", "É fundamental". No emoji bullets, no hollow motivation, no "Bora?".
- Hashtags: give exactly 2 specific ones (in Portuguese, CamelCase, no accents), the series tag ${SERIES_TAG} is added for you.`;

/* ── Pure helpers (tested) ───────────────────────────────── */

// Two regexes on purpose: a /g regex keeps lastIndex between .test() calls, so after one
// call threw on a link, the next post's link could slip past the check.
const URL_TEST = /\bhttps?:\/\/\S+|\bwww\.\S+/i;
const URL_ALL = /\bhttps?:\/\/\S+|\bwww\.\S+/gi;

/**
 * sanitizeEmDashes handles the em dash only. En dashes still show up in ranges
 * ("2020–2024") and as clause breaks; normalise both instead of aborting a paid build.
 * Exported for tests.
 */
export function normaliseDashes(text) {
  return sanitizeEmDashes(String(text || ''))
    .replace(/(\d)\s*–\s*(\d)/g, '$1-$2')
    .replace(/\s*–\s*/g, ', ');
}

/** Normalise a model-supplied hashtag to #CamelCase with no spaces/accents, or null. */
export function normaliseHashtag(tag) {
  const clean = String(tag || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/^#+/, '')
    .split(/[^A-Za-z0-9]+/).filter(Boolean)
    .map(w => w[0].toUpperCase() + w.slice(1))
    .join('');
  return clean.length >= 3 ? `#${clean}` : null;
}

/**
 * Final post text from the writer's JSON. Throws on anything that must not reach
 * LinkedIn: links in the body, leftover dashes, or an over-long post.
 */
export function assembleCommentary(post) {
  const parts = [post.hook, post.body, post.closing_question].map(s => normaliseDashes(String(s || '').trim())).filter(Boolean);
  const tags = [SERIES_TAG, ...(post.hashtags || []).map(normaliseHashtag)]
    .filter(Boolean)
    .filter((t, i, all) => all.findIndex(x => x.toLowerCase() === t.toLowerCase()) === i)
    .slice(0, 3);
  const text = `${parts.join('\n\n')}\n\n${tags.join(' ')}`.replace(/\n{3,}/g, '\n\n');

  if (URL_TEST.test(text)) throw new Error('post body contains a link; sources belong in the first comment');
  if (/[–—]/.test(text)) throw new Error('post contains an en/em dash');
  if (text.length > MAX_COMMENTARY) throw new Error(`post is ${text.length} chars, over LinkedIn's ${MAX_COMMENTARY}`);
  if (!text.includes(SERIES_TAG)) throw new Error(`post lost the ${SERIES_TAG} tag`);
  return text;
}

/** First comment with any URL the writer was not given removed, so no link is invented. */
export function policeFirstComment(comment, allowedUrls) {
  const allowed = new Set(allowedUrls.map(u => u.replace(/[).,]+$/, '')));
  const cleaned = normaliseDashes(comment)
    .replace(URL_ALL, (u) => (allowed.has(u.replace(/[).,]+$/, '')) ? u : ''))
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return cleaned;
}

/** A news link a reader can open: Google News redirect URLs are useless in a comment. */
export function citableUrl(url) {
  return url && !/news\.google\.com/.test(url) ? url : null;
}

/* ── Prompt pieces ───────────────────────────────────────── */

function ridesBlock(rides) {
  if (!rides?.length) return 'RIDE DATA: none available. Do not mention specific recent rides.';
  return `RIDE DATA (Jorge's own Strava, the only personal riding facts you may use):\n${rides.map(r => `- ${describeDay(r.date)}: ${r.km} km, ${r.elevationM} m de subida, ${r.movingMin} min em movimento${r.avgKmh ? `, média ${r.avgKmh} km/h` : ''}`).join('\n')}`;
}

function recentBlock(recent) {
  if (!recent.length) return '';
  return `\n\nALREADY POSTED in this series (do not repeat the story, the angle or the hook shape):\n${recent.map(p => `- ${p.date} [${p.format}] ${p.hook}`).join('\n')}`;
}

function researchBlock(research) {
  if (!research) return 'RESEARCH: none. Use only the news item.';
  const stats = (research.stats || []).map(s => `- ${s.value}: ${s.context} (${s.source})`).join('\n');
  const insights = (research.insights || []).slice(0, 5).map(i => `- ${i}`).join('\n');
  return `RESEARCH (use only these figures, always say where they come from):\n${stats || '- (no figures)'}${insights ? `\nContext:\n${insights}` : ''}`;
}

/* ── Opus calls ──────────────────────────────────────────── */

const CHOICE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    choice: { type: 'integer', description: 'Index of the chosen news item.' },
    angle: { type: 'string', description: 'In Portuguese, one or two sentences: the specific point Jorge will make that the news story alone does not.' },
    research_query: { type: 'string', description: 'ONE web search query that finds the data behind the issue (not the article again). Portuguese for Brazilian topics, English or Spanish when the subject is international.' }
  },
  required: ['choice', 'angle', 'research_query']
};

export async function chooseStory(client, { shortlist, format, recent, rides }) {
  const items = shortlist.map((c, i) => `${i}. [${c.lens}] ${c.title} (${c.source}, ${c.date ? describeDay(c.date.slice(0, 10)) : 'data desconhecida'})\n   ${c.summary.slice(0, 300)}`).join('\n');
  return writeJson(client, {
    label: 'linkedin story choice',
    effort: 'medium',
    max_tokens: 6000,
    schema: CHOICE_SCHEMA,
    system: `You are the editor of Jorge Bernardo's LinkedIn series.\n\n${SERIES_BRIEF}\n\n${JORGE_CONTEXT}`,
    messages: [{
      role: 'user',
      content: `${promptDateBlock()}\n\nToday's format: ${FORMAT_BRIEFS[format]}\n\nPick the ONE story where Jorge has the most to add for a professional audience, favouring Black, African and Latin-American people in cycling and access to the sport. Prefer substance (a decision, a barrier, data, a career) over results and rumours.\n\nNEWS ITEMS:\n${items}\n\n${ridesBlock(rides)}${recentBlock(recent)}`
    }]
  });
}

const POST_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    hook: { type: 'string' },
    body: { type: 'string', description: 'Paragraphs separated by blank lines. No links, no hashtags.' },
    closing_question: { type: 'string' },
    hashtags: { type: 'array', items: { type: 'string' } },
    first_comment: { type: 'string', description: 'Portuguese. Credits the reporting and gives the source links from the allowed list, one per line. May add one extra fact that did not fit.' },
    photo_choice: { type: 'string', description: 'photo format only: the filename stem from the inventory, else empty.' },
    image_scene: { type: 'string', description: 'ai-image format only: one English sentence describing the editorial scene, else empty.' },
    alt_text: { type: 'string', description: 'Portuguese description of the image for screen readers, empty for text posts.' }
  },
  required: ['hook', 'body', 'closing_question', 'hashtags', 'first_comment', 'photo_choice', 'image_scene', 'alt_text']
};

export async function writePost(client, { story, angle, format, research, rides, recent, inventory, allowedUrls }) {
  const inventoryBlock = format === 'photo' ? `\n\nPHOTO INVENTORY (pick one cycling photo of Jorge; recently used, do not pick: ${inventory.recent.join(', ') || 'none'}):\n${inventory.text}` : '';
  return writeJson(client, {
    label: 'linkedin post',
    effort: 'high',
    schema: POST_SCHEMA,
    system: `You are a ghostwriter for Jorge Bernardo on LinkedIn. Write in Brazilian Portuguese, in his voice: thoughtful, direct, culturally grounded, never corporate.\n\n${SERIES_BRIEF}\n\n${JORGE_CONTEXT}\n\n${VOICE_RULES}`,
    messages: [{
      role: 'user',
      content: `${promptDateBlock()}\n\nFORMAT: ${FORMAT_BRIEFS[format]}\n\nNEWS ITEM (${story.source}, ${story.lang}): ${story.title}\n${story.summary}\n\nANGLE: ${angle}\n\n${researchBlock(research)}\n\nALLOWED SOURCE LINKS for the first comment (use only these, copy exactly):\n${allowedUrls.length ? allowedUrls.map(u => `- ${u}`).join('\n') : '- (none: credit the outlet by name only)'}\n\n${ridesBlock(rides)}${recentBlock(recent)}${inventoryBlock}`
    }]
  });
}
