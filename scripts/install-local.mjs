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

import { execFileSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STAGE = path.join(ROOT, '.local-build');
const OUT_DIR = path.join(ROOT, 'dist');
const OUT_VSIX = path.join(OUT_DIR, 'agent-sessions-sync-local.vsix');

// Suffix applied to name / displayName.
const SUFFIX = 'local';

// CLI used to install the extension (override with VSCODE_CLI env var).
const CLI = process.env.VSCODE_CLI || '/usr/local/bin/code-insiders';

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

// ---------------------------------------------------------------------------
// 1. Build the real extension (produces dist/extension.js)
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
// dist/ is already built from the real source — never re-run the prepublish
// build inside the staged copy.
delete localPkg.scripts['vscode:prepublish'];

writeFileSync(path.join(STAGE, 'package.json'), JSON.stringify(localPkg, null, 2) + '\n');

for (const f of ['dist', 'media', '.vscodeignore', 'README.md', 'LICENSE', 'CHANGELOG.md']) {
  const src = path.join(ROOT, f);
  if (existsSync(src)) {
    cpSync(src, path.join(STAGE, f), { recursive: true });
  }
}

// Copy node_modules to the staged directory so vsce's dependency validation passes.
// The .vscodeignore still excludes node_modules from the packaged vsix.
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
