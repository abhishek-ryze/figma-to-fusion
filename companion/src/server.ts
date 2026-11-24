import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { buildComp, type BuildOptions, type Layer, type Scene } from '../../core/src/index';
import { fontMetrics } from './fonts';
import { hasFuscript, pasteIntoResolve } from './system';

export const PORT = 7421;
export const DEFAULT_FOLDER = path.join(homedir(), 'Documents', 'FigmaToFusion');

export interface Activity {
  scene: string;
  toolCount: number;
  images: number;
  texts: number;
  delivery: 'clipboard' | 'resolve';
  warnings: string[];
}

// What the server needs from whoever hosts it: the terminal command or the tray app.
export interface Host {
  defaultFolder(): string;
  copyToClipboard(text: string): Promise<void>;
  pickFolder(initial: string): Promise<string | null>;
  onActivity?(activity: Activity): void;
  onError?(message: string): void;
}

interface SendRequest {
  scene: Scene;
  options: BuildOptions;
  delivery: 'clipboard' | 'resolve';
}

const safe = (s: string) => s.replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'untitled';

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function reply(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function countLayers(layers: Layer[]): { images: number; texts: number } {
  let images = 0, texts = 0;
  for (const l of layers) {
    if (l.type === 'image') images++;
    else if (l.type === 'text') texts++;
    else if (l.type === 'group') {
      const c = countLayers(l.children);
      images += c.images;
      texts += c.texts;
    }
  }
  return { images, texts };
}

function attachFontMetrics(layers: Layer[]) {
  for (const l of layers) {
    if (l.type === 'text') l.metrics = fontMetrics(l.fontFamily, l.fontStyle);
    else if (l.type === 'group') attachFontMetrics(l.children);
  }
}

async function handle(host: Host, req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/ping') {
    return reply(res, 200, { ok: true, defaultFolder: host.defaultFolder(), fuscript: hasFuscript() });
  }

  if (req.method === 'POST' && url.pathname === '/pick-folder') {
    const { initial } = JSON.parse((await readBody(req)).toString() || '{}');
    return reply(res, 200, { folder: await host.pickFolder(initial || host.defaultFolder()) });
  }

  // Binary PNG/SVG body. Returns the absolute path to reference from the scene.
  if (req.method === 'POST' && url.pathname === '/asset') {
    const folder = url.searchParams.get('folder') || host.defaultFolder();
    const dir = path.join(folder, safe(url.searchParams.get('file') ?? ''), safe(url.searchParams.get('frame') ?? ''));
    const file = path.join(dir, safe(url.searchParams.get('name') ?? 'layer.png'));
    if (!/\.(png|svg)$/i.test(file)) return reply(res, 400, { error: 'Only .png and .svg assets are accepted' });
    await mkdir(dir, { recursive: true });
    await writeFile(file, await readBody(req));
    return reply(res, 200, { path: file });
  }

  if (req.method === 'POST' && url.pathname === '/send') {
    const { scene, options, delivery } = JSON.parse((await readBody(req)).toString()) as SendRequest;
    attachFontMetrics(scene.layers);
    const result = buildComp(scene, options);
    const counts = countLayers(scene.layers);
    if (delivery === 'resolve') await pasteIntoResolve(result.text);
    else await host.copyToClipboard(result.text);
    host.onActivity?.({ scene: scene.name, toolCount: result.toolCount, delivery, warnings: result.warnings, ...counts });
    return reply(res, 200, { ok: true, delivery, toolCount: result.toolCount, warnings: result.warnings, ...counts });
  }

  reply(res, 404, { error: 'Not found' });
}

export function startServer(host: Host): Promise<Server> {
  const server = createServer((req, res) => {
    // Figma plugin iframes have a null origin, so the wildcard is required.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    // Figma plugin iframes send "Origin: null". Ordinary websites send their real origin and are refused,
    // so a random page cannot write files or overwrite the clipboard through this server.
    const origin = req.headers.origin;
    if (origin && origin !== 'null') {
      res.writeHead(403);
      return res.end();
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }
    handle(host, req, res).catch((err: Error) => {
      host.onError?.(err.message);
      reply(res, 500, { error: err.message });
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}
