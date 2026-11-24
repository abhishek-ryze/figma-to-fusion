import { build, context } from 'esbuild';
import { copyFileSync, mkdirSync, watch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');
mkdirSync(dist, { recursive: true });

const copyUi = () => copyFileSync(path.join(root, 'src', 'ui.html'), path.join(dist, 'ui.html'));
const options = {
  entryPoints: [path.join(root, 'src', 'code.ts')],
  outfile: path.join(dist, 'code.js'),
  bundle: true,
  // Figma's plugin sandbox does not support newer syntax.
  target: 'es2017',
  logLevel: 'info',
};

copyUi();
if (process.argv.includes('--watch')) {
  watch(path.join(root, 'src', 'ui.html'), copyUi);
  await (await context(options)).watch();
} else {
  await build(options);
}
