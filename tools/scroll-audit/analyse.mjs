/**
 * Turn a walk of frame states into findings.
 *
 * Kept separate from capture so the rules can be reasoned about (and changed)
 * without touching the browser driving, and so a recorded walk can be re-graded
 * without re-shooting it.
 */

/** How far an element must travel between two frames to count as "moved", in px. */
const MOVE_EPSILON = 0.6;
/** Opacity delta that counts as a change. */
const FADE_EPSILON = 0.02;
/** An element is treated as fully revealed at or above this opacity. */
const PEAK_TARGET = 0.98;

/** Compact string of everything painted, used only for equality between frames. */
export function signature(state) {
  const parts = [];
  const ids = Object.keys(state.els).sort();
  for (const id of ids) {
    const e = state.els[id];
    parts.push(`${id}:${e.o}:${e.tx}:${e.ty}:${e.sx}:${e.top}:${e.clip}`);
  }
  parts.push('bg:' + state.bg);
  for (const v of state.videos) parts.push(`v:${v.t}:${v.ready}`);
  for (const c of state.custom) parts.push('st:' + c);
  return parts.join('|');
}

/**
 * Consecutive positions where nothing on screen changed.
 *
 * Real dead scroll means the reader is turning the wheel and being given
 * nothing. The fix is to shorten the act's span or give it a cue, not to widen
 * the tolerance here.
 */
export function findDeadScroll(frames) {
  const out = [];
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1];
    const b = frames[i];
    if (a.act !== b.act) continue; // a cut between acts is not dead scroll
    if (a.scrollY === b.scrollY) continue; // clamped at the document end
    if (a.signature === b.signature) {
      out.push({
        act: b.act,
        from: a.scrollY,
        to: b.scrollY,
        span: b.scrollY - a.scrollY,
      });
    }
  }
  return out;
}

/**
 * Elements seen part-way through a reveal that never reached full opacity on
 * any sampled frame. Usually a cue window too narrow for its act.
 *
 * Only elements observed *below* full opacity at least once are graded, so a
 * permanently dimmed decorative element is not reported as a broken reveal.
 */
export function findNeverPeak(frames) {
  const max = new Map();
  const min = new Map();

  for (const frame of frames) {
    for (const [id, el] of Object.entries(frame.state.els)) {
      if (!el.onScreen || el.deco) continue;
      max.set(id, Math.max(max.get(id) ?? 0, el.o));
      min.set(id, Math.min(min.get(id) ?? 1, el.o));
    }
  }

  const out = [];
  for (const [id, peak] of max) {
    if (peak >= PEAK_TARGET) continue;
    // An element that held one opacity for the whole walk is a design decision
    // (a dimmed nav link, a hairline separator), not a reveal that stalled.
    // Only something that was seen moving and still never arrived is a defect.
    if (peak - (min.get(id) ?? peak) < FADE_EPSILON) continue;
    out.push({ id, max: peak, from: min.get(id) ?? 0 });
  }
  return out.sort((a, b) => a.max - b.max);
}

/**
 * Classify which device families an act actually uses, from what moved.
 *
 * This is the check that catches a page made of one idea repeated: five
 * sections that behave identically are one section shown five times.
 */
