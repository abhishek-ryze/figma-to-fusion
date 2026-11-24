import { describe, expect, it } from 'vitest';
import { buildComp, type Matrix, type Scene, type ShapeLayer } from '../src/index';
import { toContours } from '../src/paths';

const I: Matrix = [[1, 0, 0], [0, 1, 0]];
const square = (x: number, y: number, s: number, clockwise = true) =>
  clockwise ? `M ${x} ${y} L ${x + s} ${y} L ${x + s} ${y + s} L ${x} ${y + s} Z` : `M ${x} ${y} L ${x} ${y + s} L ${x + s} ${y + s} L ${x + s} ${y} Z`;

describe('toContours', () => {
  it('cuts a hole for the inner contour under EVENODD', () => {
    const c = toContours([{ windingRule: 'EVENODD', data: square(0, 0, 100) + square(25, 25, 50) }], I);
    expect(c.map((x) => x.op)).toEqual(['Add', 'Subtract']);
    expect(c[0].area).toBe(10000);
  });

  it('follows direction under NONZERO', () => {
    const hole = toContours([{ windingRule: 'NONZERO', data: square(0, 0, 100) + square(25, 25, 50, false) }], I);
    expect(hole.map((x) => x.op)).toEqual(['Add', 'Subtract']);
    // Same direction: the inner square changes nothing, so it is dropped.
    const solid = toContours([{ windingRule: 'NONZERO', data: square(0, 0, 100) + square(25, 25, 50) }], I);
    expect(solid.map((x) => x.op)).toEqual(['Add']);
  });

  it('fills an island inside a hole again, outer contours first', () => {
    const c = toContours([{ windingRule: 'EVENODD', data: square(40, 40, 20) + square(0, 0, 100) + square(25, 25, 50) }], I);
    expect(c.map((x) => [x.op, x.area])).toEqual([['Add', 10000], ['Subtract', 2500], ['Add', 400]]);
  });

  it('applies the transform, converts quadratics, and closes open paths', () => {
    const c = toContours([{ windingRule: 'NONZERO', data: 'M 0 0 Q 50 100 100 0' }], [[2, 0, 10], [0, 2, 20]]);
    expect(c).toHaveLength(1);
    expect(c[0].anchors[0].p).toEqual({ x: 10, y: 20 });
    // Quadratic control (50,100) becomes cubic handles two thirds of the way to it.
    expect(c[0].anchors[0].r.x).toBeCloseTo(10 + (2 / 3) * 100);
    expect(c[0].anchors[0].r.y).toBeCloseTo(20 + (2 / 3) * 200);
    expect(c[0].anchors).toHaveLength(2); // curve, then the closing line back
  });

  it('drops zero area contours', () => {
    expect(toContours([{ windingRule: 'NONZERO', data: 'M 0 0 L 100 0 Z' }], I)).toEqual([]);
  });
});

