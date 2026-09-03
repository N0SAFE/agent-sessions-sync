import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { scanAgents } from './src/sync/scanner';
import { computeWorkspaceHash, getWorkspaceStorageRoot } from './src/util/vscode';
import { openVscodeDb } from './src/util/vscodeDb';
import { resolveVscodeLocalPath } from './src/util/vscodeRestore';
import { Agent } from './src/sync/types';

// Build a git-repo workspace with 3 sessions
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'upres-'));
const proj = path.join(tmp, 'proj');
await fs.mkdir(proj);
execFileSync('git', ['init', '-q'], { cwd: proj });
execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:N0SAFE/deployer.git'], { cwd: proj });
const userData = path.join(tmp, 'user');
const hash = computeWorkspaceHash(proj);
const base = path.join(getWorkspaceStorageRoot(userData), hash);
await fs.mkdir(path.join(base, 'chatSessions'), { recursive: true });
await fs.writeFile(path.join(base, 'workspace.json'), JSON.stringify({ folder: `file://${proj}` }));
const sessions = ['a1', 'b2', 'c3'];
const index = { version: 1, entries: {} as Record<string, any> };
for (const s of sessions) {
  await fs.writeFile(path.join(base, 'chatSessions', `${s}.jsonl`), `content-${s}\n`);
  index.entries[s] = { sessionId: s, title: 'T', lastMessageDate: 1 };
}
const db = await openVscodeDb(path.join(base, 'state.vscdb'));
db.set('chat.ChatSessionStore.index', JSON.stringify(index));
db.save(); db.close();

const agent: Agent = { id: 'vscode', label: 'VS Code', repoDir: 'vscode', localPath: path.join(userData, 'workspaceStorage'), unitDepth: 4 };
const scan = await scanAgents([agent]);
const uploads = Object.keys(scan.files).filter(k => k.startsWith('vscode/'));
console.log('upload paths:');
let fail = 0;
for (const p of uploads) {
  const local = resolveVscodeLocalPath(agent, p);
  if (p.includes('conversation')) {
    const ok = local ? await fs.readFile(local).then(() => true).catch(() => false) : false;
    console.log(`  ${p} -> ${ok ? 'OK' : 'FAIL'}`);
    if (!ok) fail++;
  } else {
    console.log(`  ${p} -> (derived, no file)`);
  }
}
console.log('conversation resolution failures:', fail, '/ 3');
