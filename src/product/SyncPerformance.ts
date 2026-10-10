import type { ActivityStage } from './SyncActivity';
import type { GitTransport } from '../github/types';
import type { SyncVault } from '../sync/execution/SyncVault';

export type VerificationLevel = 'Incremental Verified' | 'Full Integrity Verified' | 'Published Snapshot Verified';
export type PerformanceStage = 'Scan' | 'Hash' | 'Read Remote' | 'Transfer' | 'Verify';
export interface StageMeasurement {
  elapsedMs: number; files: number; bytes: number; reads: number; apiRequests: number;
}
export interface PerformanceSnapshot {
  elapsedMs: number; outcome?: 'passed' | 'failed'; verification?: VerificationLevel;
  localReads: number; localReadBytes: number; internalReads: number; internalReadBytes: number;
  hashCalls: number; hashBytes: number; metadataHashBytes: number; apiRequests: number;
  apiRequestBytes: number; apiResponseBytes: number; statCalls: number; listCalls: number;
  reusedHashes: number; cacheHits: number; reconciliations: string[];
  stages: Record<PerformanceStage, StageMeasurement>;
}
const clock = () => performance.now();
const length = (s: string) => new TextEncoder().encode(s).byteLength;
const phase = (stage: ActivityStage): PerformanceStage => /Verify|candidate|BASE|Finalize|Complete/.test(stage) ? 'Verify'
  : stage === 'Read remote' || stage === 'Build plan' ? 'Read Remote'
  : /Scan|Revalidate/.test(stage) ? 'Scan' : 'Transfer';

/** Per-service diagnostics. No content, token, planner state or execution authority. */
export class SyncPerformance {
  private data!: PerformanceSnapshot;
  private started = clock();
  private changed = this.started;
  private current: PerformanceStage = 'Scan';
  private ended?: number;
  constructor() { this.start(); }
  start() {
    this.started = clock(); this.changed = this.started; this.ended = undefined; this.current = 'Scan';
    const empty = (): StageMeasurement => ({ elapsedMs: 0, files: 0, bytes: 0, reads: 0, apiRequests: 0 });
    this.data = { elapsedMs: 0, localReads: 0, localReadBytes: 0, internalReads: 0, internalReadBytes: 0,
      hashCalls: 0, hashBytes: 0, metadataHashBytes: 0, apiRequests: 0, apiRequestBytes: 0, apiResponseBytes: 0,
      statCalls: 0, listCalls: 0, reusedHashes: 0, cacheHits: 0, reconciliations: [],
      stages: { Scan: empty(), Hash: empty(), 'Read Remote': empty(), Transfer: empty(), Verify: empty() } };
  }
  stage(stage: ActivityStage) { const now = clock(); this.data.stages[this.current].elapsedMs += now - this.changed; this.changed = now; this.current = phase(stage); }
  end(failed: boolean) { this.ended = clock(); this.data.stages[this.current].elapsedMs += this.ended - this.changed; this.changed = this.ended; this.data.outcome = failed ? 'failed' : 'passed'; if (failed) delete this.data.verification; }
  snapshot(): PerformanceSnapshot {
    const now = this.ended ?? clock(); const result = structuredClone(this.data); result.elapsedMs = now - this.started;
    if (!this.ended) result.stages[this.current].elapsedMs += now - this.changed;
    return result;
  }
  onHash(bytes: number, elapsedMs: number, metadata = false) {
    if (metadata) this.data.metadataHashBytes += bytes;
    else { this.data.hashCalls++; this.data.hashBytes += bytes; this.data.stages.Hash.files++; this.data.stages.Hash.bytes += bytes; }
    this.data.stages.Hash.elapsedMs += elapsedMs;
  }
  verification(level: VerificationLevel) { this.data.verification = level; }
  reused(count = 1) { this.data.reusedHashes += count; }
  cacheHit() { this.data.cacheHits++; }
  reconcile(reason: string) { if (!this.data.reconciliations.includes(reason)) this.data.reconciliations.push(reason); }
  localRead(bytes: number, internal = false) {
    if (internal) { this.data.internalReads++; this.data.internalReadBytes += bytes; }
    else { this.data.localReads++; this.data.localReadBytes += bytes; this.data.stages[this.current].files++; this.data.stages[this.current].bytes += bytes; }
    this.data.stages[this.current].reads++;
  }
  vault(vault: SyncVault): SyncVault {
    return { ...vault, list: path => { this.data.listCalls++; return vault.list(path); }, stat: path => { this.data.statCalls++; return vault.stat(path); },
      readBinary: async path => { const bytes = await vault.readBinary(path); this.localRead(bytes.byteLength); return bytes; },
      readInternal: async path => { const text = await vault.readInternal(path); if (text !== null) this.localRead(length(text), true); return text; },
      writeInternal: (path, contents) => vault.writeInternal(path, contents), removeInternal: path => vault.removeInternal(path),
      removeEmptyFolder: (path, recoveryPath) => vault.removeEmptyFolder(path, recoveryPath),
      apply: (path, data, expected, recoveryPath) => vault.apply(path, data, expected, recoveryPath) };
  }
  transport(transport: GitTransport): GitTransport {
    return async request => {
      this.data.apiRequests++; this.data.stages[this.current].apiRequests++;
      if (request.body) this.data.apiRequestBytes += length(request.body);
      const response = await transport(request);
      if (response.json !== undefined) {
        const bytes = length(JSON.stringify(response.json)); this.data.apiResponseBytes += bytes; this.data.stages[this.current].bytes += bytes;
        const data = response.json;
        if (data && typeof data === 'object' && 'tree' in data && Array.isArray(data.tree)) {
          this.data.stages[this.current].files += data.tree.filter((e: unknown) => e && typeof e === 'object' && 'type' in e && e.type === 'blob').length;
        }
      }
      return response;
    };
  }
}
