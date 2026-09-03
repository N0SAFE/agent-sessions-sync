import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import { encodeWorkspacePath, getAllWorkspaceEntries, getGlobalStoragePath, WorkspaceEntry } from '../util/vscode';
import { openVscodeDb, parseChatIndex, AgentModelCacheEntry, AgentStateCacheEntry } from '../util/vscodeDb';
import { localRelToRepoPath } from '../util/paths';
import { Agent, FileShaMap } from './types';

const IGNORED_FILES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);
const IGNORED_DIRS = new Set(['.git']);

/** Reserved repository folder under `vscode/` for sessions opened with no folder. */
export const VSCODE_EMPTY_WINDOW_FOLDER = '__empty_window__';

/** Path-independent marker stored as `<workspace>/workspace.json` (see scanner). */
export const VSCODE_WORKSPACE_MARKER = '__workspace__';

export function isIgnoredFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return IGNORED_FILES.has(lower) || lower.endsWith('.tmp');
}

/** Git blob SHA-1 of the content — identical to what GitHub reports for the same bytes. */
export function gitBlobSha(content: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`blob ${content.length}\0`);
  hash.update(content);
  return hash.digest('hex');
}

export interface ScanOptions {
  /** Files modified within this window are reported in `fresh` (actively-written sessions). 0/undefined disables. */
  freshMs?: number;
  /** Files larger than this many bytes are not read or hashed; reported in `oversized`. */
  maxFileSize?: number;
  /** Clock override for tests. */
  now?: number;
}

export interface ScanResult {
  files: FileShaMap;
  /** Repo paths of files modified within `freshMs` (still hashed and present in `files`). */
  fresh: Set<string>;
  /** Repo paths of files skipped for exceeding `maxFileSize` (absent from `files`). */
  oversized: Set<string>;
}

/** Hash a single on-disk file into the result under `repoPath`, honoring fresh/oversized options. */
async function hashFile(
  repoPath: string,
  absPath: string,
  result: ScanResult,
  options: ScanOptions,
  applyFresh: boolean
): Promise<void> {
  const stat = await fs.stat(absPath);
  if (options.maxFileSize !== undefined && stat.size > options.maxFileSize) {
    result.oversized.add(repoPath);
    return;
  }
  if (applyFresh && options.freshMs !== undefined && options.freshMs > 0) {
    const now = options.now ?? Date.now();
    if (now - stat.mtimeMs < options.freshMs) {
      result.fresh.add(repoPath);
    }
  }
  const content = await fs.readFile(absPath);
  result.files[repoPath] = gitBlobSha(content);
}

/** Recursively scan one agent directory, adding `<repoDir>/<rel>` entries to `result`. */
async function scanDir(agent: Agent, result: ScanResult, options: ScanOptions): Promise<void> {
  async function walk(absDir: string, rel: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw e;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const childRel = rel ? `${rel}${path.sep}${entry.name}` : entry.name;
      const childAbs = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name.toLowerCase())) {
          continue;
        }
        await walk(childAbs, childRel);
      } else if (entry.isFile()) {
        if (isIgnoredFileName(entry.name)) {
          continue;
        }
        const repoPath = localRelToRepoPath(agent.repoDir, childRel, agent.folderMap?.toRepo);
        await hashFile(repoPath, childAbs, result, options, true);
      }
    }
  }
  await walk(agent.localPath, '');
}

/**
 * Scan VS Code workspace storage directories for chat sessions and their SQLite index,
 * mapping each workspace to `<vscode>/<repoFolder>/…`. The repo folder name is the encoded
 * workspace folder path (or a `workspacePaths` alias); the SQLite index and agent caches are
 * stored as per-session sidecar files so a sync unit covers one session.
 */
async function scanVscodeAgent(agent: Agent, result: ScanResult, options: ScanOptions): Promise<void> {
  const userDataPath = path.dirname(agent.localPath);
  const entries = getAllWorkspaceEntries(userDataPath);

  for (const entry of entries) {
    const repoFolder = agent.folderMap?.toRepo.get(entry.folderPath) ?? encodeWorkspacePath(entry.folderPath);
    await scanWorkspaceSessions(agent, result, options, entry, repoFolder);
  }

  await scanEmptyWindowSessions(agent, result, options);
}

