// Turns Figma path data (fillGeometry / strokeGeometry) into closed cubic contours, and works out
// which contours add area and which cut holes, so they can become a chain of Fusion Polygon masks.
import type { Matrix, VectorPath } from './types';

export interface Pt { x: number; y: number }
// One anchor with its incoming (l) and outgoing (r) bezier control points, all absolute.
export interface Anchor { p: Pt; l: Pt; r: Pt; linearIn: boolean; linearOut: boolean }
export interface Contour { anchors: Anchor[]; op: 'Add' | 'Subtract'; area: number }

const apply = (m: Matrix, p: Pt): Pt => ({
  x: m[0][0] * p.x + m[0][1] * p.y + m[0][2],
  y: m[1][0] * p.x + m[1][1] * p.y + m[1][2],
});
const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const same = (a: Pt, b: Pt) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;

interface Segment { from: Pt; c1: Pt; c2: Pt; to: Pt; linear: boolean }

// Figma only emits absolute M, L, Q, C and Z.
function parse(data: string, m: Matrix): Segment[][] {
  const tokens = data.match(/[MLQCZ]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? [];
  const contours: Segment[][] = [];
  let current: Segment[] = [];
  let start: Pt = { x: 0, y: 0 };
  let pos: Pt = start;
  let i = 0;
  const point = (): Pt => apply(m, { x: Number(tokens[i++]), y: Number(tokens[i++]) });
  const line = (to: Pt) => current.push({ from: pos, c1: lerp(pos, to, 1 / 3), c2: lerp(pos, to, 2 / 3), to, linear: true });
  const close = () => {
    if (current.length === 0) return;
    if (!same(pos, start)) line(start);
    contours.push(current);
    current = [];
  };
  while (i < tokens.length) {
    const cmd = tokens[i++].toUpperCase();
    if (cmd === 'M') { close(); start = pos = point(); }
    else if (cmd === 'L') { const to = point(); line(to); pos = to; }
    else if (cmd === 'Q') {
      const q = point(), to = point();
      current.push({ from: pos, c1: lerp(pos, q, 2 / 3), c2: lerp(to, q, 2 / 3), to, linear: false });
      pos = to;
    } else if (cmd === 'C') {
      const c1 = point(), c2 = point(), to = point();
      current.push({ from: pos, c1, c2, to, linear: false });
      pos = to;
    } else if (cmd === 'Z') { close(); pos = start; }
    else throw new Error(`Unsupported path command "${cmd}"`);
  }
  close();
  return contours.map((c) => c.filter((s) => !(s.linear && same(s.from, s.to)))).filter((c) => c.length >= 2);
}

function flatten(segments: Segment[], steps = 8): Pt[] {
  const out: Pt[] = [];
  for (const s of segments) {
    const n = s.linear ? 1 : steps;
    for (let k = 0; k < n; k++) {
      const t = k / n, u = 1 - t;
      out.push({
        x: u * u * u * s.from.x + 3 * u * u * t * s.c1.x + 3 * u * t * t * s.c2.x + t * t * t * s.to.x,
        y: u * u * u * s.from.y + 3 * u * u * t * s.c1.y + 3 * u * t * t * s.c2.y + t * t * t * s.to.y,
      });
    }
  }
  return out;
}

const signedArea = (poly: Pt[]) => poly.reduce((a, p, i) => {
  const q = poly[(i + 1) % poly.length];
  return a + (p.x * q.y - q.x * p.y) / 2;
}, 0);

function winding(poly: Pt[], p: Pt): number {
  let w = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const side = (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y);
    if (a.y <= p.y) { if (b.y > p.y && side > 0) w++; }
    else if (b.y <= p.y && side < 0) w--;
  }
  return w;
}

// A contour matters when taking it away changes whether the area just inside it is filled. That
// works under either winding rule, and also for outlines made of pieces that share edges (Figma
// builds strokes from touching bars and corner arcs), where "just outside" is another filled piece.
export function toContours(paths: VectorPath[], m: Matrix): Contour[] {
  const out: Contour[] = [];
  for (const path of paths) {
    const parsed = parse(path.data, m);
    const polys = parsed.map((c) => flatten(c));
    const filledAt = (p: Pt, skip = -1) => {
      const counts = polys.map((poly, k) => (k === skip ? 0 : winding(poly, p)));
      return path.windingRule === 'EVENODD'
        ? counts.filter((w) => w !== 0).length % 2 === 1
        : counts.reduce((a, b) => a + b, 0) !== 0;
    };
    const fromPath: Contour[] = [];
    parsed.forEach((segments, index) => {
      const poly = polys[index];
      const area = signedArea(poly);
      if (Math.abs(area) < 1e-4) return;
      let best = 0, bestLen = -1;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        if (len > bestLen) { bestLen = len; best = i; }
      }
      const a = poly[best], b = poly[(best + 1) % poly.length];
      const mid = lerp(a, b, 0.5);
      // Normal pointing to the inside of this contour.
      const sign = area > 0 ? 1 : -1;
      const nx = (-(b.y - a.y) / bestLen) * sign, ny = ((b.x - a.x) / bestLen) * sign;
      const eps = Math.min(0.05, bestLen / 4);
      const sample = { x: mid.x + nx * eps, y: mid.y + ny * eps };
      const inside = filledAt(sample);
      if (inside === filledAt(sample, index)) return;

      const anchors: Anchor[] = segments.map((s, i) => {
        const prev = segments[(i + segments.length - 1) % segments.length];
        return { p: s.from, r: s.c1, l: prev.c2, linearOut: s.linear, linearIn: prev.linear };
      });
      fromPath.push({ anchors, op: inside ? 'Add' : 'Subtract', area: Math.abs(area) });
    });
    // Outer shapes first, so every hole is cut from something already painted.
    out.push(...fromPath.sort((x, y) => y.area - x.area));
  }
  return out;
}
