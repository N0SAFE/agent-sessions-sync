import * as fs from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { Agent, FolderMap } from '../sync/types';
import { isEmptyWindowRepoFolder, VSCODE_EMPTY_WINDOW_FOLDER, workspaceMarkerJson } from '../sync/scanner';
import { openVscodeDb, parseChatIndex, AgentModelCacheEntry, AgentStateCacheEntry } from './vscodeDb';
import {
  computeWorkspaceHash,
  decodeWorkspacePath,
  encodeWorkspacePath,
  findWorkspaceHashForFolder,
  getAllWorkspaceEntries,
  getGlobalStoragePath,
  getWorkspaceStorageRoot,
  gitRemoteIdentity,
  isRepoKeyedFolder,
  repoKeyFromIdentity,
} from './vscode';

/**
 * Restore VS Code Copilot sessions from the repository into the correct local
 * workspace storage.
 *
 * VS Code only shows sessions that are registered in the SQLite `state.vscdb`
 * index (`chat.ChatSessionStore.index` + `agentSessions.*` caches) — copying the
 * `.jsonl` files alone leaves them invisible. So restore does both:
 *
 *   1. writes the conversation files (and editing-session state), and
 *   2. merges each session's index metadata into `state.vscdb`.
 *
 * The workspace storage hash is machine-specific (folder path + birthtime), so it
 * is recomputed (or matched against an existing entry) on the target machine.
 */

/** Per-session sidecar metadata stored in the repo (`chatSessions/<sid>/meta.json`). */
export interface VscodeSessionMeta {
  format: 'jsonl' | 'json';
  index: Record<string, unknown> | null;
  agent: AgentModelCacheEntry | null;
  read: number | null;
}

export interface VscodeRestoreContext {
  /** VS Code user data directory (contains workspaceStorage/ and globalStorage/). */
  userDataPath: string;
  /** `agents.vscode.workspacePaths` mapping: repo folder name → local folder path. */
  folderMap?: FolderMap;
  /** Called when sessions were restored into the currently-open workspace (needs a restart to appear). */
  onRestoredToOpenWorkspace?: (folderPath: string, count: number) => void;
}

/** Resolved target location for a workspace group. */
interface ResolvedTarget {
  folderPath: string;
  chatSessionsDir: string;
  editingSessionsDir: string;
  stateDbPath: string;
  /** workspace.json to write (folder URI on THIS machine). */
  workspaceJson: string;
}

function folderUriFor(folderPath: string): string {
  return 'file://' + folderPath.split(path.sep).map((s) => encodeURIComponent(s)).join('/');
}

/**
 * Resolve where a repo workspace group should land on this machine, or undefined
 * when no matching local folder exists.
 */
function resolveTarget(ctx: VscodeRestoreContext, repoFolder: string): ResolvedTarget | undefined {
  // Empty-window (no folder) sessions live in global storage.
  if (isEmptyWindowRepoFolder(repoFolder)) {
    const globalPath = getGlobalStoragePath(ctx.userDataPath);
    return {
      folderPath: VSCODE_EMPTY_WINDOW_FOLDER,
      chatSessionsDir: path.join(globalPath, 'emptyWindowChatSessions'),
      editingSessionsDir: path.join(globalPath, 'emptyWindowChatSessions'),
      stateDbPath: path.join(globalPath, 'state.vscdb'),
      workspaceJson: JSON.stringify({ folder: VSCODE_EMPTY_WINDOW_FOLDER }),
    };
  }

  // 1. Explicit mapping wins.
  let folderPath = ctx.folderMap?.toLocal.get(repoFolder);
  // 2. Repo-keyed workspaces match by git remote identity; others by exact encode match or a
  //    unique project-name suffix match against real local workspaces.
  if (!folderPath) {
    folderPath = isRepoKeyedFolder(repoFolder)
      ? matchLocalWorkspaceByRepoKey(ctx.userDataPath, repoFolder)
      : matchLocalWorkspace(ctx.userDataPath, repoFolder);
  }
  // 3. Otherwise decode the encoded repo folder name back to a path.
  if (!folderPath) {
    folderPath = decodeWorkspacePath(repoFolder);
  }
  if (!folderPath || !existsSync(folderPath)) {
    return undefined;
  }

  // Find an existing storage dir for this folder, else compute the hash.
  let hash = findWorkspaceHashForFolder(ctx.userDataPath, folderPath);
  if (!hash) {
    hash = computeWorkspaceHash(folderPath);
  }

  const storageRoot = getWorkspaceStorageRoot(ctx.userDataPath);
  const base = path.join(storageRoot, hash);
  return {
    folderPath,
    chatSessionsDir: path.join(base, 'chatSessions'),
    editingSessionsDir: path.join(base, 'chatEditingSessions'),
    stateDbPath: path.join(base, 'state.vscdb'),
    workspaceJson: JSON.stringify({ folder: folderUriFor(folderPath) }),
  };
}

