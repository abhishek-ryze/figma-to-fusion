import { makeSpace, type Space } from './coords';
import { LuaRaw, LuaTable, fuid, input, link, list, point, serialize, tbl, type LuaValue } from './lua';
import { toContours } from './paths';
import type {
  BlendMode, BuildOptions, BuildResult, ClipRect, FontMetrics, Geometry, GroupLayer, ImageLayer, Layer, Rgba, Scene, ShapeLayer,
  ShapePaint, TextLayer,
} from './types';

// Flow view grid: one node is roughly 110 wide and 33 tall.
const COL = 110;
const ROW = 66;
// Columns a trunk needs to its left for Loader, placement Merge and Transform, plus a gutter.
const TRUNK_BLOCK = 5;

// Fusion's own "Purple" from the node color menu, so text is easy to spot in a big tree.
const TEXT_TILE = { R: 0.6, G: 0.4509804, B: 0.627451 };

const FUSION_LINE_FACTOR = 0.7984;
// Measured in Resolve 21, the same at 960, 1920 and 3840 wide:
// Blur: sigma px = XBlurSize x BLUR_FACTOR x comp width. Shadow: sigma px = Softness x SOFTNESS_FACTOR x comp width.
const BLUR_FACTOR = 0.000598;
const SOFTNESS_FACTOR = 0.4306;
// Typical sans serif values, used only when the font file cannot be found.
const DEFAULT_METRICS: FontMetrics = { ascent: 0.95, descent: 0.25, lineGap: 0 };

const APPLY_MODES: Partial<Record<BlendMode, string>> = {
  NORMAL: 'Normal',
  PASS_THROUGH: 'Normal',
  DARKEN: 'Darken',
  MULTIPLY: 'Multiply',
  COLOR_BURN: 'Color Burn',
  LIGHTEN: 'Lighten',
  SCREEN: 'Screen',
  COLOR_DODGE: 'Color Dodge',
  OVERLAY: 'Overlay',
  SOFT_LIGHT: 'Soft Light',
  HARD_LIGHT: 'Hard Light',
  DIFFERENCE: 'Difference',
  EXCLUSION: 'Exclusion',
  HUE: 'Hue',
  SATURATION: 'Saturation',
  COLOR: 'Color',
  LUMINOSITY: 'Luminosity',
};

class Builder {
  tools: Array<[string, LuaTable]> = [];
  warnings: string[] = [];
  names = new Set<string>();
  private row = 0;

  constructor(
    private space: Space,
    private opts: Required<Omit<BuildOptions, 'comp' | 'fit'>>,
  ) {}

  // Fusion tool names: letters, digits, underscore, not starting with a digit, unique per comp.
  private name(base: string, suffix = ''): string {
    let clean = base.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
    if (!clean || /^[0-9]/.test(clean)) clean = `L_${clean}`;
    clean = clean.slice(0, 40) + suffix;
    let candidate = clean;
    for (let i = 2; this.names.has(candidate); i++) candidate = `${clean}_${i}`;
    this.names.add(candidate);
    return candidate;
  }

  private add(name: string, ctor: string, fields: Record<string, LuaValue | undefined>, col: number, row: number,
    tile?: { R: number; G: number; B: number }) {
    const pos = point(this.opts.origin.x + col * COL, this.opts.origin.y + row * ROW);
    this.tools.push([name, tbl(ctor, {
      ...fields,
      ViewInfo: tbl('OperatorInfo', { Pos: pos }),
      Colors: tile ? tbl(null, { TileColor: tbl(null, tile) }) : undefined,
    })]);
  }

  private canvasInputs(): Record<string, LuaValue> {
    return {
      Width: input(this.space.comp.width),
      Height: input(this.space.comp.height),
      UseFrameFormatSettings: input(0),
    };
  }

  private applyMode(layer: Layer): LuaValue | undefined {
    const mode = APPLY_MODES[layer.blendMode];
    if (!mode) {
      this.warnings.push(`"${layer.name}": blend mode ${layer.blendMode} has no Fusion equivalent, using Normal.`);
      return undefined;
    }
    return mode === 'Normal' ? undefined : input(fuid(mode));
  }

