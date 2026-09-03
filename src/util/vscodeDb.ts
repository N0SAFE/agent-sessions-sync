import initSqlJs, { Database } from 'sql.js';
import * as fs from 'node:fs';
import { SQL_WASM_BASE64 } from './sql-wasm-base64';

/**
 * Minimum in-memory wrapper around VS Code's `state.vscdb` (SQLite) using sql.js.
 *
 * VS Code stores chat-session metadata in the `ItemTable` of each workspace's
 * `state.vscdb` under keys like `chat.ChatSessionStore.index`,
 * `agentSessions.model.cache` and `agentSessions.state.cache`. VS Code does NOT
 * scan the `chatSessions/` folder — it only reads these keys, so restoring
 * session files without also writing the index leaves them invisible to the UI.
 *
 * The wasm binary is inlined (`sql-wasm-base64.ts`) so the extension bundles
 * self-containedly with no native dependencies and no extra files.
 */

let sqlPromise: ReturnType<typeof initSqlJs> | undefined;

async function loadSql(): Promise<ReturnType<typeof initSqlJs>> {
  if (!sqlPromise) {
    const wasmBinary = new Uint8Array(Buffer.from(SQL_WASM_BASE64, 'base64'));
    sqlPromise = initSqlJs({ wasmBinary: wasmBinary as unknown as ArrayBuffer });
  }
  return sqlPromise;
}

export interface VscodeDb {
  /** Persist the in-memory database back to disk. */
  save(): void;
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  remove(key: string): void;
  close(): void;
}

/**
 * Open a VS Code state database, creating a fresh one with the proper schema
 * if the file does not exist yet.
 */
export async function openVscodeDb(filePath: string): Promise<VscodeDb> {
  const SQL = await loadSql();
  let db: Database;
  if (fs.existsSync(filePath)) {
    db = new SQL.Database(fs.readFileSync(filePath));
  } else {
    db = new SQL.Database();
    db.run('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);');
  }

  return {
    get(key: string): string | undefined {
      const res = db.exec("SELECT value FROM ItemTable WHERE key = ?", [key]);
      if (res.length === 0 || res[0].values.length === 0) {
        return undefined;
      }
      const val = res[0].values[0][0];
      if (val === null || val === undefined) {
        return undefined;
      }
      if (typeof val === 'string') {
        return val;
      }
      if (typeof val === 'number') {
        return String(val);
      }
      // sql.js returns BLOB columns as Uint8Array
      return Buffer.from(val).toString('utf8');
    },
    set(key: string, value: string): void {
      db.run('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)', [key, value]);
    },
    remove(key: string): void {
      db.run('DELETE FROM ItemTable WHERE key = ?', [key]);
    },
    save(): void {
      const data = Buffer.from(db.export());
      fs.writeFileSync(filePath, data);
    },
    close(): void {
      db.close();
    },
  };
}

/** The parsed shape of `chat.ChatSessionStore.index`. */
export interface ChatSessionIndex {
  version: number;
  entries: Record<string, Record<string, unknown>>;
}

export function parseChatIndex(raw: string | undefined): ChatSessionIndex {
  if (!raw) {
    return { version: 1, entries: {} };
  }
  try {
    const parsed = JSON.parse(raw) as ChatSessionIndex;
    if (parsed && typeof parsed === 'object' && parsed.entries) {
      return parsed;
    }
  } catch {
    // fall through to a fresh index
  }
  return { version: 1, entries: {} };
}

/** An entry of `agentSessions.model.cache`. */
export interface AgentModelCacheEntry {
  providerType: string;
  providerLabel: string;
  resource: string;
  icon: string;
  label: string;
  status: number;
  timing: {
    created?: number;
    lastRequestStarted?: number;
    lastRequestEnded?: number;
  };
  changes?: { files: number; insertions: number; deletions: number };
  metadata?: Record<string, unknown>;
}

/** An entry of `agentSessions.state.cache`. */
export interface AgentStateCacheEntry {
  resource: string;
  read: number;
}