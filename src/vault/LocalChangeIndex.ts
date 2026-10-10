import { PreviewError } from '../errors';
import type { DeviceStateStorage } from '../state/StateStore';
import { isRecord, isSha } from '../sync/manifest/ManifestValidator';
import { gitBlobSha } from './HashService';
import { assertPath, pathOrder } from './paths';
import type { FileStat, LocalFile } from './VaultScanner';
import type { SyncPerformance } from '../product/SyncPerformance';

export const LOCAL_CHANGE_INDEX_FILENAME = 'local-change-index.json';
export interface IndexPolicy { maxAgeMs: number; auditEvery: number; sampleSize: number }
export const DEFAULT_INDEX_POLICY: IndexPolicy = { maxAgeMs: 24 * 60 * 60 * 1000, auditEvery: 20, sampleSize: 8 };
export interface IndexedFile extends LocalFile { mtime: number; ctime: number }
interface IndexData {
  version: 1; scopeKey: string; entries: Record<string, IndexedFile>; dirty: Record<string, number>;
  revision: number; fullAt: number; cycles: number; cursor: number;
  identityEvents?: IdentityEvent[];
}
export interface IdentityEvent { revision: number; kind: 'create' | 'delete' | 'rename'; path: string; oldPath?: string }
export interface IndexTicket {
  revision: number; epoch: number; scopeKey: string; full: boolean; reason?: string;
  entries: Record<string, IndexedFile>; dirty: Record<string, number>;
}
const empty = (): IndexData => ({ version: 1, scopeKey: '', entries: {}, dirty: {}, revision: 0, fullAt: 0, cycles: 0, cursor: 0 });
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const integer = (n: unknown): n is number => finite(n) && Number.isSafeInteger(n);

/** A byte-hash cache, never BASE, identity or deletion authority. Events are
 * recorded synchronously before asynchronous disk writes or UI scheduling. */
