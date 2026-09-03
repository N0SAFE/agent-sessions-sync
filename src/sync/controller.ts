import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getGitHubSession } from '../github/auth';
import { GitHubClient, GitHubError, TreeEntry } from '../github/client';
import { forEachLimit } from '../util/async';
import { describeUnit, isValidRepoPath, makeUnitOf, repoPathToLocal, repoPathToLocalRel, UnitFn } from '../util/paths';
import { repoReadmeContent } from '../util/repoTemplate';
import { buildVscodeDerivedFile, openWorkspaces, removeVscodeSessions, resolveVscodeLocalPath, restoreVscodeSessions, VscodeRestoreContext } from '../util/vscodeRestore';
import { GitMirror } from '../github/mirror';
import { computeSyncPlan, countUnits, mapsEqual } from './engine';
import { ScanOptions, scanAgents } from './scanner';
import { StateStore } from './stateStore';
import { Trash, TrashFile } from './trash';
import { Agent, ConflictResolution, FileShaMap, RepoConfig, SyncPlan, SyncStatus, UnitConflict } from './types';

const MAX_PUSH_ATTEMPTS = 3;
const BLOB_CONCURRENCY = 6;
// Deleting more than this many units AND more than this fraction of the synced units
// requires an explicit confirmation (protects against a wiped local sessions dir).
const MASS_DELETE_MIN_UNITS = 10;
const MASS_DELETE_FRACTION = 0.5;

interface RemovedUnit {
  unit: string;
  label: string;
  agentRoot: string;
  backupPath?: string;
}

/**
 * Orchestrates a single synchronization run: scan local state, fetch remote state,
 * compute the 3-way plan, apply local writes, push a commit, persist the new BASE.
 */
export class SyncController implements vscode.Disposable {
  private readonly statusEmitter = new vscode.EventEmitter<SyncStatus>();
  readonly onDidChangeStatus = this.statusEmitter.event;

  private status: SyncStatus = { kind: 'notConfigured' };
  private conflicts: UnitConflict[] = [];
  private readonly resolutions = new Map<string, ConflictResolution>();
  private readonly blobTextCache = new Map<string, string>();
  private requestSync: (reason: string) => void = () => {};
  private lastClient?: GitHubClient;
  private lastCfg?: RepoConfig;

  /** True while the controller itself is writing to a sessions dir — the watcher ignores those events. */
  applyingLocalChanges = false;

  private lastToken = '';
  private lastRemoteMap: FileShaMap = {};
  private readonly mirror: GitMirror;
  private forceLocalNext = false;

  constructor(
    private readonly getConfig: () => RepoConfig | undefined,
    private readonly getAgents: () => Agent[],
    private readonly getScanOptions: () => ScanOptions,
    private readonly stateStore: StateStore,
    private readonly trash: Trash,
    private readonly log: vscode.LogOutputChannel,
    mirrorDir?: string
  ) {
    this.mirror = new GitMirror(mirrorDir ?? path.join(os.tmpdir(), 'agent-sessions-sync-mirror'), (m) => log.debug(m));
  }

  dispose(): void {
    this.statusEmitter.dispose();
  }

  setSyncRequester(fn: (reason: string) => void): void {
    this.requestSync = fn;
  }

  getStatus(): SyncStatus {
    return this.status;
  }

  getConflicts(): UnitConflict[] {
    return this.conflicts;
  }

  setPaused(): void {
    this.setStatus({ kind: 'paused' });
  }

  private setStatus(status: SyncStatus): void {
    this.status = status;
    this.statusEmitter.fire(status);
  }

  private repoDirs(): Set<string> {
    return new Set(this.getAgents().map((a) => a.repoDir));
  }

  /** The agent owning a unit (by the unit's first segment), or undefined. */
  private agentFor(unit: string): Agent | undefined {
    const repoDir = unit.split('/', 1)[0];
    return this.getAgents().find((a) => a.repoDir === repoDir);
  }

  /** The vscode agent, or a minimal stand-in whose resolver yields undefined. */
  private static vscodeAgent(agents: readonly Agent[]): Agent {
    return agents.find((a) => a.repoDir === 'vscode') ?? {
      id: 'vscode',
      label: 'VS Code',
      repoDir: 'vscode',
      localPath: '',
      unitDepth: 4,
    };
  }

