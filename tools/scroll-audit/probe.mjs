/**
 * In-page instrumentation for the scroll audit.
 *
 * Every export here is serialised by Puppeteer and executed inside the page, so
 * each one must be fully self-contained: no imports, no closure variables, no
 * references to anything else in this module. Arguments arrive through
 * `page.evaluate(fn, ...args)`.
 */

/** Viewport and document geometry the sampler needs to plan its walk. */
export function readGeometry() {
  const vh = window.innerHeight;
  const docH = Math.max(
    document.body.scrollHeight,
    document.documentElement.scrollHeight
  );
  return { vh, vw: window.innerWidth, docH, maxScroll: Math.max(0, docH - vh) };
}

/**
 * Discover the acts to walk. An act is a top-level narrative block: the
 * sections plus the footer. Sampling *within* each act rather than uniformly
 * down the document keeps findings anchored when an unrelated section's height
 * changes.
 */
export function readActs() {
  // Not `body > section`: a pinned act gets wrapped in a spacer by the motion
  // library, which silently drops it from the walk. The act that most needs
  // sampling is exactly the one that pins, so match by nesting depth instead.
  const nodes = Array.prototype.filter.call(
    document.querySelectorAll('section, body > footer'),
    function (el) { return !el.parentElement.closest('section'); }
  );
  return nodes.map(function (el, i) {
    const box = el.getBoundingClientRect();
    return {
      index: i,
      label: el.id || el.tagName.toLowerCase() + ':' + i,
      top: Math.round(box.top + window.scrollY),
      height: Math.round(box.height),
    };
  });
}

/**
 * Tag every element that paints its own text, plus every element the motion
 * layer plausibly touches. Tagging once gives every later call a stable handle
 * that survives re-layout, which selector strings do not.
 */
export function tagTargets() {
  let n = 0;
  const textIds = [];
  const motionIds = [];

  function hasOwnText(el) {
    return Array.prototype.some.call(el.childNodes, function (node) {
      return node.nodeType === 3 && node.textContent.trim().length > 1;
    });
  }

  const all = document.querySelectorAll('body *');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    const tag = el.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') continue;

    const id = String(n++);
    el.setAttribute('data-sa', id);

    if (hasOwnText(el)) textIds.push(id);

    // Decorative layers declare themselves. An atmospheric wash that tops out
    // at 34% is doing its job, not failing to arrive, so it is tracked for
    // movement but exempt from the never-reaches-full-opacity check.
    const decorative = !!el.closest('[aria-hidden="true"]');

    const cls = typeof el.className === 'string' ? el.className : '';
    const style = getComputedStyle(el);
    if (/gsap|reveal|hidden|parallax|stat|item|row|photo|heading|pin|wipe|drift|w-i/i.test(cls)) {
      motionIds.push(id);
    } else if (style.opacity !== '1' || style.transform !== 'none') {
      motionIds.push(id);
    }
    if (decorative) el.setAttribute('data-sa-deco', '1');
  }
  return { textIds: textIds, motionIds: motionIds, total: n };
}

/**
 * Everything that is actually painted right now, per on-stage element.
 *
 * Deliberately records *rendered* values (opacity, translation, clip-path,
 * ground colour, video playhead) and never raw scroll progress. Progress always
 * changes; a page whose progress moves while its composition does not is
 * exactly the false-green the dead-scroll check exists to catch.
 */
export function readFrameState(motionIds) {
  const els = {};
  const vh = window.innerHeight;

  // `fixed` and `sticky` need separate answers. Fixed-for-the-whole-walk is
  // chrome and gets excluded from motion classification; sticky is a held
  // stage that only acts pinned while it is stuck, so it stays in and is
  // judged geometrically.
  function positionKind(node) {
    let sticky = false;
    for (let p = node; p && p !== document.body; p = p.parentElement) {
      const pos = getComputedStyle(p).position;
      if (pos === 'fixed') return { fixed: true, sticky: sticky };
      if (pos === 'sticky') sticky = true;
    }
    return { fixed: false, sticky: sticky };
  }

  for (let i = 0; i < motionIds.length; i++) {
    const id = motionIds[i];
    const el = document.querySelector('[data-sa="' + id + '"]');
    if (!el) continue;
    const box = el.getBoundingClientRect();
    // Keep a half-viewport margin: entry and exit slides are where a parked
    // parallax or a frozen clip is most visible, and sampling only the fully
    // on-screen span is how that class of bug survives a green run.
    if (box.bottom < -vh * 0.5 || box.top > vh * 1.5) continue;

    const s = getComputedStyle(el);
    const pos = positionKind(el);
    let tx = 0;
    let ty = 0;
    let sx = 1;
    if (s.transform && s.transform !== 'none') {
      const n = s.transform.match(/-?[\d.]+/g);
      if (n) {
        if (n.length >= 6) { sx = +n[0]; tx = +n[4]; ty = +n[5]; }
        if (n.length >= 16) { sx = +n[0]; tx = +n[12]; ty = +n[13]; }
      }
    }

    els[id] = {
      o: Math.round(parseFloat(s.opacity) * 100) / 100,
      tx: Math.round(tx * 10) / 10,
      ty: Math.round(ty * 10) / 10,
      sx: Math.round(sx * 1000) / 1000,
      top: Math.round(box.top),
      clip: s.clipPath === 'none' ? '' : s.clipPath,
      onScreen: box.bottom > 0 && box.top < vh,
      // Chrome that never scrolls holds its viewport position by definition.
      // Counting it as a pin would report every act on the page as pinned, and
      // the test has to walk ancestors: a child of the fixed nav computes as
      // `static` or `absolute` while still never moving.
      fx: pos.fixed,
      stk: pos.sticky,
      deco: el.hasAttribute('data-sa-deco'),
      kin: el.classList.contains('w-i'),
      // Where this element lives in the document, so a device can be credited
      // to the act that owns the element rather than to whichever sampling
      // window happened to catch it moving.
      docY: Math.round(box.top + window.scrollY),
    };
  }

  const vids = [];
  const nodes = document.querySelectorAll('video');
  for (let i = 0; i < nodes.length; i++) {
    vids.push({ t: +(nodes[i].currentTime || 0).toFixed(2), ready: nodes[i].readyState });
  }

  const custom = [];
  const stateful = document.querySelectorAll('[data-sa-state]');
  for (let i = 0; i < stateful.length; i++) {
    custom.push(stateful[i].getAttribute('data-sa-state'));
  }

  return {
    els: els,
    bg: getComputedStyle(document.body).backgroundColor,
    videos: vids,
    custom: custom,
  };
}

