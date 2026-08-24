/**
 * Findings formatting.
 *
 * Every finding names the scroll position it was seen at, because a scroll page
 * has no single state and "the heading is low contrast" is not actionable
 * without the frame it was low contrast in.
 */

const RULE = '─'.repeat(72);

function heading(title, count) {
  return `\n${RULE}\n${title}  (${count})\n${RULE}`;
}

/** Consecutive sampled positions where nothing on screen changed. */
export function reportDeadScroll(findings) {
  if (!findings.length) return '\nDEAD SCROLL: none. Every sampled step changed something on screen.';
  const lines = findings.map(
    (f) => `  ${f.from}px -> ${f.to}px  (${f.act})  ${f.span}px of scroll, nothing moved`
  );
  return heading('DEAD SCROLL', findings.length) + '\n' + lines.join('\n');
}

/** Elements seen mid-reveal that never reached full opacity anywhere. */
export function reportNeverPeak(findings) {
  if (!findings.length) return '\nCUES THAT NEVER PEAK: none. Every animated element reached full opacity.';
  const lines = findings.map(
    (f) => `  ${f.desc}  peaked at ${(f.max * 100).toFixed(0)}% opacity`
  );
  return heading('CUES THAT NEVER PEAK', findings.length) + '\n' + lines.join('\n');
}

/**
 * Text graded against the real composited background beneath it.
 *
 * Grouped by element: one line failing at forty sampled positions is one
 * problem to fix, not forty findings, and the ungrouped list buries the rare
 * single-position failure that only a moving background produces.
 */
export function reportContrast(findings) {
  if (!findings.length) return '\nCONTRAST: none below threshold on any sampled frame.';

  const byElement = new Map();
  for (const f of findings) {
    const key = f.desc + '|' + f.text;
    const seen = byElement.get(key);
    if (!seen || f.value < seen.worst.value) {
      byElement.set(key, { worst: f, frames: (seen?.frames ?? 0) + 1 });
    } else {
      seen.frames++;
    }
  }

  const groups = [...byElement.values()].sort((a, b) => a.worst.value - b.worst.value);
  const lines = groups.map(({ worst: f, frames }) => {
    const scope = frames === 1 ? 'at 1 position' : `at ${frames} positions`;
    return (
      `  ${String(f.value).padStart(5)}:1  needs ${f.threshold}:1   ${f.layer}, ${f.direction}\n` +
      `           ${f.desc}  "${f.text}"\n` +
      `           worst ${scope}, first in ${f.act} at ${f.scrollY}px  (${Math.round(f.size)}px type)`
    );
  });

  return (
    heading('CONTRAST BELOW THRESHOLD', groups.length) +
    `\n  ${findings.length} failing samples across ${groups.length} distinct elements.\n\n` +
    lines.join('\n\n')
  );
}

/** Device families in play, and where the same one repeats back to back. */
export function reportDeviceVariety(acts) {
  const lines = acts.map((a) => `  ${String(a.label).padEnd(14)} ${a.devices.join(', ') || '(static)'}`);
  const repeats = [];
  for (let i = 1; i < acts.length; i++) {
    const prev = acts[i - 1].devices.join(',');
    const here = acts[i].devices.join(',');
    if (prev && here && prev === here) {
      repeats.push(`  ${acts[i - 1].label} -> ${acts[i].label}  both are "${here}" and nothing else`);
    }
  }
  let out = heading('DEVICE PER ACT', acts.length) + '\n' + lines.join('\n');
  if (repeats.length) {
    out += `\n\n  Same device twice in a row (${repeats.length}):\n` + repeats.join('\n');
  }
  return out;
}

/** One-line verdict the caller can exit on. */
export function summarise(result) {
  const problems =
    result.deadScroll.length + result.neverPeak.length + result.contrast.length;
  return problems === 0
    ? `\nPASS  ${result.frames.length} frames across ${result.actCount} acts, no findings.`
    : `\nFOUND ${problems} issue(s) across ${result.frames.length} frames in ${result.actCount} acts.`;
}
