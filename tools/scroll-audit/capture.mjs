/**
 * Browser driving: plan the walk, take the frames, grade the contrast.
 *
 * Two setup facts that otherwise waste a whole pass:
 *
 *   - Serve it. A `file://` load changes fetch behaviour and font timing, so it
 *     proves nothing about the deployed page.
 *   - Real Chrome, not bundled Chromium. Chromium ships without an h264
 *     decoder, so any clip silently fails to paint and the run "passes"
 *     against poster frames.
 */

import puppeteer from 'puppeteer-core';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

import * as probe from './probe.mjs';
import { signature } from './analyse.mjs';
import { sampleRect, gradeLine } from './contrast.mjs';

const DEFAULT_CHROME =
  'C:/Users/Jorge Bernardo/.cache/puppeteer/chrome/win64-148.0.7778.167/chrome-win64/chrome.exe';

/** Frames settle within this many rAF ticks in practice; the cap is a backstop. */
const SETTLE_FRAMES = 8;
// Long enough to outlast the slowest reveal on the page (1.4s counter tween),
// so a frame is never shot mid-tween and misreported as a cue that never peaks.
const SETTLE_TIMEOUT_MS = 2600;

/**
 * Sample positions across each act's whole *visible life*, from the moment it
 * slides into view to the moment it leaves, not just its fully-on-screen span.
 */
function planPositions(acts, geometry, perAct) {
  const positions = [];
  for (const act of acts) {
    const start = Math.max(0, act.top - geometry.vh * 0.85);
    const end = Math.min(geometry.maxScroll, act.top + act.height - geometry.vh * 0.15);
    const span = Math.max(0, end - start);
    for (let i = 0; i < perAct; i++) {
      const frac = perAct === 1 ? 0.5 : i / (perAct - 1);
      positions.push({ act: act.label, scrollY: Math.round(start + span * frac) });
    }
  }
  // One monotonic pass down the page, so `once: true` reveals fire in the order
  // a real reader would trigger them.
  positions.sort((a, b) => a.scrollY - b.scrollY);
  const deduped = [];
  for (const p of positions) {
    const last = deduped[deduped.length - 1];
    if (last && last.scrollY === p.scrollY && last.act === p.act) continue;
    deduped.push(p);
  }
  return deduped;
}

/**
 * Wait until what is *painted* stops changing, not just until scrolling stops.
 *
 * Settling on scroll position alone lands the shot mid-tween, which reports
 * every reveal as a cue that never reaches full opacity. The signature here is
 * deliberately coarse and viewport-only so it stays cheap enough to run per
 * animation frame.
 */
