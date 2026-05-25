/**
 * analyze-templates.mjs
 * One-time analysis of all 25 Instagram JPG templates.
 * Uses Claude vision to detect text zones, photo zones, colors, and content types.
 * Writes results to brand_assets/JB - Instagram POSTS/template-config.json.
 *
 * Usage:
 *   node analyze-templates.mjs
 *
 * Requires: ANTHROPIC_API_KEY environment variable
 * Safe to re-run — skips templates already in the config.
 */

import './load-env.mjs';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.join(__dirname, 'brand_assets', 'JB - Instagram POSTS');
const CONFIG_PATH = path.join(TEMPLATES_DIR, 'template-config.json');

const TEMPLATE_FILES = [
  'carrossel_ dica.jpg',
  'carrossel_ dica (2).jpg',
  'carrossel_ dica (3).jpg',
  'carrossel_ dica (4).jpg',
  'carrossel_ guia.jpg',
  'carrossel_ guia (2).jpg',
  'carrossel_ guia (3).jpg',
  'carrossel_ guia (4).jpg',
  'carrossel_ guia (5).jpg',
  'checklist.jpg',
  'coringa.jpg',
  'coringa (2).jpg',
  'coringa (3).jpg',
  'coringa (4).jpg',
  'dica.jpg',
  'dica (2).jpg',
  'frase.jpg',
  'frase (2).jpg',
  'guia.jpg',
  'guia (2).jpg',
  'lista.jpg',
  'lista (2).jpg',
  'lista (3).jpg',
  'mitos e verdades.jpg',
  'perguntas e respostas.jpg',
];

const SYSTEM_PROMPT = `You are a design analyst. Your task is to inspect Instagram slide templates and return structured JSON describing their layout zones so a code pipeline can overlay real content onto them.`;

const ANALYSIS_PROMPT = `Analyze this Instagram carousel slide template and return ONLY a valid JSON object (no markdown, no explanation) with this exact structure:

{
  "backgroundColor": "#rrggbb",
  "backgroundIsPhoto": false,
  "layoutStyle": "dark",
  "hasPersonPhoto": false,
  "contentTypes": [],
  "textZones": [
    {
      "role": "headline",
      "top": 5,
      "left": 5,
      "width": 90,
      "height": 12,
      "color": "#ffffff",
      "fontSize": "xl",
      "align": "center",
      "zoneColor": "#2d4a47"
    }
  ],
  "photoZone": null,
  "itemSlots": [],
  "dualBoxes": null
}

Field rules:
- backgroundColor: dominant solid background color as hex (estimate if photo background)
- backgroundIsPhoto: true if the background is a real photo (not a flat color or simple gradient)
- layoutStyle: "dark" if background is dark, "light" if background is light
- hasPersonPhoto: true if there is a person/headshot visible or a clear circular/rectangular photo slot
- contentTypes: array of 1-3 best-fit types from: hook, tip, numbered_tip, guide, list, checklist, myth_truth, qa, photo_reflection, cta
- textZones: ALL visible text placeholder areas. role values: headline, body, label, cta, number. Coordinates are 0-100 as % of image width/height from top-left. fontSize: xl (>48px), lg (32-48px), md (20-32px), sm (<20px). zoneColor: background color of this specific zone area
- photoZone: if hasPersonPhoto, describe the photo placeholder position as { top, left, width, height, shape: "rect"|"circle" }; otherwise null
- itemSlots: for list/checklist/numbered_tip templates, array of up to 6 item positions: [{ top, left, width, height }]. Empty array if not applicable.
- dualBoxes: for myth_truth/qa templates, { box1: { top, left, width, height, label }, box2: { top, left, width, height, label } } or null

Be precise with coordinates. Use the full image as reference (0,0 = top-left corner, 100,100 = bottom-right corner).`;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function analyzeTemplate(filename) {
  const filepath = path.join(TEMPLATES_DIR, filename);
  const imageBuffer = fs.readFileSync(filepath);
  const base64 = imageBuffer.toString('base64');

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: base64 },
          },
          { type: 'text', text: ANALYSIS_PROMPT },
        ],
      },
    ],
  });

  const raw = response.content[0].text.trim();
  const jsonStart = raw.indexOf('{');
  const jsonEnd = raw.lastIndexOf('}');
  if (jsonStart === -1 || jsonEnd === -1) throw new Error('No JSON object found in response');
  return JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY environment variable not set.');
    process.exit(1);
  }

  const existing = fs.existsSync(CONFIG_PATH)
    ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    : {};

  const config = { ...existing };
  let analyzed = 0;
  let skipped = 0;

  for (const filename of TEMPLATE_FILES) {
    const filepath = path.join(TEMPLATES_DIR, filename);
    if (!fs.existsSync(filepath)) {
      console.warn(`  SKIP (not found): ${filename}`);
      skipped++;
      continue;
    }

    if (config[filename]) {
      console.log(`  SKIP (cached): ${filename}`);
      skipped++;
      continue;
    }

    process.stdout.write(`  Analyzing: ${filename} ... `);
    try {
      const result = await analyzeTemplate(filename);
      config[filename] = result;
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
      console.log(`done (${result.contentTypes.join(', ')}, photo: ${result.hasPersonPhoto})`);
      analyzed++;
    } catch (err) {
      console.error(`ERROR: ${err.message}`);
    }

    await new Promise(r => setTimeout(r, 400));
  }

  console.log(`\nAnalysis complete: ${analyzed} analyzed, ${skipped} skipped.`);
  console.log(`Config written to: ${CONFIG_PATH}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
