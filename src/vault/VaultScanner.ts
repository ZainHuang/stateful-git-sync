import { assertActive, PreviewError } from '../errors';
import { gitBlobSha, type HashMeasurement } from './HashService';
import { IgnoreService } from './IgnoreService';
import { assertPath, pathOrder } from './paths';
import type { LocalChangeIndex, IndexedFile } from './LocalChangeIndex';
import type { SyncPerformance } from '../product/SyncPerformance';

export interface FileStat { type: 'file' | 'folder'; size: number; mtime: number; ctime: number }
export interface VaultReader {
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  readBinary(path: string): Promise<ArrayBuffer>;
  stat(path: string): Promise<FileStat | null>;
}
export interface LocalFile { path: string; sha: string; size: number }
export interface IgnoredFile { path: string; reason: string }
export interface LocalSnapshot {
  files: LocalFile[];
  ignored: IgnoredFile[];
  protectedDirectories: string[];
  scannedAt: string;
  verification?: 'incremental' | 'full';
}
export type FileProgress = (processed: number, total: number) => void;
export type Progress = (message: string) => void;
export interface ScanCacheOptions { index: LocalChangeIndex; scopeKey: string; forceFull?: boolean; forcePaths?: readonly string[]; audit?: boolean; metadataCheck?: boolean }
export interface ScanIssue { path: string; actualSha: string | null; problem: 'unreadable' | 'changed-during-scan' | 'added-during-scan' | 'missing-during-scan' }
export class LocalScanError extends PreviewError {
  constructor(code: string, public readonly diagnostics: ScanIssue[], public readonly observedFiles?: LocalFile[]) {
    super('LOCAL_SCAN', code, `Vault could not be verified. No partial plan was created.\n${diagnostics.map(d => `${d.path} · ${d.problem} · actual SHA ${d.actualSha ?? '(unavailable)'}`).join('\n')}`);
  }
}

export class VaultScanner {
  constructor(private readonly reader: VaultReader, private readonly measurement?: HashMeasurement & Partial<Pick<SyncPerformance, 'reused' | 'reconcile'>>) {}

  private async inventory(ignore: IgnoreService, signal?: AbortSignal): Promise<{ paths: string[]; protectedDirectories: string[] }> {
    const paths: string[] = [];
    const protectedDirectories: string[] = [];
    const seen = new Set<string>();
    const queue = [''];
    for (let index = 0; index < queue.length; index++) {
      assertActive(signal);
      const parent = queue[index]!;
      let list: Awaited<ReturnType<VaultReader['list']>>;
      try { list = await this.reader.list(parent); }
      catch { throw new LocalScanError('READ_FAILED', [{ path: parent || '/', actualSha: null, problem: 'unreadable' }]); }
      for (const path of [...list.files, ...list.folders]) {
        assertPath(path);
        const slash = path.lastIndexOf('/');
        if ((slash < 0 ? '' : path.slice(0, slash)) !== parent || seen.has(path)) {
          throw new PreviewError('LOCAL_SCAN', 'INVALID_LISTING', 'Vault returned an inconsistent directory listing.');
        }
        seen.add(path);
      }
      paths.push(...list.files);
      for (const folder of list.folders) {
        // Do not enumerate .git, trash or secret state. Counts for these are directories, never guessed file counts.
        if (ignore.protectedReason(folder)) protectedDirectories.push(folder);
        else queue.push(folder);
      }
      if (seen.size > 250_000) throw new PreviewError('LOCAL_SCAN', 'SCAN_LIMIT', 'Vault exceeds the 250,000-entry scan limit. No plan was created.');
    }
    return { paths: paths.sort(pathOrder), protectedDirectories: protectedDirectories.sort(pathOrder) };
  }

