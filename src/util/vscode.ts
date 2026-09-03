import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Get the folder's birth/creation time in milliseconds since epoch,
 * matching VS Code's computation per platform.
 *
 * On Windows: Math.floor(stat.birthtimeMs)
 * On macOS: stat.birthtime (st_birthtime)
 * On Linux: stat.ino (inode number, since Linux ctime != birthtime)
 */
function getFolderBirthtimeMs(folderPath: string): number {
  const stat = fs.statSync(folderPath);
  if (process.platform === 'win32') {
    return Math.floor(stat.birthtimeMs);
  } else if (process.platform === 'darwin') {
    return Math.floor(stat.birthtime.getTime());
  } else {
    // Linux: VS Code uses the inode number
    return stat.ino;
  }
}

/**
 * Compute the workspace storage hash the same way VS Code does:
 * MD5( fsPath + birthtimeStr )
 *
 * IMPORTANT: VS Code's getSingleFolderWorkspaceIdentifier uses
 * folderUri.fsPath as-is (no lowercasing) for single-folder workspaces.
 *
 * See: https://github.com/microsoft/vscode/blob/main/src/vs/platform/workspaces/node/workspaces.ts
 */
export function computeWorkspaceHash(folderPath: string): string {
  const birthtimeMs = getFolderBirthtimeMs(folderPath);
  const hashInput = folderPath + String(birthtimeMs);
  return createHash('md5').update(hashInput).digest('hex');
}

/**
 * Get the VS Code user data directory based on the platform.
 */
export function getVscodeUserDataPath(variant?: string): string {
  const appName = variant ? `Code - ${variant}` : 'Code';
  if (process.platform === 'win32') {
    return path.join(os.homedir(), 'AppData', 'Roaming', appName, 'User');
  } else if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', appName, 'User');
  } else {
    return path.join(os.homedir(), '.config', appName, 'User');
  }
}

/**
 * Get the workspace storage root directory.
 */
export function getWorkspaceStorageRoot(variant?: string): string {
  return path.join(getVscodeUserDataPath(variant), 'workspaceStorage');
}

/**
 * Encode a workspace path for use as a directory name in the repository.
 * Replaces path separators with dashes and removes colons (Windows).
 */
export function encodeWorkspacePath(workspacePath: string): string {
  return workspacePath
    .replace(/[/\\]/g, '-')
    .replace(/:/g, '')
    .replace(/^-/, '');
}

/**
 * Decode a workspace path from a repository directory name.
 */
export function decodeWorkspacePath(encoded: string): string {
  // This is a best-effort decode; the original path is stored in workspace.json
  return encoded;
}

/**
 * Find the workspace storage directory for a given workspace path.
 * Returns the hash directory name if found, undefined otherwise.
 */
export function findWorkspaceHash(workspaceStorageRoot: string, workspacePath: string): string | undefined {
  if (!fs.existsSync(workspaceStorageRoot)) {
    return undefined;
  }

  const entries = fs.readdirSync(workspaceStorageRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const wsJsonPath = path.join(workspaceStorageRoot, entry.name, 'workspace.json');
    if (!fs.existsSync(wsJsonPath)) {
      continue;
    }

    try {
      const wsJson = JSON.parse(fs.readFileSync(wsJsonPath, 'utf8'));
      const folder = wsJson.folder || '';
      // VS Code stores folder as file:///path, so we need to decode it
      if (folder.startsWith('file://')) {
        const decodedPath = decodeURIComponent(folder.slice(7));
        if (decodedPath === workspacePath) {
          return entry.name;
        }
      }
    } catch {
      // Skip invalid workspace.json files
    }
  }

  return undefined;
}

/**
 * Get all workspace storage entries with their folder paths.
 */
export interface WorkspaceEntry {
  hash: string;
  folderPath: string;
  folderUri: string;
  chatSessionsDir: string;
  stateDbPath: string;
}

export function getAllWorkspaceEntries(variant?: string): WorkspaceEntry[] {
  const root = getWorkspaceStorageRoot(variant);
  if (!fs.existsSync(root)) {
    return [];
  }

  const entries: WorkspaceEntry[] = [];
  const dirs = fs.readdirSync(root, { withFileTypes: true });

  for (const dir of dirs) {
    if (!dir.isDirectory()) {
      continue;
    }

    const wsJsonPath = path.join(root, dir.name, 'workspace.json');
    const chatSessionsDir = path.join(root, dir.name, 'chatSessions');
    const stateDbPath = path.join(root, dir.name, 'state.vscdb');

    if (!fs.existsSync(wsJsonPath)) {
      continue;
    }

    try {
      const wsJson = JSON.parse(fs.readFileSync(wsJsonPath, 'utf8'));
      const folder = wsJson.folder || '';
      if (folder.startsWith('file://')) {
        const folderPath = decodeURIComponent(folder.slice(7));
        entries.push({
          hash: dir.name,
          folderPath,
          folderUri: folder,
          chatSessionsDir,
          stateDbPath,
        });
      }
    } catch {
      // Skip invalid workspace.json files
    }
  }

  return entries;
}