/** A readable description of one tagged element, for report lines. */
export function describe(id) {
  const el = document.querySelector('[data-sa="' + id + '"]');
  if (!el) return id;
  const cls = typeof el.className === 'string' && el.className
    ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
    : '';
  return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + cls;
}

/**
 * Text currently on screen, with each rect clamped to the viewport.
 *
 * The clamp matters: the half of a heading that has scrolled above the fold is
 * not on screen, so whatever sits in those pixels is not behind anything the
 * reader can see, and grading against it invents failures.
 */
export function readTextTargets(textIds) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const out = [];

  // Opacity does not inherit the way visibility does: an element computing
  // opacity 1 inside a faded-out ancestor still paints nothing. A closed
  // drawer left at `opacity: 0` is otherwise graded as live text sitting over
  // whatever happens to be behind it, which invents failures that no reader
  // can see.
  function effectiveOpacity(node) {
    let value = 1;
    for (let p = node; p && p !== document.documentElement; p = p.parentElement) {
      value *= parseFloat(getComputedStyle(p).opacity);
      if (value < 0.01) return 0;
    }
    return value;
  }

  for (let i = 0; i < textIds.length; i++) {
    const el = document.querySelector('[data-sa="' + textIds[i] + '"]');
    if (!el) continue;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none') continue;

    // Frames are only sampled once the page has settled, so a low opacity here
    // is a design state rather than a transition. Grade it at that opacity
    // instead of skipping it: deliberately faded text is exactly where
    // contrast fails, and skipping it hides the worst offenders.
    const alpha = effectiveOpacity(el);
    if (alpha < 0.06) continue; // a hidden layer, not faint type

    const box = el.getBoundingClientRect();
    const x = Math.max(0, box.left);
    const y = Math.max(0, box.top);
    const r = Math.min(vw, box.right);
    const b = Math.min(vh, box.bottom);
    if (r - x < 8 || b - y < 8) continue;

    const size = parseFloat(s.fontSize);
    const weight = parseInt(s.fontWeight, 10) || 400;

    // Chrome that paints in front of the scroll needs the opposite treatment
    // from scrolling copy: its background is its own bar, not whatever happens
    // to be travelling underneath it at this position.
    let inFixed = false;
    for (let p = el; p && p !== document.body; p = p.parentElement) {
      const ps = getComputedStyle(p);
      if (ps.position === 'fixed' || ps.position === 'sticky') { inFixed = true; break; }
    }

    out.push({
      id: textIds[i],
      rect: { x: Math.round(x), y: Math.round(y), w: Math.round(r - x), h: Math.round(b - y) },
      color: s.color,
      alpha: Math.round(alpha * 1000) / 1000,
      size: size,
      inFixed: inFixed,
      // WCAG large text: >=24px, or >=18.66px when bold.
      large: size >= 24 || (size >= 18.66 && weight >= 700),
      text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 58),
    });
  }
  return out;
}

/**
 * Hide the text so the next screenshot shows the real background behind each
 * line, with scrims, gradients, blends and travelling photography included.
 *
 * `hideFixed` decides which background question is being asked. Hide the fixed
 * chrome to grade *scrolling* copy, because a fixed bar paints in front of what
 * scrolls under it and its own fill is not the background behind a passing
 * headline. Leave it visible to grade the chrome's own labels, whose background
 * really is that bar.
 */
export function maskForBackground(args) {
  const textIds = args.textIds;
  for (let i = 0; i < textIds.length; i++) {
    const el = document.querySelector('[data-sa="' + textIds[i] + '"]');
    if (el) el.style.setProperty('visibility', 'hidden', 'important');
  }
  if (!args.hideFixed) return true;

  const all = document.querySelectorAll('body *');
  for (let i = 0; i < all.length; i++) {
    const s = getComputedStyle(all[i]);
    if (s.position === 'fixed' && s.visibility !== 'hidden') {
      all[i].setAttribute('data-sa-fixed', '1');
      all[i].style.setProperty('visibility', 'hidden', 'important');
    }
  }
  return true;
}

/** Undo maskForBackground. */
export function unmask(textIds) {
  for (let i = 0; i < textIds.length; i++) {
    const el = document.querySelector('[data-sa="' + textIds[i] + '"]');
    if (el) el.style.removeProperty('visibility');
  }
  const fixed = document.querySelectorAll('[data-sa-fixed]');
  for (let i = 0; i < fixed.length; i++) {
    fixed[i].style.removeProperty('visibility');
    fixed[i].removeAttribute('data-sa-fixed');
  }
  return true;
}