/**
 * Map a repository path under `vscode/` to the real local file on this machine, or
 * `undefined` when it has no on-disk counterpart (the `meta.json`/`workspace.json`
 * sidecars are stored in the SQLite index, not as files) or no matching workspace.
 *
 * Used by the upload path so local session content is read from the actual
 * `workspaceStorage/<hash>/chatSessions/<sid>.<ext>` location instead of the
 * generic (wrong) `repoPathToLocal` layout.
 */
export function resolveVscodeLocalPath(agent: Agent, repoPath: string): string | undefined {
  if (!repoPath.startsWith('vscode/')) {
    return undefined;
  }
  const userDataPath = path.dirname(agent.localPath);
  const parts = repoPath.split('/');
  if (parts.length < 3) {
    return undefined;
  }
  const repoFolder = parts[1];

  // No-folder sessions live in global storage.
  if (isEmptyWindowRepoFolder(repoFolder)) {
    const conv = repoPath.match(/^vscode\/[^/]+\/chatSessions\/([^/]+)\/conversation\.(jsonl|json)$/);
    if (!conv) {
      return undefined;
    }
    return path.join(getGlobalStoragePath(userDataPath), 'emptyWindowChatSessions', `${conv[1]}.${conv[2]}`);
  }

  // Editing-session state.
  const edit = repoPath.match(/^vscode\/[^/]+\/chatEditingSessions\/(.+)$/);
  if (edit) {
    const base = resolveWorkspaceStorageBase(agent, repoFolder);
    return base ? path.join(base, 'chatEditingSessions', edit[1]) : undefined;
  }

  // Conversation file.
  const conv = repoPath.match(/^vscode\/[^/]+\/chatSessions\/([^/]+)\/conversation\.(jsonl|json)$/);
  if (conv) {
    const base = resolveWorkspaceStorageBase(agent, repoFolder);
    return base ? path.join(base, 'chatSessions', `${conv[1]}.${conv[2]}`) : undefined;
  }

  // meta.json / workspace.json sidecars are DB-derived, not real files.
  return undefined;
}

/**
 * Resolve a repo workspace folder back to a local workspaceStorage dir:
 * mapping, then repo-identity (repo-keyed) / exact-encode / suffix match against real local
 * workspaces, then best-effort decode.
 */
function resolveWorkspaceStorageBase(agent: Agent, repoFolder: string): string | undefined {
  const folderPath = resolveLocalFolder(agent, repoFolder);
  if (!folderPath) {
    return undefined;
  }
  const hash = findWorkspaceHashForFolder(path.dirname(agent.localPath), folderPath) ?? computeWorkspaceHash(folderPath);
  return path.join(getWorkspaceStorageRoot(path.dirname(agent.localPath)), hash);
}

/** The local folder path for a repo workspace folder, or undefined. */
function resolveLocalFolder(agent: Agent, repoFolder: string): string | undefined {
  const userDataPath = path.dirname(agent.localPath);
  let folderPath = agent.folderMap?.toLocal.get(repoFolder);
  if (!folderPath) {
    folderPath = isRepoKeyedFolder(repoFolder)
      ? matchLocalWorkspaceByRepoKey(userDataPath, repoFolder)
      : matchLocalWorkspace(userDataPath, repoFolder);
  }
  if (!folderPath) {
    folderPath = decodeWorkspacePath(repoFolder);
  }
  if (!folderPath || !existsSync(folderPath)) {
    return undefined;
  }
  return folderPath;
}

/**
 * Find a local workspace folder for a path-keyed repo folder: exact encoded-name match,
 * then a unique project-name suffix match (last path segments shared). `undefined` when
 * ambiguous.
 */
function matchLocalWorkspace(userDataPath: string, repoFolder: string): string | undefined {
  const locals = getAllWorkspaceEntries(userDataPath);
  const exact = locals.find((e) => encodeWorkspacePath(e.folderPath) === repoFolder);
  if (exact) {
    return exact.folderPath;
  }
  const suffix = repoFolder.split('-').slice(-3).join('-');
  if (!suffix) {
    return undefined;
  }
  const bySuffix = locals.filter((e) => encodeWorkspacePath(e.folderPath).endsWith(suffix));
  if (bySuffix.length === 1) {
    return bySuffix[0].folderPath;
  }
  return undefined;
}

