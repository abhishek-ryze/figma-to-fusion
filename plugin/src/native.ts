/// <reference types="@figma/plugin-typings" />
// Reads a Figma vector layer as geometry + paints that Fusion can rebuild exactly. Anything it cannot
// express returns a short reason instead, and the caller sends that layer as a PNG.
import type { BlendMode, Geometry, Matrix, Rect, ShapeEffect, ShapeLayer, ShapePaint, ShapePart, VectorPath } from '../../core/src/types';

const SHAPE_TYPES = new Set(['RECTANGLE', 'ELLIPSE', 'VECTOR', 'STAR', 'POLYGON', 'LINE', 'BOOLEAN_OPERATION']);
const FRAME_TYPES = new Set(['FRAME', 'COMPONENT', 'INSTANCE']);
// Every contour becomes a Polygon mask node in one long chain, so busy outlines (dashed strokes,
// detailed icons) are better off as one PNG.
const MAX_CONTOURS = 12;

type Pt = { x: number; y: number };
type Shapeable = SceneNode & GeometryMixin & LayoutMixin & BlendMixin;

export const canBeNative = (node: SceneNode, asBackground: boolean): node is Shapeable =>
  asBackground ? FRAME_TYPES.has(node.type) : SHAPE_TYPES.has(node.type);

const apply = (m: Matrix, p: Pt): Pt => ({
  x: m[0][0] * p.x + m[0][1] * p.y + m[0][2],
  y: m[1][0] * p.x + m[1][1] * p.y + m[1][2],
});

function invert(m: readonly (readonly number[])[]): Matrix {
  const [[a, c, e], [b, d, f]] = m as Matrix;
  const det = a * d - b * c;
  return [[d / det, -c / det, (c * f - d * e) / det], [-b / det, a / det, (b * e - a * f) / det]];
}

// Figma describes a gradient by the transform from the layer's unit square into gradient space,
// where the gradient runs from (0, 0.5) to (1, 0.5). Inverting it gives the handles on the layer.
export function toPaint(paint: Paint, node: { width: number; height: number }, toFrame: Matrix): ShapePaint | string {
  if (paint.blendMode && paint.blendMode !== 'NORMAL') return 'a fill with its own blend mode';
  const opacity = paint.opacity ?? 1;
  if (paint.type === 'SOLID') return { kind: 'solid', color: { ...paint.color, a: opacity } };
  if (paint.type === 'IMAGE' || paint.type === 'VIDEO') return 'an image fill';
  if (paint.type !== 'GRADIENT_LINEAR' && paint.type !== 'GRADIENT_RADIAL') {
    return paint.type === 'GRADIENT_ANGULAR' ? 'an angular gradient' : paint.type === 'GRADIENT_DIAMOND' ? 'a diamond gradient' : 'an unsupported fill';
  }

  const inverse = invert(paint.gradientTransform);
  const onFrame = (gx: number, gy: number) => {
    const unit = apply(inverse, { x: gx, y: gy });
    return apply(toFrame, { x: unit.x * node.width, y: unit.y * node.height });
  };
  const stops = paint.gradientStops.map((s) => ({ position: s.position, color: { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a * opacity } }));
  if (paint.type === 'GRADIENT_LINEAR') return { kind: 'linear', stops, start: onFrame(0, 0.5), end: onFrame(1, 0.5) };

  const center = onFrame(0.5, 0.5), edge = onFrame(1, 0.5), other = onFrame(0.5, 1);
  const r1 = Math.hypot(edge.x - center.x, edge.y - center.y);
  const r2 = Math.hypot(other.x - center.x, other.y - center.y);
  // Fusion's radial gradient is always a circle.
  if (Math.abs(r1 - r2) / Math.max(r1, r2) > 0.02) return 'an elliptical radial gradient';
  return { kind: 'radial', stops, start: center, end: edge };
}

function geometryOf(node: Shapeable, toFrame: Matrix): Geometry | string {
  const [[a, c], [b, d]] = toFrame;
  // Parametric masks can only be moved and rotated, not skewed, flipped or scaled.
  const rigid = Math.abs(a - d) < 1e-4 && Math.abs(b + c) < 1e-4 && Math.abs(Math.hypot(a, b) - 1) < 1e-3;
  const placed = {
    center: apply(toFrame, { x: node.width / 2, y: node.height / 2 }),
    width: node.width, height: node.height,
    rotation: (Math.atan2(c, a) * 180) / Math.PI,
  };

  if (rigid && (node.type === 'RECTANGLE' || FRAME_TYPES.has(node.type))) {
    const box = node as RectangleNode | FrameNode;
    if (typeof box.cornerRadius === 'number' && (box.cornerSmoothing ?? 0) === 0) {
      return { kind: 'rect', ...placed, cornerRadius: box.cornerRadius };
    }
  }
  if (rigid && node.type === 'ELLIPSE') {
    const arc = node.arcData;
    if (arc.innerRadius === 0 && Math.abs(Math.abs(arc.endingAngle - arc.startingAngle) - 2 * Math.PI) < 1e-4) {
      return { kind: 'ellipse', ...placed };
    }
  }
  return pathsOf(node.fillGeometry, toFrame);
}

