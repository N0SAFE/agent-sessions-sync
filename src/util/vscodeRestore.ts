import * as fs from 'node:fs';
import * as path from 'node:path';
import { computeWorkspaceHash, decodeWorkspacePath, getAllWorkspaceEntries, getWorkspaceStorageRoot } from './vscode';

/**
 * Parse a VS Code session index from state.vscdb.
 * This is a simplified parser that extracts the chat.ChatSessionStore.index key.
 */
export function parseSessionIndex(stateDbPath: string): Record<string, unknown> | null {
  try {
    // VS Code uses a simple key-value store in state.vscdb
    // For simplicity, we'll read the JSON file directly if it exists
    const indexPath = path.join(path.dirname(stateDbPath), 'chatSessions', 'index.json');
    if (fs.existsSync(indexPath)) {
      return JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    }
  } catch {
    // Ignore errors
  }
  return null;
}

/**
 * Create or update a VS Code session index file.
 */
export function writeSessionIndex(stateDbPath: string, index: Record<string, unknown>): void {
  const chatSessionsDir = path.join(path.dirname(stateDbPath), 'chatSessions');
  fs.mkdirSync(chatSessionsDir, { recursive: true });
  const indexPath = path.join(chatSessionsDir, 'index.json');
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
}

/**
 * Restore VS Code chat sessions from repository paths to the correct workspace storage location.
 *
 * @param repoPaths Repository paths to restore (e.g., "vscode/Users-mathis-projects-myproject/chatSessions/abc.jsonl")
 * @param sourceContent Function to get the content of a file from the repository
 * @param variant VS Code variant (e.g., "Insiders" for VS Code Insiders)
 */
export async function restoreVscodeSessions(
  repoPaths: string[],
  sourceContent: (repoPath: string) => Promise<Buffer>,
  variant?: string
): Promise<void> {
  // Group files by workspace path
  const byWorkspace = new Map<string, string[]>();
  for (const repoPath of repoPaths) {
    // Parse: vscode/<encoded-path>/chatSessions/<filename>
    const parts = repoPath.split('/');
    if (parts.length < 4 || parts[0] !== 'vscode') {
      continue;
    }
    const encodedPath = parts[1];
    if (!byWorkspace.has(encodedPath)) {
      byWorkspace.set(encodedPath, []);
    }
    byWorkspace.get(encodedPath)!.push(repoPath);
  }

  const workspaceStorageRoot = getWorkspaceStorageRoot(variant);

  for (const [encodedPath, paths] of byWorkspace) {
    // Find the workspace folder path from workspace.json
    const workspaceJsonPath = paths.find(p => p.endsWith('workspace.json'));
    let folderPath: string | undefined;

    if (workspaceJsonPath) {
      try {
        const content = await sourceContent(workspaceJsonPath);
        const wsJson = JSON.parse(content.toString('utf8'));
        const folder = wsJson.folder || '';
        if (folder.startsWith('file://')) {
          folderPath = decodeURIComponent(folder.slice(7));
        }
      } catch {
        // Can't parse workspace.json, try to decode the path
        folderPath = decodeWorkspacePath(encodedPath);
      }
    } else {
      folderPath = decodeWorkspacePath(encodedPath);
    }

    if (!folderPath) {
      continue;
    }

    // Compute the correct workspace hash for this machine
    const targetHash = computeWorkspaceHash(folderPath);
    const targetDir = path.join(workspaceStorageRoot, targetHash);
    const targetChatSessionsDir = path.join(targetDir, 'chatSessions');

    // Create the directory structure
    fs.mkdirSync(targetChatSessionsDir, { recursive: true });

    // Copy workspace.json if it doesn't exist
    const targetWsJsonPath = path.join(targetDir, 'workspace.json');
    if (!fs.existsSync(targetWsJsonPath) && workspaceJsonPath) {
      try {
        const content = await sourceContent(workspaceJsonPath);
        fs.writeFileSync(targetWsJsonPath, content);
      } catch {
        // Create a minimal workspace.json
        const wsJson = { folder: `file://${folderPath}` };
        fs.writeFileSync(targetWsJsonPath, JSON.stringify(wsJson, null, 2));
      }
    }

    // Copy chat session files
    for (const repoPath of paths) {
      if (repoPath.endsWith('workspace.json')) {
        continue; // Already handled
      }

      const filename = path.basename(repoPath);
      const targetPath = path.join(targetChatSessionsDir, filename);

      try {
        const content = await sourceContent(repoPath);
        fs.writeFileSync(targetPath, content);
      } catch (e) {
        console.error(`Failed to restore ${repoPath}:`, e);
      }
    }

    // Update the session index in state.vscdb
    // Note: VS Code uses SQLite for state.vscdb, but for simplicity we'll
    // create a JSON index file that can be read by our extension
    const sessionIndex: Record<string, unknown> = {};
    for (const repoPath of paths) {
      if (repoPath.endsWith('workspace.json')) {
        continue;
      }

      const filename = path.basename(repoPath);
      const sessionId = filename.replace('.jsonl', '');
      sessionIndex[sessionId] = {
        sessionId,
        lastMessageDate: Date.now(),
        timing: { created: Date.now() },
        initialLocation: 'panel',
        hasPendingEdits: false,
        isEmpty: false,
        isExternal: false,
        lastResponseState: 1,
      };
    }

    if (Object.keys(sessionIndex).length > 0) {
      writeSessionIndex(path.join(targetDir, 'state.vscdb'), sessionIndex);
    }
  }
}

/**
 * Find orphaned VS Code sessions (sessions that don't have a matching workspace hash).
 */
export function findOrphanedSessions(variant?: string): Array<{
  folderPath: string;
  currentHash: string;
  orphanedHash: string;
  sessions: string[];
}> {
  const entries = getAllWorkspaceEntries(variant);
  const orphaned: Array<{
    folderPath: string;
    currentHash: string;
    orphanedHash: string;
    sessions: string[];
  }> = [];

  for (const entry of entries) {
    const currentHash = computeWorkspaceHash(entry.folderPath);
    if (currentHash !== entry.hash) {
      // This workspace has an orphaned hash
      const sessions: string[] = [];
      try {
        const files = fs.readdirSync(entry.chatSessionsDir);
        sessions.push(...files.filter(f => f.endsWith('.jsonl')));
      } catch {
        // No chatSessions directory
      }

      if (sessions.length > 0) {
        orphaned.push({
          folderPath: entry.folderPath,
          currentHash,
          orphanedHash: entry.hash,
          sessions,
        });
      }
    }
  }

  return orphaned;
}