/** Short-lived cache of local repo identity (repoKey → folderPath), to avoid re-spawning git. */
let repoIndexCache: { userDataPath: string; at: number; map: Map<string, string> } | undefined;

function localRepoIndex(userDataPath: string): Map<string, string> {
  const now = Date.now();
  if (repoIndexCache && repoIndexCache.userDataPath === userDataPath && now - repoIndexCache.at < 5000) {
    return repoIndexCache.map;
  }
  const map = new Map<string, string>();
  for (const entry of getAllWorkspaceEntries(userDataPath)) {
    const identity = gitRemoteIdentity(entry.folderPath);
    if (identity) {
      map.set(repoKeyFromIdentity(identity), entry.folderPath);
    }
  }
  repoIndexCache = { userDataPath, at: now, map };
  return map;
}

/** Map a repo-keyed folder (`repo-N0SAFE-deployer`) to the local folder with the same remote. */
function matchLocalWorkspaceByRepoKey(userDataPath: string, repoFolder: string): string | undefined {
  return localRepoIndex(userDataPath).get(repoFolder);
}

/**
 * Generate the content of a DB-derived repo file for upload:
 * - `chatSessions/<sid>/meta.json` → read the local SQLite index/agent caches
 * - `<workspace>/workspace.json` → the path-independent marker
 * Returns `undefined` for anything else (already covered by `resolveVscodeLocalPath`).
 */
export async function buildVscodeDerivedFile(agent: Agent, repoPath: string): Promise<Buffer | undefined> {
  const meta = repoPath.match(/^vscode\/([^/]+)\/chatSessions\/([^/]+)\/meta\.json$/);
  if (meta) {
    const [, repoFolder, sid] = meta;
    return buildVscodeSessionMeta(agent, repoFolder, sid);
  }
  if (repoPath.endsWith('/workspace.json')) {
    const repoFolder = repoPath.split('/')[1];
    if (isEmptyWindowRepoFolder(repoFolder)) {
      return Buffer.from(JSON.stringify({ folder: VSCODE_EMPTY_WINDOW_FOLDER }));
    }
    let repoIdentity: string | undefined;
    if (isRepoKeyedFolder(repoFolder)) {
      const folderPath = resolveLocalFolder(agent, repoFolder);
      if (folderPath) {
        repoIdentity = gitRemoteIdentity(folderPath);
      }
    }
    return Buffer.from(workspaceMarkerJson(repoFolder, repoIdentity));
  }
  return undefined;
}

async function buildVscodeSessionMeta(agent: Agent, repoFolder: string, sid: string): Promise<Buffer | undefined> {
  const userDataPath = path.dirname(agent.localPath);
  const isEmptyWindow = isEmptyWindowRepoFolder(repoFolder);
  const storageBase = isEmptyWindow ? undefined : resolveWorkspaceStorageBase(agent, repoFolder);
  const dbPath = isEmptyWindow
    ? path.join(getGlobalStoragePath(userDataPath), 'state.vscdb')
    : storageBase ? path.join(storageBase, 'state.vscdb') : '';
  if (!dbPath || !existsSync(dbPath) || !statSync(dbPath).size) {
    return Buffer.from(JSON.stringify({ format: 'jsonl', index: null, agent: null, read: null }));
  }

  const sessionDir = isEmptyWindow
    ? path.join(getGlobalStoragePath(userDataPath), 'emptyWindowChatSessions')
    : storageBase ? path.join(storageBase, 'chatSessions') : '';
  const format: 'jsonl' | 'json' =
    existsSync(path.join(sessionDir, `${sid}.jsonl`)) ? 'jsonl'
      : existsSync(path.join(sessionDir, `${sid}.json`)) ? 'json'
        : 'jsonl';

  try {
    const db = await openVscodeDb(dbPath);
    const index = parseChatIndex(db.get('chat.ChatSessionStore.index'));
    const agentModel = parseJsonArray<AgentModelCacheEntry>(db.get('agentSessions.model.cache'));
    const agentState = parseJsonArray<AgentStateCacheEntry>(db.get('agentSessions.state.cache'));
    db.close();

    const resource = `vscode-chat-session://local/${Buffer.from(sid).toString('base64')}`;
    const meta: VscodeSessionMeta = {
      format,
      index: index.entries[sid] ?? index.entries[resource] ?? null,
      agent: agentModel.find((a) => a.resource === resource) ?? null,
      read: agentState.find((a) => a.resource === resource)?.read ?? null,
    };
    return Buffer.from(JSON.stringify(meta));
  } catch {
    return Buffer.from(JSON.stringify({ format, index: null, agent: null, read: null }));
  }
}