/** Scan one workspace storage entry into `<repoFolder>/`. */
async function scanWorkspaceSessions(
  agent: Agent,
  result: ScanResult,
  options: ScanOptions,
  entry: WorkspaceEntry,
  repoFolder: string
): Promise<void> {
  const base = `${agent.repoDir}/${repoFolder}`;

  // workspace.json — a path-independent marker. The real folder URI differs per machine,
  // so storing it raw would make the same workspace a permanent conflict across machines;
  // restore writes the correct local URI instead.
  result.files[`${base}/workspace.json`] = gitBlobSha(Buffer.from(JSON.stringify({ folder: VSCODE_WORKSPACE_MARKER })));

  // Read the SQLite index + agent caches once per workspace.
  let index = { version: 1, entries: {} as Record<string, Record<string, unknown>> };
  let agentModel: AgentModelCacheEntry[] = [];
  let agentState: AgentStateCacheEntry[] = [];
  if (existsSync(entry.stateDbPath) && statSync(entry.stateDbPath).size > 0) {
    try {
      const db = await openVscodeDb(entry.stateDbPath);
      index = parseChatIndex(db.get('chat.ChatSessionStore.index'));
      agentModel = parseJsonArray<AgentModelCacheEntry>(db.get('agentSessions.model.cache'));
      agentState = parseJsonArray<AgentStateCacheEntry>(db.get('agentSessions.state.cache'));
      db.close();
    } catch {
      // unreadable/corrupt db — sessions still sync, just without index metadata
    }
  }

  // Index of session id → read timestamp (from agentSessions.state.cache).
  const readByResource = new Map<string, number>();
  for (const s of agentState) {
    readByResource.set(s.resource, s.read);
  }

  // Session content files.
  let chatEntries: Dirent[] = [];
  try {
    chatEntries = await fs.readdir(entry.chatSessionsDir, { withFileTypes: true });
  } catch {
    chatEntries = [];
  }

  for (const file of chatEntries) {
    if (!file.isFile() || isIgnoredFileName(file.name)) {
      continue;
    }
    const lower = file.name.toLowerCase();
    const isJson = lower.endsWith('.json');
    const isJsonl = lower.endsWith('.jsonl');
    if (!isJson && !isJsonl) {
      continue;
    }
    const sid = file.name.slice(0, isJsonl ? -'.jsonl'.length : -'.json'.length);
    const abs = path.join(entry.chatSessionsDir, file.name);
    const sessionBase = `${base}/chatSessions/${sid}`;
    await hashFile(`${sessionBase}/conversation.${isJsonl ? 'jsonl' : 'json'}`, abs, result, options, true);

    // Per-session metadata sidecar (index entry + agent cache + read state + format).
    const indexEntry = index.entries[sid] ?? index.entries[`vscode-chat-session://local/${Buffer.from(sid).toString('base64')}`];
    const agentResource = `vscode-chat-session://local/${Buffer.from(sid).toString('base64')}`;
    const agentEntry = agentModel.find((a) => a.resource === agentResource);
    const meta = {
      format: isJsonl ? 'jsonl' : 'json',
      index: indexEntry ?? null,
      agent: agentEntry ?? null,
      read: readByResource.get(agentResource) ?? null,
    };
    result.files[`${sessionBase}/meta.json`] = gitBlobSha(Buffer.from(JSON.stringify(meta)));
  }

  // Agent editing-session state (pending file edits etc.).
  let editingDirs: Dirent[] = [];
  try {
    editingDirs = await fs.readdir(entry.editingSessionsDir, { withFileTypes: true });
  } catch {
    editingDirs = [];
  }
  for (const dir of editingDirs) {
    if (!dir.isDirectory()) {
      continue;
    }
    const absBase = path.join(entry.editingSessionsDir, dir.name);
    const repoBase = `${base}/chatEditingSessions/${dir.name}`;
    await walkTree(result, options, absBase, repoBase);
  }
}