  // Builds one vertical Merge chain. Returns the name of the tool holding the result.
  trunk(layers: Layer[], label: string, depth: number, clip: ClipRect | null = null): string {
    const col = -depth * TRUNK_BLOCK;
    const base = this.name(label, '_Canvas');
    const clipMask = clip ? this.clipMask(label, clip, col - 1, this.row) : null;
    this.add(base, 'Background', {
      Inputs: tbl(null, { ...this.canvasInputs(), TopLeftAlpha: input(0) }),
    }, col, this.row++);

    let current = base;
    for (const layer of layers) {
      const source = this.source(layer, base, col, depth);
      if (!source) continue;
      const merge = this.name(layer.name, '_Merge');
      this.add(merge, 'Merge', {
        Inputs: tbl(null, {
          Background: link(current),
          Foreground: link(source.tool),
          ...source.mergeInputs,
          // The frame's clip cuts its children, not its own background and shadow.
          EffectMask: clipMask && !layer.unclipped ? link(clipMask, 'Mask') : undefined,
          Blend: layer.opacity < 1 ? input(layer.opacity) : undefined,
          ApplyMode: this.applyMode(layer),
          PerformDepthMerge: input(0),
        }),
      }, col, this.row++);
      // Branches that hang below the layer's own row (strokes under a fill) keep their rows free.
      this.row += source.rowsBelow ?? 0;
      current = merge;
    }
    return current;
  }

  // Creates the branch feeding a trunk Merge. The branch sits on the row the Merge will take.
  private source(layer: Layer, canvas: string, col: number, depth: number):
    { tool: string; mergeInputs: Record<string, LuaValue | undefined>; rowsBelow?: number } | null {
    if (layer.type === 'group') return this.group(layer, col, depth);
    if (layer.type === 'text') return this.text(layer, col);
    if (layer.type === 'shape') return this.shape(layer, col);
    return this.image(layer, canvas, col);
  }

  private image(layer: ImageLayer, canvas: string, col: number) {
    const c = this.space.center(layer.bounds);
    const size = this.space.imageSize(layer.multiplier);
    const row = this.row;

    const loader = this.name(layer.name);
    this.add(loader, 'Loader', {
      Clips: list(null, [
        tbl('Clip', {
          ID: 'Clip1',
          Filename: layer.file,
          FormatID: 'PNGFormat',
          StartFrame: -1,
          LengthSetManually: true,
          TrimIn: 0, TrimOut: 0, ExtendFirst: 0, ExtendLast: 0,
          Loop: 0, AspectMode: 0, Depth: 0, TimeCode: 0,
          GlobalStart: 0,
          GlobalEnd: this.opts.holdFrames,
        }),
      ]),
      // Figma PNGs carry straight alpha, Fusion composites premultiplied.
      Inputs: tbl(null, { PostMultiplyByAlpha: input(1) }),
    }, col - (this.opts.transformNodes ? 3 : 1), row);

    const placement = {
      Center: input(point(c.x, c.y)),
      Size: size === 1 ? undefined : input(size),
    };
    if (!this.opts.transformNodes) return { tool: loader, mergeInputs: placement };

    const place = this.name(layer.name, '_Place');
    this.add(place, 'Merge', {
      Inputs: tbl(null, {
        Background: link(canvas),
        Foreground: link(loader),
        ...placement,
        PerformDepthMerge: input(0),
      }),
    }, col - 2, row);
    return { tool: this.transform(layer.name, place, c, col, row), mergeInputs: {} };
  }

  // Identity Transform with its pivot on the element, so scale and rotation animate around it.
  private transform(label: string, from: string, pivot: { x: number; y: number }, col: number, row: number, angle = 0): string {
    const xf = this.name(label, '_XF');
    this.add(xf, 'Transform', {
      Inputs: tbl(null, { Pivot: input(point(pivot.x, pivot.y)), Angle: Math.abs(angle) > 1e-4 ? input(angle) : undefined, Input: link(from) }),
    }, col - 1, row);
    return xf;
  }

