// Hand-drawn pencil strokes as SVG path data. Seeded, so a mark keeps its shape across re-renders.

export function rng(seed) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

const jit = (r, amt) => (r() - 0.5) * 2 * amt;
const pt = (x, y) => `${x.toFixed(1)},${y.toFixed(1)}`;

// A line drawn through text, overshooting both ends a little.
export function strike(x1, x2, y, r) {
  const a = [x1 - 3 + jit(r, 1.5), y + jit(r, 1)];
  const b = [x2 + 3 + jit(r, 1.5), y + jit(r, 1.2)];
  const m = [(a[0] + b[0]) / 2 + jit(r, 4), (a[1] + b[1]) / 2 + jit(r, 1.4)];
  return `M${pt(...a)} Q${pt(...m)} ${pt(...b)}`;
}

// The proofreader's delete mark: a small pigtail loop rising off the end of a strike.
export function pigtail(x, y, r) {
  const s = 1 + jit(r, 0.12);
  const P = (dx, dy) => pt(x + dx * s, y + dy * s);
  return `M${P(0, 0)} C${P(7, -1)} ${P(12, -9)} ${P(8, -14)} C${P(4, -18)} ${P(-1, -12)} ${P(4, -9)} C${P(8, -6)} ${P(13, -8)} ${P(17, -13)}`;
}

// Wavy underline for phrases that are flagged but not cut.
export function wavy(x1, x2, y, r) {
  const step = 4.2;
  let d = `M${pt(x1, y)}`;
  let up = true;
  for (let x = x1 + step; x <= x2 + 0.1; x += step) {
    d += ` Q${pt(x - step / 2, y + (up ? -2.1 : 2.1) + jit(r, 0.4))} ${pt(x, y + jit(r, 0.3))}`;
    up = !up;
  }
  return d;
}

// A confident underline, slightly bowed, for the line that survives.
export function underline(x1, x2, y, r) {
  return `M${pt(x1 - 2, y + jit(r, 0.8))} Q${pt((x1 + x2) / 2, y + 2.2 + jit(r, 1))} ${pt(x2 + 4, y - 1 + jit(r, 0.8))}`;
}

// A loose loop that overshoots where it started, like circling a grade.
export function circle(cx, cy, rx, ry, r) {
  const pts = [];
  const start = -Math.PI * 0.85 + jit(r, 0.3);
  const n = 30;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = start + t * Math.PI * 2 * 1.12;
    const k = 1 + jit(r, 0.035) + t * 0.07;
    pts.push([cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k]);
  }
  return smooth(pts);
}

// Stet: a row of pencil dots under the text.
export function dots(x1, x2, y, r) {
  const out = [];
  for (let x = x1 + 2; x < x2; x += 9) out.push([x + jit(r, 1), y + jit(r, 0.8)]);
  return out;
}

function smooth(pts) {
  let d = `M${pt(...pts[0])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${pt(...c1)} ${pt(...c2)} ${pt(...p2)}`;
  }
  return d;
}
