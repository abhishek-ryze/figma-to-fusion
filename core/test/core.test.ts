import { describe, expect, it } from 'vitest';
import { buildComp, makeSpace, type ImageLayer, type Scene, type TextLayer } from '../src/index';
import { input, point, serialize, tbl } from '../src/lua';

const image = (over: Partial<ImageLayer>): ImageLayer => ({
  type: 'image', id: '1:1', name: 'Icon', opacity: 1, blendMode: 'NORMAL',
  file: 'C:\\exports\\icon@2x.png', bounds: { x: 0, y: 0, width: 20, height: 20 }, multiplier: 2,
  ...over,
});

describe('coords', () => {
  const space = makeSpace({ width: 1920, height: 1080 });

  it('maps the top left corner to (0, 1) and the center to (0.5, 0.5)', () => {
    expect(space.point(0, 0)).toEqual({ x: 0, y: 1 });
    expect(space.point(960, 540)).toEqual({ x: 0.5, y: 0.5 });
    expect(space.point(1920, 1080)).toEqual({ x: 1, y: 0 });
  });

  it('places elements by their center', () => {
    expect(space.center({ x: 100, y: 100, width: 200, height: 80 })).toEqual({ x: 200 / 1920, y: 1 - 140 / 1080 });
  });

  it('measures sizes against comp width on both axes', () => {
    expect(space.size(192)).toBeCloseTo(0.1);
  });

  it('inverts the export multiplier, scaled by comp resolution', () => {
    expect(space.imageSize(4)).toBe(0.25);
    const uhd = makeSpace({ width: 1920, height: 1080 }, { width: 3840, height: 2160 });
    expect(uhd.imageSize(2)).toBe(1); // zero resampling
    expect(uhd.center({ x: 0, y: 0, width: 1920, height: 1080 })).toEqual({ x: 0.5, y: 0.5 });
  });

  it('centers the frame when aspect ratios differ', () => {
    const square = makeSpace({ width: 1080, height: 1080 }, { width: 1920, height: 1080 }, 'height');
    expect(square.point(540, 540)).toEqual({ x: 0.5, y: 0.5 });
    expect(square.point(0, 0).x).toBeCloseTo(420 / 1920);
  });
});

describe('lua', () => {
  it('escapes Windows paths and quotes keys that are not identifiers', () => {
    const out = serialize(tbl(null, { Filename: 'C:\\a\\b.png', 'Gamut.SLogVersion': 1 }));
    expect(out).toBe('{ Filename = "C:\\\\a\\\\b.png", ["Gamut.SLogVersion"] = 1 }');
  });

  it('nests constructors', () => {
    expect(serialize(input(point(0.5, 0.25)))).toBe('Input {\n\tValue = { 0.5, 0.25 },\n}');
  });
});