  private text(layer: TextLayer, col: number) {
    const row = this.row;
    const b = layer.bounds;
    const anchorX =
      layer.alignHorizontal === 'RIGHT' ? b.x + b.width :
      layer.alignHorizontal === 'CENTER' ? b.x + b.width / 2 :
      b.x;
    const hAlign = layer.alignHorizontal === 'RIGHT' ? 1 : layer.alignHorizontal === 'CENTER' ? 0 : -1;

    if (layer.alignHorizontal === 'JUSTIFIED') {
      this.warnings.push(`"${layer.name}": justified text is imported left aligned.`);
    }
    if (layer.letterSpacingPx !== 0) {
      this.warnings.push(`"${layer.name}": letter spacing is approximated (Fusion tracking is a multiplier, not pixels).`);
    }
    if (!layer.metrics) {
      this.warnings.push(`"${layer.name}": font "${layer.fontFamily} ${layer.fontStyle}" was not found on this computer, size and baseline are estimated.`);
    }

    // Figma's line layout, in frame pixels: each line box is lineHeight tall with the font's
    // ascent + descent centered inside it.
    const fm = layer.metrics ?? DEFAULT_METRICS;
    const em = layer.fontSize;
    const content = (fm.ascent + fm.descent) * em;
    const linePx = layer.lineHeightPx ?? (fm.ascent + fm.descent + fm.lineGap) * em;
    const lines = layer.characters.replace(/\n+$/, '').split('\n').length;
    const slack = b.height - lines * linePx;
    const blockTop = b.y + (layer.alignVertical === 'BOTTOM' ? slack : layer.alignVertical === 'CENTER' ? slack / 2 : 0);
    const firstBaseline = blockTop + (linePx - content) / 2 + fm.ascent * em;
    const lastBaseline = firstBaseline + (lines - 1) * linePx;

    // Measured in Resolve 21: Fusion scales a font so ascent + descent equals
    // FUSION_LINE_FACTOR x Size x comp width, and that is also its default line height.
    const size = (this.space.size(em) * (fm.ascent + fm.descent)) / FUSION_LINE_FACTOR;
    const leading = linePx / content;
    // Tracking multiplies glyph advances; about 0.55 em is a typical average advance.
    const tracking = 1 + layer.letterSpacingPx / (em * 0.55);
    const near1 = (n: number) => Math.abs(n - 1) < 1e-4;

    const tool = this.name(layer.name, layer.paint ? '_Text' : '');
    const textCol = col - (layer.paint ? 3 : 2);
    // Under a gradient the glyphs only provide the shape, so they are drawn plain white.
    const ink = layer.paint ? { r: 1, g: 1, b: 1, a: 1 } : layer.color;
    const runs = layer.paint ? (layer.runs ?? []).map((r) => ({ ...r, color: undefined })) : layer.runs ?? [];
    if (runs.length > 0) {
      this.warnings.push(`"${layer.name}": mixed text styles were imported with the main style only.`);
    }
    // With the vertical anchor at 1, Text+ puts the last line's baseline exactly on Center.y.
    const anchor = this.space.point(anchorX, lastBaseline);
    this.add(tool, 'TextPlus', {
      Inputs: tbl(null, {
        ...this.canvasInputs(),
        Center: input(point(anchor.x, anchor.y)),
        StyledText: input(layer.characters),
        Font: input(layer.fontFamily),
        Style: input(layer.fontStyle),
        Size: input(size),
        CharacterSpacing: near1(tracking) ? undefined : input(tracking),
        LineSpacing: near1(leading) ? undefined : input(leading),
        VerticalJustificationNew: input(3),
        HorizontalJustificationNew: input(3),
        HorizontalLeftCenterRight: input(hAlign),
        VerticalTopCenterBottom: input(1),
        Red1: input(ink.r),
        Green1: input(ink.g),
        Blue1: input(ink.b),
        Alpha1: ink.a < 1 ? input(ink.a) : undefined,
      }),
    }, textCol, row, TEXT_TILE);

    let out = tool;
    if (layer.paint) {
      // The live text becomes the mask (its alpha) of an ordinary, editable gradient Background.
      out = this.name(layer.name);
      this.add(out, 'Background', {
        Inputs: tbl(null, { ...this.canvasInputs(), ...this.paintInputs(layer.paint), EffectMask: link(tool, 'Output') }),
      }, col - 2, row);
    }
    const angle = layer.rotation ?? 0;
    // Rotated text always gets its Transform, which is where the angle lives.
    if (!this.opts.transformNodes && Math.abs(angle) < 1e-4) return { tool: out, mergeInputs: {} };
    return { tool: this.transform(layer.name, out, this.space.center(b), col, row, angle), mergeInputs: {} };
  }