export function classifyDevices(frames, actList) {
  // Credit a device to the act that owns the element, not to the sampling
  // window that caught it. An enter-tween on a section's first element often
  // fires while the previous act is still the nearest sample.
  const ownerOf = (docY) => {
    let owner = actList[0];
    for (const act of actList) {
      if (docY >= act.top - 1) owner = act;
    }
    return owner ? owner.label : (actList[0] && actList[0].label);
  };

  const devices = new Map();
  const add = (label, device) => {
    if (!label) return;
    if (!devices.has(label)) devices.set(label, new Set());
    devices.get(label).add(device);
  };

  // A pinned act is implemented as `position: fixed`, which is also what the
  // nav is. The difference is duration: chrome is fixed for the whole walk, a
  // pin only while its act holds the stage. Anything fixed everywhere it
  // appears is chrome and is excluded from motion classification entirely.
  const seen = new Map();
  const fixedIn = new Map();
  const anchorY = new Map();
  for (const frame of frames) {
    for (const [id, el] of Object.entries(frame.state.els)) {
      seen.set(id, (seen.get(id) ?? 0) + 1);
      if (el.fx) fixedIn.set(id, (fixedIn.get(id) ?? 0) + 1);
      // While pinned, docY sweeps down the document as the page scrolls under
      // the held stage, so only an unpinned reading anchors the element.
      else if (!anchorY.has(id)) anchorY.set(id, el.docY);
    }
  }
  const isChrome = (id) => (fixedIn.get(id) ?? 0) >= (seen.get(id) ?? 0);

  // Compare every adjacent pair in both the settled and the in-flight walks.
  const walks = [frames.map((f) => ({ ...f, state: f.state })),
                 frames.map((f) => ({ ...f, state: f.earlyState || f.state }))];

  for (const walk of walks) {
    for (let i = 1; i < walk.length; i++) {
      const prev = walk[i - 1].state;
      const here = walk[i].state;
      const scrolled = walk[i].scrollY - walk[i - 1].scrollY;

      for (let v = 0; v < here.videos.length; v++) {
        if (prev.videos[v] && Math.abs(prev.videos[v].t - here.videos[v].t) > 0.01) {
          add(walk[i].act, 'scrub');
        }
      }

      for (const [id, now] of Object.entries(here.els)) {
        const was = prev.els[id];
        if (!was) continue;

        // Drift is graded before the chrome filter: the ground is a fixed
        // layer by construction, so filtering fixed elements first would hide
        // the one device that is *supposed* to be fixed and changing.
        if (now.deco) {
          if (Math.abs(was.o - now.o) > FADE_EPSILON) add(walk[i].act, 'drift');
          continue;
        }
        if (isChrome(id)) continue;

        const label = ownerOf(anchorY.has(id) ? anchorY.get(id) : now.docY);

        // Held stage: fixed only while its act owns the screen.
        if (now.fx && (!was.fx || (Math.abs(now.top - was.top) < 2 && Math.abs(scrolled) > 40))) {
          add(label, 'pin');
        }

        if (was.clip !== now.clip) add(label, 'reveal');
        if (Math.abs(was.o - now.o) > FADE_EPSILON) add(label, 'fade-in');
        if (Math.abs(was.sx - now.sx) > 0.004) add(label, 'scale');
        // Lateral travel is its own family and reads as "options" where
        // vertical reads as "argument". Tracking only translateY made every
        // x-slide invisible to the device table.
        if (Math.abs(was.tx - now.tx) > MOVE_EPSILON) add(label, 'slide');

        // Type assembling from behind its own baseline is its own family, and
        // reads as parallax to a purely geometric test.
        if (now.kin) {
          if (Math.abs(was.ty - now.ty) > MOVE_EPSILON) add(label, 'kinetic');
          continue;
        }

        // An element translating against its own scroll travel is parallax; one
        // holding its viewport position while the page scrolls is a pin.
        if (now.fx || was.fx || scrolled === 0) continue;

        if (Math.abs(was.ty - now.ty) > MOVE_EPSILON && Math.abs(now.o - was.o) <= FADE_EPSILON) {
          add(label, 'parallax');
        }
        // Only sticky elements are geometric pin candidates. Applying this to
        // everything reads clamped scroll and mid-tween frames as held stages.
        if (now.stk && Math.abs(now.top - was.top) < 3 && Math.abs(scrolled) > 40 && now.onScreen) {
          add(label, 'pin');
        }
      }
    }
  }

  return actList.map((act) => ({
    label: act.label,
    devices: [...(devices.get(act.label) || [])].sort(),
  }));
}
