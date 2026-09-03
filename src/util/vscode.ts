import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * VS Code Copilot Chat storage internals.
 *
 * Layout:
 *   <userData>/workspaceStorage/<hash>/workspace.json      folder URI (file:///...)
 *   <userData>/workspaceStorage/<hash>/state.vscdb         SQLite: chat.ChatSessionStore.index,
 *                                                          agentSessions.model.cache, agentSessions.state.cache
 *   <userData>/workspaceStorage/<hash>/chatSessions/<sid>.jsonl|.json   conversation content
 *   <userData>/workspaceStorage/<hash>/chatEditingSessions/<sid>/       pending agent file edits
 *   <userData>/globalStorage/emptyWindowChatSessions/<sid>.jsonl        sessions with no folder open
 *   <userData>/globalStorage/state.vscdb                               their index
 *
 * The <hash> is MD5(folderPath + birthtimeMs) — machine-specific, so sessions are synced
 * keyed by the workspace *folder path*, and the correct hash is computed on each machine.
 */

/** Get the folder's birthtime salt VS Code uses for the storage hash. */
function getBirthtimeSalt(folderPath: string): string {
  const stat = fs.statSync(folderPath);
  if (process.platform === 'win32') {
    return String(Math.floor(stat.birthtimeMs));
  }
  if (process.platform === 'darwin') {
    return String(Math.floor(stat.birthtime.getTime()));
  }
  return String(stat.ino); // Linux: VS Code uses the inode (ctime is unreliable there)
}

/**
 * Compute the workspace storage hash the same way VS Code does:
 *   MD5( folderUri.fsPath + birthtimeSalt )
 * See microsoft/vscode src/vs/platform/workspaces/node/workspaces.ts.
 */
export function computeWorkspaceHash(folderPath: string): string {
  const salt = getBirthtimeSalt(folderPath);
  return createHash('md5').update(folderPath).update(salt).digest('hex');
}

/**
 * Resolve the VS Code user data directory (the `User` folder containing
 * workspaceStorage/ and globalStorage/). `variant` is e.g. "Insiders".
 */
export function getUserDataPath(variant?: string): string {
  const appName = variant ? `Code - ${variant}` : 'Code';
  if (process.platform === 'win32') {
    return path.join(os.homedir(), 'AppData', 'Roaming', appName, 'User');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', appName, 'User');
  }
  return path.join(os.homedir(), '.config', appName, 'User');
}

export function getWorkspaceStorageRoot(userDataPath: string): string {
  return path.join(userDataPath, 'workspaceStorage');
}

export function getGlobalStoragePath(userDataPath: string): string {
  return path.join(userDataPath, 'globalStorage');
}

/** Encode a workspace folder path into a single safe repo folder name. */
export function encodeWorkspacePath(folderPath: string): string {
  const clean = folderPath.replace(/[/\\:]/g, '-').replace(/^-/, '');
  return clean || 'root';
}

/**
 * Repo-based workspace keys: sessions are grouped by the folder's git remote identity
 * (`owner/repo`) instead of its absolute path, so the same project maps to the same sync
 * folder on every machine regardless of where it is cloned.
 */
export const REPO_KEY_PREFIX = 'repo-';

/** True when a repo folder name is a repo-identity key rather than an encoded path. */
export function isRepoKeyedFolder(repoFolder: string): boolean {
  return repoFolder.startsWith(REPO_KEY_PREFIX);
}

/** `N0SAFE/deployer` → `repo-N0SAFE-deployer` (safe, stable across machines). */
export function repoKeyFromIdentity(identity: string): string {
  return REPO_KEY_PREFIX + identity.replace(/[^A-Za-z0-9._-]/g, '-');
}

/**
 * Normalize a git remote URL to `owner/repo` (keeps nested group paths for GitLab etc.,
 * strips protocol/credentials/host and the `.git` suffix).
 */
export function normalizeGitRemote(url: string): string | undefined {
  let u = url.trim().replace(/\.git\/?$/, '');
  if (!u) {
    return undefined;
  }
  if (u.includes('@') && u.includes(':') && !u.includes('://')) {
    // scp-like: git@github.com:owner/repo
    u = u.slice(u.lastIndexOf(':') + 1);
  } else {
    // scheme://[user@]host/owner/repo
    u = u.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    u = u.replace(/^[^/@]+@/, '');
    u = u.replace(/^[^/]+\//, '');
  }
  u = u.replace(/\/+$/, '');
  return u || undefined;
}

/** The repo identity (`owner/repo`) of a folder's `origin` remote, if it is a git repo. */
export function gitRemoteIdentity(folderPath: string): string | undefined {
  try {
    const url = execFileSync('git', ['-C', folderPath, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
    return normalizeGitRemote(url);
  } catch {
    return undefined;
  }
}

/**
 * Best-effort decode of an encoded repo folder name back to a local path.
 * On POSIX the leading slash is re-added. Paths containing `-` are ambiguous and
 * should use the `workspacePaths` mapping instead.
 */
export function decodeWorkspacePath(encoded: string): string {
  let decoded = encoded.replace(/-/g, path.sep);
  if (process.platform !== 'win32' && !decoded.startsWith(path.sep)) {
    decoded = path.sep + decoded;
  }
  return decoded;
}

/** A single-folder workspace's storage entry. */
export interface WorkspaceEntry {
  /** The workspaceStorage/<hash> directory name. */
  hash: string;
  /** Absolute folder path (decoded from workspace.json's folder URI). */
  folderPath: string;
  /** The raw folder URI, e.g. file:///Users/alice/proj. */
  folderUri: string;
  chatSessionsDir: string;
  stateDbPath: string;
  editingSessionsDir: string;
}

function parseWorkspaceJson(wsJsonPath: string): { folderPath: string; folderUri: string } | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(wsJsonPath, 'utf8')) as { folder?: string };
    const folder = raw.folder;
    if (folder && folder.startsWith('file://')) {
      return { folderPath: decodeURIComponent(folder.slice('file://'.length)), folderUri: folder };
    }
  } catch {
    // invalid workspace.json — skip
  }
  return undefined;
}

/** List every single-folder workspace storage entry (dirs with a readable workspace.json). */
export function getAllWorkspaceEntries(userDataPath: string): WorkspaceEntry[] {
  const root = getWorkspaceStorageRoot(userDataPath);
  if (!fs.existsSync(root)) {
    return [];
  }
  const entries: WorkspaceEntry[] = [];
  for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) {
      continue;
    }
    const wsJsonPath = path.join(root, dir.name, 'workspace.json');
    const parsed = parseWorkspaceJson(wsJsonPath);
    if (!parsed) {
      continue;
    }
    const base = path.join(root, dir.name);
    entries.push({
      hash: dir.name,
      folderPath: parsed.folderPath,
      folderUri: parsed.folderUri,
      chatSessionsDir: path.join(base, 'chatSessions'),
      stateDbPath: path.join(base, 'state.vscdb'),
      editingSessionsDir: path.join(base, 'chatEditingSessions'),
    });
  }
  return entries;
}

