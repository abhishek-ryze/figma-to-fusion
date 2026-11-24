/// <reference types="@figma/plugin-typings" />
import type { BlendMode, BuildOptions, GroupLayer, ImageLayer, Layer, Rect, Scene, ShapeLayer, ShapePaint, TextLayer, TextRun } from '../../core/src/types';
import { canBeNative, nativeShape, toPaint } from './native';
import { DEFAULT_SETTINGS, type Asset, type PreviewRow, type SelectionSummary, type Settings, type ToCode, type ToUi } from './messages';

const SETTINGS_KEY = 'settings-v1';
const ICON_MAX_PX = 128;
const MAX_PREVIEW_ROWS = 60;
// Per layer override of the split setting, saved in the Figma file: 'merge' or 'split'.
const SPLIT_KEY = 'f2f-split';
const SHAPE_TYPES = new Set(['VECTOR', 'BOOLEAN_OPERATION', 'ELLIPSE', 'RECTANGLE', 'LINE', 'STAR', 'POLYGON']);

type Container = FrameNode | GroupNode | ComponentNode | InstanceNode | SectionNode;
interface Job {
  name: string;
  run: () => Promise<void>;
}
interface Plan {
  scene: Scene;
  jobs: Job[];
  assets: Asset[];
  notes: string[];
  summary: SelectionSummary;
}

const post = (msg: ToUi) => figma.ui.postMessage(msg);

const isContainer = (n: SceneNode): n is Container =>
  n.type === 'FRAME' || n.type === 'GROUP' || n.type === 'COMPONENT' || n.type === 'INSTANCE' || n.type === 'SECTION';

// Includes shadows, blurs and outside strokes. Sections only have a layout box.
const renderBounds = (n: SceneNode): Rect | null =>
  'absoluteRenderBounds' in n ? n.absoluteRenderBounds : n.absoluteBoundingBox;

const isRotated =(n: SceneNode) => Math.abs(n.absoluteTransform[0][1]) > 1e-6;

const hasVisible = (paints: readonly Paint[] | typeof figma.mixed | undefined) =>
  Array.isArray(paints) && paints.some((p) => p.visible !== false && (p.opacity ?? 1) > 0);

// Fusion text does not wrap to a box and Figma does not say where it wrapped, so the breaks are
// measured: on an off canvas copy, words are deleted from the end one at a time, and every time the
// height drops, the word just removed was the first on its line. Those spaces become real line breaks
// (same length, so styled ranges keep their positions). Deleting keeps mixed styles intact.
const MAX_WRAP_WORDS = 400;
async function wrappedCharacters(node: TextNode): Promise<string> {
  const text = node.characters;
  const words: Array<{ start: number; end: number }> = [];
  const word = /\S+/g;
  for (let m = word.exec(text); m; m = word.exec(text)) words.push({ start: m.index, end: m.index + m[0].length });
  if (words.length < 2) return text;
  if (words.length > MAX_WRAP_WORDS) throw new Error('too long to measure');

  await Promise.all(node.getRangeAllFontNames(0, text.length).map((f) => figma.loadFontAsync(f)));
  const copy = node.clone();
  const breaks: number[] = [];
  try {
    figma.currentPage.appendChild(copy);
    copy.textAutoResize = 'HEIGHT';
    let height = copy.height;
    for (let i = words.length - 1; i > 0; i--) {
      // Remove word i together with the whitespace before it.
      copy.deleteCharacters(words[i - 1].end, copy.characters.length);
      if (copy.height < height - 0.5) {
        // A drop after a line break the designer typed is not a wrap.
        if (!text.slice(words[i - 1].end, words[i].start).includes('\n')) breaks.push(words[i].start);
        height = copy.height;
      }
    }
  } finally {
    if (!copy.removed) copy.remove();
  }
  const chars = text.split('');
  for (const start of breaks) chars[start - 1] = '\n';
  return chars.join('');
}

function topLevelAncestor(node: SceneNode): SceneNode {
  let current: SceneNode = node;
  while (current.parent && current.parent.type !== 'PAGE' && current.parent.type !== 'SECTION') {
    current = current.parent as SceneNode;
  }
  return current;
}