  async scan(ignore: IgnoreService, progress: Progress = () => {}, signal?: AbortSignal, excludedPaths: readonly string[] = [], fileProgress?: FileProgress, cache?: ScanCacheOptions): Promise<LocalSnapshot> {
    try {
      const inventory = await this.inventory(ignore, signal);
      const files: LocalFile[] = [];
      const ignored: IgnoredFile[] = [];
      const issues: ScanIssue[] = [];
      const eligible = (path: string) => !ignore.reason(path) && !excludedPaths.includes(path);
      const total = inventory.paths.filter(eligible).length;
      const paths = inventory.paths.filter(eligible);
      const index = cache?.index;
      let ticket = cache ? index!.ticket(JSON.stringify([cache.scopeKey, [...excludedPaths].sort(pathOrder)]), cache.forceFull) : undefined;
      const stats = new Map<string, FileStat | null>();
      if (ticket && !ticket.full) {
        let unobserved = [...new Set([...paths, ...Object.keys(ticket.entries)])].some(path => !index!.isDirty(ticket!, path) && paths.includes(path) !== Object.hasOwn(ticket!.entries, path));
        for (const path of paths) {
          assertActive(signal);
          let stat: FileStat | null;
          try { stat = cache?.metadataCheck === false && ticket.entries[path] ? { type: 'file', ...ticket.entries[path] } : await this.reader.stat(path); }
          catch { throw new LocalScanError('READ_FAILED', [{ path, actualSha: null, problem: 'unreadable' }]); }
          stats.set(path, stat);
          if (!index!.isDirty(ticket, path) && ticket.entries[path] && !index!.matches(ticket.entries[path], stat)) unobserved = true;
        }
        if (unobserved) { index!.invalidate('unobserved-file-event'); ticket = index!.ticket(ticket.scopeKey); }
      }
      if (ticket?.full && ticket.reason) this.measurement?.reconcile?.(ticket.reason);
      const samples = new Set(cache?.audit && ticket ? index!.samples(ticket, paths.filter(p => !index!.isDirty(ticket, p))) : []);
      const indexed: IndexedFile[] = [];
      fileProgress?.(0, total);
      const read = async (path: string): Promise<LocalFile | undefined> => {
        try {
          const before = await this.reader.stat(path);
          if (!before || before.type !== 'file') { issues.push({ path, actualSha: null, problem: 'missing-during-scan' }); return; }
          const bytes = await this.reader.readBinary(path);
          const after = await this.reader.stat(path);
          const sha = gitBlobSha(bytes, this.measurement);
          if (!after || after.type !== 'file' || before.size !== bytes.byteLength || after.size !== bytes.byteLength
            || before.mtime !== after.mtime || before.ctime !== after.ctime) issues.push({ path, actualSha: after ? sha : null, problem: 'changed-during-scan' });
          if (after) indexed.push({ path, size: bytes.byteLength, sha, mtime: after.mtime, ctime: after.ctime });
          return { path, size: bytes.byteLength, sha };
        } catch { issues.push({ path, actualSha: null, problem: 'unreadable' }); return; }
      };
      for (const path of inventory.paths) {
        assertActive(signal);
        const reason = ignore.reason(path) ?? (excludedPaths.includes(path) ? 'SyncPlan identity exclusion' : undefined);
        if (reason) { ignored.push({ path, reason }); continue; }
        const stored = ticket?.entries[path];
        const reuse = !!stored && !ticket!.full && !index!.isDirty(ticket!, path) && !samples.has(path) && !cache?.forcePaths?.includes(path) && index!.matches(stored, stats.get(path) ?? null);
        const file = reuse ? { path, size: stored.size, sha: stored.sha } : await read(path);
        if (reuse) { indexed.push(stored); this.measurement?.reused?.(); }
        if (samples.has(path) && stored && file && file.sha !== stored.sha) {
          index!.invalidate('integrity-sample-mismatch');
          return this.scan(ignore, progress, signal, excludedPaths, fileProgress, { ...cache!, audit: false });
        }
        if (file) { files.push(file); if (files.length % 25 === 0 || files.length === total) fileProgress?.(files.length, total); }
        if (files.length % 25 === 0) {
          progress(`Hashing local files: ${files.length}`);
          if (typeof window !== 'undefined') await new Promise(resolve => window.setTimeout(resolve, 0));
          else await Promise.resolve();
        }
      }
      const afterInventory = await this.inventory(ignore, signal);
      // Directory metadata and ignored files are not part of the user-file domain.
      const beforePaths = new Set(inventory.paths.filter(eligible));
      const afterPaths = new Set(afterInventory.paths.filter(eligible));
      for (const path of beforePaths) if (!afterPaths.has(path)) issues.push({ path, actualSha: null, problem: 'missing-during-scan' });
      for (const path of afterPaths) if (!beforePaths.has(path)) {
        const file = await read(path);
        if (file) issues.push({ path, actualSha: file.sha, problem: 'added-during-scan' });
      }
      assertActive(signal);
      if (issues.length) throw new LocalScanError(issues.some(d => d.problem === 'unreadable') ? 'READ_FAILED' : 'LOCAL_CHANGED',
        [...new Map(issues.map(d => [d.path, d])).values()], files);
      if (ticket) await index!.accept(ticket, indexed);
      return { files, ignored, protectedDirectories: inventory.protectedDirectories, scannedAt: new Date().toISOString(), ...(ticket ? { verification: ticket.full ? 'full' as const : 'incremental' as const } : {}) };
    } catch (error) {
      if (error instanceof PreviewError) throw error;
      throw new PreviewError('LOCAL_SCAN', 'READ_FAILED', 'A file or directory could not be read. No partial plan was created.');
    }
  }
}