  /** Trash-backup entries for a set of repository paths (relative to their agent's root). */
  private trashFilesFor(agents: readonly Agent[], repoPaths: readonly string[]): TrashFile[] {
    const files: TrashFile[] = [];
    for (const p of repoPaths) {
      if (p.startsWith('vscode/')) {
        continue; // VS Code removals are handled by removeVscodeSessions (files + DB index)
      }
      const absPath = repoPathToLocal(agents, p);
      const relPath = repoPathToLocalRel(agents, p);
      if (absPath && relPath) {
        files.push({ absPath, relPath });
      }
    }
    return files;
  }

  /** Called after the user picks a (different) repository in the setup wizard. */
  async resetAfterRepoChange(): Promise<void> {
    this.conflicts = [];
    this.resolutions.clear();
    this.blobTextCache.clear();
    await this.stateStore.reset();
  }

  /** Record the user's conflict decision; the next sync run enforces it for the whole unit. */
  async resolveConflict(unit: string, resolution: ConflictResolution): Promise<void> {
    if (resolution === 'remote') {
      const conflict = this.conflicts.find((c) => c.unit === unit);
      if (conflict) {
        const agents = this.getAgents();
        const localPaths = conflict.files.filter((f) => f.localSha !== undefined).map((f) => f.path);
        await this.trash.backup(this.trashFilesFor(agents, localPaths), unit);
      }
    }
    this.resolutions.set(unit, resolution);
    this.log.info(`Conflict for ${unit} resolved as '${resolution}'`);
  }