export class LocalChangeIndex {
  private data = empty();
  private trusted = false;
  private reason = 'plugin-restart';
  private epoch = 0;
  private queue: Promise<void> = Promise.resolve();
  private savedRaw?: string;
  private writeRequested = false;
  private writing = false;
  private measurement?: SyncPerformance;
  measureWith(measurement: SyncPerformance) { this.measurement = measurement; }
  readonly policy: IndexPolicy;
  constructor(private readonly storage: DeviceStateStorage, policy: Partial<IndexPolicy> = {}, private readonly now = () => Date.now()) {
    this.policy = { ...DEFAULT_INDEX_POLICY, ...policy };
    if (!integer(this.policy.maxAgeMs) || this.policy.maxAgeMs < 1 || !integer(this.policy.auditEvery) || this.policy.auditEvery < 1 || !integer(this.policy.sampleSize)) throw new Error('Invalid audit policy');
  }
  async load(): Promise<void> {
    try {
      const raw = await this.storage.read();
      if (raw !== null) {
        const e: unknown = JSON.parse(raw);
        if (!isRecord(e) || typeof e.payload !== 'string' || gitBlobSha(new TextEncoder().encode(e.payload), this.measurement, true) !== e.sha) throw new Error();
        const d: unknown = JSON.parse(e.payload);
        if (!isRecord(d) || d.version !== 1 || typeof d.scopeKey !== 'string' || !isRecord(d.entries) || !isRecord(d.dirty)
          || !integer(d.revision) || !finite(d.fullAt) || !integer(d.cycles) || !integer(d.cursor)
          || Object.keys(d.entries).length > 250_000 || Object.keys(d.dirty).length > 250_000) throw new Error();
        for (const [path, entry] of Object.entries(d.entries)) {
          assertPath(path);
          if (!isRecord(entry) || entry.path !== path || !isSha(entry.sha) || !integer(entry.size) || !finite(entry.mtime) || !finite(entry.ctime)) throw new Error();
        }
        for (const [path, revision] of Object.entries(d.dirty)) { assertPath(path); if (!integer(revision) || revision > d.revision) throw new Error(); }
        if (d.identityEvents !== undefined) {
          if (!Array.isArray(d.identityEvents) || d.identityEvents.length > 250_000) throw new Error();
          for (const event of d.identityEvents) {
            if (!isRecord(event) || !integer(event.revision) || event.revision > d.revision || !['create', 'delete', 'rename'].includes(String(event.kind)) || typeof event.path !== 'string') throw new Error();
            assertPath(event.path); if (event.kind === 'rename') { if (typeof event.oldPath !== 'string') throw new Error(); assertPath(event.oldPath); }
          }
        }
        this.data = d as unknown as IndexData;
        this.savedRaw = raw;
      }
      this.invalidate('plugin-restart', false);
    } catch { this.data = empty(); this.invalidate('index-corrupt', false); }
  }
  snapshot() { return { trusted: this.trusted, reason: this.reason, revision: this.data.revision, epoch: this.epoch,
    dirtyPaths: Object.keys(this.data.dirty).sort(pathOrder), fullAt: this.data.fullAt }; }
  async validateStorage(): Promise<void> {
    await this.flush();
    try { if (this.savedRaw !== undefined && await this.storage.read() !== this.savedRaw) this.invalidate('index-corrupt', false); }
    catch { this.invalidate('index-storage-failed', false); }
  }
  invalidate(reason: string, persist = true) { this.trusted = false; this.reason = reason; this.epoch++; if (persist) this.persist(); }
  record(kind: 'create' | 'modify' | 'delete' | 'rename', path: string, oldPath?: string, retainIdentity = false): void {
    try { assertPath(path); if (oldPath) assertPath(oldPath); }
    catch { this.invalidate('invalid-file-event'); return; }
    const revision = ++this.data.revision;
    if (retainIdentity && kind !== 'modify') (this.data.identityEvents ??= []).push({ revision, kind, path, ...(oldPath ? { oldPath } : {}) });
    const mark = (p: string) => { Object.defineProperty(this.data.dirty, p, { value: revision, writable: true, enumerable: true, configurable: true }); };
    mark(path); if (oldPath) mark(oldPath);
    for (const p of Object.keys(this.data.entries)) {
      if (p.startsWith(`${path}/`)) mark(p);
      if (oldPath && p.startsWith(`${oldPath}/`)) { mark(p); if (kind === 'rename') mark(path + p.slice(oldPath.length)); }
    }
    this.persist();
  }
  identityEvents(): IdentityEvent[] { return structuredClone(this.data.identityEvents ?? []); }
  acknowledgeIdentity(revision: number) { this.data.identityEvents = (this.data.identityEvents ?? []).filter(e => e.revision !== revision); this.persist(); }
  isDirty(ticket: IndexTicket, path: string) { return Object.keys(ticket.dirty).some(p => p === path || path.startsWith(`${p}/`)); }
  ticket(scopeKey: string, forceFull = false): IndexTicket {
    if (this.data.scopeKey !== scopeKey) this.invalidate(this.trusted ? 'ignore-scope-changed' : this.reason, false);
    if (this.trusted && (this.now() < this.data.fullAt || this.now() - this.data.fullAt >= this.policy.maxAgeMs || this.data.cycles >= this.policy.auditEvery - 1)) this.invalidate('scheduled-integrity-audit', false);
    return { revision: this.data.revision, epoch: this.epoch, scopeKey, full: forceFull || !this.trusted,
      reason: forceFull ? 'full-verification-required' : this.trusted ? undefined : this.reason, entries: structuredClone(this.data.entries), dirty: { ...this.data.dirty } };
  }
  samples(ticket: IndexTicket, paths: string[]): string[] {
    if (ticket.full || !paths.length) return [];
    const ordered = [...paths].sort(pathOrder); const count = Math.min(this.policy.sampleSize, ordered.length);
    const sample = Array.from({ length: count }, (_, i) => ordered[(this.data.cursor + i) % ordered.length]!);
    this.data.cursor = (this.data.cursor + count) % ordered.length;
    return sample;
  }
  assertCurrent(ticket: IndexTicket): void {
    if (ticket.revision !== this.data.revision || ticket.epoch !== this.epoch) throw new PreviewError('LOCAL_SCAN', 'LOCAL_CHANGED', 'Vault events changed during verification. Changes remain queued; run Preview again.');
  }
  async accept(ticket: IndexTicket, entries: IndexedFile[]): Promise<void> {
    this.assertCurrent(ticket);
    if (!ticket.full && !Object.keys(this.data.dirty).length && JSON.stringify(this.data.entries) === JSON.stringify(Object.fromEntries(entries.map(e => [e.path, e])))) return;
    this.data.entries = Object.fromEntries(entries.map(e => [e.path, e])); this.data.scopeKey = ticket.scopeKey;
    for (const [path, revision] of Object.entries(this.data.dirty)) if (revision <= ticket.revision) delete this.data.dirty[path];
    if (ticket.full) { this.data.fullAt = this.now(); this.data.cycles = 0; this.data.cursor = 0; }
    this.trusted = true; this.reason = '';
    this.persist(); await this.flush();
    // Events received while persisting are deliberately retained, not cleared.
  }
  completed() { this.data.cycles++; this.persist(); }
  matches(entry: IndexedFile, stat: FileStat | null) { return !!stat && stat.type === 'file' && entry.size === stat.size && entry.mtime === stat.mtime && entry.ctime === stat.ctime; }
  private persist() {
    this.writeRequested = true;
    if (this.writing) return;
    this.writing = true;
    this.queue = this.queue.then(async () => {
      try {
        while (this.writeRequested) {
          this.writeRequested = false;
          const payload = JSON.stringify(this.data); const raw = JSON.stringify({ payload, sha: gitBlobSha(new TextEncoder().encode(payload), this.measurement, true) });
          try { await this.storage.write(raw); if (await this.storage.read() !== raw) throw new Error(); this.savedRaw = raw; }
          catch { this.invalidate('index-storage-failed', false); }
        }
      } finally { this.writing = false; }
    });
  }
  async flush(): Promise<void> { let pending; do { pending = this.queue; await pending; } while (pending !== this.queue); }
}