describe('buildComp', () => {
  const scene: Scene = {
    name: 'Hero',
    frame: { width: 1920, height: 1080 },
    layers: [
      image({ name: 'BG', bounds: { x: 0, y: 0, width: 1920, height: 1080 }, multiplier: 1 }),
      {
        type: 'group', id: '1:2', name: 'Card', opacity: 0.5, blendMode: 'MULTIPLY',
        bounds: { x: 100, y: 100, width: 400, height: 200 },
        clip: { rect: { x: 100, y: 100, width: 400, height: 200 }, cornerRadius: 50 },
        children: [image({ name: '20 icon' })],
      },
    ],
  };

  it('builds a trunk with Loader, placement, Transform and Merge per image', () => {
    const { text, toolCount, warnings } = buildComp(scene);
    expect(warnings).toEqual([]);
    // canvas + BG(4) + group canvas + icon(4) + clip + group XF + group merge
    expect(toolCount).toBe(13);
    expect(text).toContain('Tools = ordered() {');
    expect(text).toContain('BG = Loader {');
    expect(text).toContain('L_20_icon = Loader {'); // names cannot start with a digit
    expect(text).toContain('FuID { "Multiply" }');
    expect(text).toContain('Blend = Input { Value = 0.5 }');
    expect(text).toContain('CornerRadius = Input { Value = 0.5 }');
    expect(text).toContain('Source = "Mask"');
  });

  it('puts placement on the trunk Merge when Transform nodes are off', () => {
    const { toolCount, text } = buildComp({ ...scene, layers: [scene.layers[0]] }, { transformNodes: false });
    expect(toolCount).toBe(3);
    expect(text).not.toContain('Transform {');
  });

  const title = (target: 'textplus'): Scene => ({
    ...scene,
    layers: [{
      type: 'text', id: '1:3', name: 'Title', opacity: 1, blendMode: 'NORMAL', target,
      characters: 'Hello\n"World"', fontFamily: 'Inter', fontStyle: 'Bold', fontSize: 96,
      color: { r: 1, g: 0.5, b: 0, a: 1 }, letterSpacingPx: 0, lineHeightPx: null,
      alignHorizontal: 'LEFT', alignVertical: 'TOP', bounds: { x: 0, y: 0, width: 960, height: 120 },
    }],
  });

  it('sizes Text+ by ascent + descent and anchors the last baseline', () => {
    const scene = title('textplus');
    const layer = scene.layers[0] as TextLayer;
    layer.characters = 'H';
    layer.fontSize = 137.12; // what Arial Bold measured at Size 0.1 in a 1920 comp
    layer.metrics = { ascent: 1854 / 2048, descent: 434 / 2048, lineGap: 67 / 2048 };
    layer.lineHeightPx = 200;
    layer.bounds = { x: 0, y: 440, width: 960, height: 200 };
    const { text, warnings } = buildComp(scene);
    expect(warnings).toEqual([]);
    expect(Number(/Size = Input \{ Value = ([\d.]+) \}/.exec(text)![1])).toBeCloseTo(0.1, 3);
    expect(text).toContain('VerticalTopCenterBottom = Input { Value = 1 }');
    // baseline = 440 + (200 - 153.19) / 2 + 124.13 = 587.54 px from the top
    expect(Number(/Center = Input \{\s*Value = \{ 0, ([\d.]+) \}/.exec(text)![1])).toBeCloseTo(1 - 587.54 / 1080, 4);
    expect(Number(/LineSpacing = Input \{ Value = ([\d.]+) \}/.exec(text)![1])).toBeCloseTo(200 / 153.19, 3);
  });

  it('escapes text and warns when the font is unknown', () => {
    const { text, warnings } = buildComp(title('textplus'));
    expect(text).toContain('StyledText = Input { Value = "Hello\\n\\"World\\"" }');
    expect(warnings[0]).toMatch(/was not found/);
  });

  it('imports mixed text into Text+ with the main style and says so', () => {
    const s = title('textplus');
    (s.layers[0] as TextLayer).runs = [{ start: 0, end: 5, fontStyle: 'Regular' }];
    const { text, warnings } = buildComp(s);
    expect(text).toContain('TextPlus {');
    expect(warnings.some((w) => /main style only/.test(w))).toBe(true);
  });

  it('carries text rotation on the Transform, even when Transform nodes are off', () => {
    const s = title('textplus');
    (s.layers[0] as TextLayer).rotation = 30;
    const { text } = buildComp(s, { transformNodes: false });
    expect(text).toContain('Title_XF = Transform {');
    expect(text).toContain('Angle = Input { Value = 30 }');
    // Pivot on the center of the upright box: (480, 60) in a 1920 x 1080 frame.
    expect(text).toMatch(/Pivot = Input \{\s*Value = \{ 0\.25, 0\.9444444 \}/);
  });

  it('fills text with a gradient by masking a gradient Background with white text', () => {
    const s = title('textplus');
    const layer = s.layers[0] as TextLayer;
    layer.paint = { kind: 'linear', start: { x: 0, y: 60 }, end: { x: 960, y: 60 }, stops: [{ position: 0, color: { r: 1, g: 0, b: 0, a: 1 } }, { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } }] };
    layer.runs = [{ start: 0, end: 5, color: { r: 0, g: 1, b: 0, a: 1 }, fontStyle: 'Regular' }];
    const { text } = buildComp(s);
    expect(text).toContain('Title_Text = TextPlus {');
    expect(text).toContain('Green1 = Input { Value = 1 }'); // drawn white, the gradient supplies the color
    expect(text).toContain('Title = Background {');
    expect(text).toContain('EffectMask = Input { SourceOp = "Title_Text", Source = "Output" }');
    expect(text).toContain('[0] = { 1, 0, 0, 1 }, [1] = { 0, 0, 1, 1 }');
  });
  it('sizes clip mask height against comp height', () => {
    const { text } = buildComp(scene);
    expect(text).toContain(`Height = Input { Value = ${parseFloat((200 / 1080).toFixed(7))} }`);
  });
});
