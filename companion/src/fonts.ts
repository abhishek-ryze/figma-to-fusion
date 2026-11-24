// Reads vertical metrics (hhea ascent / descent / line gap) from installed fonts. Fusion sizes text
// by ascent + descent and Figma lays out baselines from the same numbers, so they are needed to
// land live text where Figma drew it.
import { closeSync, openSync, readSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { FontMetrics } from '../../core/src/types';

const FONT_DIRS = [
  'C:\\Windows\\Fonts',
  path.join(homedir(), 'AppData', 'Local', 'Microsoft', 'Windows', 'Fonts'),
];

const key = (family: string, style: string) => `${family}|${style}`.toLowerCase().replace(/\s+/g, '');

let index: Map<string, FontMetrics> | null = null;

function read(fd: number, offset: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  readSync(fd, buf, 0, length, offset);
  return buf;
}

function parseFace(fd: number, faceOffset: number, out: Map<string, FontMetrics>) {
  const numTables = read(fd, faceOffset + 4, 2).readUInt16BE(0);
  const dir = read(fd, faceOffset + 12, numTables * 16);
  const tables: Record<string, { offset: number; length: number }> = {};
  for (let i = 0; i < numTables; i++) {
    tables[dir.toString('ascii', i * 16, i * 16 + 4)] = {
      offset: dir.readUInt32BE(i * 16 + 8),
      length: dir.readUInt32BE(i * 16 + 12),
    };
  }
  if (!tables.head || !tables.hhea || !tables.name) return;

  const unitsPerEm = read(fd, tables.head.offset + 18, 2).readUInt16BE(0);
  const hhea = read(fd, tables.hhea.offset + 4, 6);
  const metrics: FontMetrics = {
    ascent: hhea.readInt16BE(0) / unitsPerEm,
    descent: -hhea.readInt16BE(2) / unitsPerEm,
    lineGap: hhea.readInt16BE(4) / unitsPerEm,
  };

  const name = read(fd, tables.name.offset, tables.name.length);
  const count = name.readUInt16BE(2);
  const strings = name.readUInt16BE(4);
  const names: Record<number, string> = {};
  for (let i = 0; i < count; i++) {
    const rec = 6 + i * 12;
    const platform = name.readUInt16BE(rec);
    const nameId = name.readUInt16BE(rec + 6);
    if (![1, 2, 16, 17].includes(nameId)) continue;
    const raw = name.subarray(strings + name.readUInt16BE(rec + 10), strings + name.readUInt16BE(rec + 10) + name.readUInt16BE(rec + 8));
    // Windows platform strings are UTF-16BE and win over Mac Roman ones.
    if (platform === 3) names[nameId] = Buffer.from(raw).swap16().toString('utf16le');
    else if (platform === 1 && !names[nameId]) names[nameId] = raw.toString('latin1');
  }
  // Figma shows typographic names (16/17) when a font has them, legacy names (1/2) otherwise.
  const pairs: Array<[string | undefined, string | undefined]> = [[names[16], names[17]], [names[1], names[2]]];
  for (const [family, style] of pairs) {
    if (!family) continue;
    out.set(key(family, style ?? 'Regular'), metrics);
    if (!out.has(key(family, '*'))) out.set(key(family, '*'), metrics);
  }
}

function buildIndex(): Map<string, FontMetrics> {
  const out = new Map<string, FontMetrics>();
  for (const dir of FONT_DIRS) {
    let files: string[] = [];
    try { files = readdirSync(dir); } catch { continue; }
    for (const file of files) {
      if (!/\.(ttf|otf|ttc)$/i.test(file)) continue;
      let fd: number | null = null;
      try {
        fd = openSync(path.join(dir, file), 'r');
        if (read(fd, 0, 4).toString('ascii') === 'ttcf') {
          const faces = read(fd, 8, 4).readUInt32BE(0);
          const offsets = read(fd, 12, faces * 4);
          for (let i = 0; i < faces; i++) parseFace(fd, offsets.readUInt32BE(i * 4), out);
        } else {
          parseFace(fd, 0, out);
        }
      } catch {
        // Unreadable or malformed font: skip it.
      } finally {
        if (fd !== null) closeSync(fd);
      }
    }
  }
  return out;
}

// Exact family + style first, then any face of the family (weights nearly always share metrics,
// and variable fonts only register their default instance).
export function fontMetrics(family: string, style: string): FontMetrics | null {
  index ??= buildIndex();
  return index.get(key(family, style)) ?? index.get(key(family, '*')) ?? null;
}
