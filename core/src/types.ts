// Scene description shared by the Figma plugin, the companion and the converter.
// All pixel values are in Figma frame space: origin top left, Y down.

export interface Size {
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Rgba {
  r: number; // 0..1
  g: number;
  b: number;
  a: number;
}

export type BlendMode =
  | 'NORMAL' | 'PASS_THROUGH' | 'DARKEN' | 'MULTIPLY' | 'LINEAR_BURN' | 'COLOR_BURN'
  | 'LIGHTEN' | 'SCREEN' | 'LINEAR_DODGE' | 'COLOR_DODGE' | 'OVERLAY' | 'SOFT_LIGHT'
  | 'HARD_LIGHT' | 'DIFFERENCE' | 'EXCLUSION' | 'HUE' | 'SATURATION' | 'COLOR' | 'LUMINOSITY';

interface LayerBase {
  id: string;
  name: string;
  // Applied on the trunk Merge. Leaves exported as PNG have their own opacity baked in, so they send 1.
  opacity: number;
  blendMode: BlendMode;
  // A frame's own background: drawn inside the group but outside its clip, so its shadow survives.
  unclipped?: boolean;
}

export interface ImageLayer extends LayerBase {
  type: 'image';
  // Absolute path on disk, filled in by the companion after it writes the PNG.
  file: string;
  // Render bounds in frame pixels (includes shadows, blurs, outside strokes).
  bounds: Rect;
  // Export scale the PNG was rendered at (1..4).
  multiplier: number;
}

export type TextTarget = 'textplus';

// hhea metrics in em units, descent positive.
export interface FontMetrics {
  ascent: number;
  descent: number;
  lineGap: number;
}

// A stretch of characters styled differently from the rest of its text layer. Only what differs is set.
export interface TextRun {
  start: number; // character index, inclusive
  end: number; // exclusive
  color?: Rgba;
  fontFamily?: string;
  fontStyle?: string;
  fontSize?: number;
}

export interface TextLayer extends LayerBase {
  type: 'text';
  target: TextTarget;
  characters: string;
  fontFamily: string;
  fontStyle: string;
  fontSize: number; // px
  color: Rgba;
  letterSpacingPx: number;
  // Line height in px, null when Figma is on AUTO.
  lineHeightPx: number | null;
  alignHorizontal: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED';
  alignVertical: 'TOP' | 'CENTER' | 'BOTTOM';
  // Layout box in frame pixels.
  bounds: Rect;
  // Counter clockwise degrees around the center of `bounds`. The text is built upright and the
  // Transform after it carries the angle, so `bounds` is the upright box centered where Figma shows it.
  rotation?: number;
  // A gradient fill: the text is drawn white and used as the mask of a gradient Background. Its
  // handles are given in the same upright space as `bounds`.
  paint?: ShapePaint;
  // Mixed styles: the layer's own font, size and color describe the main style, runs the exceptions.
  runs?: TextRun[];
  // Filled in by the companion from the installed font file. Without it typical values are assumed.
  metrics?: FontMetrics | null;
}

export interface ClipRect {
  rect: Rect;
  cornerRadius: number; // px
}

export interface GroupLayer extends LayerBase {
  type: 'group';
  bounds: Rect;
  clip: ClipRect | null;
  // Bottom to top, same order as Figma's children array.
  children: Layer[];
}

// 2x3 affine matrix, [[a, c, e], [b, d, f]], mapping path coordinates to frame pixels.
export type Matrix = [[number, number, number], [number, number, number]];

export interface VectorPath {
  windingRule: 'NONZERO' | 'EVENODD';
  data: string;
}

// Rotation is counter clockwise in degrees, around the center. All values in frame pixels.
// `outline` draws only a border of that width, centered on the shape's edge (mask Solid off + Border Width).
export type Geometry =
  | { kind: 'rect'; center: { x: number; y: number }; width: number; height: number; rotation: number; cornerRadius: number; outline?: number }
  | { kind: 'ellipse'; center: { x: number; y: number }; width: number; height: number; rotation: number; outline?: number }
  | { kind: 'paths'; paths: VectorPath[]; transform: Matrix };

export interface GradientStop {
  position: number;
  color: Rgba;
}

export type ShapePaint =
  | { kind: 'solid'; color: Rgba }
  // start / end in frame pixels. For radial: center and a point on the outer edge.
  | { kind: 'linear' | 'radial'; stops: GradientStop[]; start: { x: number; y: number }; end: { x: number; y: number } };

export interface ShapePart {
  label: string; // "Fill", "Stroke"
  geometry: Geometry;
  paint: ShapePaint;
  // Inside and outside strokes: Figma outlines a centered stroke of twice the weight and keeps only
  // the half inside (or outside) the shape. `shape` must build as a single mask node.
  clip?: { shape: Geometry; keep: 'inside' | 'outside' };
}

// Figma values in frame pixels. `blur` is Figma's blur radius, which is two Gaussian sigma.
export type ShapeEffect =
  | { kind: 'dropShadow'; offset: { x: number; y: number }; blur: number; color: Rgba }
  | { kind: 'layerBlur'; blur: number };

// A vector layer rebuilt from Fusion nodes: one masked Background per part, stacked bottom to top.
export interface ShapeLayer extends LayerBase {
  type: 'shape';
  bounds: Rect;
  parts: ShapePart[];
  // At most one drop shadow, then an optional layer blur (which also blurs the shadow, as in Figma).
  effects?: ShapeEffect[];
}

export type Layer = ImageLayer | TextLayer | GroupLayer | ShapeLayer;

export interface Scene {
  name: string;
  // The Figma reference space (the frame, or the union bounds of a loose selection).
  frame: Size;
  // Bottom to top.
  layers: Layer[];
}

export type FitMode = 'width' | 'height' | 'none';

export interface BuildOptions {
  // Fusion comp resolution. Defaults to the frame size.
  comp?: Size;
  fit?: FitMode;
  // Loader -> place on canvas -> Transform (pivot at element center) -> trunk Merge.
  // When false: Loader -> trunk Merge, placement lives on the Merge itself.
  transformNodes?: boolean;
  // How rectangles and ellipses with a solid fill are built: a masked Background (the default), or
  // Fusion's shape system (sRectangle / sEllipse into sRender). Gradients and paths always use masks.
  shapeStyle?: 'masks' | 'shapes';
  // How long stills are held, in frames.
  holdFrames?: number;
  // Flow position of the top of the trunk.
  origin?: { x: number; y: number };
}

export interface BuildResult {
  text: string;
  warnings: string[];
  toolCount: number;
}
