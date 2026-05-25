/**
 * agent-templates.mjs
 * Regenerates HTML carousel templates from the live Canva brand design.
 *
 * Pipeline per content type:
 *   1. Export the canonical Canva page as a JPEG via Canva MCP
 *   2. Claude Sonnet analyzes the image and generates 1080×1080 HTML/CSS
 *   3. Validate required {{VARS}} are present
 *   4. Save to templates/html/{contentType}.html
 *
 * Usage:
 *   node agent-templates.mjs                   # generate all 10 types (skips cached)
 *   node agent-templates.mjs hook tip cta       # specific types only
 *   node agent-templates.mjs --force            # regenerate even if cached
 *
 * Requires: ANTHROPIC_API_KEY in .env
 * Requires: Canva MCP authenticated in Claude Code (run once via IDE)
 *
 * NOTE: This script uses the Canva export URLs that were pre-fetched and
 * stored in templates/canva-page-map.json. Re-run with --refresh-exports
 * to fetch fresh signed URLs from Canva (they expire after ~24h).
 */

import './load-env.mjs';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, 'templates', 'html');
const THUMBNAILS_DIR = path.join(__dirname, 'temp', 'canva-thumbnails');
const PAGE_MAP_PATH = path.join(__dirname, 'templates', 'canva-page-map.json');

const CONTENT_TYPES = [
  'hook', 'tip', 'numbered_tip', 'guide', 'list',
  'checklist', 'myth_truth', 'qa', 'photo_reflection', 'cta',
];

// Canva design page → content type mapping (from visual analysis of DAGulAA_7MI)
const CANONICAL_PAGE = {
  hook:             27,
  tip:              20,
  numbered_tip:      3,
  guide:             4,
  list:              9,
  checklist:         8,
  myth_truth:        7,
  qa:               12,
  photo_reflection:  1,
  cta:              25,
};

// Which {{VARS}} each template must contain
const REQUIRED_VARS = {
  hook:             ['{{HEADLINE}}', '{{BODY}}'],
  tip:              ['{{HEADLINE}}', '{{BODY}}'],
  numbered_tip:     ['{{HEADLINE}}', '{{ITEMS_HTML}}'],
  guide:            ['{{HEADLINE}}', '{{ITEMS_HTML}}'],
  list:             ['{{HEADLINE}}', '{{ITEMS_HTML}}'],
  checklist:        ['{{HEADLINE}}', '{{ITEMS_HTML}}'],
  myth_truth:       ['{{MYTH}}', '{{TRUTH}}'],
  qa:               ['{{QUESTION}}', '{{ANSWER}}'],
  photo_reflection: ['{{HEADLINE}}', '{{BODY}}', '{{PHOTO_URL}}'],
  cta:              ['{{HEADLINE}}', '{{BODY}}'],
};

const ZONE_SPECS = {
  hook: `
TEXT ZONES (use these exact placeholder strings):
  {{HEADLINE}} — Large, bold hook statement. Position prominently on the slide.
  {{BODY}} — Smaller supporting sentence below the headline.`,

  tip: `
TEXT ZONES (use these exact placeholder strings):
  {{HEADLINE}} — Bold tip title.
  {{BODY}} — Explanation text (2–3 sentences) below the headline.`,

  numbered_tip: `
TEXT ZONES (use these exact placeholder strings):
  {{HEADLINE}} — Section title near the top.
  {{ITEMS_HTML}} — Inject inside <div class="items-container">{{ITEMS_HTML}}</div>.
    Style .items-container and .item for numbered item readability.`,

  guide: `
TEXT ZONES (use these exact placeholder strings):
  {{HEADLINE}} — Guide title near the top.
  {{ITEMS_HTML}} — Inject inside <div class="items-container">{{ITEMS_HTML}}</div>.
    Style .items-container and .item for numbered step readability.`,

  list: `
TEXT ZONES (use these exact placeholder strings):
  {{HEADLINE}} — List title near the top.
  {{ITEMS_HTML}} — Inject inside <div class="items-container">{{ITEMS_HTML}}</div>.`,

  checklist: `
TEXT ZONES (use these exact placeholder strings):
  {{HEADLINE}} — Checklist title near the top.
  {{ITEMS_HTML}} — Inject inside <div class="items-container">{{ITEMS_HTML}}</div>.`,

  myth_truth: `
TEXT ZONES (use these exact placeholder strings):
  {{MYTH}} — The misconception text inside a "MITO" labeled box.
  {{TRUTH}} — The reality text inside a "VERDADE" labeled box.
  The labels "MITO" and "VERDADE" are hard-coded in the HTML — not variables.`,

  qa: `
TEXT ZONES (use these exact placeholder strings):
  {{QUESTION}} — The question text inside a "PERGUNTA" labeled box.
  {{ANSWER}} — The answer text inside a "RESPOSTA" labeled box.
  The labels "PERGUNTA" and "RESPOSTA" are hard-coded in the HTML — not variables.`,

  photo_reflection: `
TEXT ZONES (use these exact placeholder strings):
  {{PHOTO_URL}} — src attribute of an <img> element for Jorge's photo.
    Use exactly: <img src="{{PHOTO_URL}}" style="position:absolute; [zone styles]; object-fit:cover;">
  {{HEADLINE}} — Reflection headline overlaid on or adjacent to the photo zone.
  {{BODY}} — Personal reflection body text.`,

  cta: `
TEXT ZONES (use these exact placeholder strings):
  {{HEADLINE}} — Main call-to-action headline.
  {{BODY}} — Secondary CTA text (e.g. "Link na bio ↗").`,
};