  private maskInputs(): Record<string, LuaValue> {
    return {
      MaskWidth: input(this.space.comp.width),
      MaskHeight: input(this.space.comp.height),
      PixelAspect: input(point(1, 1)),
      ClippingMode: input(fuid('None')),
    };
  }

  // Builds the mask (or chain of masks) for one geometry, ending at column `col`. Returns the last tool.
  // `onto` continues an existing mask chain: Multiply keeps only the overlap, Subtract cuts it out.
  private geometryMask(label: string, g: Geometry, col: number, row: number,
    onto?: { previous: string; mode: 'Multiply' | 'Subtract' }): string | null {
    if (g.kind === 'rect' || g.kind === 'ellipse') {
      const c = this.space.point(g.center.x, g.center.y);
      const mask = this.name(label, '_Mask');
      const maxRadius = Math.min(g.width, g.height) / 2;
      this.add(mask, g.kind === 'rect' ? 'RectangleMask' : 'EllipseMask', {
        Inputs: tbl(null, {
          ...this.maskInputs(),
          PaintMode: onto ? input(fuid(onto.mode)) : undefined,
          EffectMask: onto ? link(onto.previous, 'Mask') : undefined,
          Center: input(point(c.x, c.y)),
          Width: input(this.space.size(g.width)),
          // Verified in Resolve 21: Rectangle height is relative to comp height, Ellipse height to comp width.
          Height: input(g.kind === 'rect' ? this.space.sizeY(g.height) : this.space.size(g.height)),
          CornerRadius: g.kind === 'rect' && g.cornerRadius > 0 && maxRadius > 0
            ? input(Math.min(1, g.cornerRadius / maxRadius)) : undefined,
          Angle: Math.abs(g.rotation) > 1e-4 ? input(g.rotation) : undefined,
          // Verified in Resolve 21: with Solid off, Border Width (over comp width) is the full stroke
          // width, centered on the edge, and rounded corners are offset correctly.
          Solid: g.outline ? input(0) : undefined,
          BorderWidth: g.outline ? input(this.space.size(g.outline)) : undefined,
        }),
      }, col, row);
      return mask;
    }

    const contours = toContours(g.paths, g.transform);
    if (contours.length === 0) return null;
    const all = contours.flatMap((c) => c.anchors.map((a) => a.p));
    const cx = (Math.min(...all.map((p) => p.x)) + Math.max(...all.map((p) => p.x))) / 2;
    const cy = (Math.min(...all.map((p) => p.y)) + Math.max(...all.map((p) => p.y))) / 2;
    const center = this.space.point(cx, cy);

    let previous: string | null = onto?.previous ?? null;
    contours.forEach((contour, i) => {
      const mask = this.name(label, contours.length > 1 ? `_Path${i + 1}` : '_Path');
      // Points are offsets from Center; handles are control point offsets from their point.
      const points = contour.anchors.map((a) => tbl(null, {
        X: this.space.dx(a.p.x - cx), Y: this.space.dy(a.p.y - cy),
        LX: this.space.dx(a.l.x - a.p.x), LY: this.space.dy(a.l.y - a.p.y),
        RX: this.space.dx(a.r.x - a.p.x), RY: this.space.dy(a.r.y - a.p.y),
      }));
      this.add(mask, 'PolylineMask', {
        DrawMode: 'InsertAndModify',
        DrawMode2: 'InsertAndModify',
        Inputs: tbl(null, {
          ...this.maskInputs(),
          PaintMode: previous ? input(fuid(i === 0 && onto ? onto.mode : contour.op)) : undefined,
          Center: input(point(center.x, center.y)),
          Polyline: input(tbl('Polyline', { Closed: true, Points: list(null, points) })),
          Polyline2: new LuaRaw('Input { Disabled = true, Value = Polyline { } }'),
          EffectMask: previous ? link(previous, 'Mask') : undefined,
        }),
      }, col - (contours.length - 1 - i), row);
      previous = mask;
    });
    return previous;
  }

