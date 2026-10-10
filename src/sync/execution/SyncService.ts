import type { ActivityStage, ActivitySnapshot } from '../../product/SyncActivity';
import { assertActive, PreviewError, readWithTimeout, safeError } from '../../errors';
import { GitHubWriter, MAX_SYNC_FILE_BYTES, type PublishEvent } from '../../github/GitHubWriter';
import { RemoteManifestReader, MAX_MANIFEST_BYTES } from '../../github/RemoteManifestReader';
import { RemoteTreeReader } from '../../github/RemoteTreeReader';
import type { GitTransport } from '../../github/types';
import { gitBlobSha } from '../../vault/HashService';
import { IgnoreService } from '../../vault/IgnoreService';
import { VaultScanner, type Progress } from '../../vault/VaultScanner';
import { STANDARD_CONFIG_DIRECTORY } from '../../vault/paths';
import { MANIFEST_PATH } from '../manifest/ManifestSchema';
import type { SyncManifest } from '../manifest/ManifestSchema';
import { parseManifest } from '../manifest/ManifestValidator';
import { PreviewSnapshotReader } from '../PreviewSnapshotReader';
import type { PreviewOptions } from '../PreviewService';
import type { StatefulPreviewResult } from '../StatefulPreviewService';
import { LocalStateStore, parseLocalState } from '../state/LocalStateStore';
import type { LocalSyncState } from '../state/LocalSyncState';
import { compileExecution, type Capture, type ExecutionPlan, type Resolution, type SyncMode } from './ExecutionPlan';
import { TransactionStore, recoveryError, recoveryEnvironmentChanged, sameTransactionTarget as sameTarget, type SyncTransaction } from './TransactionStore';
import type { SyncVault } from './SyncVault';
import type { SyncDecision } from '../planner/SyncDecision';
import { DEVICE_REPORT_ROOT, type SyncObserver } from '../../product/ProductStore';
import type { Settings } from '../../settings/settings';
import { isLegacyPublished, legacyTransactionChanged, recoverLegacyPublished } from './LegacyPublishedRecovery';
import { validateManifestHistory, validateManifestTree } from '../manifest/ManifestConsistency';
import { manifestCommitParents } from '../manifest/RemoteManifestAudit';
import { transactionIgnore, verifyLocal } from './LocalVerification';
import { cleanupEmptyFolders } from './EmptyFolderCleanup';
import { SyncPerformance } from '../../product/SyncPerformance';
import type { LocalChangeIndex } from '../../vault/LocalChangeIndex';
import { RemoteMetadataCache } from '../../github/RemoteMetadataCache';
import { changedVerificationPaths, recoveryHashes } from './VerificationScope';

export interface SyncPreview extends StatefulPreviewResult { mode: SyncMode; adoptionChoice?: Resolution; canExecute: boolean; deletions: number; requiresDeleteConfirmation: boolean; scopeKey: string }
interface Session { previewSteps: ActivitySnapshot['steps']; capture: Capture; execution: ExecutionPlan; options: PreviewOptions; manifest: SyncManifest | null; resolutions: Record<string, Resolution>; stateKey: string }
const fail = (code: string, message: string) => new PreviewError('SYNC', code, message);
const equalMap = (a: Record<string, string>, b: Record<string, string>) => Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([p, s]) => b[p] === s);

