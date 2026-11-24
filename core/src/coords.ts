import type { FitMode, Rect, Size } from './types';

// Fusion positions are normalized 0..1 with (0,0) at the bottom left and Y up.
// Positions divide X by comp width and Y by comp height, but sizes (mask width/height,
// text size) are relative to comp WIDTH on both axes.
export interface Space {
  comp: Size;
  scale: number;
  point(pxX: number, pxY: number): { x: number; y: number };
  center(rect: Rect): { x: number; y: number };
  size(px: number): number;
  // Mask heights are the exception: they are relative to comp height.
  sizeY(px: number): number;
  // Offsets from a mask Center, as polygon points use them: X over comp width, Y over comp height, Y up.
  dx(px: number): number;
  dy(px: number): number;
  // Merge/Transform Size for a PNG exported at `multiplier`.
  imageSize(multiplier: number): number;
}

export function makeSpace(frame: Size, comp: Size = frame, fit: FitMode = 'width'): Space {
  const scale =
    fit === 'width' ? comp.width / frame.width :
    fit === 'height' ? comp.height / frame.height :
    1;
  // The frame is centered inside the comp when aspect ratios differ.
  const offsetX = (comp.width - frame.width * scale) / 2;
  const offsetY = (comp.height - frame.height * scale) / 2;

  const point = (pxX: number, pxY: number) => ({
    x: (offsetX + pxX * scale) / comp.width,
    y: 1 - (offsetY + pxY * scale) / comp.height,
  });

  return {
    comp,
    scale,
    point,
    center: (r) => point(r.x + r.width / 2, r.y + r.height / 2),
    size: (px) => (px * scale) / comp.width,
    sizeY: (px) => (px * scale) / comp.height,
    dx: (px) => (px * scale) / comp.width,
    dy: (px) => (-px * scale) / comp.height,
    imageSize: (multiplier) => scale / multiplier,
  };
}
