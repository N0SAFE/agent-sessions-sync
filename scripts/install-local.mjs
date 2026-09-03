#!/usr/bin/env node
// =============================================================================
// install-local.mjs — build, package and install a "local" variant of the
// agent-sessions-sync extension.
//
// The local variant gets a "-local" suffix on its identity so it can be
// installed side-by-side with the marketplace version:
//
//   name        agent-sessions-sync        → agent-sessions-sync-local
//   displayName Agent Sessions Sync        → Agent Sessions Sync (Local)
//   extension id (publisher.name)          → Gregor-von-Vitek.agent-sessions-sync-local
//
// Flow: build real extension → stage a renamed copy (no prepublish) → vsce
// package → code-insiders --install-extension --force.
// =============================================================================

import { execFileSync, execSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STAGE = path.join(ROOT, '.local-build');
const OUT_DIR = path.join(ROOT, 'dist');
const OUT_VSIX = path.join(OUT_DIR, 'agent-sessions-sync-local.vsix');

const SUFFIX = 'local';

// ---------------------------------------------------------------------------
// Detect VS Code CLI
// ---------------------------------------------------------------------------
function findVscodeCli() {
  if (process.env.VSCODE_CLI) return process.env.VSCODE_CLI;

  const probe = process.platform === 'win32' ? 'where' : 'which';
  const shell = process.platform === 'win32' ? {} : { shell: '/bin/sh' };

  // 1. Try PATH lookup
  for (const bin of ['code-insiders', 'code']) {
    try {
      const out = execSync(`${probe} ${bin}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], ...shell }).trim();
      if (out) return out.split('\n')[0].trim();
    } catch { /* not in PATH */ }
  }

  // 2. Common install locations
  const candidates = [];
  const home = process.env.HOME || '~';
  if (process.platform === 'darwin') {
    candidates.push(
      '/usr/local/bin/code-insiders',
      '/usr/local/bin/code',
      `/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code`,
      `/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code`,
    );
  } else if (process.platform === 'linux') {
    candidates.push(
      '/usr/local/bin/code-insiders',
      '/usr/local/bin/code',
      '/usr/bin/code-insiders',
      '/usr/bin/code',
      '/snap/bin/code-insiders',
      '/snap/bin/code',
      `/home/${home.split('/').pop()}/.local/share/code-insiders/bin/code-insiders`,
      `/home/${home.split('/').pop()}/.local/share/code/bin/code`,
    );
  } else if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || '';
    candidates.push(
      path.join(localAppData, 'Programs', 'Microsoft VS Code Insiders', 'bin', 'code-insiders.cmd'),
      path.join(localAppData, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'),
    );
  }

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }

  console.error('\n❌  Could not find "code-insiders" or "code".');
  console.error('    Install VS Code and ensure the CLI is in your PATH, or set VSCODE_CLI.');
  console.error('    e.g.  export VSCODE_CLI=/usr/local/bin/code-insiders\n');
  process.exit(1);
}

const CLI = findVscodeCli();
console.log(`[local-install] Using CLI: ${CLI}`);

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

// ---------------------------------------------------------------------------
// 1. Build the real extension
// ---------------------------------------------------------------------------
console.log(`\n[local-install] Building extension…`);
run('npm', ['run', 'package'], { cwd: ROOT });

// ---------------------------------------------------------------------------
// 2. Stage a renamed copy of the extension
// ---------------------------------------------------------------------------
console.log(`[local-install] Staging "${SUFFIX}" variant…`);
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const localPkg = {
  ...pkg,
  name: `${pkg.name}-${SUFFIX}`,
  displayName: `${pkg.displayName} (${SUFFIX[0].toUpperCase()}${SUFFIX.slice(1)})`,
  scripts: { ...pkg.scripts },
};
delete localPkg.scripts['vscode:prepublish'];

writeFileSync(path.join(STAGE, 'package.json'), JSON.stringify(localPkg, null, 2) + '\n');

for (const f of ['dist', 'media', '.vscodeignore', 'README.md', 'LICENSE', 'CHANGELOG.md']) {
  const src = path.join(ROOT, f);
  if (existsSync(src)) {
    cpSync(src, path.join(STAGE, f), { recursive: true });
  }
}

const nmSrc = path.join(ROOT, 'node_modules');
const nmDest = path.join(STAGE, 'node_modules');
if (existsSync(nmSrc) && !existsSync(nmDest)) {
  cpSync(nmSrc, nmDest, { recursive: true });
}

// ---------------------------------------------------------------------------
// 3. Package the staged copy into a "-local" vsix
// ---------------------------------------------------------------------------
console.log(`[local-install] Packaging ${path.basename(OUT_VSIX)}…`);
mkdirSync(OUT_DIR, { recursive: true });
const vsce = path.join(ROOT, 'node_modules', '@vscode', 'vsce', 'vsce');
run(process.execPath, [vsce, 'package', '--out', OUT_VSIX], { cwd: STAGE });

// ---------------------------------------------------------------------------
// 4. Install the packaged extension
// ---------------------------------------------------------------------------
console.log(`[local-install] Installing into ${CLI}…`);
run(CLI, ['--install-extension', OUT_VSIX, '--force']);

console.log(`\n✅  Installed local variant — extension id: Gregor-von-Vitek.agent-sessions-sync-local\n`);
