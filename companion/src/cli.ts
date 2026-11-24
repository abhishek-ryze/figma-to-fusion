// Terminal version of the companion: npm run companion
import { DEFAULT_FOLDER, PORT, startServer } from './server';
import { copyToClipboard, pickFolder } from './system';

startServer({
  defaultFolder: () => DEFAULT_FOLDER,
  copyToClipboard,
  pickFolder,
  onActivity: (a) => console.log(`Sent "${a.scene}": ${a.toolCount} nodes, ${a.images} images, ${a.texts} texts, via ${a.delivery}`),
  onError: (message) => console.error(message),
}).then(() => {
  console.log(`Figma to Fusion companion listening on http://localhost:${PORT}`);
  console.log(`Default export folder: ${DEFAULT_FOLDER}`);
}).catch((err: NodeJS.ErrnoException) => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${PORT} is already in use: the companion is probably running already.` : err.message);
  process.exit(1);
});
