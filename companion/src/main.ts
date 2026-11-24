// Tray app version of the companion. Hosts the same localhost server as the terminal command,
// with a system tray menu, native folder dialog, notifications and a Start with Windows toggle.
import { app, clipboard, dialog, Menu, nativeImage, Notification, shell, Tray } from 'electron';
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_FOLDER, PORT, startServer, type Activity } from './server';

interface Settings {
  defaultFolder: string;
  notify: boolean;
}

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const asset = (name: string) => path.join(__dirname, '..', 'assets', name);

let tray: Tray | null = null;
let settings: Settings = { defaultFolder: DEFAULT_FOLDER, notify: true };
let status = 'Starting';
let lastSend = 'Nothing sent yet';

function loadSettings() {
  try { settings = { ...settings, ...JSON.parse(readFileSync(settingsFile(), 'utf8')) }; } catch { /* first run */ }
}

function saveSettings() {
  mkdirSync(path.dirname(settingsFile()), { recursive: true });
  writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
}

// Unpackaged (npm run app) the executable is electron.exe, which needs the app path as an argument.
const loginItem = () => ({ path: process.execPath, args: app.isPackaged ? [] : [app.getAppPath()] });

function notify(title: string, body: string) {
  if (settings.notify && Notification.isSupported()) new Notification({ title, body, icon: asset('icon.png') }).show();
}

async function chooseFolder(initial: string): Promise<string | null> {
  // Figma has focus when this is requested, so the dialog has to be brought forward explicitly.
  app.focus({ steal: true });
  const result = await dialog.showOpenDialog({
    title: 'Figma to Fusion export folder',
    defaultPath: initial,
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
}

function renderMenu() {
  if (!tray) return;
  tray.setToolTip(`Figma to Fusion: ${status}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Figma to Fusion ${app.getVersion()}`, enabled: false },
    { label: status, enabled: false },
    { label: lastSend, enabled: false },
    { type: 'separator' },
    {
      label: 'Open export folder',
      click: () => { mkdirSync(settings.defaultFolder, { recursive: true }); shell.openPath(settings.defaultFolder); },
    },
    {
      label: 'Change default export folder',
      click: async () => {
        const folder = await chooseFolder(settings.defaultFolder);
        if (folder) { settings.defaultFolder = folder; saveSettings(); renderMenu(); }
      },
    },
    { type: 'separator' },
    {
      label: 'Start with Windows', type: 'checkbox',
      checked: app.getLoginItemSettings(loginItem()).openAtLogin,
      click: (item) => app.setLoginItemSettings({ ...loginItem(), openAtLogin: item.checked }),
    },
    {
      label: 'Notify after each send', type: 'checkbox', checked: settings.notify,
      click: (item) => { settings.notify = item.checked; saveSettings(); },
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
}

// A terminal companion (npm run companion) holds the same port: stop it so the tray app can listen.
function retireLegacyCompanion(): Promise<void> {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-Command',
      `$c = Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue; ` +
      `if ($c) { $p = Get-Process -Id $c.OwningProcess; if ($p.ProcessName -eq 'node') { Stop-Process -Id $p.Id -Force -Confirm:$false } }`,
    ], { windowsHide: true }, () => setTimeout(resolve, 500));
  });
}

function describe(a: Activity): string {
  const parts = [`${a.images} PNG`, a.texts ? `${a.texts} text` : ''].filter(Boolean).join(', ');
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${time}  "${a.scene}": ${a.toolCount} nodes (${parts})`;
}

async function listen(retry = true): Promise<void> {
  try {
    await startServer({
      defaultFolder: () => settings.defaultFolder,
      copyToClipboard: async (text) => clipboard.writeText(text),
      pickFolder: chooseFolder,
      onActivity: (a) => {
        lastSend = describe(a);
        renderMenu();
        notify(`Sent "${a.scene}" to Fusion`, a.delivery === 'resolve'
          ? `${a.toolCount} nodes pasted into Resolve.`
          : `${a.toolCount} nodes copied. Click the Fusion node editor and press Ctrl+V.`);
      },
      onError: (message) => notify('Figma to Fusion: send failed', message),
    });
    status = `Listening on port ${PORT}`;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE' && retry) {
      await retireLegacyCompanion();
      return listen(false);
    }
    status = (err as NodeJS.ErrnoException).code === 'EADDRINUSE'
      ? `Port ${PORT} is in use by another program`
      : `Error: ${(err as Error).message}`;
    dialog.showErrorBox('Figma to Fusion', status);
  }
  renderMenu();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Windows shows this name on notifications.
  app.setAppUserModelId('com.ryze.figma-to-fusion');
  app.on('window-all-closed', () => { /* tray only: stay alive with no windows */ });
  app.whenReady().then(async () => {
    loadSettings();
    tray = new Tray(nativeImage.createFromPath(asset('tray.png')));
    tray.on('click', () => tray?.popUpContextMenu());
    renderMenu();
    await listen();
  });
}