/**
 * Apply downloads for the vscode agent. `downloads` are repo paths like
 * `vscode/<repoFolder>/chatSessions/<sid>/conversation.jsonl`.
 */
export async function restoreVscodeSessions(
  ctx: VscodeRestoreContext,
  downloads: readonly string[],
  getBlob: (repoPath: string) => Promise<Buffer>,
  log: (msg: string) => void
): Promise<void> {
  // Group repo paths by workspace folder name.
  const byFolder = new Map<string, string[]>();
  for (const p of downloads) {
    const parts = p.split('/');
    if (parts.length >= 3 && parts[0] === 'vscode') {
      const list = byFolder.get(parts[1]) ?? [];
      list.push(p);
      byFolder.set(parts[1], list);
    }
  }

  for (const [repoFolder, paths] of byFolder) {
    const target = resolveTarget(ctx, repoFolder);
    if (!target) {
      log(`Skipping VS Code restore for '${repoFolder}': no matching workspace folder on this machine. Set 'agentSessionsSync.agents.vscode.workspacePaths' to map it.`);
      continue;
    }

    // Session conversation + metadata, grouped per session id.
    const sessionMeta = new Map<string, VscodeSessionMeta>();
    for (const p of paths) {
      const m = p.match(/^vscode\/[^/]+\/chatSessions\/([^/]+)\/(conversation\.(jsonl|json)|meta\.json)$/);
      if (!m) {
        continue;
      }
      const sid = m[1];
      if (m[2] === 'meta.json') {
        try {
          const content = await getBlob(p);
          sessionMeta.set(sid, JSON.parse(content.toString('utf8')) as VscodeSessionMeta);
        } catch {
          // ignore unparseable meta
        }
      } else {
        const format = m[3] as 'jsonl' | 'json';
        const existing = sessionMeta.get(sid);
        sessionMeta.set(sid, existing ?? { format, index: null, agent: null, read: null });
        try {
          const content = await getBlob(p);
          await fs.mkdir(target.chatSessionsDir, { recursive: true });
          await fs.writeFile(path.join(target.chatSessionsDir, `${sid}.${format}`), content);
          log(`Restored VS Code session ${sid} (${format}) → ${target.folderPath}`);
        } catch (e) {
          log(`Failed to restore VS Code session ${sid}: ${String(e)}`);
        }
      }
    }

    // Editing-session state files.
    for (const p of paths) {
      const m = p.match(/^vscode\/[^/]+\/chatEditingSessions\/(.+)$/);
      if (!m) {
        continue;
      }
      try {
        const content = await getBlob(p);
        const rel = m[1];
        const dest = path.join(target.editingSessionsDir, rel);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, content);
      } catch (e) {
        log(`Failed to restore VS Code editing session ${p}: ${String(e)}`);
      }
    }

    // Write workspace.json so VS Code maps this hash dir to the local folder.
    try {
      await fs.mkdir(path.dirname(target.stateDbPath), { recursive: true });
      await fs.writeFile(path.join(path.dirname(target.stateDbPath), 'workspace.json'), Buffer.from(target.workspaceJson));
    } catch {
      // non-fatal
    }

    // Merge session metadata into the SQLite index.
    if (sessionMeta.size > 0) {
      try {
        await updateVscodeDb(target.stateDbPath, sessionMeta);
        log(`Updated VS Code session index for ${target.folderPath} (${sessionMeta.size} session(s))`);
      } catch (e) {
        log(`Failed to update VS Code session index for ${target.folderPath}: ${String(e)}`);
      }
    }

    // If the target is the currently-open workspace, VS Code's in-memory cache will
    // shadow the DB until a restart.
    if (ctx.onRestoredToOpenWorkspace && isOpenWorkspace(target.folderPath)) {
      ctx.onRestoredToOpenWorkspace(target.folderPath, sessionMeta.size);
    }
  }
}

/** True if `folderPath` is one of the folders open in the current VS Code window. */
export function isOpenWorkspace(folderPath: string): boolean {
  // Injected by the caller to avoid importing vscode here.
  return openWorkspaces.has(folderPath);
}

/** Set by the controller: currently open workspace folder paths. */
export const openWorkspaces = new Set<string>();

