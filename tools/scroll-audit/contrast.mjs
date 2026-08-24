/**
 * Contrast grading against the *composited* page.
 *
 * The input is a screenshot taken with the text hidden, so scrims, gradients,
 * parallax photography and blend modes are all already baked into the pixels.
 * A static audit of CSS colours cannot see any of that: the frame under a
 * headline changes as the photo behind it travels, so a line can clear 4.5:1
 * at one scroll position and fail badly three hundred pixels later.
 */

/** WCAG relative luminance from 8-bit sRGB. */
export function luminance(r, g, b) {
  const channel = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two relative luminances. */
export function ratio(l1, l2) {
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

/** Parse the `rgb()` / `rgba()` string a computed style hands back. */
export function parseColor(css) {
  const m = String(css).match(/-?[\d.]+/g);
  if (!m || m.length < 3) return null;
  return { r: +m[0], g: +m[1], b: +m[2], a: m.length > 3 ? +m[3] : 1 };
}

/**
 * Luminance statistics for one rect of a raw RGBA buffer.
 *
 * Returns robust extremes (5th/95th percentile) rather than absolute min/max so
 * a single stray antialiased pixel cannot decide the grade.
 */
export function sampleRect(raw, imgW, imgH, rect, scale = 1) {
  const x0 = Math.max(0, Math.round(rect.x * scale));
  const y0 = Math.max(0, Math.round(rect.y * scale));
  const x1 = Math.min(imgW, Math.round((rect.x + rect.w) * scale));
  const y1 = Math.min(imgH, Math.round((rect.y + rect.h) * scale));
  if (x1 <= x0 || y1 <= y0) return null;

  // Cap the work: a full-bleed headline rect can be a megapixel on its own.
  const stepX = Math.max(1, Math.floor((x1 - x0) / 160));
  const stepY = Math.max(1, Math.floor((y1 - y0) / 60));

  const lums = [];
  let sum = 0;
  for (let y = y0; y < y1; y += stepY) {
    for (let x = x0; x < x1; x += stepX) {
      const i = (y * imgW + x) * 4;
      const l = luminance(raw[i], raw[i + 1], raw[i + 2]);
      lums.push(l);
      sum += l;
    }
  }
  if (!lums.length) return null;

  lums.sort((a, b) => a - b);
  const at = (p) => lums[Math.min(lums.length - 1, Math.floor(p * (lums.length - 1)))];
  return { mean: sum / lums.length, p05: at(0.05), p95: at(0.95), n: lums.length };
}

/**
 * Grade one line of text against the background actually behind it.
 *
 * The failure direction is picked per line. Light type on a dark page fails on
 * the brightest patch under it; dark type on a light page fails on the
 * *darkest* one. Grading everything against the brightest patch is the most
 * lenient reading available, and it lets a high-key page report clean over text
 * that is genuinely failing.
 */
/** sRGB channel value whose relative luminance is `l`. */
function grayFor(l) {
  const clamped = Math.min(1, Math.max(0, l));
  const s = clamped <= 0.0031308
    ? clamped * 12.92
    : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
  return s * 255;
}

export function gradeLine(target, stats) {
  const ink = parseColor(target.color);
  if (!ink || !stats) return null;

  // Text drawn at less than full opacity is composited with whatever is behind
  // it, so its own colour is not what the reader sees. Grading the declared
  // colour reports a 70%-opacity label as if it were solid.
  const alpha = (target.alpha ?? 1) * (ink.a ?? 1);

  let inkL = luminance(ink.r, ink.g, ink.b);
  const lightInk = inkL > stats.mean;
  const worstBgL = lightInk ? stats.p95 : stats.p05;

  if (alpha < 0.999) {
    const bg = grayFor(worstBgL);
    inkL = luminance(
      alpha * ink.r + (1 - alpha) * bg,
      alpha * ink.g + (1 - alpha) * bg,
      alpha * ink.b + (1 - alpha) * bg
    );
  }

  const value = ratio(inkL, worstBgL);
  const threshold = target.large ? 3.0 : 4.5;

  return {
    value: Math.round(value * 100) / 100,
    threshold,
    pass: value >= threshold,
    direction: lightInk ? 'light-on-dark' : 'dark-on-light',
    alpha: Math.round(alpha * 100) / 100,
    inkL: Math.round(inkL * 1000) / 1000,
    bgL: Math.round(worstBgL * 1000) / 1000,
  };
}