function pathsOf(geometry: readonly VectorPath[] | ReadonlyArray<{ windingRule: string; data: string }>, toFrame: Matrix): Geometry | string {
  const paths = geometry
    .filter((p) => p.data.trim().length > 0)
    .map((p) => ({ windingRule: p.windingRule === 'EVENODD' ? 'EVENODD' as const : 'NONZERO' as const, data: p.data }));
  if (paths.length === 0) return 'no outline to draw';
  const contours = paths.reduce((n, p) => n + (p.data.match(/M/gi) ?? []).length, 0);
  if (contours > MAX_CONTOURS) return `a very detailed outline (${contours} separate paths)`;
  return { kind: 'paths', paths, transform: toFrame };
}

// The stroke of a plain rectangle or ellipse is one mask drawn as an outline along the middle of the
// stroke (Fusion's Border Width is centered on the edge). When a tight corner radius makes that
// impossible it is an outer shape minus an inner one. Either way far fewer nodes than the eight
// polygons Figma's own outline is made of, and the width stays editable.
function simpleStroke(node: Shapeable, toFrame: Matrix): Pick<ShapePart, 'geometry' | 'clip'> | null {
  const shape = geometryOf(node, toFrame);
  if (typeof shape === 'string' || shape.kind === 'paths') return null;
  const weight = node.strokeWeight;
  if (typeof weight !== 'number' || weight <= 0) return null; // per side weights
  if ('dashPattern' in node && node.dashPattern.length > 0) return null;
  const align = 'strokeAlign' in node ? node.strokeAlign : 'CENTER';
  // How far the stroke reaches outside and inside the shape's edge.
  const out = align === 'OUTSIDE' ? weight : align === 'CENTER' ? weight / 2 : 0;
  const inn = align === 'INSIDE' ? weight : align === 'CENTER' ? weight / 2 : 0;

  const grow = (by: number): Geometry => {
    const size = { ...shape, width: shape.width + 2 * by, height: shape.height + 2 * by };
    if (size.kind !== 'rect' || shape.kind !== 'rect') return size;
    // A sharp corner stays sharp under a miter join and rounds by the stroke's reach under a round join.
    const sharp = shape.cornerRadius === 0;
    const radius = sharp ? (by > 0 && node.strokeJoin === 'ROUND' ? by : 0) : Math.max(0, shape.cornerRadius + by);
    return { ...size, cornerRadius: radius };
  };
  if (shape.kind === 'rect' && shape.cornerRadius === 0 && out > 0 && node.strokeJoin === 'BEVEL') return null;

  // Middle of the stroke: half way between its outer and inner reach.
  const middle = (out - inn) / 2;
  const fits = shape.width + 2 * middle > 0 && shape.height + 2 * middle > 0;
  const radiusOk = shape.kind !== 'rect' || shape.cornerRadius === 0 || shape.cornerRadius + middle >= 0;
  const miterOk = shape.kind !== 'rect' || shape.cornerRadius > 0 || node.strokeJoin === 'MITER';
  if (fits && radiusOk && miterOk) {
    const line = { ...shape, width: shape.width + 2 * middle, height: shape.height + 2 * middle, outline: weight };
    if (line.kind === 'rect' && shape.kind === 'rect' && shape.cornerRadius > 0) line.cornerRadius = shape.cornerRadius + middle;
    return { geometry: line, clip: undefined };
  }

  const hollow = shape.width - 2 * inn > 0 && shape.height - 2 * inn > 0;
  return { geometry: grow(out), clip: hollow ? { shape: grow(-inn), keep: 'outside' } : undefined };
}

const opaque = (paint: Paint) => (paint.opacity ?? 1) >= 0.999 &&
  (paint.type === 'SOLID' || ((paint.type === 'GRADIENT_LINEAR' || paint.type === 'GRADIENT_RADIAL') && paint.gradientStops.every((s) => s.color.a >= 0.999)));