async function updateVscodeDb(dbPath: string, sessionMeta: Map<string, VscodeSessionMeta>): Promise<void> {
  const db = await openVscodeDb(dbPath);

  const index = parseChatIndex(db.get('chat.ChatSessionStore.index'));
  for (const [sid, meta] of sessionMeta) {
    if (meta.index) {
      index.entries[sid] = meta.index;
    }
  }
  db.set('chat.ChatSessionStore.index', JSON.stringify(index));

  const agentModel = parseJsonArray<AgentModelCacheEntry>(db.get('agentSessions.model.cache'));
  const knownResources = new Set(agentModel.map((a) => a.resource));
  for (const [, meta] of sessionMeta) {
    if (meta.agent && !knownResources.has(meta.agent.resource)) {
      agentModel.push(meta.agent);
      knownResources.add(meta.agent.resource);
    }
  }
  db.set('agentSessions.model.cache', JSON.stringify(agentModel));

  const agentState = parseJsonArray<AgentStateCacheEntry>(db.get('agentSessions.state.cache'));
  const knownState = new Set(agentState.map((a) => a.resource));
  for (const [sid, meta] of sessionMeta) {
    if (meta.read != null) {
      const resource = `vscode-chat-session://local/${Buffer.from(sid).toString('base64')}`;
      if (!knownState.has(resource)) {
        agentState.push({ resource, read: meta.read });
        knownState.add(resource);
      }
    }
  }
  db.set('agentSessions.state.cache', JSON.stringify(agentState));

  db.save();
  db.close();
}

/**
 * Remove locally-restored VS Code data for repo paths deleted on another machine:
 * delete session files / editing state and drop the entries from the SQLite index.
 */
export async function removeVscodeSessions(
  ctx: VscodeRestoreContext,
  removePaths: readonly string[],
  log: (msg: string) => void
): Promise<void> {
  const byFolder = new Map<string, string[]>();
  for (const p of removePaths) {
    const parts = p.split('/');
    if (parts.length >= 3 && parts[0] === 'vscode') {
      const list = byFolder.get(parts[1]) ?? [];
      list.push(p);
      byFolder.set(parts[1], list);
    }
  }

  for (const [repoFolder, paths] of byFolder) {
    const target = resolveTarget(ctx, repoFolder);
    if (!target) {
      continue;
    }

    const removedSids: string[] = [];
    for (const p of paths) {
      const conv = p.match(/^vscode\/[^/]+\/chatSessions\/([^/]+)\/conversation\.(jsonl|json)$/);
      if (conv) {
        const sid = conv[1];
        await fs.rm(path.join(target.chatSessionsDir, `${sid}.${conv[2]}`), { force: true });
        await fs.rm(path.join(target.editingSessionsDir, sid), { recursive: true, force: true });
        removedSids.push(sid);
        log(`Removed local VS Code session ${sid}`);
        continue;
      }
      const edit = p.match(/^vscode\/[^/]+\/chatEditingSessions\/(.+)$/);
      if (edit) {
        await fs.rm(path.join(target.editingSessionsDir, edit[1]), { force: true });
        continue;
      }
      if (p.endsWith('/workspace.json')) {
        await fs.rm(path.join(path.dirname(target.stateDbPath), 'workspace.json'), { force: true });
      }
    }

    if (removedSids.length > 0 && existsSync(target.stateDbPath)) {
      try {
        const db = await openVscodeDb(target.stateDbPath);
        const index = parseChatIndex(db.get('chat.ChatSessionStore.index'));
        for (const sid of removedSids) {
          delete index.entries[sid];
        }
        db.set('chat.ChatSessionStore.index', JSON.stringify(index));

        const agentModel = parseJsonArray<AgentModelCacheEntry>(db.get('agentSessions.model.cache'));
        const agentState = parseJsonArray<AgentStateCacheEntry>(db.get('agentSessions.state.cache'));
        const removedResources = new Set(removedSids.map((s) => `vscode-chat-session://local/${Buffer.from(s).toString('base64')}`));
        db.set(
          'agentSessions.model.cache',
          JSON.stringify(agentModel.filter((a) => !removedResources.has(a.resource)))
        );
        db.set(
          'agentSessions.state.cache',
          JSON.stringify(agentState.filter((a) => !removedResources.has(a.resource)))
        );
        db.save();
        db.close();
      } catch (e) {
        log(`Failed to update VS Code index after removal: ${String(e)}`);
      }
    }
  }
}

function parseJsonArray<T>(raw: string | undefined): T[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}