export class SyncService {
  readonly performance = new SyncPerformance();
  private readonly remoteCache = new RemoteMetadataCache(this.performance);
  performanceSnapshot() { return this.performance.snapshot(); }
  private busy: false | 'preview' | 'sync' = false;
  private stopped = false;
  private readonly sessions = new WeakMap<SyncPreview, Session>();
  readonly transactions: TransactionStore;
  constructor(private readonly vault: SyncVault, private readonly transport: GitTransport, private readonly configDir: string, private readonly state: LocalStateStore, private readonly observer?: SyncObserver, private readonly index?: LocalChangeIndex) {
    this.vault = this.performance.vault(vault);
    this.transport = this.performance.transport(transport);
    this.transactions = new TransactionStore(this.vault, this.performance);
    this.index?.measureWith(this.performance);
  }
  get running() { return !!this.busy; }
  get executing() { return this.busy === 'sync'; }
  invalidateIndex(reason: string) { this.index?.invalidate(reason); this.remoteCache.clear(); }
  stop() { this.stopped = true; }
  private active() { if (this.stopped) throw fail('PLUGIN_UNLOADED', 'Plugin unloaded. Resume the journal after reopening Obsidian.'); }
  async preview(options: PreviewOptions, token: string, progress: Progress = () => {}, signal?: AbortSignal,
    resolutions: Record<string, Resolution> = {}, fullIntegrity = false): Promise<SyncPreview> {
    return this.lock(async () => {
      const previewSteps: ActivitySnapshot['steps'] = [];
      const stage = (stage: ActivityStage, processed?: number, total?: number) => {
        if (previewSteps.at(-1)?.stage !== stage) previewSteps.push({ stage, at: Date.now() });
        this.stage(stage, processed, total);
      };
      const revision = this.observer?.revision ?? 0;
      progress('Checking pending recovery');
      if (await readWithTimeout(() => this.transactions.active(), 'RECOVERY', signal,
        'Pending recovery could not be read within 30 seconds. Check local storage and retry Preview. Recovery files are retained.')) throw recoveryError();
      const state = parseLocalState(this.state.current());
      await this.index?.validateStorage();
      if (state.baseManifest && (!state.target || !sameTarget(state.target, options))) throw fail('TARGET_MISMATCH', 'This device BASE belongs to another repository or branch. Use a separate Vault.');
      const capture = await new PreviewSnapshotReader(this.vault, this.transport, this.configDir, this.performance, this.index, this.index ? this.remoteCache : undefined, fullIntegrity)
        .read(options, token, progress, signal, stage);
      const manifest = await new RemoteManifestReader(capture.client, this.performance, this.index ? this.remoteCache : undefined).read(capture.remote, signal);
      await capture.verify();
      if (JSON.stringify(this.state.current()) !== JSON.stringify(state)) throw fail('STATE_CHANGED', 'Device metadata changed. Refresh Preview.');
      const scopeKey = JSON.stringify({ configDir: this.configDir, includeObsidian: options.includeObsidian, patterns: options.ignorePatterns, gitignore: capture.gitignore });
      stage('Build plan');
      const execution = compileExecution(capture, state, manifest, scopeKey, resolutions);
      if (execution.mode !== 'BLOCKED' && this.index) this.remoteCache.remember(capture.remote, manifest);
      const result = this.result({ previewSteps, capture, execution, manifest, options: { ...options }, resolutions, stateKey: JSON.stringify(state) });
      await this.observer?.preview(result, capture, revision, options);
      if (result.mode === 'SYNC' && result.canExecute && !result.plan.entries.some(entry => /^(PUSH|PULL)_/.test(entry.category))) {
        this.performance.verification(capture.local.verification === 'incremental' ? 'Incremental Verified' : 'Full Integrity Verified');
      }
      return result;
    }, 'preview');
  }
  /** Review the private captured plan, never caller-mutated UI fields. */
  autoBlock(preview: SyncPreview, settings: Pick<Settings, 'autoSyncDeleteThreshold' | 'autoSyncChangeThreshold'>): string | undefined {
    const session = this.session(preview); const trusted = this.result(session);
    if (JSON.stringify(this.state.current()) !== session.stateKey) return 'BASE or device metadata changed after Preview.';
    if (!trusted.state.baseManifest || trusted.mode !== 'SYNC') return `${trusted.mode}: initialization, adoption or scope review requires manual confirmation.`;
    if (!trusted.canExecute || trusted.plan.hasConflicts || Object.keys(session.resolutions).length) return 'Conflicts require manual confirmation.';
    if (JSON.stringify(session.manifest) !== JSON.stringify(trusted.state.baseManifest)) return 'Remote Manifest changed since BASE. Review the plan manually.';
    if (!Number.isSafeInteger(settings.autoSyncDeleteThreshold) || settings.autoSyncDeleteThreshold < 0
      || !Number.isSafeInteger(settings.autoSyncChangeThreshold) || settings.autoSyncChangeThreshold < 1) return 'Invalid automatic safety thresholds.';
    if (trusted.deletions > settings.autoSyncDeleteThreshold || trusted.requiresDeleteConfirmation) return 'Delete threshold requires manual confirmation.';
    if (trusted.plan.entries.filter(e => /^(PUSH|PULL)_/.test(e.category)).length > settings.autoSyncChangeThreshold) return 'Changed file threshold requires manual confirmation.';
    if (trusted.plan.entries.some(e => /^(PUSH|PULL)_/.test(e.category) && [e.path, e.oldPath].some(p => p && (p === '.gitignore' || p.startsWith(`${this.configDir}/`) || p.startsWith(`${STANDARD_CONFIG_DIRECTORY}/`))))) return 'Configuration changes require manual confirmation.';
    return undefined;
  }
  resolve(preview: SyncPreview, key: string, resolution: Resolution): SyncPreview {
    const old = this.session(preview);
    return this.resolveChoices(old, { [key]: resolution });
  }
  resolveAll(preview: SyncPreview, resolution: Resolution): SyncPreview {
    const old = this.session(preview);
    const choices = Object.fromEntries(old.execution.plan.entries.filter(entry => entry.category.startsWith('CONFLICT_'))
      .map(entry => [entry.fileId ?? entry.path, resolution]));
    return this.resolveChoices(old, choices);
  }
  private resolveChoices(old: Session, choices: Record<string, Resolution>): SyncPreview {
    if (old.execution.mode === 'ADOPT') throw fail('ADOPTION_CHOICE_REQUIRED', 'Choose Use Local or Use Remote for legacy adoption.');
    if (old.execution.mode === 'BLOCKED') throw fail('BLOCKED', 'Repair the repository diagnostic before choosing file versions.');
    if (Object.values(choices).some(choice => choice !== 'local' && choice !== 'remote')) throw fail('INVALID_RESOLUTION', 'Choose Local or Remote.');
    const resolutions = { ...old.resolutions, ...choices };
    const identities = Object.fromEntries(Object.values(old.execution.manifest.files).filter(f => !f.deleted).map(f => [f.path, f.fileId]));
    const execution = compileExecution(old.capture, parseLocalState(JSON.parse(old.stateKey)), old.manifest, old.execution.scopeKey, resolutions, identities);
    return this.result({ ...old, execution, resolutions });
  }
  selectAdoption(preview: SyncPreview, choice: Resolution): SyncPreview {
    const old = this.session(preview);
    const identities = Object.fromEntries(Object.values(old.execution.manifest.files).filter(f => !f.deleted).map(f => [f.path, f.fileId]));
    const execution = compileExecution(old.capture, parseLocalState(JSON.parse(old.stateKey)), old.manifest, old.execution.scopeKey, {}, identities, choice);
    return this.result({ ...old, execution, resolutions: {} });
  }
  async inspect(preview: SyncPreview, entry: SyncDecision, token: string): Promise<string> {
    const { capture, options, manifest } = this.session(preview);
    await capture.verify();
    const legacy = !manifest ? capture.remote.entries.find(f => f.path === entry.path && f.type === 'blob') : undefined;
    const remote = (entry.fileId ? manifest?.files[entry.fileId] : Object.values(manifest?.files ?? {}).find(file => !file.deleted && file.path === entry.path))
      ?? (legacy ? { path: legacy.path, blobSha: legacy.sha, deleted: false } : undefined);
    const render = (bytes: Uint8Array) => {
      try { const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes); return value.includes('\0') ? '[Binary content; compare SHA above]' : value.slice(0, 32768) + (value.length > 32768 ? '\n[Truncated at 32K characters]' : ''); }
      catch { return '[Binary content; compare SHA above]'; }
    };
    const local = capture.local.files.find(f => f.path === entry.path && f.sha === entry.localSha)
      ?? capture.local.files.find(f => f.sha === entry.localSha);
    const l = local ? render(new Uint8Array(await this.vault.readBinary(local.path))) : '[Deleted or identity uncertain]';
    const r = remote && !remote.deleted ? render(await new GitHubWriter(options, token, this.transport, this.performance).download(remote.blobSha!)) : '[Deleted or not present]';
    return `LOCAL · ${local?.path ?? entry.path}\n${l}\n\nREMOTE · ${remote?.path ?? entry.path}\n${r}`;
  }
  private result(session: Session): SyncPreview {
    const e = session.execution;
    const canExecute = e.mode !== 'BLOCKED' && !e.plan.hasConflicts && (e.mode !== 'ADOPT' || !!e.adoptionChoice);
    const deletions = canExecute ? Object.keys(e.before).filter(p => !e.after[p]).length + session.capture.remote.entries.filter(f => f.type === 'blob' && !session.capture.ignore.reason(f.path)
      && !Object.values(e.manifest.files).some(m => !m.deleted && m.path === f.path)).length : 0;
    const result: SyncPreview = { state: parseLocalState(JSON.parse(session.stateKey)), plan: structuredClone(e.plan), mode: e.mode, adoptionChoice: e.adoptionChoice,
      canExecute, deletions,
      requiresDeleteConfirmation: e.mode !== 'ADOPT' && deletions > session.options.deleteSafetyThreshold, scopeKey: e.scopeKey };
    this.sessions.set(result, session); return result;
  }
  private session(preview: SyncPreview) { const value = this.sessions.get(preview); if (!value) throw fail('STALE_PREVIEW', 'Refresh Preview before syncing.'); return value; }
  async execute(preview: SyncPreview, token: string, progress: Progress = () => {}, signal?: AbortSignal, deleteConfirmation = ''): Promise<void> {
    return this.lock(async () => {
      const session = this.session(preview); const { execution: e, capture, options } = session;
      this.performance.stage('Revalidate');
      this.observer?.activity?.({ type: 'stage', stage: 'Revalidate', completedSteps: session.previewSteps, generation: e.manifest.generation });
      const trusted = this.result(session);
      if (!trusted.canExecute) throw fail('BLOCKED', 'Resolve every conflict before Sync. No automatic winner is selected.');
      if (e.adoptionChoice && deleteConfirmation !== `USE ${e.adoptionChoice.toUpperCase()}`) throw fail('ADOPTION_CONFIRMATION', `Type USE ${e.adoptionChoice.toUpperCase()} to confirm this legacy adoption.`);
      if (trusted.requiresDeleteConfirmation && deleteConfirmation !== `DELETE ${trusted.deletions}`) throw fail('DELETE_CONFIRMATION', `Type DELETE ${trusted.deletions} to approve this deletion count.`);
      if (await this.transactions.active()) throw recoveryError();
      if (JSON.stringify(this.state.current()) !== session.stateKey) throw fail('STATE_CHANGED', 'Metadata changed. Refresh Preview.');
      await capture.verify(); assertActive(signal);
      const github = new GitHubWriter(options, token, this.transport, this.performance);
      if (await github.head() !== capture.remote.remoteHeadSha) throw fail('REMOTE_HEAD_CHANGED', 'GitHub changed. Refresh Preview.');
      const id = crypto.randomUUID();
      const manifestBytes = new TextEncoder().encode(JSON.stringify(parseManifest(e.manifest)));
      if (manifestBytes.length > MAX_MANIFEST_BYTES) throw fail('MANIFEST_LIMIT', 'Manifest exceeds the supported 2 MiB limit.');
      for (const f of capture.local.files) if (e.before[f.path] && f.size > MAX_SYNC_FILE_BYTES) throw fail('FILE_TOO_LARGE', `Exclude files larger than ${MAX_SYNC_FILE_BYTES / 1024 / 1024} MiB before syncing.`);
      for (const f of capture.remote.entries) if (e.after[f.path] && (f.size ?? 0) > MAX_SYNC_FILE_BYTES) throw fail('FILE_TOO_LARGE', 'A remote file exceeds the 20 MiB mobile safety limit.');
      this.performance.stage('Stage recovery copies');
      this.observer?.activity?.({ type: 'stage', stage: 'Stage recovery copies', transactionId: id, generation: e.manifest.generation });
      progress('Staging verified content and recovery backups');
      const staged = new Set<string>();
      const incremental = !!this.index?.snapshot().trusted && capture.local.verification === 'incremental' && e.mode === 'SYNC';
      const retainedPaths = new Set(changedVerificationPaths({ before: e.before, after: e.after, originalState: trusted.state }));
      const baseMap = new Map(Object.values(trusted.state.baseManifest?.files ?? {}).filter(f => !f.deleted).map(f => [f.path, f.blobSha]));
      for (const f of capture.remote.entries) if (f.type === 'blob' && !capture.ignore.reason(f.path) && !e.excludedPaths.includes(f.path) && f.sha !== baseMap.get(f.path)) retainedPaths.add(f.path);
      // Full initialization/adoption keeps all copies. Incremental sync retains
      // both versions of every changed path; clean files are never overwritten.
      for (const [path, sha] of Object.entries(e.before)) {
        if (incremental && !retainedPaths.has(path)) continue;
        assertActive(signal); const bytes = new Uint8Array(await this.vault.readBinary(path));
        if (gitBlobSha(bytes, this.performance) !== sha) throw fail('LOCAL_CHANGED', 'Local bytes changed. Refresh Preview.');
        await this.transactions.putBlob(id, bytes); staged.add(sha);
      }
      const retained = new Set([...Object.entries(e.after).filter(([path]) => !incremental || retainedPaths.has(path)).map(([, sha]) => sha),
        ...capture.remote.entries.filter(f => f.type === 'blob' && !capture.ignore.reason(f.path) && !e.excludedPaths.includes(f.path) && (!incremental || retainedPaths.has(f.path))).map(f => f.sha)]);
      for (const sha of retained) {
        assertActive(signal); if (!staged.has(sha)) { await this.transactions.putBlob(id, await github.download(sha)); staged.add(sha); }
      }
      await capture.verify();
      if (JSON.stringify(this.state.current()) !== session.stateKey) throw fail('STATE_CHANGED', 'Metadata changed. Refresh Preview.');
      if (await github.head() !== capture.remote.remoteHeadSha) throw fail('REMOTE_HEAD_CHANGED', 'GitHub changed. Refresh Preview.');
      assertActive(signal);
      this.active();
      const t: SyncTransaction = { version: 1, id, createdAt: new Date().toISOString(), options, scopeKey: e.scopeKey, originalState: trusted.state, originalHead: capture.remote.remoteHeadSha,
        commit: capture.remote.remoteHeadSha, manifest: e.manifest, before: e.before, after: e.after, excludedPaths: e.excludedPaths, phase: 'prepared',
        ...(incremental ? { retainedHashes: [...new Set([...staged, ...retained])] } : {}),
        ...(e.adoptionChoice ? { adoptionChoice: e.adoptionChoice, backupRef: `refs/heads/local-mirror-sync-backup/${id}` } : {}) };
      if (this.observer) t.observation = this.observer.prepare(t, e.plan.entries);
      // Establish a durable journal before any GitHub mutation. No cancellation after this point;
      // close/reload is handled through explicit recovery, never an unjournaled partial write.
      await this.transactions.begin(t);
      if (t.backupRef) {
        this.stage('Backup remote');
        progress('Creating and verifying GitHub backup ref');
        await github.backup(t.backupRef, t.originalHead);
        await capture.verify();
        if (await github.head() !== t.originalHead) throw fail('REMOTE_HEAD_CHANGED', 'GitHub changed. Refresh Preview.');
      }
      const changed = !session.manifest || JSON.stringify(e.manifest) !== JSON.stringify(session.manifest);
      if (changed) {
        progress('Creating atomic GitHub tree and manifest commit');
        const tree: { path: string; mode: string; type: 'blob'; sha: string | null }[] = [];
        const remoteMap = new Map(capture.remote.entries.filter(f => f.type === 'blob').map(f => [f.path, f]));
        const total = Object.entries(e.after).filter(([path, sha]) => remoteMap.get(path)?.sha !== sha).length;
        let processed = 0; this.stage('Upload blobs', processed, total);
        for (const [path, sha] of Object.entries(e.after)) if (remoteMap.get(path)?.sha !== sha) {
          await github.upload(await this.transactions.blob(id, sha));
          this.stage('Upload blobs', ++processed, total);
          tree.push({ path, mode: remoteMap.get(path)?.mode ?? '100644', type: 'blob', sha });
        }
        for (const f of capture.remote.entries) if (f.type === 'blob' && !capture.ignore.reason(f.path) && !e.excludedPaths.includes(f.path)
          && !Object.values(e.manifest.files).some(m => !m.deleted && m.path === f.path)) tree.push({ path: f.path, mode: f.mode, type: 'blob', sha: null });
        const manifestSha = await github.upload(manifestBytes);
        this.active();
        tree.push({ path: MANIFEST_PATH, mode: '100644', type: 'blob', sha: manifestSha });
        // Advisory device publication shares this existing atomic commit. It is
        // outside Manifest.files and never drives identity, conflicts or BASE.
        if (t.observation) {
          const reportSha = await github.upload(new TextEncoder().encode(JSON.stringify(t.observation.device)));
          tree.push({ path: `${DEVICE_REPORT_ROOT}${t.originalState.deviceId}.json`, mode: '100644', type: 'blob', sha: reportSha });
        }
        this.stage('Create tree');
        const treeSha = await github.create('trees', { base_tree: capture.remote.treeSha, tree });
        this.stage('Create commit');
        t.commit = await github.create('commits', { tree: treeSha, parents: [t.originalHead], message: `Stateful Git Sync generation ${t.manifest.generation} · ${preview.state.deviceId}` });
        t.publication = { treeSha, events: [{ kind: 'commit-created', at: new Date().toISOString(), commit: t.commit }] };
        this.active();
        await this.transactions.save(t);
        await capture.verify();
        this.active();
        this.stage('Check candidate');
        await this.verifyRemoteCandidate(t, github);
        this.stage('Publish');
        await github.publish(t.commit, t.originalHead, event => this.recordPublication(t, event));
      } else {
        // Pull/attach/no-op has no candidate to publish; confirm the existing ref.
        if (await github.head() !== t.commit) throw fail('REMOTE_HEAD_CHANGED', 'GitHub changed before verification.');
      }
      this.active();
      t.phase = 'published'; await this.transactions.save(t);
      await this.completeTransaction(t, github, e.scopeKey, progress, false, capture.local.verification !== 'incremental' || e.mode !== 'SYNC');
      this.sessions.delete(preview);
    });
  }
  async resume(options: PreviewOptions, token: string, progress: Progress = () => {}, reviewed?: SyncTransaction): Promise<void> {
    return this.lock(async () => {
      this.invalidateIndex('recovery');
      const t = await this.transactions.active(); if (!t) throw fail('NO_TRANSACTION', 'No pending sync transaction.');
      this.observer?.activity?.({ type: 'stage', stage: 'Revalidate', transactionId: t.id, generation: t.manifest.generation });
      if (reviewed && JSON.stringify(reviewed) !== JSON.stringify(t)) throw isLegacyPublished(reviewed) ? legacyTransactionChanged() : recoveryEnvironmentChanged('The pending transaction changed since this dialog was opened. Reopen Recovery to review the current transaction.');
      if (isLegacyPublished(t)) return recoverLegacyPublished(t, options, token, this.vault, this.transport, this.configDir,
        this.state, this.transactions, progress, () => this.active(), this.observer, 'resume', { measurement: this.performance, index: this.index });
      if (!sameTarget(options, t.options)) throw recoveryEnvironmentChanged(`Current repository/branch differs from the transaction. Restore ${t.options.owner}/${t.options.repository} (${t.options.branch}) in settings.`);
      if (this.state.current().deviceId !== t.originalState.deviceId) throw recoveryEnvironmentChanged('This transaction belongs to another device identity. Resume it on the original device/Vault. Preserve device metadata and recovery files.');
      const github = new GitHubWriter(t.options, token, this.transport, this.performance);
      progress('Revalidating remote HEAD, backup ref and transaction phase…');
      const head = await github.head();
      if (t.backupRef) {
        try { await github.verifyBackup(t.backupRef, t.originalHead); }
        catch (error) { throw recoveryEnvironmentChanged(`Cannot verify backup ${t.backupRef} at original HEAD ${t.originalHead} (${error instanceof PreviewError ? error.code : 'unavailable'}). Check repository access, network and the retained backup.`); }
      }
      // A confirmed publication without local writes can finish its pinned BASE
      // after main advances. Unconfirmed adoption and local writes keep exact HEAD.
      const requiresExactHead = !!t.adoptionChoice && (t.phase === 'prepared' || !equalMap(t.before, t.after));
      if (t.commit === t.originalHead && t.phase === 'prepared') {
        if (head !== t.originalHead) throw recoveryEnvironmentChanged(`The unpublished transaction requires original HEAD ${t.originalHead}; current HEAD is ${head}.`);
      } else if (t.commit !== t.originalHead && head === t.originalHead) {
        if (t.phase !== 'prepared') throw recoveryEnvironmentChanged(`The transaction is ${t.phase}, but the branch is back at original HEAD ${head}. The published commit must remain on this branch.`);
      } else if (requiresExactHead ? head !== t.commit : !await github.contains(t.commit, head)) {
        throw recoveryEnvironmentChanged(requiresExactHead
          ? `${t.phase === 'prepared' ? 'Adoption publication is not yet confirmed' : 'Adoption still has local writes'} and requires exact HEAD ${t.commit}; current HEAD is ${head}.`
          : `Current HEAD ${head} does not descend from transaction commit ${t.commit}. Remote history diverged.`);
      }
      await this.revalidateTransaction(t);
      if (t.commit !== t.originalHead && head === t.originalHead) {
        if (t.adoptionChoice) { await this.verifyAdoptionLocal(t, false); await github.verifyBackup(t.backupRef!, t.originalHead); }
        await this.revalidateTransaction(t);
        this.stage('Check candidate');
        await this.verifyRemoteCandidate(t, github);
        this.stage('Publish');
        await github.publish(t.commit, t.originalHead, event => this.recordPublication(t, event));
      } else if (t.phase === 'prepared' && head === t.commit) {
        await this.recordPublication(t, { kind: 'recovery-head', at: new Date().toISOString(), head });
      }
      if (t.commit === t.originalHead && t.phase === 'prepared') {
        // Failure while constructing objects: no branch publication or local apply occurred.
        // Re-preview creates a fresh commit; immutable unreachable objects are harmless.
        await this.transactions.clear(); return;
      }
      if (t.phase === 'prepared' && (head === t.commit || head === t.originalHead)) {
        this.active();
        // Either publish() just confirmed PATCH + read-back, or Recovery read
        // the exact candidate at HEAD after an interrupted/lost PATCH response.
        t.phase = 'published'; await this.transactions.save(t);
      }
      // Preserve existing pinned-ancestor Recovery: it must pass the full
      // verifier, but ancestry alone does not create a published checkpoint.
      await this.completeTransaction(t, github, t.scopeKey, progress, true);
    }).catch(error => {
      if (error instanceof PreviewError && error.code === 'LOCAL_CHANGED') throw new PreviewError('RECOVERY', 'RECOVERY_LOCAL_CHANGED',
        `Recovery stopped to preserve current Local files.\n${error.message}\nChoose Start fresh Preview from current HEAD to verify this transaction, keep current files and BASE, and review the differences before syncing.`);
      if (error instanceof PreviewError && ['REMOTE_HEAD_CHANGED', 'REMOTE_DIVERGED', 'BACKUP_VERIFY_FAILED', 'INVALID_BACKUP_REF'].includes(error.code)) throw recoveryEnvironmentChanged(`Recovery verification stopped (${error.code}). Review the branch history and retained backup. ${error.message}`);
      if (error instanceof PreviewError && (error.code === 'NETWORK_ERROR' || /^HTTP_\d{3}$/.test(error.code))) {
        throw new PreviewError(error.stage, error.code, 'GitHub could not be verified. Check the connection, token permissions and GitHub rate limits, then retry Resume Transaction. Recovery data is retained. Preview stays blocked until recovery completes or a safe Abort succeeds.');
      }
      throw error;
    });
  }
  /** Explicitly retain an interrupted transaction for audit after fresh proof.
   * The next preview uses the ordinary planner and the unchanged local BASE. */
  async startFreshPreviewFromCurrentHead(options: PreviewOptions, token: string, progress: Progress = () => {}, reviewed?: SyncTransaction): Promise<void> {
    return this.lock(async () => {
      const t = await this.transactions.active();
      if (!t) throw fail('LEGACY_FRESH_PREVIEW_UNAVAILABLE', 'No pending transaction can be reviewed for fresh Preview.');
      this.observer?.activity?.({ type: 'stage', stage: 'Revalidate', transactionId: t.id, generation: t.manifest.generation });
      if (reviewed && JSON.stringify(reviewed) !== JSON.stringify(t)) throw isLegacyPublished(t) ? legacyTransactionChanged() : recoveryEnvironmentChanged('The pending transaction changed since review. Reopen Recovery before starting fresh Preview.');
      if (isLegacyPublished(t)) await recoverLegacyPublished(t, options, token, this.vault, this.transport, this.configDir,
        this.state, this.transactions, progress, () => this.active(), this.observer, 'fresh-preview', { measurement: this.performance, index: this.index });
      else await this.replanPublishedLocalWrites(t, options, token, progress);
    });
  }
  private async replanPublishedLocalWrites(t: SyncTransaction, options: PreviewOptions, token: string, progress: Progress): Promise<void> {
    if (t.phase === 'prepared' || equalMap(t.before, t.after)) throw fail('LEGACY_FRESH_PREVIEW_UNAVAILABLE', 'Fresh Preview requires a confirmed transaction with local writes. Use Resume or safe Abort for this transaction.');
    if (!sameTarget(options, t.options)) throw recoveryEnvironmentChanged('Current repository/branch differs from the transaction. Restore the transaction target in settings.');
    const previous = this.state.current(); const stateKey = JSON.stringify(previous);
    if (previous.deviceId !== t.originalState.deviceId || previous.target && !sameTarget(previous.target, t.options)) throw recoveryEnvironmentChanged('This transaction or BASE belongs to another device or repository.');
    const sameBase = (base: LocalSyncState) => previous.baseRemoteCommit === base.baseRemoteCommit
      && JSON.stringify(previous.baseManifest) === JSON.stringify(base.baseManifest) && previous.syncScope === base.syncScope;
    const completedBase = previous.baseRemoteCommit === t.commit && JSON.stringify(previous.baseManifest) === JSON.stringify(t.manifest) && previous.syncScope === t.scopeKey;
    if (!sameBase(t.originalState) && !completedBase) throw recoveryEnvironmentChanged('Current BASE differs from the original or verified transaction BASE. It cannot be replaced or discarded.');
    const rules = JSON.parse(t.scopeKey) as { configDir: string; gitignore: string };
    if (rules.configDir !== this.configDir || options.includeObsidian !== t.options.includeObsidian || options.ignorePatterns !== t.options.ignorePatterns) throw recoveryEnvironmentChanged('Configuration directory or ignore settings differ from the reviewed transaction scope.');
    const github = new GitHubWriter(t.options, token, this.transport, this.performance); const head = await github.head();
    if (!await github.contains(t.commit, head)) throw recoveryEnvironmentChanged('Current branch does not descend from the transaction commit. Remote history must be corrected before fresh Preview.');
    const verifyContext = async () => {
      await this.revalidateTransaction(t);
      if (JSON.stringify(this.state.current()) !== stateKey) throw recoveryEnvironmentChanged('Device metadata changed during recovery review. Reopen Recovery.');
      if (await github.head() !== head) throw recoveryEnvironmentChanged('Remote HEAD changed during recovery review. Reopen Recovery to review the new HEAD.');
      if (t.backupRef) await github.verifyBackup(t.backupRef, t.originalHead);
    };
    progress('Verifying published transaction and retained recovery copies…'); await verifyContext();
    await this.verifyRemoteCandidate(t, github);
    const reviewedIgnore = transactionIgnore(t);
    const eligible = (path: string) => !reviewedIgnore.reason(path) && !t.excludedPaths.includes(path);
    if (!equalMap(t.after, Object.fromEntries(Object.values(t.manifest.files).filter(f => !f.deleted && eligible(f.path)).map(f => [f.path, f.blobSha!])))) throw recoveryError();
    for (const sha of recoveryHashes(t)) await this.transactions.blob(t.id, sha);
    const capture = await new PreviewSnapshotReader(this.vault, this.transport, this.configDir, this.performance).read(t.options, token, progress, undefined, (stage, processed, total) => this.stage(stage, processed, total));
    if (capture.remote.remoteHeadSha !== head) throw recoveryEnvironmentChanged('Remote HEAD changed while reading the current snapshot. Retry recovery review.');
    const ruleSha = capture.local.files.find(f => f.path === '.gitignore')?.sha;
    if (capture.gitignore !== rules.gitignore && (!('.gitignore' in t.before || '.gitignore' in t.after) || ruleSha !== t.after['.gitignore'])) throw recoveryEnvironmentChanged('Local .gitignore differs from both the reviewed and transaction rules. Restore the reviewed scope before recovery.');
    const manifest = await new RemoteManifestReader(capture.client, this.performance).read(capture.remote);
    if (!manifest) throw fail('REMOTE_MANIFEST_MISSING', 'Current HEAD has no Manifest. Recovery is retained.');
    validateManifestHistory(t.manifest, manifest); validateManifestHistory(previous.baseManifest ?? null, manifest);
    validateManifestTree(manifest, capture.remote.entries.filter(f => f.type !== 'tree' && !capture.ignore.reason(f.path)), path => !capture.ignore.reason(path));
    const local = Object.fromEntries(capture.local.files.map(f => [f.path, f.sha]));
    const differences = [...new Set([...Object.keys(t.after), ...Object.keys(local)])].sort().filter(path => t.after[path] !== local[path])
      .map(path => `${path}: expected ${t.after[path] ?? '(absent)'}, current ${local[path] ?? '(absent)'}`);
    progress('Retaining current Local bytes before starting a reviewed Preview…');
    for (const file of capture.local.files) {
      if (file.size > MAX_SYNC_FILE_BYTES) throw fail('FILE_TOO_LARGE', 'A current Local file exceeds the 20 MiB recovery limit. Recovery is retained.');
      const content = new Uint8Array(await this.vault.readBinary(file.path));
      if (gitBlobSha(content, this.performance) !== file.sha) throw recoveryEnvironmentChanged(`Local file changed during recovery review: ${file.path}. Retry after editing stops.`);
      await this.transactions.putBlob(t.id, content);
    }
    await capture.verify(); await verifyContext();
    await this.transactions.retainFreshPreview(t, { head, generation: manifest.generation, baseState: previous, local, differences });
    await capture.verify(); await verifyContext();
    // Keep original phase/journals and BASE. This is explicit replanning, never
    // Abort, successful verification, or authority to replay the old writes.
    await this.transactions.clear(); await this.observer?.recoveryCleared?.();
    progress('Recovery retained for audit. BASE and current files are unchanged. Review the fresh Preview before syncing.');
  }
  /** V1.1.1 user-facing Abort: only an unpublished transaction at unchanged HEAD. */
  async abortTransaction(options: PreviewOptions, token: string, reviewed?: SyncTransaction): Promise<void> {
    return this.lock(async () => {
      const t = await this.transactions.active(); if (!t) throw fail('NO_TRANSACTION', 'No pending sync transaction.');
      this.observer?.activity?.({ type: 'stage', stage: 'Revalidate', transactionId: t.id, generation: t.manifest.generation });
      if (reviewed && JSON.stringify(reviewed) !== JSON.stringify(t)) throw recoveryEnvironmentChanged('The pending transaction changed since review. Reopen Recovery before attempting Abort.');
      if (!sameTarget(options, t.options)) throw recoveryEnvironmentChanged(`Current repository/branch differs from the transaction. Restore ${t.options.owner}/${t.options.repository} (${t.options.branch}) in settings.`);
      if (t.phase !== 'prepared') throw fail('ALREADY_PUBLISHED', 'This transaction may already be published or applied. Resume Transaction to finish verification.');
      const github = new GitHubWriter(t.options, token, this.transport, this.performance);
      if (await github.head() !== t.originalHead) throw recoveryEnvironmentChanged('Abort requires the unchanged original branch HEAD. The branch advanced or this candidate may already be published; use Resume Transaction to verify it.');
      await this.revalidateTransaction(t);
      // Delete only the pending pointer. Journals, blobs, quarantine and backup ref
      // remain recovery evidence. Never load, repair or save BASE here.
      await this.transactions.removePending();
    });
  }
  private async revalidateTransaction(t: SyncTransaction): Promise<void> {
    this.active();
    if (JSON.stringify(await this.transactions.active()) !== JSON.stringify(t)) throw recoveryEnvironmentChanged('The pending transaction changed during verification. Reopen Recovery to review it.');
  }
  private async recordPublication(t: SyncTransaction, event: PublishEvent): Promise<void> {
    await this.revalidateTransaction(t);
    // Old journals remain readable. Evidence never decides whether to publish.
    if (!t.publication) return;
    t.publication.events.push(event);
    await this.transactions.save(t);
  }
  /** Legacy V1 API retained for existing callers; Recovery UI uses abortTransaction. */
  async discardUnpublished(options: PreviewOptions, token: string): Promise<void> {
    return this.lock(async () => {
      const t = await this.transactions.active(); if (!t) return;
      if (!sameTarget(options, t.options) || t.phase !== 'prepared') throw recoveryError();
      const github = new GitHubWriter(t.options, token, this.transport, this.performance);
      if (t.commit !== t.originalHead && await github.contains(t.commit, await github.head())) throw fail('ALREADY_PUBLISHED', 'The commit was published. Resume to finish verification.');
      await this.transactions.clear();
    });
  }
  /** Manual/Auto execute await the full pipeline; Resume enters it only after
   * interruption. A durable active pointer is a checkpoint, not a user action. */
  private async completeTransaction(t: SyncTransaction, github: GitHubWriter, scopeKey: string, progress: Progress, recovering = false, forceFull = true): Promise<void> {
    this.active();
    const stateKey = JSON.stringify(recovering ? this.state.current() : t.originalState);
    if (JSON.stringify(this.state.current()) !== stateKey) throw recoveryEnvironmentChanged();
    // Only recovery of a publication with no local apply can use the published
    // snapshot alone. Mixed/PULL transactions retain full local verification.
    const publishedBaseOnly = recovering && equalMap(t.before, t.after);
    const requiresExactHead = !!t.adoptionChoice && (t.phase === 'prepared' || !publishedBaseOnly);
    if (t.adoptionChoice) {
      if (requiresExactHead && await github.head() !== t.commit) throw fail('REMOTE_HEAD_CHANGED', 'GitHub changed during adoption. BASE has not advanced; review recovery before a new Preview.');
      await github.verifyBackup(t.backupRef!, t.originalHead);
      if (!publishedBaseOnly) await this.verifyAdoptionLocal(t, ['applying', 'verified', 'complete'].includes(t.phase));
      // Re-read every recovery blob before any overwrite/removal, including on resume.
      for (const sha of new Set(Object.values(t.before))) await this.transactions.blob(t.id, sha);
    }
    this.stage('Verify remote');
    if (!await github.contains(t.commit, await github.head())) throw fail('REMOTE_DIVERGED', 'The transaction commit is not on the remote branch. No local files were applied.');
    progress('Verifying immutable remote commit and manifest');
    const { pinned } = await this.verifyRemoteCandidate(t, github);
    const pinnedMap = new Map(pinned.entries.map(f => [f.path, f]));
    for (const [path, sha] of Object.entries(t.after)) if (pinnedMap.get(path)?.sha !== sha || !['100644', '100755'].includes(pinnedMap.get(path)!.mode)) throw fail('REMOTE_VERIFY_FAILED', 'Committed tree does not match expected files.');
    for (const path of Object.keys(t.before)) if (!t.after[path] && pinnedMap.has(path)) throw fail('REMOTE_VERIFY_FAILED', 'Remote deletion was not verified.');
    const ignore = transactionIgnore(t);
    const eligible = (path: string) => !ignore.reason(path) && !t.excludedPaths.includes(path);
    if (t.adoptionChoice && !equalMap(Object.fromEntries(pinned.entries.filter(f => f.type !== 'tree' && eligible(f.path)).map(f => [f.path, f.sha])), t.after)) {
      throw fail('REMOTE_VERIFY_FAILED', 'Committed eligible tree differs from the adoption plan. BASE has not advanced.');
    }
    if (t.adoptionChoice) { t.phase = 'applying'; await this.transactions.save(t); }
    this.stage('Apply local');
    progress('Applying local files with verified recovery copies');
    const paths = [...new Set([...Object.keys(t.before), ...Object.keys(t.after)])];
    for (const path of paths) {
      this.active();
      if (!eligible(path)) throw recoveryError();
      if (t.before[path] === t.after[path]) continue;
      const recovery = `${this.transactions.directory(t.id)}/quarantine/${gitBlobSha(new TextEncoder().encode(path), this.performance, true)}`;
      await this.vault.apply(path, t.after[path] ? await this.transactions.blob(t.id, t.after[path]) : null, t.before[path] ?? null, recovery);
    }
    progress('Removing verified old empty folders');
    await cleanupEmptyFolders(this.vault, this.transactions, t, ignore);
    progress(publishedBaseOnly ? 'Completing published BASE; subsequent Local changes remain for Preview' : 'Verifying local bytes before saving BASE');
    let localVerification: 'incremental' | 'full' = 'full';
    if (!publishedBaseOnly) {
      this.stage('Verify local');
      localVerification = await verifyLocal(this.vault, t, ignore, (processed, total) => this.stage('Verify local', processed, total), this.performance,
        this.index ? { index: this.index, scopeKey, forceFull: forceFull || recovering, forcePaths: changedVerificationPaths(t) } : undefined);
    }
    this.performance.verification(publishedBaseOnly ? 'Published Snapshot Verified' : localVerification === 'incremental' ? 'Incremental Verified' : 'Full Integrity Verified');
    const finalHead = await github.head();
    if (requiresExactHead ? finalHead !== t.commit : !await github.contains(t.commit, finalHead)) throw fail('REMOTE_DIVERGED', 'Remote history changed. BASE has not advanced.');
    await this.revalidateTransaction(t);
    if (JSON.stringify(this.state.current()) !== stateKey) throw recoveryEnvironmentChanged();
    // A completed/history checkpoint retains its original proof for idempotent
    // Recovery. Current Recovery evidence is separately reported in activity.
    t.verification ??= this.performance.snapshot().verification;
    t.phase = 'verified'; await this.transactions.save(t);
    this.active();
    const previous = this.state.current();
    if (JSON.stringify(previous) !== stateKey) throw recoveryEnvironmentChanged();
    if (previous.deviceId !== t.originalState.deviceId) throw recoveryError();
    const localFiles = this.completedLocalFiles(t, previous, eligible, publishedBaseOnly);
    this.stage('Save BASE');
    progress('Saving and reading back verified BASE');
    await this.state.save({ schemaVersion: 1, deviceId: previous.deviceId, target: { owner: t.options.owner, repository: t.options.repository, branch: t.options.branch },
      baseManifest: t.manifest, baseRemoteCommit: t.commit, lastSeenGeneration: t.manifest.generation,
      lastSuccessfulSyncAt: new Date().toISOString(), localFiles, syncScope: scopeKey });
    this.active();
    // History is success-only and durable before clearing recovery. On an
    // observability write failure, resume retries the same transaction record.
    await this.observer?.verified(t);
    this.active();
    this.stage('Finalize transaction');
    progress('Completing transaction');
    t.phase = 'complete'; await this.transactions.save(t);
    this.active();
    await this.transactions.clear();
    if (!publishedBaseOnly) this.index?.completed();
    this.stage('Complete');
    progress(`Verified · BASE generation ${t.manifest.generation}`);
  }
  private completedLocalFiles(t: SyncTransaction, current: LocalSyncState, eligible: (path: string) => boolean, preserveLaterChanges: boolean) {
    const files: NonNullable<LocalSyncState['localFiles']> = { ...t.manifest.files };
    // Excluded identities were not applied. Recorded later renames/deletes and
    // recreations belong to the next Preview, never to the published Manifest.
    for (const [id, entry] of Object.entries(t.originalState.localFiles ?? {})) {
      if (!eligible(entry.path)) files[id] = { ...files[id], ...entry };
    }
    if (preserveLaterChanges) for (const [id, entry] of Object.entries(current.localFiles ?? {})) {
      const original = t.originalState.localFiles?.[id] ?? t.originalState.baseManifest?.files[id];
      if (!original || entry.path !== original.path || entry.deleted !== original.deleted) files[id] = { ...files[id], ...entry };
    }
    return files;
  }
  private async verifyRemoteCandidate(t: SyncTransaction, github: GitHubWriter) {
    const cached = this.index ? this.remoteCache.get(t.commit) : undefined;
    if (cached?.parent !== t.originalHead && t.commit !== t.originalHead) await manifestCommitParents(github.reader, t.commit, t.originalHead);
    const pinned = cached?.snapshot ?? await new RemoteTreeReader(github.reader).readCommit(t.commit);
    const manifest = cached ? cached.manifest : await new RemoteManifestReader(github.reader, this.performance).read(pinned);
    if (!manifest || JSON.stringify(manifest) !== JSON.stringify(t.manifest)) throw fail('REMOTE_VERIFY_FAILED', 'Candidate Manifest differs from the transaction.');
    const ignore = transactionIgnore(t);
    const eligible = (path: string) => !ignore.reason(path) && !t.excludedPaths.includes(path);
    validateManifestTree(manifest, pinned.entries.filter(f => f.type !== 'tree' && eligible(f.path)), eligible);
    if (this.index) this.remoteCache.remember(pinned, manifest, t.commit !== t.originalHead ? t.originalHead : undefined);
    return { pinned, manifest };
  }
  private async verifyAdoptionLocal(t: SyncTransaction, allowApplied: boolean): Promise<void> {
    const rules = JSON.parse(t.scopeKey) as { gitignore: string };
    const stat = await this.vault.stat('.gitignore');
    const ruleBytes = stat ? await this.vault.readBinary('.gitignore') : undefined;
    const gitignore = ruleBytes ? new TextDecoder('utf-8', { fatal: true }).decode(ruleBytes) : '';
    const appliedRules = allowApplied && ('.gitignore' in t.before || '.gitignore' in t.after);
    if (gitignore !== rules.gitignore && !(appliedRules && (ruleBytes ? gitBlobSha(ruleBytes, this.performance) : undefined) === t.after['.gitignore'])) {
      throw fail('RECOVERY_SCOPE_CHANGED', 'Local .gitignore differs from the reviewed transaction rules. Preserve its current contents and restore the reviewed sync scope before resuming.');
    }
    // Continue the reviewed scope even if .gitignore itself was part of the apply.
    const ignore = new IgnoreService({ configDir: this.configDir, includeObsidian: t.options.includeObsidian, patterns: t.options.ignorePatterns, gitignore: rules.gitignore });
    const scan = await new VaultScanner(this.vault, this.performance).scan(ignore);
    const actual = Object.fromEntries(scan.files.filter(f => !t.excludedPaths.includes(f.path)).map(f => [f.path, f.sha]));
    const paths = new Set([...Object.keys(actual), ...Object.keys(t.before), ...Object.keys(t.after)]);
    const differences = [...paths].filter(path => actual[path] !== t.before[path] && (!allowApplied || actual[path] !== t.after[path]));
    if (differences.length) {
      throw fail('LOCAL_CHANGED', `Local files differ from the reviewed transaction (${differences.length}):\n${differences.slice(0, 20).map(path => `${path}: ${!actual[path] ? 'missing' : !t.before[path] && !t.after[path] ? 'added' : 'modified'}`).join('\n')}${differences.length > 20 ? '\nAdditional differences will be retained during fresh Preview review.' : ''}`);
    }
  }
  private stage(stage: ActivityStage, processed?: number, total?: number): void { this.performance.stage(stage); this.observer?.activity?.({ type: 'stage', stage, processed, total }); }
  private async lock<T>(run: () => Promise<T>, operation: 'preview' | 'sync' = 'sync'): Promise<T> {
    this.active();
    if (this.busy) throw fail('BUSY', 'A sync is already running.'); this.busy = operation;
    let error: string | undefined;
    this.performance.start();
    try { this.observer?.activity?.({ type: 'start', operation }); this.observer?.activityChanged?.(); return await run(); }
    catch (caught) { error = safeError(caught); throw caught; }
    finally { this.performance.end(error !== undefined); this.busy = false; this.observer?.activity?.({ type: 'end', error, performance: this.performance.snapshot(), pendingChanges: !!this.index?.snapshot().dirtyPaths.length }); this.observer?.activityChanged?.(); }
  }
}