  /**
   * Make the next sync treat THIS machine as authoritative: local wins every conflict,
   * sessions that only exist on the remote are removed from it, sessions only on local are
   * re-uploaded, and nothing is deleted locally. Ask first — this can remove remote-only
   * history.
   */
  async forceLocalSync(): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      'Agent Sessions Sync: make THIS machine the source of truth? This overwrites the repository ' +
        'with local state — sessions that only exist on other machines will be removed from the repo ' +
        '(your local sessions are never deleted).',
      { modal: true },
      'Force Local Over Remote'
    );
    if (choice !== 'Force Local Over Remote') {
      return;
    }
    this.forceLocalNext = true;
    this.resolutions.clear();
    this.requestSync('force-local');
  }

  /** Remote file content for the diff editor, fetched by blob sha (cached). */
  async getRemoteFileText(sha: string): Promise<string> {
    if (!sha) {
      return '';
    }
    const cached = this.blobTextCache.get(sha);
    if (cached !== undefined) {
      return cached;
    }
    // Prefer the git mirror worktree when available (avoids a REST blob request).
    if (GitMirror.isAvailable()) {
      const entry = Object.entries(this.lastRemoteMap).find(([, s]) => s === sha);
      if (entry && this.mirror.exists(entry[0])) {
        const text = this.mirror.readFile(entry[0]).toString('utf8');
        this.blobTextCache.set(sha, text);
        return text;
      }
    }
    if (!this.lastClient || !this.lastCfg) {
      throw new Error('Not connected to GitHub yet.');
    }
    const buf = await this.lastClient.getBlob(this.lastCfg.owner, this.lastCfg.repo, sha);
    const text = buf.toString('utf8');
    if (this.blobTextCache.size > 50) {
      this.blobTextCache.clear();
    }
    this.blobTextCache.set(sha, text);
    return text;
  }

  /** Unit counts for the post-setup prompts ("N local sessions found", "N sessions available remotely"). */
  async getFirstSyncCounts(): Promise<{ localUnits: number; remoteUnits: number }> {
    const cfg = this.getConfig();
    if (!cfg) {
      throw new Error('Not configured');
    }
    const session = await getGitHubSession(false);
    if (!session) {
      throw new Error('GitHub sign-in required');
    }
    const agents = this.getAgents();
    const unitFn = makeUnitOf(agents);
    const client = this.createClient(session.accessToken, cfg);
    const scan = await scanAgents(agents);
    const headSha = await client.getBranchHeadSha(cfg.owner, cfg.repo, cfg.branch);
    let remote: FileShaMap = {};
    if (headSha) {
      const { treeSha } = await client.getCommit(cfg.owner, cfg.repo, headSha);
      remote = await this.fetchRemoteFiles(client, cfg, treeSha);
    }
    return { localUnits: countUnits(scan.files, unitFn), remoteUnits: countUnits(remote, unitFn) };
  }

  /** Distinct first-level folder names under one agent namespace in the repository (for the project-mapping UI). */
  async listRemoteFolders(repoDir: string): Promise<string[]> {
    const cfg = this.getConfig();
    if (!cfg) {
      throw new Error('Not configured');
    }
    const session = await getGitHubSession(false);
    if (!session) {
      throw new Error('GitHub sign-in required');
    }
    const client = this.createClient(session.accessToken, cfg);
    const headSha = await client.getBranchHeadSha(cfg.owner, cfg.repo, cfg.branch);
    if (!headSha) {
      return [];
    }
    const { treeSha } = await client.getCommit(cfg.owner, cfg.repo, headSha);
    const files = await this.fetchRemoteFiles(client, cfg, treeSha);
    const folders = new Set<string>();
    for (const p of Object.keys(files)) {
      const [dir, folder, ...rest] = p.split('/');
      if (dir === repoDir && folder && rest.length > 0) {
        folders.add(folder);
      }
    }
    return [...folders].sort();
  }

  /** Entry point for the scheduler. Never throws; failures end up in the status + log. */
  async sync(trigger: string): Promise<void> {
    const cfg = this.getConfig();
    if (!cfg) {
      this.setStatus({ kind: 'notConfigured' });
      return;
    }
    this.setStatus({ kind: 'syncing' });
    this.log.info(`Sync started (${trigger}) → ${cfg.owner}/${cfg.repo}@${cfg.branch}`);
    try {
      const session = await getGitHubSession(false);
      if (!session) {
        this.log.warn('No GitHub session — sign-in required.');
        this.setStatus({ kind: 'signInRequired' });
        return;
      }
      const client = this.createClient(session.accessToken, cfg);

      for (let attempt = 1; ; attempt++) {
        const done = await this.syncOnce(client, cfg);
        if (done) {
          break;
        }
        if (attempt >= MAX_PUSH_ATTEMPTS) {
          throw new Error('Remote repository kept changing during upload — will retry on the next sync.');
        }
        this.log.info(`Remote moved during upload, retrying (attempt ${attempt + 1})…`);
      }
    } catch (e) {
      if (e instanceof GitHubError && e.status === 401) {
        this.log.warn('GitHub token rejected — sign-in required.');
        this.setStatus({ kind: 'signInRequired' });
        return;
      }
      const message = e instanceof Error ? e.message : String(e);
      this.log.error(`Sync failed: ${message}`);
      this.setStatus({ kind: 'error', message });
    }
  }

  private createClient(token: string, cfg: RepoConfig): GitHubClient {
    this.lastToken = token;
    const client = new GitHubClient(token, (m) => this.log.debug(m));
    this.lastClient = client;
    this.lastCfg = cfg;
    return client;
  }

  /** One sync pass. Returns false when the push lost a race with another device and the pass must be re-run. */
  private async syncOnce(client: GitHubClient, cfg: RepoConfig): Promise<boolean> {
    // Refresh which folders are open right now, so restored sessions into the current
    // window can prompt for a restart (VS Code's in-memory index would shadow the DB write).
    openWorkspaces.clear();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      openWorkspaces.add(folder.uri.fsPath);
    }

    const agents = this.getAgents();
    const unitFn = makeUnitOf(agents);
    const scan = await scanAgents(agents, this.getScanOptions());
    const base = await this.stateStore.load(cfg);

    // Freeze actively-written and oversized files at their BASE state: the unit is skipped in
    // both directions this run, and an active session alone doesn't defeat the no-op detection.
    const heldPaths = [...scan.fresh, ...scan.oversized];
    const frozen = new Set(heldPaths.map(unitFn));
    const local: FileShaMap = { ...scan.files };
    for (const p of heldPaths) {
      if (base.files[p] !== undefined) {
        local[p] = base.files[p];
      } else {
        delete local[p];
      }
    }
    for (const p of scan.oversized) {
      if (base.files[p] === undefined) {
        this.log.warn(`Skipping oversized file (larger than the maxFileSizeMB setting): ${p}`);
      }
    }

    const headSha = await client.getBranchHeadSha(cfg.owner, cfg.repo, cfg.branch);

    // Cheap no-op detection: nothing changed anywhere since the last sync.
    if (headSha === base.commitSha && mapsEqual(local, base.files) && this.resolutions.size === 0) {
      this.log.info('Nothing to sync.');
      this.finish(cfg);
      return true;
    }

    // Transport: the git mirror (bulk push/pull in one packfile) is preferred when the
    // `git` binary is available; otherwise fall back to the REST Git Data API.
    const useGit = GitMirror.isAvailable() && this.lastToken.length > 0;
    let remoteFiles: FileShaMap = {};
    let headTreeSha: string | undefined;
    let blobProvider: (repoPath: string) => Promise<Buffer>;

    if (useGit) {
      this.mirror.ensureRepo(cfg.branch);
      const branchExists = this.mirror.syncToRemote(cfg.owner, cfg.repo, cfg.branch, this.lastToken);
      if (!headSha && !branchExists) {
        // Branch missing: distinguish an empty repository from a wrong branch name.
        const branches = await client.listBranches(cfg.owner, cfg.repo);
        if (branches.length > 0) {
          throw new Error(
            `Branch '${cfg.branch}' not found in ${cfg.owner}/${cfg.repo}. Run "Agent Sessions Sync: Set Up / Change Repository" again.`
          );
        }
      }
      remoteFiles = this.filterRemoteFileMap(this.mirror.remoteFileMap());
      blobProvider = async (p) => this.mirror.readFile(p);
    } else if (headSha) {
      const { treeSha } = await client.getCommit(cfg.owner, cfg.repo, headSha);
      headTreeSha = treeSha;
      remoteFiles = await this.fetchRemoteFiles(client, cfg, treeSha);
      blobProvider = (p) => client.getBlob(cfg.owner, cfg.repo, remoteFiles[p]);
    } else {
      // Branch missing: distinguish an empty repository from a wrong branch name.
      const branches = await client.listBranches(cfg.owner, cfg.repo);
      if (branches.length > 0) {
        throw new Error(
          `Branch '${cfg.branch}' not found in ${cfg.owner}/${cfg.repo}. Run "Agent Sessions Sync: Set Up / Change Repository" again.`
        );
      }
      blobProvider = (p) => client.getBlob(cfg.owner, cfg.repo, remoteFiles[p]);
    }
    this.lastRemoteMap = remoteFiles;

    const forceLocal = this.forceLocalNext;
    this.forceLocalNext = false;
    if (forceLocal) {
      this.log.info('Forcing local state to take the lead over the repository.');
    }

    const plan = computeSyncPlan(local, remoteFiles, base.files, unitFn, this.resolutions, frozen, forceLocal);
    this.log.info(
      `Plan: ${plan.uploads.length} upload(s), ${plan.downloads.length} download(s), ` +
        `${plan.removeRemote.length} remote deletion(s), ${plan.removeLocal.length} local deletion(s), ` +
        `${plan.conflicts.length} conflict(s), ${plan.skipped.length} skipped unit(s)` +
        (useGit ? ' [git transport]' : ' [REST transport]')
    );
    if (plan.skipped.length > 0) {
      const shown = plan.skipped.slice(0, 5).join(', ');
      this.log.info(
        `Skipped (active or oversized): ${shown}${plan.skipped.length > 5 ? ` +${plan.skipped.length - 5} more` : ''}`
      );
    }

    if (!(await this.confirmLargeDeletions(plan, base.files, unitFn))) {
      this.log.warn('Sync cancelled: a large deletion was not confirmed.');
      this.setStatus({
        kind: 'error',
        message: 'Cancelled: a large deletion was not confirmed. Run Sync Now to retry.',
      });
      return true;
    }

    // 1) Apply remote → local changes.
    let removedUnits: RemovedUnit[] = [];
    this.applyingLocalChanges = true;
    try {
      await this.applyDownloads(client, cfg, agents, plan, remoteFiles, scan.files, blobProvider);
      removedUnits = await this.applyLocalRemovals(agents, plan, unitFn);
    } finally {
      this.applyingLocalChanges = false;
    }

    // 2) Apply local → remote changes as a single commit.
    let newHead = headSha;
    if (plan.uploads.length > 0 || plan.removeRemote.length > 0) {
      const message = buildCommitMessage(plan, base.files, unitFn);
      if (useGit) {
        // Stage the full change set in the mirror and push once.
        for (const p of plan.uploads) {
          try {
            const content = await this.readUploadContent(agents, p);
            if (content === undefined) {
              this.log.warn(`Skipping upload of ${p}: no local file (unresolvable workspace)`);
              delete plan.newBaseFiles[p];
              continue;
            }
            this.mirror.writeFile(p, content);
          } catch (e) {
            // Files can vanish between scan and upload (e.g. VS Code clears an editing
            // session's state.json after the agent finishes). Skip them — the next scan
            // sees the deletion and propagates it.
            this.log.warn(`Skipping upload of ${p}: ${e instanceof Error ? e.message : String(e)}`);
            delete plan.newBaseFiles[p];
          }
        }
        for (const p of plan.removeRemote) {
          this.mirror.deleteFile(p);
        }
        if (!headSha) {
          // Empty repository: seed a README so the branch starts with a meaningful root.
          this.mirror.writeFile('README.md', Buffer.from(repoReadmeContent(cfg)));
        }
        const commitSha = this.mirror.commit(message);
        try {
          this.mirror.push(cfg.owner, cfg.repo, cfg.branch, this.lastToken);
        } catch (e) {
          if (/rejected|non-fast-forward|fetch first/i.test(String(e))) {
            return false; // remote moved while we were pushing — re-run
          }
          throw e;
        }
        newHead = commitSha;
        this.log.info(`Pushed via git ${commitSha.slice(0, 8)}: ${message}`);
      } else {
        if (!newHead) {
          // Empty repository: create the initial commit (README), then re-run the pass on the new head.
          await this.initializeEmptyRepo(client, cfg);
          return false;
        }
        const blobShaByPath: Record<string, string> = {};
        await forEachLimit(plan.uploads, BLOB_CONCURRENCY, async (p) => {
          try {
            const content = await this.readUploadContent(agents, p);
            if (content === undefined) {
              this.log.warn(`Skipping upload of ${p}: no local file (unresolvable workspace)`);
              return;
            }
            blobShaByPath[p] = await client.createBlob(cfg.owner, cfg.repo, content);
          } catch (e) {
            // Files can vanish between scan and upload (e.g. VS Code clears an editing
            // session's state.json after the agent finishes). Skip them — the next scan
            // sees the deletion and propagates it.
            this.log.warn(`Skipping upload of ${p}: ${e instanceof Error ? e.message : String(e)}`);
            delete plan.newBaseFiles[p];
          }
        });
        const entries: TreeEntry[] = [
          ...plan.uploads
            .filter((p) => blobShaByPath[p] !== undefined)
            .map((p) => ({ path: p, mode: '100644', type: 'blob', sha: blobShaByPath[p] })),
          ...plan.removeRemote.map((p) => ({ path: p, mode: '100644', type: 'blob', sha: null })),
        ];
        const treeSha = await client.createTree(cfg.owner, cfg.repo, entries, headTreeSha);
        const commitSha = await client.createCommit(cfg.owner, cfg.repo, message, treeSha, [newHead]);
        try {
          await client.updateRef(cfg.owner, cfg.repo, cfg.branch, commitSha);
        } catch (e) {
          if (e instanceof GitHubError && (e.status === 422 || e.status === 409)) {
            return false; // non-fast-forward: another device pushed meanwhile
          }
          throw e;
        }
        newHead = commitSha;
        // The actual blob shas reported by GitHub become the BASE entries (file may have changed since scan).
        for (const [p, sha] of Object.entries(blobShaByPath)) {
          plan.newBaseFiles[p] = sha;
        }
        this.log.info(`Pushed commit ${commitSha.slice(0, 8)}: ${message}`);
      }
    }

    // 3) Persist the new BASE and surface the result.
    await this.stateStore.save({
      owner: cfg.owner,
      repo: cfg.repo,
      branch: cfg.branch,
      commitSha: newHead ?? null,
      files: plan.newBaseFiles,
    });

    const previouslyConflicted = new Set(this.conflicts.map((c) => c.unit));
    this.conflicts = plan.conflicts;
    this.resolutions.clear();
    this.finish(cfg);

    this.notifyRemovedUnits(removedUnits);
    const newConflicts = plan.conflicts.filter((c) => !previouslyConflicted.has(c.unit));
    if (newConflicts.length > 0) {
      this.notifyConflicts(newConflicts);
    }
    return true;
  }

  /** Ask before propagating an unusually large deletion (e.g. a wiped local sessions dir). */
  private async confirmLargeDeletions(plan: SyncPlan, baseFiles: FileShaMap, unitFn: UnitFn): Promise<boolean> {
    const baseUnits = countUnits(baseFiles, unitFn);
    const confirm = async (paths: string[], target: string, button: string): Promise<boolean> => {
      const units = new Set(paths.map(unitFn));
      if (units.size <= MASS_DELETE_MIN_UNITS || units.size <= baseUnits * MASS_DELETE_FRACTION) {
        return true;
      }
      const choice = await vscode.window.showWarningMessage(
        `Agent Sessions Sync: this sync would delete ${units.size} of ${baseUnits} synced session unit(s) ${target}. Continue?`,
        { modal: true },
        button
      );
      return choice === button;
    };
    return (
      (await confirm(plan.removeRemote, 'from the repository', 'Delete From Repository')) &&
      (await confirm(plan.removeLocal, 'from this machine', 'Delete Local Sessions'))
    );
  }

  private finish(cfg: RepoConfig): void {
    if (this.conflicts.length > 0) {
      const agents = this.getAgents();
      this.setStatus({ kind: 'conflict', units: this.conflicts.map((c) => describeUnit(agents, c.unit)) });
    } else {
      this.setStatus({ kind: 'synced', at: Date.now(), repo: `${cfg.owner}/${cfg.repo}` });
    }
  }

  private async fetchRemoteFiles(client: GitHubClient, cfg: RepoConfig, treeSha: string): Promise<FileShaMap> {
    const tree = await client.getTreeRecursive(cfg.owner, cfg.repo, treeSha);
    const repoDirs = this.repoDirs();
    const files: FileShaMap = {};
    for (const entry of tree) {
      if (entry.type !== 'blob') {
        continue;
      }
      if (!isValidRepoPath(repoDirs, entry.path)) {
        continue; // outside a known agent namespace (e.g. README.md) or unsafe path
      }
      if (entry.mode === '120000') {
        this.log.warn(`Skipping symlink in repository: ${entry.path}`);
        continue;
      }
      files[entry.path] = entry.sha;
    }
    return files;
  }

  /** Keep only agent-namespace files (mirror `git ls-tree` also lists README.md etc.). */
  private filterRemoteFileMap(map: FileShaMap): FileShaMap {
    const repoDirs = this.repoDirs();
    const files: FileShaMap = {};
    for (const [p, sha] of Object.entries(map)) {
      if (isValidRepoPath(repoDirs, p)) {
        files[p] = sha;
      }
    }
    return files;
  }

  private async applyDownloads(
    client: GitHubClient,
    cfg: RepoConfig,
    agents: readonly Agent[],
    plan: SyncPlan,
    remoteFiles: FileShaMap,
    localFiles: FileShaMap,
    blobProvider: (repoPath: string) => Promise<Buffer>
  ): Promise<void> {
    if (plan.downloads.length === 0) {
      return;
    }

    // Separate VS Code downloads from other agents
    const vscodePaths = plan.downloads.filter(p => p.startsWith('vscode/'));
    const otherPaths = plan.downloads.filter(p => !p.startsWith('vscode/'));

    // Handle VS Code sessions specially
    if (vscodePaths.length > 0) {
      await this.applyVscodeDownloads(client, cfg, agents, vscodePaths, remoteFiles, blobProvider);
    }

    // Handle other agents normally
    if (otherPaths.length > 0) {
      // Guard against case-collisions on case-insensitive file systems (Windows/macOS).
      const localByLower = new Map<string, string>();
      for (const p of Object.keys(localFiles)) {
        localByLower.set(p.toLowerCase(), p);
      }
      await forEachLimit(otherPaths, BLOB_CONCURRENCY, async (p) => {
        const localPath = repoPathToLocal(agents, p);
        if (!localPath) {
          this.log.warn(`Skipping unsafe or unknown repository path: ${p}`);
          delete plan.newBaseFiles[p];
          return;
        }
        const existing = localByLower.get(p.toLowerCase());
        if (existing && existing !== p) {
          this.log.warn(`Skipping '${p}': collides with local '${existing}' on a case-insensitive file system.`);
          delete plan.newBaseFiles[p];
          return;
        }
        try {
          const content = await blobProvider(p);
          await fs.mkdir(path.dirname(localPath), { recursive: true });
          await fs.writeFile(localPath, content);
          this.log.info(`Downloaded ${p}`);
        } catch (e) {
          this.log.warn(`Skipping download of ${p}: ${e instanceof Error ? e.message : String(e)}`);
          delete plan.newBaseFiles[p];
        }
      });
    }
  }

  private async applyVscodeDownloads(
    client: GitHubClient,
    cfg: RepoConfig,
    agents: readonly Agent[],
    vscodePaths: string[],
    remoteFiles: FileShaMap,
    blobProvider: (repoPath: string) => Promise<Buffer>
  ): Promise<void> {
    const vscodeAgent = agents.find((a) => a.repoDir === 'vscode');
    if (!vscodeAgent) {
      return;
    }
    const ctx: VscodeRestoreContext = {
      userDataPath: path.dirname(vscodeAgent.localPath),
      folderMap: vscodeAgent.folderMap,
      onRestoredToOpenWorkspace: (folderPath, count) => {
        this.log.warn(
          `Restored ${count} VS Code session(s) into the currently-open workspace (${folderPath}). ` +
            'They will appear after a full VS Code restart (quit completely, then reopen).'
        );
        void vscode.window.showWarningMessage(
          `Agent Sessions Sync restored ${count} VS Code session(s) into the open workspace "${folderPath}". ` +
            'Quit VS Code completely (not just reload) and reopen for them to appear in the chat history.',
          'OK'
        );
      },
    };
    await restoreVscodeSessions(
      ctx,
      vscodePaths,
      async (repoPath) => {
        const sha = remoteFiles[repoPath];
        if (!sha) {
          throw new Error(`No blob sha for ${repoPath}`);
        }
        return blobProvider(repoPath);
      },
      (msg) => this.log.info(msg)
    );
  }

  /** Resolve the local content to upload for a repo path, or undefined when unresolvable. */
  private async readUploadContent(agents: readonly Agent[], p: string): Promise<Buffer | undefined> {
    if (p.startsWith('vscode/')) {
      const vscodeAgent = SyncController.vscodeAgent(agents);
      const localPath = resolveVscodeLocalPath(vscodeAgent, p);
      if (localPath) {
        return fs.readFile(localPath);
      }
      return buildVscodeDerivedFile(vscodeAgent, p);
    }
    const localPath = repoPathToLocal(agents, p);
    return localPath ? fs.readFile(localPath) : undefined;
  }

  private async applyLocalRemovals(
    agents: readonly Agent[],
    plan: SyncPlan,
    unitFn: UnitFn
  ): Promise<RemovedUnit[]> {
    if (plan.removeLocal.length === 0) {
      return [];
    }

    // VS Code removals go through the dedicated handler (deletes files AND drops
    // the SQLite index entries so the sessions stop being listed).
    const vscodePaths = plan.removeLocal.filter((p) => p.startsWith('vscode/'));
    const otherPaths = plan.removeLocal.filter((p) => !p.startsWith('vscode/'));
    if (vscodePaths.length > 0) {
      const vscodeAgent = agents.find((a) => a.repoDir === 'vscode');
      if (vscodeAgent) {
        const ctx: VscodeRestoreContext = {
          userDataPath: path.dirname(vscodeAgent.localPath),
          folderMap: vscodeAgent.folderMap,
        };
        await removeVscodeSessions(ctx, vscodePaths, (m) => this.log.info(m));
      }
    }

    if (otherPaths.length === 0) {
      return [];
    }

    const byUnit = new Map<string, string[]>();
    for (const p of otherPaths) {
      const unit = unitFn(p);
      const list = byUnit.get(unit) ?? [];
      list.push(p);
      byUnit.set(unit, list);
    }
    const removed: RemovedUnit[] = [];
    const affectedAgents = new Set<Agent>();
    for (const [unit, paths] of byUnit) {
      const agent = this.agentFor(unit);
      const backupPath = agent ? await this.trash.backup(this.trashFilesFor(agents, paths), unit) : undefined;
      for (const p of paths) {
        const localPath = repoPathToLocal(agents, p);
        if (localPath) {
          await fs.rm(localPath, { force: true });
          this.log.info(`Removed local ${p} (deleted on another device)`);
        }
      }
      if (agent) {
        affectedAgents.add(agent);
        removed.push({ unit, label: describeUnit(agents, unit), agentRoot: agent.localPath, backupPath });
      }
    }
    for (const agent of affectedAgents) {
      await pruneEmptyDirs(agent.localPath, true);
    }
    return removed;
  }

  private notifyRemovedUnits(removed: RemovedUnit[]): void {
    for (const item of removed) {
      if (!item.backupPath) {
        continue;
      }
      void vscode.window
        .showInformationMessage(
          `Session data '${item.label}' was removed (deleted on another device). A local backup was kept.`,
          'Undo'
        )
        .then(async (choice) => {
          if (choice === 'Undo') {
            try {
              await this.trash.restore(item.backupPath!, item.agentRoot);
              this.requestSync('undo-removal');
            } catch (e) {
              void vscode.window.showErrorMessage(`Failed to restore '${item.label}': ${String(e)}`);
            }
          }
        });
    }
  }

  private notifyConflicts(conflicts: UnitConflict[]): void {
    const agents = this.getAgents();
    const names = conflicts.map((c) => describeUnit(agents, c.unit)).join(', ');
    void vscode.window
      .showWarningMessage(`Session conflict detected: ${names}`, 'Resolve Conflicts')
      .then((choice) => {
        if (choice === 'Resolve Conflicts') {
          void vscode.commands.executeCommand('agentSessionsSync.resolveConflicts');
        }
      });
  }

  private async initializeEmptyRepo(client: GitHubClient, cfg: RepoConfig): Promise<void> {
    this.log.info(`Initializing empty repository ${cfg.owner}/${cfg.repo}…`);
    const commitSha = await client.createFileViaContents(
      cfg.owner,
      cfg.repo,
      'README.md',
      Buffer.from(repoReadmeContent(cfg), 'utf8'),
      'Initialize Agent Sessions Sync'
    );
    const repo = await client.getRepo(cfg.owner, cfg.repo);
    if (repo.default_branch !== cfg.branch) {
      await client.createRef(cfg.owner, cfg.repo, cfg.branch, commitSha);
    }
  }
}