async function settle(page) {
  await page.evaluate(
    (frames, timeout) =>
      new Promise((resolve) => {
        const deadline = performance.now() + timeout;
        let stable = 0;
        let last = '';

        const snapshot = () => {
          const vh = window.innerHeight;
          const parts = [String(window.scrollY)];
          // Every on-screen element, not a sample of them. Striding the list
          // let settle return while an element it skipped was still tweening,
          // and a frame shot mid-reveal reports that element's transient
          // opacity as a contrast failure.
          const nodes = document.querySelectorAll('[data-sa]');
          for (let i = 0; i < nodes.length; i++) {
            const box = nodes[i].getBoundingClientRect();
            if (box.bottom < 0 || box.top > vh) continue;
            const s = getComputedStyle(nodes[i]);
            parts.push(Math.round(box.top) + ',' + Math.round(parseFloat(s.opacity) * 100));
          }
          return parts.join(';');
        };

        const tick = () => {
          const now = snapshot();
          stable = now === last ? stable + 1 : 0;
          last = now;
          if (stable >= frames || performance.now() > deadline) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    SETTLE_FRAMES,
    SETTLE_TIMEOUT_MS
  );
}

/**
 * Walk the page and capture everything the report needs.
 *
 * @returns {Promise<object>} frames, contrast findings, and geometry
 */
export async function capture(options) {
  const {
    url,
    outDir,
    width = 1440,
    height = 900,
    perAct = 6,
    reducedMotion = false,
    chromePath = process.env.CHROME_PATH || DEFAULT_CHROME,
  } = options;

  if (!fs.existsSync(chromePath)) {
    throw new Error(
      `Chrome not found at ${chromePath}. Bundled Chromium is not a substitute ` +
        `(no h264 decoder). Set CHROME_PATH to a real Chrome build.`
    );
  }
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--force-color-profile=srgb'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    if (reducedMotion) {
      await page.emulateMediaFeatures([
        { name: 'prefers-reduced-motion', value: 'reduce' },
      ]);
    }

    const consoleErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => consoleErrors.push(String(e.message || e)));

    await page.goto(url, { waitUntil: 'networkidle0', timeout: 45000 });

    // `scroll-behavior: smooth` turns every scrollTo into an animation, so the
    // walk lands somewhere between the last position and the next one and every
    // measured delta is wrong. The audit samples resting states; it needs the
    // jump to be instant.
    await page.addStyleTag({ content: 'html, body { scroll-behavior: auto !important; }' });

    await page.evaluate(() => document.fonts && document.fonts.ready);
    await settle(page);

    const geometry = await page.evaluate(probe.readGeometry);
    const acts = await page.evaluate(probe.readActs);
    const { textIds, motionIds } = await page.evaluate(probe.tagTargets);
    const positions = planPositions(acts, geometry, perAct);

    const frames = [];
    const contrast = [];

    for (let i = 0; i < positions.length; i++) {
      const { act, scrollY: requestedY } = positions[i];
      await page.evaluate((y) => window.scrollTo(0, y), requestedY);

      // An in-flight sample, taken before the page settles. Enter-tweens fire
      // and finish inside the settle window, so a settled-only walk never sees
      // a wipe or a word assembly happen and reports the act as having no
      // device at all. Used for device classification only; everything graded
      // for correctness is read from the settled state below.
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
      const earlyState = await page.evaluate(probe.readFrameState, motionIds);

      await settle(page);

      // Read where the page actually came to rest, never where it was asked to
      // go. Requested positions clamp at the document end, and the walk must
      // not treat two frames at the same real offset as movement.
      const scrollY = await page.evaluate(() => Math.round(window.scrollY));
      const state = await page.evaluate(probe.readFrameState, motionIds);
      const targets = await page.evaluate(probe.readTextTargets, textIds);

      const file = path.join(outDir, `f${String(i).padStart(3, '0')}.png`);
      await page.screenshot({ path: file });

      // Re-shoot the same frame twice with the text hidden, so what is sampled
      // is the real background behind each line: scrims, gradients, blend modes
      // and travelling photography all included.
      //
      // Two shots because the question differs by layer. Scrolling copy is
      // graded with the fixed chrome hidden (a fixed bar paints in front of the
      // page, so its fill is not the background behind a headline passing
      // beneath it). The chrome's own labels are graded with it visible,
      // because that bar genuinely is their background.
      const layers = {};
      for (const hideFixed of [true, false]) {
        await page.evaluate(probe.maskForBackground, { textIds, hideFixed });
        const buffer = await page.screenshot({ type: 'png' });
        await page.evaluate(probe.unmask, textIds);
        layers[hideFixed ? 'scrolling' : 'chrome'] = await sharp(buffer)
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
      }

      for (const target of targets) {
        const layer = target.inFixed ? layers.chrome : layers.scrolling;
        const stats = sampleRect(layer.data, layer.info.width, layer.info.height, target.rect);
        const grade = gradeLine(target, stats);
        if (grade && !grade.pass) {
          contrast.push({
            ...grade,
            act,
            scrollY,
            text: target.text,
            size: target.size,
            layer: target.inFixed ? 'fixed chrome' : 'scrolling copy',
            desc: await page.evaluate(probe.describe, target.id),
          });
        }
      }

      frames.push({ index: i, act, scrollY, file, state, earlyState, signature: signature(state) });
    }

    // Resolve handles to readable selectors while the page is still open, so
    // findings computed after teardown can still name what they are about.
    const describeMap = {};
    for (const id of motionIds) {
      describeMap[id] = await page.evaluate(probe.describe, id);
    }

    return { frames, contrast, acts, geometry, consoleErrors, describeMap };
  } finally {
    await browser.close();
  }
}
