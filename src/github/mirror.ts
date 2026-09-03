import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FileShaMap } from '../sync/types';

/**
 * Local git mirror of the sync repository, used to push/pull in bulk via the git
 * smart protocol instead of the GitHub REST Git Data API (which needs one request
 * per blob — a big first sync burns hundreds/thousands of rate-limited requests).
 *
 * The mirror lives in the extension's globalStorage and mirrors the remote branch:
 * fetch → checkout the remote → apply the computed change set → commit → push.
 * A single `git push` transfers the whole packfile in one HTTP transaction.
 *
 * Falls back to the REST path in the controller when `git` is not installed.
 */
export class GitMirror {
  constructor(
    private readonly mirrorDir: string,
    private readonly logDebug: (msg: string) => void = () => {}
  ) {}

  static isAvailable(): boolean {
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  private run(args: string[], allowFail = false): { ok: boolean; stdout: string; stderr: string } {
    this.logDebug(`git ${sanitizeArgs(args).join(' ')}`);
    try {
      const res = execFileSync('git', args, {
        cwd: this.mirrorDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
      });
      return { ok: true, stdout: res, stderr: '' };
    } catch (e) {
      const err = e as { stdout?: Buffer | string; stderr?: Buffer | string };
      const stdout = Buffer.isBuffer(err.stdout) ? err.stdout.toString('utf8') : (err.stdout ?? '');
      const stderr = Buffer.isBuffer(err.stderr) ? err.stderr.toString('utf8') : (err.stderr ?? '');
      if (allowFail) {
        return { ok: false, stdout, stderr };
      }
      throw new Error(`git ${args[0]} failed: ${(stderr || stdout).trim()}`);
    }
  }

  /** Create the repo on first use and pin a safe identity/behavior. */
  ensureRepo(branch: string): void {
    if (!fs.existsSync(path.join(this.mirrorDir, '.git'))) {
      fs.mkdirSync(this.mirrorDir, { recursive: true });
      this.run(['init', '-b', branch]);
      this.run(['config', 'user.name', 'Agent Sessions Sync']);
      this.run(['config', 'user.email', 'agent-sessions-sync@users.noreply.github.com']);
      this.run(['config', 'commit.gpgsign', 'false']);
      this.run(['config', 'core.autocrlf', 'false']);
    }
  }

  private authUrl(owner: string, repo: string, token: string): string {
    return `https://x-access-token:${encodeURIComponent(token)}@github.com/${owner}/${repo}.git`;
  }

  /**
   * Bring the mirror in sync with the remote branch. Returns `true` when the branch
   * exists remotely (worktree = remote), `false` when the remote branch is empty.
   */
  syncToRemote(owner: string, repo: string, branch: string, token: string): boolean {
    const url = this.authUrl(owner, repo, token);
    const fetch = this.run(['fetch', url, branch], true);
    if (!fetch.ok) {
      const msg = fetch.stderr + fetch.stdout;
      if (msg.includes("couldn't find remote ref") || msg.includes('could not read from remote')) {
        // Empty repository / branch does not exist yet → start from an empty worktree.
        this.run(['checkout', '--orphan', branch]);
        for (const entry of fs.readdirSync(this.mirrorDir)) {
          if (entry !== '.git') {
            fs.rmSync(path.join(this.mirrorDir, entry), { recursive: true, force: true });
          }
        }
        return false;
      }
      throw new Error(`git fetch failed: ${msg.trim()}`);
    }
    this.run(['checkout', '-B', branch, 'FETCH_HEAD']);
    this.run(['reset', '--hard', 'FETCH_HEAD']);
    this.run(['clean', '-fd']);
    return true;
  }

  writeFile(relPath: string, content: Buffer): void {
    const abs = path.join(this.mirrorDir, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  deleteFile(relPath: string): void {
    fs.rmSync(path.join(this.mirrorDir, relPath), { force: true });
  }

  hasChanges(): boolean {
    return this.run(['status', '--porcelain']).stdout.trim().length > 0;
  }

  /** Stage all, commit, return the new HEAD sha. */
  commit(message: string): string {
    this.run(['add', '-A']);
    if (this.hasChanges()) {
      this.run(['commit', '-m', message]);
    }
    return this.head();
  }

  head(): string {
    const res = this.run(['rev-parse', 'HEAD'], true);
    return res.ok ? res.stdout.trim() : '';
  }

  /** Push HEAD to the remote branch. Throws on non-fast-forward (remote moved). */
  push(owner: string, repo: string, branch: string, token: string): void {
    const url = this.authUrl(owner, repo, token);
    this.run(['push', url, `HEAD:${branch}`]);
  }

  /** Repository-relative path → git blob sha for the current HEAD tree. */
  remoteFileMap(): FileShaMap {
    const map: FileShaMap = {};
    const head = this.head();
    if (!head) {
      return map;
    }
    const res = this.run(['ls-tree', '-r', head]);
    for (const line of res.stdout.split('\n')) {
      if (!line) {
        continue;
      }
      const m = line.match(/^(\d+)\s+(\w+)\s+([0-9a-f]{40})\t(.+)$/);
      if (m && m[2] === 'blob') {
        map[m[4]] = m[3];
      }
    }
    return map;
  }

  /** Read a file from the mirror worktree. */
  readFile(relPath: string): Buffer {
    return fs.readFileSync(path.join(this.mirrorDir, relPath));
  }

  exists(relPath: string): boolean {
    return fs.existsSync(path.join(this.mirrorDir, relPath));
  }
}

/** Redact `https://user:password@…` credentials from git args before logging. */
function sanitizeArgs(args: string[]): string[] {
  return args.map((a) => a.replace(/(https:\/\/)[^/@]+@/, '$1***@'));
}