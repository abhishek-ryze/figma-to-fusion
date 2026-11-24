// Bundles the tray app for Electron and draws its icons (no image tooling needed).
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

const root = path.dirname(fileURLToPath(import.meta.url));
mkdirSync(path.join(root, 'assets'), { recursive: true });

await build({
  entryPoints: [path.join(root, 'src', 'main.ts')],
  outfile: path.join(root, 'dist', 'main.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  logLevel: 'info',
});

function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) raw.set(pixel(x, y), y * (size * 4 + 1) + 1 + x * 4);
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Icon: rounded blue tile with a white "layer into node" mark: a small square, an arrow, a larger square.
// Shapes are signed distance fields in 0..1 space, supersampled 4x4 for smooth edges.
const box = (px, py, cx, cy, hw, hh, r) => {
  const dx = Math.abs(px - cx) - hw + r, dy = Math.abs(py - cy) - hh + r;
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r;
};
function sample(u, v) {
  if (box(u, v, 0.5, 0.5, 0.47, 0.47, 0.22) > 0) return null;
  const small = box(u, v, 0.27, 0.5, 0.11, 0.11, 0.035) <= 0;
  const big = box(u, v, 0.73, 0.5, 0.15, 0.2, 0.05) <= 0 && box(u, v, 0.73, 0.5, 0.09, 0.14, 0.02) > 0;
  const shaft = box(u, v, 0.475, 0.5, 0.06, 0.022, 0) <= 0;
  const head = u > 0.5 && u < 0.585 && Math.abs(v - 0.5) < (0.585 - u) * 0.95;
  return small || big || shaft || head ? [255, 255, 255] : [24 + 20 * v, 110 - 30 * v, 255 - 35 * v];
}
function icon(size) {
  const n = 4;
  return png(size, (x, y) => {
    let r = 0, g = 0, b = 0, a = 0;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const c = sample((x + (i + 0.5) / n) / size, (y + (j + 0.5) / n) / size);
      if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
    }
    return a ? [r / a, g / a, b / a, (255 * a) / (n * n)] : [0, 0, 0, 0];
  });
}
writeFileSync(path.join(root, 'assets', 'tray.png'), icon(32));
writeFileSync(path.join(root, 'assets', 'icon.png'), icon(512));
console.log('icons written');
