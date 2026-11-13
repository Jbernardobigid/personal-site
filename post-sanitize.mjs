/**
 * post-sanitize.mjs
 * Output safety for generated blog HTML: the post-body sanitizer and the JSON-LD
 * serializer. Pure functions, no dependencies, no I/O. Used by generate-post.mjs.
 *
 * The post body is model output grounded in scraped news, so a prompt injection in a
 * feed item can end up there as markup. The previous sanitizer was a regex blocklist and
 * let <svg/onload=alert(1)> and entity-encoded javascript: URLs straight through, onto a
 * page whose CSP allows inline script.
 */

// An allowlist that is safe by construction: escape EVERYTHING, then turn back only the
// bare tags a post actually uses. No attribute survives, so there is no handler, href or
// src to get wrong. Every published body uses only these tags with zero attributes, so
// nothing real is lost. Deliberately dependency-free: the generator runs on a VPS cron
// and must not break on a missing package.
const ALLOWED_BODY_TAGS = ['p', 'h2', 'h3', 'strong', 'em', 'blockquote', 'ul', 'ol', 'li'];
const ALLOWED_TAG_NAMES = ALLOWED_BODY_TAGS.join('|');

// An escaped allowlisted tag, with optional attributes (discarded) or a self-closing slash.
const ESCAPED_ALLOWED_TAG = new RegExp(
  `&lt;(/?)(${ALLOWED_TAG_NAMES})(?:\\s(?:(?!&lt;|&gt;)[\\s\\S])*|/)?&gt;`, 'gi');

// "&" that does not already start an entity. Entities are kept as written: in element
// content they can only ever decode to text.
const BARE_AMPERSAND = /&(?!(?:[a-z][a-z0-9]{1,31}|#\d{1,7}|#x[0-9a-f]{1,6});)/gi;

// Cosmetic only, never relied on for safety: without these a blocked element would show
// up in the post as visible source text instead of disappearing.
const DROPPED_ELEMENTS = /<(script|style|iframe|object|noscript|template)\b[\s\S]*?<\/\1\s*>/gi;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const UNLISTED_TAG = new RegExp(`</?(?!(?:${ALLOWED_TAG_NAMES})(?:[\\s/>]|$))[a-z][^>]*>`, 'gi');

/**
 * Reduce model-written HTML to the allowlisted, attribute-free tags.
 * @param {unknown} html
 * @returns {string} markup in which every "<" opens or closes an allowlisted bare tag
 */
export function sanitizeContent(html) {
  const tidied = String(html ?? '')
    .replace(DROPPED_ELEMENTS, '')
    .replace(HTML_COMMENT, '')
    .replace(UNLISTED_TAG, '');
  const escaped = tidied
    .replace(BARE_AMPERSAND, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  // The only place a "<" is ever written back.
  return escaped.replace(ESCAPED_ALLOWED_TAG, (_match, slash, tag) => `<${slash}${tag.toLowerCase()}>`);
}

const JSON_ESCAPED_LESS_THAN = '\\u003c';

/**
 * JSON for a <script type="application/ld+json"> block. JSON.stringify leaves the
 * less-than sign as is, so a value containing a closing script tag would end the element
 * and start a real one. Its JSON unicode escape is the same character to a JSON parser
 * and inert to the HTML parser.
 * @param {unknown} data
 * @returns {string}
 */
export function jsonLdScript(data) {
  return JSON.stringify(data, null, 2).replace(/</g, JSON_ESCAPED_LESS_THAN);
}