function buildPrompt(contentType) {
  return `You are a world-class Instagram designer and senior frontend developer.

I'm showing you a professional Instagram carousel slide from the brand "JB" — Jorge Bernardo, a Black Brazilian cyclist, data security professional, and entrepreneur.

YOUR TASK: Recreate this slide as clean, production-ready HTML/CSS using template variable placeholders instead of real text content.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CONTENT TYPE: ${contentType.toUpperCase()}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${ZONE_SPECS[contentType]}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STRUCTURAL REQUIREMENTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. DIMENSIONS: Exactly width:1080px; height:1080px — no scrollbars.
   Use: <div id="slide" style="width:1080px;height:1080px;position:relative;overflow:hidden;">

2. POSITIONING: position:absolute with px coordinates for all inner elements.
   ALL elements must fit within 0–1080px × 0–1080px.

3. FONTS: Import Google Fonts in <head> matching the reference image's typography.
   The design uses a high-contrast serif (like Cormorant Garamond) for headlines
   and a geometric sans-serif (like Montserrat) for labels/handles.

4. TYPOGRAPHY SCALE (for 1080×1080):
   - Headline: 52–72px, font-weight 700–900
   - Body text: 24–30px, line-height 1.4–1.6
   - Labels/uppercase: 10–14px, letter-spacing 2–4px, text-transform uppercase

5. DESIGN FIDELITY: Extract from the reference image:
   - Exact background color (not a generic guess)
   - All decorative elements: bars, dividers, shapes, geometric accents
   - @jotabernardO handle element if visible
   - Color palette — use the exact accent colors seen in the design
   - The brand accent color is approximately #C8A96E (gold/tan)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WHAT TO AVOID
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- NO hardcoded sample content (no "Lorem ipsum", no example text)
- NO content overflowing 1080×1080
- NO external images except Google Fonts CDN and {{PHOTO_URL}}
- NO markdown code fences

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OUTPUT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Return ONLY the complete HTML document starting with <!DOCTYPE html>.
No explanation. No markdown. Start directly with <!DOCTYPE html>.`;
}

function extractHtml(raw) {
  let start = raw.indexOf('<!DOCTYPE html>');
  if (start === -1) start = raw.indexOf('<!DOCTYPE HTML>');
  if (start === -1) start = raw.indexOf('<!doctype html>');
  if (start === -1) start = raw.indexOf('<html');
  const end = raw.lastIndexOf('</html>');
  if (start === -1 || end === -1) return null;
  return raw.slice(start, end + 7);
}

function validateVars(html, contentType) {
  return (REQUIRED_VARS[contentType] ?? []).filter(v => !html.includes(v));
}

function thumbnailPath(pageNum) {
  return path.join(THUMBNAILS_DIR, `page${String(pageNum).padStart(2, '0')}.jpg`);
}

async function generateTemplate(client, contentType) {
  const pageNum = CANONICAL_PAGE[contentType];
  const imgPath = thumbnailPath(pageNum);

  if (!fs.existsSync(imgPath)) {
    throw new Error(
      `Canva thumbnail not found: ${imgPath}\n` +
      `Re-export Canva design DAGulAA_7MI thumbnails to temp/canva-thumbnails/`
    );
  }

  const base64 = fs.readFileSync(imgPath).toString('base64');

  process.stdout.write(`  Generating ${contentType} (page ${pageNum})... `);

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8000,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: base64 },
          },
          { type: 'text', text: buildPrompt(contentType) },
        ],
      },
    ],
  });

  const raw = response.content[0].text ?? '';
  const html = extractHtml(raw);
  if (!html) throw new Error('No valid HTML returned');

  const missing = validateVars(html, contentType);
  if (missing.length > 0) {
    console.warn(`\n  Warning: missing vars: ${missing.join(', ')}`);
  } else {
    process.stdout.write('ok\n');
  }

  return html;
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY not set in .env');
    process.exit(1);
  }

  if (!fs.existsSync(THUMBNAILS_DIR)) {
    console.error(
      `Error: ${THUMBNAILS_DIR} not found.\n` +
      `Export the Canva design first (see temp/canva-thumbnails/).`
    );
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const requested = args.filter(a => !a.startsWith('--') && CONTENT_TYPES.includes(a));
  const toProcess = requested.length > 0 ? requested : CONTENT_TYPES;

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  console.log(`\nGenerating HTML templates from Canva design DAGulAA_7MI`);
  console.log(`(${toProcess.length} type${toProcess.length > 1 ? 's' : ''})\n`);

  let generated = 0;
  let skipped = 0;
  let errors = 0;

  for (const contentType of toProcess) {
    const outPath = path.join(OUTPUT_DIR, `${contentType}.html`);

    if (!force && fs.existsSync(outPath)) {
      console.log(`  SKIP (cached): ${contentType}`);
      skipped++;
      continue;
    }

    try {
      const html = await generateTemplate(client, contentType);
      fs.writeFileSync(outPath, html, 'utf8');
      const kb = Math.round(html.length / 1024);
      console.log(`  Saved: templates/html/${contentType}.html (${kb} KB)`);
      generated++;
    } catch (err) {
      console.error(`  ERROR (${contentType}): ${err.message}`);
      errors++;
    }

    // Avoid API rate limits
    await new Promise(r => setTimeout(r, 600));
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`Done: ${generated} generated, ${skipped} skipped, ${errors} errors`);
  console.log(`Templates saved to: templates/html/`);
  console.log(`Run "node generate-carousel.mjs" to generate slides.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
