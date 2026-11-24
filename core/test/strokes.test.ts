import { describe, expect, it } from 'vitest';
import { buildComp, type Geometry, type Matrix, type Scene, type ShapePart } from '../src/index';
import { toContours } from '../src/paths';

const I: Matrix = [[1, 0, 0], [0, 1, 0]];
// Real Figma strokeGeometry: inside stroke of 8 on a 240 x 160 rectangle with radius 24. Four bars and
// four corner arcs that share edges, outlining a centered stroke of twice the weight.
const INSIDE_8 = 'M24 0 L24 8 L216 8 L216 0 L216 -8 L24 -8 L24 0 Z M240 24 L232 24 L232 136 L240 136 L248 136 L248 24 L240 24 Z M216 160 L216 152 L24 152 L24 160 L24 168 L216 168 L216 160 Z M0 136 L8 136 L8 24 L0 24 L-8 24 L-8 136 L0 136 Z M24 160 L24 152 C15.1634 152 8 144.837 8 136 L0 136 L-8 136 C-8 153.673 6.3269 168 24 168 L24 160 Z M240 136 L232 136 C232 144.837 224.837 152 216 152 L216 160 L216 168 C233.673 168 248 153.673 248 136 L240 136 Z M216 0 L216 8 C224.837 8 232 15.1634 232 24 L240 24 L248 24 C248 6.32689 233.673 -8 216 -8 L216 0 Z M24 0 L24 -8 C6.32689 -8 -8 6.32688 -8 24 L0 24 L8 24 C8 15.1634 15.1634 8 24 8 L24 0 Z';
const white = { kind: 'solid' as const, color: { r: 1, g: 1, b: 1, a: 1 } };
const box = (w: number, h: number, r: number): Geometry => ({ kind: 'rect', center: { x: 120, y: 80 }, width: w, height: h, rotation: 0, cornerRadius: r });
const scene = (part: ShapePart): Scene => ({
  name: 'S', frame: { width: 1920, height: 1080 },
  layers: [{ type: 'shape', id: '1', name: 'Box', opacity: 1, blendMode: 'NORMAL', bounds: { x: 0, y: 0, width: 240, height: 160 }, parts: [part] }],
});

describe('strokes', () => {
  it('keeps every piece of an outline whose pieces share edges', () => {
    // The corner arcs used to be dropped: just outside their longest edge lies a bar, which is filled too.
    const contours = toContours([{ windingRule: 'NONZERO', data: INSIDE_8 }], I);
    expect(contours).toHaveLength(8);
    expect(contours.every((c) => c.op === 'Add')).toBe(true);
  });

  it('clips an inside stroke to the shape with a Multiply mask, an outside stroke with Subtract', () => {
    const geometry: Geometry = { kind: 'paths', transform: I, paths: [{ windingRule: 'NONZERO', data: INSIDE_8 }] };
    const inside = buildComp(scene({ label: 'Stroke', paint: white, geometry, clip: { shape: box(240, 160, 24), keep: 'inside' } })).text;
    expect(inside).toContain('Box_Inside_Mask = RectangleMask {');
    expect(inside).toMatch(/Box_Inside_Mask = RectangleMask \{[\s\S]*?PaintMode = Input \{\s*Value = FuID \{ "Multiply" \}/);
    expect(inside).toContain('EffectMask = Input { SourceOp = "Box_Path8", Source = "Mask" }');
    expect(inside).toContain('EffectMask = Input { SourceOp = "Box_Inside_Mask", Source = "Mask" }'); // the Background reads the clip

    const outside = buildComp(scene({ label: 'Stroke', paint: white, geometry, clip: { shape: box(240, 160, 24), keep: 'outside' } })).text;
    expect(outside).toMatch(/Box_Outside_Mask = RectangleMask \{[\s\S]*?Value = FuID \{ "Subtract" \}/);
  });

  it('draws a rectangle stroke as one outline mask: Solid off, Border Width over comp width', () => {
    const { text, toolCount } = buildComp(scene({ label: 'Stroke', paint: white, geometry: { ...box(232, 152, 20), outline: 8 } as Geometry }));
    expect(toolCount).toBe(5); // canvas, mask, background, transform, merge
    expect(text).toContain('Solid = Input { Value = 0 }');
    expect(text).toContain(`BorderWidth = Input { Value = ${parseFloat((8 / 1920).toFixed(7))} }`);
  });

  it('lays a fill + stroke layer out along one row, with the stroke branch underneath', () => {
    const fill: ShapePart = { label: 'Fill', paint: white, geometry: box(240, 160, 24) };
    const stroke: ShapePart = { label: 'Stroke', paint: white, geometry: { ...box(232, 152, 20), outline: 8 } as Geometry };
    const s = scene(fill);
    s.layers = [{ ...s.layers[0], parts: [fill, stroke] } as Scene['layers'][0], { ...s.layers[0], id: '2', name: 'Next' }];
    const { text } = buildComp(s);
    const pos = (tool: string) => new RegExp(`${tool} = \\w+ \\{[\\s\\S]*?Pos = \\{ (-?\\d+), (-?\\d+) \\}`).exec(text)!.slice(1, 3).map(Number);
    // Main row (y 66): fill mask, fill Background, Over merge, Transform, trunk Merge, left to right.
    expect(pos('Box_Fill_Mask')).toEqual([-440, 66]);
    expect(pos('Box_Fill')).toEqual([-330, 66]);
    expect(pos('Box_Stroke_Over')).toEqual([-220, 66]);
    expect(pos('Box_XF')).toEqual([-110, 66]);
    expect(pos('Box_Merge')).toEqual([0, 66]);
    // The stroke's Background sits straight under the Over merge it feeds, its mask to the left.
    expect(pos('Box_Stroke')).toEqual([-220, 132]);
    expect(pos('Box_Stroke_Mask')).toEqual([-330, 132]);
    // The next layer starts below the stroke row, not on top of it.
    expect(pos('Next_Merge')).toEqual([0, 198]);
  });

  it('does the same with the shape system', () => {
    const { text } = buildComp(scene({ label: 'Stroke', paint: white, geometry: { ...box(232, 152, 20), outline: 8 } as Geometry }), { shapeStyle: 'shapes' });
    expect(text).toMatch(/Box_Shape = sRectangle \{[\s\S]*?Solid = Input \{ Value = 0 \}[\s\S]*?BorderWidth/);
  });
});