/** Scan the empty-window (no folder) sessions under `vscode/<reserved>/`. */
async function scanEmptyWindowSessions(agent: Agent, result: ScanResult, options: ScanOptions): Promise<void> {
  const userDataPath = path.dirname(agent.localPath);
  const sessionsDir = path.join(getGlobalStoragePath(userDataPath), 'emptyWindowChatSessions');
  const stateDbPath = path.join(getGlobalStoragePath(userDataPath), 'state.vscdb');
  const base = `${agent.repoDir}/${VSCODE_EMPTY_WINDOW_FOLDER}`;

  let index = { version: 1, entries: {} as Record<string, Record<string, unknown>> };
  if (existsSync(stateDbPath) && statSync(stateDbPath).size > 0) {
    try {
      const db = await openVscodeDb(stateDbPath);
      index = parseChatIndex(db.get('chat.ChatSessionStore.index'));
      db.close();
    } catch {
      // ignore
    }
  }

  let chatEntries: Dirent[] = [];
  try {
    chatEntries = await fs.readdir(sessionsDir, { withFileTypes: true });
  } catch {
    chatEntries = [];
  }

  // Marker so the other machine knows these are no-folder sessions (only when any exist).
  const sessionFiles = chatEntries.filter((f) => {
    if (!f.isFile() || isIgnoredFileName(f.name)) {
      return false;
    }
    const lower = f.name.toLowerCase();
    return lower.endsWith('.json') || lower.endsWith('.jsonl');
  });
  if (sessionFiles.length === 0) {
    return;
  }
  result.files[`${base}/workspace.json`] = gitBlobSha(Buffer.from(JSON.stringify({ folder: VSCODE_EMPTY_WINDOW_FOLDER })));

  for (const file of sessionFiles) {
    if (!file.isFile() || isIgnoredFileName(file.name)) {
      continue;
    }
    const lower = file.name.toLowerCase();
    const isJson = lower.endsWith('.json');
    const isJsonl = lower.endsWith('.jsonl');
    if (!isJson && !isJsonl) {
      continue;
    }
    const sid = file.name.slice(0, isJsonl ? -'.jsonl'.length : -'.json'.length);
    const abs = path.join(sessionsDir, file.name);
    const sessionBase = `${base}/chatSessions/${sid}`;
    await hashFile(`${sessionBase}/conversation.${isJsonl ? 'jsonl' : 'json'}`, abs, result, options, true);
    const meta = {
      format: isJsonl ? 'jsonl' : 'json',
      index: index.entries[sid] ?? null,
      agent: null,
      read: null,
    };
    result.files[`${sessionBase}/meta.json`] = gitBlobSha(Buffer.from(JSON.stringify(meta)));
  }
}

/** Recursively copy an absolute directory tree into repo paths below `repoBase`. */
async function walkTree(
  result: ScanResult,
  options: ScanOptions,
  absDir: string,
  repoDir: string
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name.toLowerCase())) {
        continue;
      }
      await walkTree(result, options, path.join(absDir, entry.name), `${repoDir}/${entry.name}`);
      continue;
    }
    if (entry.isFile()) {
      if (isIgnoredFileName(entry.name)) {
        continue;
      }
      await hashFile(`${repoDir}/${entry.name}`, path.join(absDir, entry.name), result, options, false);
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

/**
 * Scan every agent's local sessions directory into a single repository-path → git blob sha map.
 * Missing directories contribute nothing (so agents the user doesn't use are simply empty).
 */
export async function scanAgents(agents: readonly Agent[], options: ScanOptions = {}): Promise<ScanResult> {
  const result: ScanResult = { files: {}, fresh: new Set(), oversized: new Set() };
  for (const agent of agents) {
    if (agent.id === 'vscode') {
      await scanVscodeAgent(agent, result, options);
    } else {
      await scanDir(agent, result, options);
    }
  }
  return result;
}
