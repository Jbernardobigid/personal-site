#!/usr/bin/env node
/**
 * scroll-audit — walk a scroll page and report what a single screenshot cannot.
 *
 * A scroll page has no single state: every position is a different frame, and
 * the failures live between the two you happened to look at. `screenshot.mjs`
 * flattens the whole document into one image, which is exactly the view in
 * which travelling parallax, mid-reveal cues, and text-over-photo contrast are
 * invisible.
 *
 * Reports three things:
 *   DEAD SCROLL            consecutive positions where nothing on screen changed
 *   CUES THAT NEVER PEAK   elements that never reach full opacity anywhere
 *   CONTRAST               graded on the composited page, per scroll position
 *
 * Plus a device-per-act table, because a page whose every section uses the same
 * reveal is one section shown N times.
 *
 * Usage:
 *   node scroll-audit.mjs [url] [--width 1440] [--per-act 6] [--out lab/desktop]
 *   node scroll-audit.mjs http://localhost:3000 --width 390 --height 844
 *   node scroll-audit.mjs http://localhost:3000 --reduced-motion
 */

import path from 'path';
import { fileURLToPath } from 'url';

import { capture } from './tools/scroll-audit/capture.mjs';
import { findDeadScroll, findNeverPeak, classifyDevices } from './tools/scroll-audit/analyse.mjs';
import { buildContactSheet } from './tools/scroll-audit/sheet.mjs';
import {
  reportDeadScroll,
  reportNeverPeak,
  reportContrast,
  reportDeviceVariety,
  summarise,
} from './tools/scroll-audit/report.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; i++; }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function integerFlag(flags, name, fallback) {
  if (flags[name] === undefined) return fallback;
  const value = parseInt(flags[name], 10);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid --${name} "${flags[name]}" — expected a positive integer.`);
  }
  return value;
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));

  const url = positional[0] || 'http://localhost:3000';
  const width = integerFlag(flags, 'width', 1440);
  const height = integerFlag(flags, 'height', 900);
  const perAct = integerFlag(flags, 'per-act', 6);
  const reducedMotion = Boolean(flags['reduced-motion']);
  const label = flags.out || (reducedMotion ? 'reduced' : `${width}w`);
  const outDir = path.isAbsolute(String(label))
    ? String(label)
    : path.join(ROOT, 'temporary screenshots', 'scroll-audit', String(label));

  console.log(`scroll-audit  ${url}  ${width}x${height}  ${perAct} positions/act${reducedMotion ? '  reduced-motion' : ''}`);

  const result = await capture({ url, outDir, width, height, perAct, reducedMotion });

  const deadScroll = findDeadScroll(result.frames);
  const neverPeak = findNeverPeak(result.frames);
  const devices = classifyDevices(result.frames, result.acts);

  const described = neverPeak.map((f) => ({ ...f, desc: result.describeMap[f.id] || `#${f.id}` }));

  console.log(reportDeviceVariety(devices));
  console.log(reportDeadScroll(deadScroll));
  console.log(reportNeverPeak(described));
  console.log(reportContrast(result.contrast));

  if (result.consoleErrors.length) {
    console.log(`\nCONSOLE ERRORS (${result.consoleErrors.length}):`);
    for (const e of [...new Set(result.consoleErrors)].slice(0, 10)) console.log('  ' + e);
  }

  const sheetPath = await buildContactSheet(result.frames, path.join(outDir, 'sheet.png'));

  console.log(
    summarise({
      frames: result.frames,
      actCount: result.acts.length,
      deadScroll,
      neverPeak: described,
      contrast: result.contrast,
    })
  );
  console.log(`frames:  ${outDir}`);
  if (sheetPath) console.log(`sheet:   ${sheetPath}`);
  console.log('\nNow read sheet.png. The harness proves a thing moved; it cannot tell you the composition is good.');
}

main().catch((err) => {
  console.error('scroll-audit failed:', err.message);
  process.exit(1);
});