/** Find the workspaceStorage <hash> dir for a folder path already present locally, if any. */
export function findWorkspaceHashForFolder(userDataPath: string, folderPath: string): string | undefined {
  const normalized = path.normalize(folderPath);
  for (const entry of getAllWorkspaceEntries(userDataPath)) {
    if (path.normalize(entry.folderPath) === normalized) {
      return entry.hash;
    }
  }
  return undefined;
}

/** True if the current process is running inside VS Code Insiders (used for the default path). */
export function isInsiders(userDataPath: string): boolean {
  return userDataPath.includes('Code - Insiders');
}

/**
 * Mapping between repository workspace-folder names and this machine's workspace
 * folder paths (mirrors Claude's projectPaths, but path-based for VS Code).
 */
export interface VscodeFolderMap {
  /** Repository folder name → local workspace folder path. */
  toLocal: ReadonlyMap<string, string>;
  /** Local workspace folder path → repository folder name. */
  toRepo: ReadonlyMap<string, string>;
}

/**
 * Build the VS Code folder mapping from the `agents.vscode.workspacePaths` setting:
 * each entry maps a repository folder name to a project directory on this machine.
 */
export function buildVscodeFolderMap(
  entries: Readonly<Record<string, string>>,
  localFolders: readonly string[]
): VscodeFolderMap | undefined {
  const byEncoded = new Map(localFolders.map((p) => [encodeWorkspacePath(p), p]));
  const toLocal = new Map<string, string>();
  const toRepo = new Map<string, string>();
  for (const [repoFolder, localDir] of Object.entries(entries)) {
    const expanded = expandUserPath(localDir);
    if (expanded.trim() === '' || !fs.existsSync(expanded)) {
      continue;
    }
    // The repo folder is normally an encoded path; allow a friendly alias too.
    const localFolder = byEncoded.get(expanded) ?? byEncoded.get(encodeWorkspacePath(expanded));
    if (!localFolder || toRepo.has(localFolder) || toLocal.has(repoFolder)) {
      continue;
    }
    toLocal.set(repoFolder, localFolder);
    toRepo.set(localFolder, repoFolder);
  }
  return toLocal.size > 0 ? { toLocal, toRepo } : undefined;
}

/** Expand a leading `~` and resolve to an absolute path. */
export function expandUserPath(p: string): string {
  const value = p.trim();
  if (value === '~') {
    return os.homedir();
  }
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return path.resolve(value);
}