// One drop shadow and one plain layer blur map onto Fusion's Shadow and Blur tools exactly.
function effectsOf(node: Shapeable, fills: readonly Paint[], rotated: boolean): ShapeEffect[] | string {
  const out: ShapeEffect[] = [];
  let blur: ShapeEffect | null = null;
  for (const e of node.effects) {
    if (!e.visible) continue;
    if (e.type === 'DROP_SHADOW') {
      if (out.length > 0) return 'more than one drop shadow';
      if ((e.spread ?? 0) !== 0) return 'a shadow with spread';
      if (e.blendMode !== 'NORMAL') return 'a shadow with its own blend mode';
      // Fusion draws the whole shadow behind the shape. Figma hides that part unless asked, which only
      // shows when the fill is see-through.
      if (!e.showShadowBehindNode && (fills.length === 0 || !fills.every(opaque))) return 'a shadow behind a see-through fill';
      if (rotated && (e.offset.x !== 0 || e.offset.y !== 0)) return 'an offset shadow on a rotated layer';
      out.push({ kind: 'dropShadow', offset: { x: e.offset.x, y: e.offset.y }, blur: e.radius, color: { ...e.color } });
    } else if (e.type === 'LAYER_BLUR') {
      if ((e as { blurType?: string }).blurType === 'PROGRESSIVE') return 'a progressive blur';
      if (blur) return 'more than one layer blur';
      blur = { kind: 'layerBlur', blur: e.radius };
    } else {
      return e.type === 'INNER_SHADOW' ? 'an inner shadow' : e.type === 'BACKGROUND_BLUR' ? 'a background blur' : 'a noise, texture or glass effect';
    }
  }
  // Figma blurs the layer together with its shadow, so the blur comes last.
  return blur ? [...out, blur] : out;
}

export function nativeShape(node: Shapeable, ref: Pt, bounds: Rect, asBackground: boolean): ShapeLayer | string {
  if (node.fills === figma.mixed) return 'mixed fills';
  const t = node.absoluteTransform;
  const toFrame: Matrix = [[t[0][0], t[0][1], t[0][2] - ref.x], [t[1][0], t[1][1], t[1][2] - ref.y]];
  const visible = (paints: readonly Paint[]) => paints.filter((p) => p.visible !== false && (p.opacity ?? 1) > 0);
  const parts: ShapePart[] = [];

  const fills = visible(node.fills);
  if (fills.length > 0) {
    const geometry = geometryOf(node, toFrame);
    if (typeof geometry === 'string') return geometry;
    for (const [i, fill] of fills.entries()) {
      const paint = toPaint(fill, node, toFrame);
      if (typeof paint === 'string') return paint;
      parts.push({ label: fills.length > 1 ? `Fill${i + 1}` : 'Fill', geometry, paint });
    }
  }

  const strokes = visible(node.strokes);
  const simple = strokes.length > 0 ? simpleStroke(node, toFrame) : null;
  if (simple) {
    for (const [i, stroke] of strokes.entries()) {
      const paint = toPaint(stroke, node, toFrame);
      if (typeof paint === 'string') return paint.replace('fill', 'stroke');
      parts.push({ label: strokes.length > 1 ? `Stroke${i + 1}` : 'Stroke', paint, ...simple });
    }
  } else if (strokes.length > 0 && node.strokeGeometry.length > 0) {
    // Figma has already outlined the stroke (alignment, caps, joins, dashes), so it is just another fill.
    const geometry = pathsOf(node.strokeGeometry, toFrame);
    if (typeof geometry === 'string') return geometry === 'no outline to draw' ? 'a stroke Figma gives no outline for' : geometry;
    // For inside and outside strokes Figma outlines a centered stroke of twice the weight and shows
    // only the half inside (or outside) the shape, so the shape itself becomes a clip on the stroke.
    let clip: ShapePart['clip'];
    const align = 'strokeAlign' in node ? node.strokeAlign : 'CENTER';
    if (align !== 'CENTER' && node.type !== 'LINE') {
      const shape = geometryOf(node, toFrame);
      if (typeof shape === 'string') return `an ${align.toLowerCase()} stroke on a shape with ${shape}`;
      if (shape.kind === 'paths' && shape.paths.reduce((k, path) => k + (path.data.match(/M/gi) ?? []).length, 0) > 1) {
        return `an ${align.toLowerCase()} stroke on a shape with holes`;
      }
      clip = { shape, keep: align === 'INSIDE' ? 'inside' : 'outside' };
    }
    for (const [i, stroke] of strokes.entries()) {
      const paint = toPaint(stroke, node, toFrame);
      if (typeof paint === 'string') return paint.replace('fill', 'stroke');
      parts.push({ label: strokes.length > 1 ? `Stroke${i + 1}` : 'Stroke', geometry, paint, clip });
    }
  }

  if (parts.length === 0) return 'nothing to draw';
  const effects = effectsOf(node, fills, Math.abs(t[0][1]) > 1e-6);
  if (typeof effects === 'string') return effects;
  return {
    type: 'shape', id: node.id + (asBackground ? ' BG' : ''), name: node.name + (asBackground ? ' BG' : ''),
    // A frame's own opacity and blend mode are applied once, on the group that holds its children.
    opacity: asBackground ? 1 : node.opacity,
    blendMode: asBackground ? 'NORMAL' : (node.blendMode as BlendMode),
    bounds, parts, effects,
    // A frame's clip cuts its children, never its own background or the shadow around it.
    unclipped: asBackground || undefined,
  };
}