  // Shape system version of a simple shape. Verified in Resolve 21: every unit is relative to comp
  // width (Y offsets too), offsets are measured from the comp center, Y up.
  private shapeNodes(label: string, g: Exclude<Geometry, { kind: 'paths' }>, color: Rgba, col: number, row: number): string {
    const c = this.space.point(g.center.x, g.center.y);
    const { width, height } = this.space.comp;
    const maxRadius = Math.min(g.width, g.height) / 2;
    const shape = this.name(label, '_Shape');
    this.add(shape, g.kind === 'rect' ? 'sRectangle' : 'sEllipse', {
      Inputs: tbl(null, {
        'Translate.X': input(c.x - 0.5),
        'Translate.Y': input(((c.y - 0.5) * height) / width),
        Width: input(this.space.size(g.width)),
        Height: input(this.space.size(g.height)),
        CornerRadius: g.kind === 'rect' && g.cornerRadius > 0 && maxRadius > 0 ? input(Math.min(1, g.cornerRadius / maxRadius)) : undefined,
        Angle: Math.abs(g.rotation) > 1e-4 ? input(g.rotation) : undefined,
        Solid: g.outline ? input(0) : undefined,
        BorderWidth: g.outline ? input(this.space.size(g.outline)) : undefined,
        Red: input(color.r), Green: input(color.g), Blue: input(color.b),
        Alpha: color.a < 1 ? input(color.a) : undefined,
      }),
    }, col - 1, row);
    const render = this.name(label);
    this.add(render, 'sRender', { Inputs: tbl(null, { ...this.canvasInputs(), Input: link(shape) }) }, col, row);
    return render;
  }

  private paintInputs(paint: ShapePaint): Record<string, LuaValue | undefined> {
    if (paint.kind === 'solid') {
      return {
        TopLeftRed: input(paint.color.r), TopLeftGreen: input(paint.color.g), TopLeftBlue: input(paint.color.b),
        TopLeftAlpha: paint.color.a < 1 ? input(paint.color.a) : undefined,
      };
    }
    const start = this.space.point(paint.start.x, paint.start.y);
    const end = this.space.point(paint.end.x, paint.end.y);
    // Stops are table keys, so two stops at the same position (a hard edge) are nudged apart.
    let last = -1;
    const stops = [...paint.stops].sort((a, b) => a.position - b.position).map((stop) => {
      last = Math.max(stop.position, last + 1e-4);
      return `[${parseFloat(last.toFixed(6))}] = { ${[stop.color.r, stop.color.g, stop.color.b, stop.color.a].map((v) => parseFloat(v.toFixed(6))).join(', ')} }`;
    });
    return {
      Type: input(fuid('Gradient')),
      GradientType: input(fuid(paint.kind === 'linear' ? 'Linear' : 'Radial')),
      Start: input(point(start.x, start.y)),
      End: input(point(end.x, end.y)),
      Gradient: input(new LuaRaw(`Gradient { Colors = { ${stops.join(', ')} } }`)),
    };
  }

  // Shadow first, then blur, so a layer blur softens the shadow too, as Figma does. Ends at column `col`.
  private effects(layer: ShapeLayer, from: string, col: number, row: number): string {
    const list = layer.effects ?? [];
    const { width, height } = this.space.comp;
    let current = from;
    list.forEach((fx, i) => {
      const at = col - (list.length - 1 - i);
      const sigma = (fx.blur / 2) * this.space.scale;
      if (fx.kind === 'dropShadow') {
        const tool = this.name(layer.name, '_Shadow');
        this.add(tool, 'Shadow', {
          Inputs: tbl(null, {
            // Offset from (0.5, 0.5): X over comp width, Y over comp height, Y up.
            ShadowOffset: input(point(0.5 + (fx.offset.x * this.space.scale) / width, 0.5 - (fx.offset.y * this.space.scale) / height)),
            Softness: input(sigma / (SOFTNESS_FACTOR * width)),
            Red: input(fx.color.r), Green: input(fx.color.g), Blue: input(fx.color.b),
            Alpha: input(fx.color.a),
            Input: link(current),
          }),
        }, at, row);
        current = tool;
      } else {
        const tool = this.name(layer.name, '_Blur');
        this.add(tool, 'Blur', {
          Inputs: tbl(null, {
            Filter: input(fuid('Fast Gaussian')),
            XBlurSize: input(sigma / (BLUR_FACTOR * width)),
            // Frame clipping would cut the soft edge off at the comp border less gracefully than None.
            ClippingMode: input(fuid('None')),
            Input: link(current),
          }),
        }, at, row);
        current = tool;
      }
    });
    return current;
  }