describe('shape layers', () => {
  const shape = (parts: ShapeLayer['parts']): Scene => ({
    name: 'S', frame: { width: 1920, height: 1080 },
    layers: [{ type: 'shape', id: '1', name: 'Card', opacity: 0.8, blendMode: 'NORMAL', bounds: { x: 100, y: 100, width: 400, height: 200 }, parts }],
  });
  const rect = { kind: 'rect' as const, center: { x: 300, y: 200 }, width: 400, height: 200, rotation: 15, cornerRadius: 50 };

  it('builds a rounded, rotated Rectangle mask behind a solid Background', () => {
    const { text, toolCount } = buildComp(shape([{ label: 'Fill', geometry: rect, paint: { kind: 'solid', color: { r: 1, g: 0.5, b: 0, a: 0.5 } } }]));
    expect(toolCount).toBe(5); // canvas, mask, background, transform, merge
    expect(text).toContain('Card_Mask = RectangleMask {');
    expect(text).toContain(`Height = Input { Value = ${parseFloat((200 / 1080).toFixed(7))} }`);
    expect(text).toContain('CornerRadius = Input { Value = 0.5 }');
    expect(text).toContain('Angle = Input { Value = 15 }');
    expect(text).toContain('TopLeftAlpha = Input { Value = 0.5 }');
    expect(text).toContain('EffectMask = Input { SourceOp = "Card_Mask", Source = "Mask" }');
    expect(text).toContain('Blend = Input { Value = 0.8 }');
  });

  it('can use the shape system for solid rectangles, offsets from the comp center in width units', () => {
    const { text, toolCount } = buildComp(shape([{ label: 'Fill', geometry: rect, paint: { kind: 'solid', color: { r: 1, g: 0.5, b: 0, a: 1 } } }]), { shapeStyle: 'shapes' });
    expect(toolCount).toBe(5); // canvas, sRectangle, sRender, transform, merge
    expect(text).toContain('Card_Shape = sRectangle {');
    expect(text).toContain('Card = sRender {');
    expect(text).toContain(`["Translate.X"] = Input { Value = ${parseFloat((300 / 1920 - 0.5).toFixed(7))} }`);
    // 340 px above the comp center, divided by comp WIDTH
    expect(text).toContain(`["Translate.Y"] = Input { Value = ${parseFloat((340 / 1920).toFixed(7))} }`);
    expect(text).toContain(`Height = Input { Value = ${parseFloat((200 / 1920).toFixed(7))} }`);
  });

  it('keeps masks for gradients even when the shape system is chosen', () => {
    const { text } = buildComp(shape([{ label: 'Fill', geometry: rect, paint: { kind: 'radial', start: { x: 300, y: 200 }, end: { x: 500, y: 200 }, stops: [{ position: 0, color: { r: 1, g: 1, b: 1, a: 1 } }, { position: 1, color: { r: 0, g: 0, b: 0, a: 1 } }] } }]), { shapeStyle: 'shapes' });
    expect(text).toContain('RectangleMask {');
    expect(text).not.toContain('sRender');
  });

  it('sizes an Ellipse mask against comp width on both axes', () => {
    const { text } = buildComp(shape([{ label: 'Fill', geometry: { kind: 'ellipse', center: { x: 960, y: 540 }, width: 192, height: 192, rotation: 0 }, paint: { kind: 'solid', color: { r: 1, g: 1, b: 1, a: 1 } } }]));
    expect(text.match(/(Width|Height) = Input \{ Value = 0\.1 \}/g)).toHaveLength(2);
  });

  it('chains polygon masks with Subtract for holes and writes point offsets', () => {
    const { text } = buildComp(shape([{
      label: 'Fill', paint: { kind: 'solid', color: { r: 1, g: 1, b: 1, a: 1 } },
      geometry: { kind: 'paths', transform: I, paths: [{ windingRule: 'EVENODD', data: square(0, 0, 192) + square(48, 48, 96) }] },
    }]));
    expect(text).toContain('Card_Path1 = PolylineMask {');
    expect(text).toContain('PaintMode = Input {\n\t\t\t\t\tValue = FuID { "Subtract" },');
    expect(text).toContain('EffectMask = Input { SourceOp = "Card_Path1", Source = "Mask" }');
    // Top left corner of a 192 px square centered on the mask: x -96/1920, y +96/1080 (Y up).
    expect(text).toContain(`X = -0.05, Y = ${parseFloat((96 / 1080).toFixed(7))}`);
  });

  it('adds an editable Shadow then Blur, sized from the measured Fusion factors', () => {
    const scene = shape([{ label: 'Fill', geometry: rect, paint: { kind: 'solid', color: { r: 1, g: 1, b: 1, a: 1 } } }]);
    (scene.layers[0] as ShapeLayer).effects = [
      { kind: 'dropShadow', offset: { x: 96, y: 108 }, blur: 40, color: { r: 0, g: 0, b: 0, a: 0.25 } },
      { kind: 'layerBlur', blur: 12 },
    ];
    const { text, toolCount } = buildComp(scene);
    expect(toolCount).toBe(7); // canvas, mask, background, shadow, blur, transform, merge
    // 96 px right and 108 px down: X over width, Y over height, Y up.
    expect(text).toMatch(/ShadowOffset = Input \{\s*Value = \{ 0\.55, 0\.4 \}/);
    // sigma 20 px / (0.4306 x 1920)
    expect(Number(/Softness = Input \{ Value = ([\d.]+) \}/.exec(text)![1])).toBeCloseTo(20 / (0.4306 * 1920), 6);
    // sigma 6 px / (0.000598 x 1920)
    expect(Number(/XBlurSize = Input \{ Value = ([\d.]+) \}/.exec(text)![1])).toBeCloseTo(6 / (0.000598 * 1920), 4);
    expect(text).toContain('Input = Input { SourceOp = "Card_Shadow", Source = "Output" }'); // blur reads the shadow
    expect(text.indexOf('Card_Shadow = Shadow')).toBeLessThan(text.indexOf('Card_Blur = Blur'));
  });

  it('clips the children of a frame but not its own background', () => {
    const bg = shape([{ label: 'Fill', geometry: rect, paint: { kind: 'solid', color: { r: 1, g: 1, b: 1, a: 1 } } }]).layers[0] as ShapeLayer;
    const child = { ...bg, id: '2', name: 'Child' };
    const { text } = buildComp({
      name: 'S', frame: { width: 1920, height: 1080 },
      layers: [{ type: 'group', id: 'g', name: 'Frame', opacity: 1, blendMode: 'NORMAL', bounds: bg.bounds,
        clip: { rect: bg.bounds, cornerRadius: 0 }, children: [{ ...bg, name: 'Frame BG', unclipped: true }, child] }],
    });
    const merge = (name: string) => text.slice(text.indexOf(name + ' = Merge {'), text.indexOf('ViewInfo', text.indexOf(name + ' = Merge {')));
    expect(merge('Child_Merge')).toContain('EffectMask = Input { SourceOp = "Frame_Clip", Source = "Mask" }');
    expect(merge('Frame_BG_Merge')).not.toContain('EffectMask');
    expect(merge('Frame_Merge')).not.toContain('EffectMask');
  });

  it('stacks fill and stroke, with a gradient fill', () => {
    const { text, toolCount } = buildComp(shape([
      { label: 'Fill', geometry: rect, paint: { kind: 'linear', start: { x: 100, y: 200 }, end: { x: 500, y: 200 },
        stops: [{ position: 0, color: { r: 1, g: 0, b: 0, a: 1 } }, { position: 0.5, color: { r: 0, g: 1, b: 0, a: 1 } }, { position: 0.5, color: { r: 0, g: 0, b: 1, a: 1 } }] } },
      { label: 'Stroke', geometry: rect, paint: { kind: 'solid', color: { r: 0, g: 0, b: 0, a: 1 } } },
    ]));
    expect(toolCount).toBe(8); // canvas, 2 masks, 2 backgrounds, over, transform, merge
    expect(text).toContain('GradientType = Input {\n\t\t\t\t\tValue = FuID { "Linear" },');
    // The duplicate 0.5 stop is nudged so both survive as table keys.
    expect(text).toContain('[0] = { 1, 0, 0, 1 }, [0.5] = { 0, 1, 0, 1 }, [0.5001] = { 0, 0, 1, 1 }');
    expect(text).toContain('Card_Stroke_Over = Merge {');
  });
});
