// Minimal serializer for Fusion's Lua table syntax (.setting / clipboard node text).

export class LuaRaw {
  constructor(public code: string) {}
}

export class LuaTable {
  constructor(
    public ctor: string | null,
    public fields: Array<[string | null, LuaValue]>,
  ) {}
}

export type LuaValue = number | string | boolean | LuaTable | LuaRaw;

export function tbl(ctor: string | null, fields: Record<string, LuaValue | undefined>): LuaTable {
  const out: Array<[string | null, LuaValue]> = [];
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) out.push([k, v]);
  return new LuaTable(ctor, out);
}

export function list(ctor: string | null, items: LuaValue[]): LuaTable {
  return new LuaTable(ctor, items.map((v) => [null, v]));
}

export const input = (value: LuaValue) => tbl('Input', { Value: value });
export const link = (sourceOp: string, source = 'Output') =>
  tbl('Input', { SourceOp: sourceOp, Source: source });
export const fuid = (id: string) => list('FuID', [id]);
export const point = (x: number, y: number) => list(null, [x, y]);

function num(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`Cannot serialize number: ${n}`);
  if (Number.isInteger(n)) return String(n);
  return String(parseFloat(n.toFixed(7)));
}

function str(s: string): string {
  return '"' + s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/\t/g, '\\t') + '"';
}

function key(k: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : `[${str(k)}]`;
}

export function serialize(value: LuaValue, indent = 0): string {
  if (typeof value === 'number') return num(value);
  if (typeof value === 'string') return str(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof LuaRaw) return value.code;

  const head = value.ctor ? `${value.ctor} {` : '{';
  if (value.fields.length === 0) return `${head} }`;

  const flat = value.fields.every(([, v]) => typeof v !== 'object' || v instanceof LuaRaw);
  if (flat) {
    const body = value.fields
      .map(([k, v]) => (k === null ? serialize(v) : `${key(k)} = ${serialize(v)}`))
      .join(', ');
    return `${head} ${body} }`;
  }

  const pad = '\t'.repeat(indent + 1);
  const body = value.fields
    .map(([k, v]) => `${pad}${k === null ? '' : `${key(k)} = `}${serialize(v, indent + 1)},`)
    .join('\n');
  return `${head}\n${body}\n${'\t'.repeat(indent)}}`;
}