/** Remove empty directories below `dir`; with `keepRoot`, `dir` itself is preserved. */
async function pruneEmptyDirs(dir: string, keepRoot = false): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await pruneEmptyDirs(path.join(dir, entry.name), false);
    }
  }
  if (keepRoot) {
    return;
  }
  try {
    const remaining = await fs.readdir(dir);
    if (remaining.length === 0) {
      await fs.rmdir(dir);
    }
  } catch {
    // ignore — non-empty or already gone
  }
}

function buildCommitMessage(plan: SyncPlan, baseFiles: FileShaMap, unitFn: UnitFn): string {
  const baseUnits = new Set(Object.keys(baseFiles).map(unitFn));
  const uploadUnits = new Set(plan.uploads.map(unitFn));
  const removeUnits = new Set(plan.removeRemote.map(unitFn));

  const added = [...uploadUnits].filter((s) => !baseUnits.has(s)).sort();
  const updated = [...uploadUnits].filter((s) => baseUnits.has(s)).sort();
  const removed = [...removeUnits].filter((s) => !uploadUnits.has(s)).sort();

  const fmt = (units: string[]): string => {
    const shown = units.slice(0, 8).join(', ');
    return units.length > 8 ? `${shown} +${units.length - 8} more` : shown;
  };
  const parts: string[] = [];
  if (added.length > 0) {
    parts.push(`add ${fmt(added)}`);
  }
  if (updated.length > 0) {
    parts.push(`update ${fmt(updated)}`);
  }
  if (removed.length > 0) {
    parts.push(`remove ${fmt(removed)}`);
  }
  return `Sync from ${os.hostname()}: ${parts.join('; ') || 'update sessions'}`;
}