// Document order path, used to keep Figma's stacking order for multi selections.
function orderPath(node: SceneNode): number[] {
  const out: number[] = [];
  let current: BaseNode = node;
  while (current.parent && current.type !== 'PAGE') {
    out.unshift(current.parent.children.indexOf(current as SceneNode));
    current = current.parent;
  }
  return out;
}

function comparePaths(a: number[], b: number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

function union(rects: Rect[]): Rect {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  return {
    x, y,
    width: Math.max(...rects.map((r) => r.x + r.width)) - x,
    height: Math.max(...rects.map((r) => r.y + r.height)) - y,
  };
}

function plan(settings: Settings): Plan {
  const selection = figma.currentPage.selection;
  const notes: string[] = [];
  const jobs: Job[] = [];
  const assets: Asset[] = [];
  const counts = { images: 0, shapes: 0, texts: 0, groups: 0 };
  // Why layers that could have been native shapes are PNGs instead, grouped so the notes stay short.
  const fallbacks = new Map<string, string[]>();
  // Containers by layer id, for the clickable preview tree.
  const containers = new Map<string, { merged: boolean; canToggle: boolean }>();
  const empty = (label: string): Plan => ({
    scene: { name: '', frame: { width: 1, height: 1 }, layers: [] },
    jobs, assets, notes,
    summary: { label, title: '', frame: { width: 0, height: 0 }, rows: [], moreRows: 0, images: 0, shapes: 0, texts: 0, groups: 0, ok: false },
  });
  if (selection.length === 0) return empty('Select a frame or some layers');

  // Whole frame: a single top level container. Its own box is the comp space.
  // Anything else: only the selection is sent, positioned where it sits in its top level frame.
  const single = selection.length === 1 ? selection[0] : null;
  const wholeFrame = single && isContainer(single) && topLevelAncestor(single) === single && single.type !== 'GROUP';
  let ref: Rect;
  let roots: SceneNode[];
  let name: string;
  let label: string;

  if (wholeFrame && single) {
    ref = single.absoluteBoundingBox!;
    roots = [single];
    name = single.name;
    label = `Frame "${single.name}"`;
  } else {
    const selected = new Set(selection.map((n) => n.id));
    roots = selection
      .filter((n) => {
        for (let p = n.parent; p && p.type !== 'PAGE'; p = p.parent) if (selected.has(p.id)) return false;
        return true;
      })
      .sort((a, b) => comparePaths(orderPath(a), orderPath(b)));
    const tops = new Set(roots.map(topLevelAncestor));
    const top = tops.size === 1 ? [...tops][0] : null;
    if (top && !roots.includes(top) && top.absoluteBoundingBox) {
      ref = top.absoluteBoundingBox;
      name = top.name;
      label = `${roots.length} layer${roots.length > 1 ? 's' : ''} in "${top.name}"`;
    } else {
      const boxes = roots.map((n) => renderBounds(n) ?? n.absoluteBoundingBox).filter((r): r is Rect => !!r);
      if (boxes.length === 0) return empty('Selection has nothing visible');
      ref = union(boxes);
      name = roots[0].name;
      label = `${roots.length} loose layer${roots.length > 1 ? 's' : ''}`;
    }
  }

  const local = (r: Rect): Rect => ({ x: r.x - ref.x, y: r.y - ref.y, width: r.width, height: r.height });

  function multiplierFor(bounds: Rect): number {
    let m: number = settings.multiplier;
    if (settings.boostSmall) while (m < 4 && Math.max(bounds.width, bounds.height) * m < 96) m++;
    return m;
  }

  function imageLayer(node: SceneNode, exportNode: (scale: number) => Promise<{ bytes: Uint8Array; bounds: Rect | null }>,
    suffix = ''): ImageLayer | null {
    const render = renderBounds(node);
    if (!render || render.width <= 0 || render.height <= 0) return null;
    const multiplier = multiplierFor(render);
    const key = `asset:${node.id}${suffix}`;
    const safeName = (node.name + suffix).replace(/[^A-Za-z0-9 _-]+/g, '_').trim().slice(0, 48) || 'layer';
    const asset: Asset = {
      key,
      fileName: `${safeName}_${node.id.replace(/[^A-Za-z0-9]+/g, '-')}@${multiplier}x.png`,
      bytes: new Uint8Array(0),
    };
    const layer: ImageLayer = {
      type: 'image', id: node.id + suffix, name: node.name + suffix,
      // The PNG already carries the node's own opacity. Blend modes need the backdrop, so they go on the Merge.
      opacity: 1,
      blendMode: 'blendMode' in node ? (node.blendMode as BlendMode) : 'NORMAL',
      file: key, bounds: local(render), multiplier,
    };
    assets.push(asset);
    jobs.push({
      name: layer.name,
      run: async () => {
        const out = await exportNode(multiplier);
        asset.bytes = out.bytes;
        if (out.bounds) layer.bounds = local(out.bounds);
      },
    });
    counts.images++;
    return layer;
  }

  const png = (node: SceneNode, scale: number) =>
    node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: scale } });

  const flat = (node: SceneNode): ImageLayer | null =>
    imageLayer(node, async (scale) => ({ bytes: await png(node, scale), bounds: null }));

  // In Hybrid and Native mode a vector layer is rebuilt from Fusion nodes when that is exact.
  function native(node: SceneNode, asBackground: boolean): ShapeLayer | null {
    if (settings.importMode === 'png' || node.name.startsWith('*') || !canBeNative(node, asBackground)) return null;
    // The layout box, not the render bounds: a shadow must not pull the Transform pivot off the shape.
    const bounds = node.absoluteBoundingBox ?? renderBounds(node);
    if (!bounds) return null;
    const shape = nativeShape(node, ref, local(bounds), asBackground);
    if (typeof shape === 'string') {
      // An image fill being a PNG needs no explanation.
      if (shape !== 'an image fill') fallbacks.set(shape, [...(fallbacks.get(shape) ?? []), node.name]);
      return null;
    }
    counts.shapes++;
    return shape;
  }

  // A container's own fill, stroke and effects, rendered without its children.
  function ownBackground(node: Container): ImageLayer | ShapeLayer | null {
    if (node.type === 'GROUP' || node.type === 'SECTION') return null;
    if (!hasVisible(node.fills) && !hasVisible(node.strokes)) return null;
    const shape = native(node, true);
    if (shape) return shape;
    const image = imageLayer(node, async (scale) => {
      const copy = node.clone();
      try {
        figma.currentPage.appendChild(copy);
        const bare = copy.type === 'INSTANCE' ? copy.detachInstance() : copy;
        bare.layoutMode = 'NONE';
        for (const child of [...bare.children]) child.remove();
        bare.resize(node.width, node.height);
        bare.relativeTransform = node.absoluteTransform;
        bare.opacity = 1;
        const bytes = await png(bare, scale);
        const bounds = bare.absoluteRenderBounds;
        bare.remove();
        return { bytes, bounds };
      } catch (err) {
        if (!copy.removed) copy.remove();
        throw err;
      }
    }, ' BG');
    if (image) image.unclipped = true;
    return image;
  }

  function textLayer(node: TextNode): TextLayer | null {
    const box = node.absoluteBoundingBox;
    const why = (reason: string) => {
      notes.push(`"${node.name}": ${reason}, sent as PNG.`);
      return null;
    };
    if (!box) return null;
    // Rotated text is built upright around its real center; the Transform after it carries the angle.
    const m = node.absoluteTransform;
    const rigid = Math.abs(m[0][0] - m[1][1]) < 1e-4 && Math.abs(m[0][1] + m[1][0]) < 1e-4 && Math.abs(Math.hypot(m[0][0], m[1][0]) - 1) < 1e-3;
    if (!rigid) return why('skewed, flipped or scaled text');
    const rotation = (Math.atan2(m[0][1], m[0][0]) * 180) / Math.PI;
    const centerX = m[0][0] * (node.width / 2) + m[0][1] * (node.height / 2) + m[0][2] - ref.x;
    const centerY = m[1][0] * (node.width / 2) + m[1][1] * (node.height / 2) + m[1][2] - ref.y;
    const upright: Rect = { x: centerX - node.width / 2, y: centerY - node.height / 2, width: node.width, height: node.height };
    // Mixed styles stay live text: the longest run is the main style, the others travel as styled ranges.
    const segments = node.getStyledTextSegments(['fontName', 'fontSize', 'fills', 'letterSpacing', 'lineHeight']);
    if (segments.length === 0) return null;
    const solidOf = (paints: readonly Paint[]) => {
      const p = paints.find((x) => x.visible !== false);
      return p && p.type === 'SOLID' ? p : null;
    };
    // One gradient over the whole text: the text masks a gradient Background. Anything else that is
    // not a solid color (images, a different gradient per range) stays a PNG.
    let gradient: ShapePaint | undefined;
    if (segments.some((s) => !solidOf(s.fills))) {
      const fills = node.fills === figma.mixed ? [] : node.fills.filter((p) => p.visible !== false);
      if (fills.length !== 1) return why(node.fills === figma.mixed ? 'different non solid fills per range' : 'several text fills');
      const paint = toPaint(fills[0], node, [[1, 0, upright.x], [0, 1, upright.y]]);
      if (typeof paint === 'string') return why(paint);
      if (paint.kind === 'solid') return why('an unsupported text fill');
      gradient = paint;
    }
    const main = segments.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
    const WHITE: SolidPaint = { type: 'SOLID', color: { r: 1, g: 1, b: 1 } };
    const fill = solidOf(main.fills) ?? WHITE;
    const sameColor = (a: SolidPaint, b: SolidPaint) => a.color.r === b.color.r && a.color.g === b.color.g && a.color.b === b.color.b && (a.opacity ?? 1) === (b.opacity ?? 1);
    const runs: TextRun[] = [];
    for (const s of segments) {
      if (s === main) continue;
      const paint = solidOf(s.fills) ?? WHITE;
      const run: TextRun = { start: s.start, end: s.end };
      if (!gradient && !sameColor(paint, fill)) run.color = { ...paint.color, a: paint.opacity ?? 1 };
      if (s.fontName.family !== main.fontName.family) run.fontFamily = s.fontName.family;
      if (s.fontName.family !== main.fontName.family || s.fontName.style !== main.fontName.style) run.fontStyle = s.fontName.style;
      if (s.fontSize !== main.fontSize) run.fontSize = s.fontSize;
      // Ranges that only differ in spacing look like the main style.
      if (run.color || run.fontFamily || run.fontStyle || run.fontSize) runs.push(run);
    }
    if (hasVisible(node.strokes) || node.effects.some((e) => e.visible)) {
      notes.push(`"${node.name}": text strokes and effects are not carried over to live text.`);
    }
    const size = main.fontSize;
    const spacing = main.letterSpacing;
    const leading = main.lineHeight;
    const lineHeightPx = leading.unit === 'AUTO' ? null : leading.unit === 'PIXELS' ? leading.value : (size * leading.value) / 100;
    // A box taller than its typed lines has probably wrapped: the real breaks are measured at send time.
    const explicitLines = node.characters.replace(/\n+$/, '').split('\n').length;
    const mayWrap = node.textAutoResize !== 'WIDTH_AND_HEIGHT' && upright.height / (lineHeightPx ?? size * 1.2) > explicitLines + 0.6;
    counts.texts++;
    const layer: TextLayer = {
      type: 'text', id: node.id, name: node.name,
      opacity: node.opacity, blendMode: node.blendMode as BlendMode,
      target: 'textplus',
      characters: node.characters,
      fontFamily: main.fontName.family, fontStyle: main.fontName.style, fontSize: size,
      runs: runs.length > 0 ? runs : undefined,
      rotation: Math.abs(rotation) > 1e-4 ? rotation : undefined,
      paint: gradient,
      color: { ...fill.color, a: fill.opacity ?? 1 },
      letterSpacingPx: spacing.unit === 'PIXELS' ? spacing.value : (size * spacing.value) / 100,
      lineHeightPx,
      alignHorizontal: node.textAlignHorizontal, alignVertical: node.textAlignVertical,
      bounds: upright,
    };
    if (mayWrap) {
      jobs.push({
        name: `${node.name} (line breaks)`,
        run: async () => {
          try {
            layer.characters = await wrappedCharacters(node);
          } catch (err) {
            notes.push(`"${node.name}": could not read where the lines wrap (${err instanceof Error ? err.message : err}), so it arrives on its typed lines only.`);
          }
        },
      });
    }
    return layer;
  }

  function isIcon(node: Container): boolean {
    if (Math.max(node.width, node.height) > ICON_MAX_PX) return false;
    const all = 'findAll' in node ? node.findAll() : [];
    return all.length > 0 && all.every((n) => SHAPE_TYPES.has(n.type) || n.type === 'GROUP' || n.type === 'FRAME');
  }

  function mustFlatten(node: Container): string | null {
    if (node.children.some((c) => 'isMask' in c && c.isMask)) return 'contains a mask';
    if (isRotated(node) && 'clipsContent' in node && node.clipsContent) return 'rotated clipping frame';
    if ('effects' in node && node.effects.some((e) => e.visible) && !('fills' in node && hasVisible(node.fills))) {
      return 'effects on a container without a fill';
    }
    return null;
  }

  // Should this container travel as one element? Name and content rules win, then the choice saved
  // on the layer, then icons, then the global split setting.
  function together(node: Container, depth: number): { merged: boolean; canToggle: boolean; reason?: string } {
    if (node.name.startsWith('*')) return { merged: true, canToggle: false };
    if (node.name.startsWith('+')) return { merged: false, canToggle: false };
    const reason = mustFlatten(node);
    if (reason) return { merged: true, canToggle: false, reason };
    const saved = node.getPluginData(SPLIT_KEY);
    if (saved === 'merge') return { merged: true, canToggle: true };
    if (saved === 'split') return { merged: false, canToggle: true };
    if (settings.flattenIcons && isIcon(node)) return { merged: true, canToggle: true };
    return { merged: settings.splitMode === 'top' && depth >= 1, canToggle: true };
  }

  function walk(node: SceneNode, depth: number): Layer | null {
    if (!node.visible || node.name.startsWith('-')) return null;
    if (node.type === 'TEXT' && settings.textMode !== 'png' && !node.name.startsWith('*')) {
      const text = textLayer(node);
      if (text) return text;
    }
    if (!isContainer(node)) return native(node, false) ?? flat(node);
    const decision = together(node, depth);
    containers.set(node.id, decision);
    if (decision.merged) {
      if (decision.reason) notes.push(`"${node.name}": ${decision.reason}, sent as one PNG.`);
      return flat(node);
    }

    const box = node.absoluteBoundingBox;
    if (!box) return null;
    const children: Layer[] = [];
    const bg = ownBackground(node);
    if (bg) children.push(bg);
    for (const child of node.children) {
      const layer = walk(child, depth + 1);
      if (layer) children.push(layer);
    }
    if (children.length === 0) return null;
    counts.groups++;

    let clip: GroupLayer['clip'] = null;
    if ('clipsContent' in node && node.clipsContent) {
      const radius = node.cornerRadius === figma.mixed ? node.topLeftRadius : node.cornerRadius;
      if (node.cornerRadius === figma.mixed) notes.push(`"${node.name}": mixed corner radii, clip uses the top left radius.`);
      clip = { rect: local(box), cornerRadius: radius };
    }
    return {
      type: 'group', id: node.id, name: node.name,
      opacity: 'opacity' in node ? node.opacity : 1,
      blendMode: 'blendMode' in node ? (node.blendMode as BlendMode) : 'NORMAL',
      bounds: local(box), clip, children,
    };
  }

  let layers: Layer[] = [];
  for (const root of roots) {
    const layer = walk(root, wholeFrame ? 0 : 1);
    if (layer) layers.push(layer);
  }
  // The root frame becomes the comp itself rather than a nested group.
  if (wholeFrame && layers.length === 1 && layers[0].type === 'group') {
    counts.groups--;
    layers = layers[0].children;
  }

  for (const [reason, names] of fallbacks) {
    const shown = names.slice(0, 3).map((n) => `"${n}"`).join(', ') + (names.length > 3 ? ` and ${names.length - 3} more` : '');
    notes.push(`${names.length === 1 ? 'Stays a PNG' : `${names.length} layers stay PNGs`} because of ${reason}: ${shown}.`);
  }

  const rows: PreviewRow[] = [];
  const collect = (list: Layer[], depth: number) => {
    for (const l of list) {
      if (l.type === 'group') collect(l.children, depth + 1);
      const container = containers.get(l.id);
      rows.push({ name: l.name, kind: l.type, depth, ...(container ? { nodeId: l.id, ...container } : {}) });
    }
  };
  collect(layers, 0);

  return {
    scene: { name, frame: { width: ref.width, height: ref.height }, layers },
    jobs, assets, notes,
    summary: {
      label, title: name, frame: { width: Math.round(ref.width), height: Math.round(ref.height) },
      rows: rows.slice(0, MAX_PREVIEW_ROWS), moreRows: Math.max(0, rows.length - MAX_PREVIEW_ROWS),
      ...counts, ok: layers.length > 0,
    },
  };
}

