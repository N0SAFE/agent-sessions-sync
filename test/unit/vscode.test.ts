import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanAgents, gitBlobSha } from '../../src/sync/scanner';
import { Agent } from '../../src/sync/types';
import { openVscodeDb } from '../../src/util/vscodeDb';
import { restoreVscodeSessions } from '../../src/util/vscodeRestore';
import { computeWorkspaceHash, encodeWorkspacePath, getWorkspaceStorageRoot } from '../../src/util/vscode';

function vscodeAgent(userDataPath: string): Agent {
  return {
    id: 'vscode',
    label: 'VS Code',
    repoDir: 'vscode',
    localPath: path.join(userDataPath, 'workspaceStorage'),
    unitDepth: 4,
  };
}

describe('vscode agent sync', () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    while (tmpDirs.length) {
      await fs.rm(tmpDirs.pop()!, { recursive: true, force: true });
    }
  });

  async function mkTmp(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vscsync-'));
    tmpDirs.push(dir);
    return dir;
  }

  const BODY = '{"kind":0,"v":{"sessionId":"aaaa-bbbb-cccc"}}\n';
  const SID = 'aaaa-bbbb-cccc';

  async function seedWorkspace(userDataPath: string, folderPath: string): Promise<string> {
    const hash = computeWorkspaceHash(folderPath);
    const base = path.join(getWorkspaceStorageRoot(userDataPath), hash);
    await fs.mkdir(path.join(base, 'chatSessions'), { recursive: true });
    await fs.writeFile(path.join(base, 'workspace.json'), JSON.stringify({ folder: `file://${folderPath}` }));
    await fs.writeFile(path.join(base, 'chatSessions', `${SID}.jsonl`), BODY);

    const index = {
      version: 1,
      entries: {
        [SID]: {
          sessionId: SID,
          title: 'Hello',
          lastMessageDate: 123,
          timing: { created: 123, lastRequestStarted: 123, lastRequestEnded: 123 },
          initialLocation: 'panel',
          hasPendingEdits: false,
          isEmpty: false,
          isExternal: false,
          lastResponseState: 1,
        },
      },
    };
    const db = await openVscodeDb(path.join(base, 'state.vscdb'));
    db.set('chat.ChatSessionStore.index', JSON.stringify(index));
    db.set('agentSessions.model.cache', JSON.stringify([]));
    db.set('agentSessions.state.cache', JSON.stringify([]));
    db.save();
    db.close();
    return base;
  }

  it('scans workspace sessions into vscode/<encoded>/chatSessions/<sid>/ and restores them', async () => {
    const userDataA = await mkTmp();
    const folderA = path.join(userDataA, 'project');
    await fs.mkdir(folderA, { recursive: true });
    await seedWorkspace(userDataA, folderA);

    const encoded = encodeWorkspacePath(folderA);
    const scan = await scanAgents([vscodeAgent(userDataA)]);
    const sessionBase = `vscode/${encoded}/chatSessions/${SID}`;

    expect(scan.files[`vscode/${encoded}/workspace.json`]).toBe(gitBlobSha(Buffer.from(JSON.stringify({ folder: '__workspace__' }))));
    expect(scan.files[`${sessionBase}/conversation.jsonl`]).toBe(gitBlobSha(Buffer.from(BODY)));
    expect(scan.files[`${sessionBase}/meta.json`]).toBeDefined();

    // Restore into a second machine with the same folder path.
    const userDataB = await mkTmp();
    const folderB = path.join(userDataB, 'project');
    await fs.mkdir(folderB, { recursive: true });

    const getBlob = async (repoPath: string): Promise<Buffer> => {
      if (repoPath.endsWith('meta.json')) {
        return Buffer.from(
          JSON.stringify({
            format: 'jsonl',
            index: { sessionId: SID, title: 'Hello', lastMessageDate: 123 },
            agent: null,
            read: null,
          })
        );
      }
      if (repoPath.endsWith('conversation.jsonl')) {
        return Buffer.from(BODY);
      }
      if (repoPath.endsWith('workspace.json')) {
        return Buffer.from(JSON.stringify({ folder: '__workspace__' }));
      }
      return Buffer.from('');
    };

    const log: string[] = [];
    await restoreVscodeSessions(
      { userDataPath: userDataB, folderMap: { toLocal: new Map([[encoded, folderB]]), toRepo: new Map([[folderB, encoded]]) } },
      [`${sessionBase}/conversation.jsonl`, `${sessionBase}/meta.json`, `vscode/${encoded}/workspace.json`],
      getBlob,
      (m) => log.push(m)
    );
    const hashB = computeWorkspaceHash(folderB);
    const restoredBase = path.join(getWorkspaceStorageRoot(userDataB), hashB);
    const content = await fs.readFile(path.join(restoredBase, 'chatSessions', `${SID}.jsonl`), 'utf8');
    expect(content).toBe(BODY);

    const db = await openVscodeDb(path.join(restoredBase, 'state.vscdb'));
    const indexRaw = db.get('chat.ChatSessionStore.index');
    db.close();
    const index = JSON.parse(indexRaw!);
    expect(index.entries[SID]).toBeDefined();
    expect(index.entries[SID].title).toBe('Hello');
  });

  it('produces an empty scan when no workspace storage exists', async () => {
    const userDataA = await mkTmp();
    const scan = await scanAgents([vscodeAgent(userDataA)]);
    expect(scan.files).toEqual({});
  });
});