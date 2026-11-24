import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const FUSCRIPT = 'C:\\Program Files\\Blackmagic Design\\DaVinci Resolve\\fuscript.exe';

function run(file: string, args: string[], timeoutMs = 60000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${path.basename(file)} failed: ${stderr || err.message}`));
      else resolve(stdout.trim());
    });
  });
}

const powershell = (command: string, sta = false) =>
  run('powershell.exe', ['-NoProfile', ...(sta ? ['-STA'] : []), '-Command', command]);

async function tempFile(name: string, content: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'figma-to-fusion-'));
  const file = path.join(dir, name);
  await writeFile(file, content, 'utf8');
  return file;
}

const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

export async function copyToClipboard(text: string): Promise<void> {
  // Goes through a file so large comps never hit command line length limits.
  const file = await tempFile('comp.setting', text);
  await powershell(`Set-Clipboard -Value (Get-Content -Raw -Encoding UTF8 -LiteralPath ${psQuote(file)})`);
}

export async function pickFolder(initial: string): Promise<string | null> {
  const out = await powershell(
    'Add-Type -AssemblyName System.Windows.Forms; ' +
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog; ' +
    `$d.Description = 'Figma to Fusion export folder'; $d.SelectedPath = ${psQuote(initial)}; ` +
    '$o = New-Object System.Windows.Forms.Form; $o.TopMost = $true; ' +
    'if ($d.ShowDialog($o) -eq [System.Windows.Forms.DialogResult]::OK) { $d.SelectedPath }',
    true,
  );
  return out || null;
}

export const hasFuscript = () => existsSync(FUSCRIPT);

// Studio only: pastes the node text straight into the comp that is open in Resolve's Fusion page.
export async function pasteIntoResolve(text: string): Promise<string> {
  if (!hasFuscript()) throw new Error('fuscript.exe not found, is DaVinci Resolve installed?');
  const comp = await tempFile('comp.setting', text);
  const script = await tempFile('paste.lua', `
local f = assert(io.open([[${comp}]], "r"))
local text = f:read("*a")
f:close()
local resolve = bmd.scriptapp("Resolve")
if not resolve then print("ERR no-resolve") return end
local fusion = resolve:Fusion()
local comp = fusion and fusion:GetCurrentComp()
if not comp then print("ERR no-comp") return end
comp:Lock()
comp:StartUndo("Figma to Fusion")
local ok = comp:Paste(bmd.readstring(text))
comp:EndUndo(true)
comp:Unlock()
print(ok and "OK" or "ERR paste-failed")
`);
  const out = await run(FUSCRIPT, ['-l', 'lua', script]);
  if (out.includes('ERR no-resolve')) {
    throw new Error('Could not connect to Resolve. External scripting needs Resolve Studio, running, with Preferences > System > General > External scripting set to Local.');
  }
  if (out.includes('ERR no-comp')) throw new Error('Open a Fusion composition in Resolve first (Fusion page).');
  if (!out.includes('OK')) throw new Error(`Paste failed: ${out}`);
  return out;
}