function buildOptions(settings: Settings, scene: Scene): BuildOptions {
  const comp = settings.compSize === 'frame'
    ? scene.frame
    : { width: Number(settings.compSize.split('x')[0]), height: Number(settings.compSize.split('x')[1]) };
  // Fit whichever axis keeps the whole frame inside the comp.
  const fit = comp.width / scene.frame.width <= comp.height / scene.frame.height ? 'width' : 'height';
  return { comp, fit, transformNodes: settings.transformNodes, shapeStyle: settings.shapeStyle };
}

async function send(settings: Settings) {
  const { scene, jobs, assets, notes, summary } = plan(settings);
  if (!summary.ok) return post({ type: 'error', message: summary.label });
  for (let i = 0; i < jobs.length; i++) {
    post({ type: 'progress', done: i, total: jobs.length, name: jobs[i].name });
    await jobs[i].run();
  }
  post({
    type: 'export-done', scene, assets, notes,
    options: buildOptions(settings, scene),
    fileName: figma.root.name,
  });
}

async function main() {
  figma.showUI(__html__, { width: 320, height: 520, themeColors: false });
  const stored = (await figma.clientStorage.getAsync(SETTINGS_KEY)) as Partial<Settings> | undefined;
  let settings: Settings = { ...DEFAULT_SETTINGS, ...stored };
  // The old Native mode was Fusion nodes with icons split apart.
  if ((stored?.importMode as string) === 'native') settings = { ...settings, importMode: 'hybrid', flattenIcons: false };
  post({ type: 'init', settings, summary: plan(settings).summary });

  figma.on('selectionchange', () => post({ type: 'selection', summary: plan(settings).summary }));

  figma.ui.onmessage = async (msg: ToCode) => {
    try {
      if (msg.type === 'save-settings') {
        settings = msg.settings;
        await figma.clientStorage.setAsync(SETTINGS_KEY, settings);
        post({ type: 'selection', summary: plan(settings).summary });
      } else if (msg.type === 'send') {
        settings = msg.settings;
        await send(settings);
      } else if (msg.type === 'set-split') {
        const node = await figma.getNodeByIdAsync(msg.nodeId);
        if (node) node.setPluginData(SPLIT_KEY, msg.value);
        post({ type: 'selection', summary: plan(settings).summary });
      } else if (msg.type === 'resize') {
        figma.ui.resize(320, Math.max(320, Math.min(760, Math.round(msg.height))));
      } else if (msg.type === 'notify') {
        figma.notify(msg.message, { error: msg.error });
      }
    } catch (err) {
      post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };
}

main();