  // One masked Background per part (fill, stroke), stacked with Merges when there is more than one.
  // The layer reads left to right along ONE row: first part (usually the fill), an Over merge per
  // further part, effects, Transform, trunk Merge. Every further part (a stroke) hangs on its own row
  // underneath, with its Background straight below the Over merge it feeds.
  private shape(layer: ShapeLayer, col: number) {
    const mainRow = this.row;
    const fx = layer.effects?.length ?? 0;
    const firstCol = col - 2 - fx - Math.max(0, layer.parts.length - 1);
    const multi = layer.parts.length > 1;
    let current: string | null = null;
    let built = 0;
    for (const part of layer.parts) {
      const row = mainRow + built;
      const bgCol = firstCol + built;
      const label = multi ? `${layer.name}_${part.label}` : layer.name;
      let bg: string;
      if (this.opts.shapeStyle === 'shapes' && part.geometry.kind !== 'paths' && part.paint.kind === 'solid') {
        bg = this.shapeNodes(label, part.geometry, part.paint.color, bgCol, row);
      } else {
        const clipped = part.clip ? 1 : 0;
        let mask = this.geometryMask(label, part.geometry, bgCol - 1 - clipped, row);
        if (!mask) continue;
        if (part.clip) {
          mask = this.geometryMask(`${label}_${part.clip.keep === 'inside' ? 'Inside' : 'Outside'}`, part.clip.shape, bgCol - 1, row,
            { previous: mask, mode: part.clip.keep === 'inside' ? 'Multiply' : 'Subtract' }) ?? mask;
        }
        bg = this.name(label);
        this.add(bg, 'Background', {
          Inputs: tbl(null, { ...this.canvasInputs(), ...this.paintInputs(part.paint), EffectMask: link(mask, 'Mask') }),
        }, bgCol, row);
      }
      if (!current) {
        current = bg;
      } else {
        const over = this.name(label, '_Over');
        this.add(over, 'Merge', {
          Inputs: tbl(null, { Background: link(current), Foreground: link(bg), PerformDepthMerge: input(0) }),
        }, bgCol, mainRow);
        current = over;
      }
      built++;
    }
    if (!current) {
      this.warnings.push(`"${layer.name}": no drawable geometry, skipped.`);
      return null;
    }
    current = this.effects(layer, current, col - 2, mainRow);
    const tool = this.opts.transformNodes ? this.transform(layer.name, current, this.space.center(layer.bounds), col, mainRow) : current;
    return { tool, mergeInputs: {}, rowsBelow: built - 1 };
  }

  private clipMask(label: string, clip: ClipRect, col: number, row: number): string {
    const r = clip.rect;
    const c = this.space.center(r);
    const mask = this.name(label, '_Clip');
    const maxRadius = Math.min(r.width, r.height) / 2;
    this.add(mask, 'RectangleMask', {
      Inputs: tbl(null, {
        ...this.maskInputs(),
        Center: input(point(c.x, c.y)),
        // Verified in Resolve 21: mask Width is relative to comp width, Height to comp height.
        Width: input(this.space.size(r.width)),
        Height: input(this.space.sizeY(r.height)),
        CornerRadius: clip.cornerRadius > 0 && maxRadius > 0 ? input(Math.min(1, clip.cornerRadius / maxRadius)) : undefined,
      }),
    }, col, row);
    return mask;
  }

  private group(layer: GroupLayer, col: number, depth: number) {
    if (layer.children.length === 0) return null;
    const result = this.trunk(layer.children, layer.name, depth + 1, layer.clip);
    const tool = this.opts.transformNodes
      ? this.transform(layer.name, result, this.space.center(layer.bounds), col, this.row)
      : result;
    return { tool, mergeInputs: {} };
  }
}

export function buildComp(scene: Scene, options: BuildOptions = {}): BuildResult {
  const space = makeSpace(scene.frame, options.comp ?? scene.frame, options.fit ?? 'width');
  const builder = new Builder(space, {
    transformNodes: options.transformNodes ?? true,
    shapeStyle: options.shapeStyle ?? 'masks',
    holdFrames: options.holdFrames ?? 5000,
    origin: options.origin ?? { x: 0, y: 0 },
  });

  const last = builder.trunk(scene.layers, scene.name, 0);
  const tools = new LuaTable(null, builder.tools);
  const text = serialize(
    tbl(null, { Tools: new LuaRaw('ordered() ' + serialize(tools, 1)), ActiveTool: last }),
  );
  return { text, warnings: builder.warnings, toolCount: builder.tools.length };
}
