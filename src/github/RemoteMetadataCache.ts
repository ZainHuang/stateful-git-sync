import type { RemoteSnapshot } from './types';
import type { SyncManifest } from '../sync/manifest/ManifestSchema';
import type { SyncPerformance } from '../product/SyncPerformance';

/** Only validated immutable Commit/Tree/Manifest tuples. Mutable HEAD is never
 * cached. Kept in memory; restart, resume and full audits discard all tuples. */
export class RemoteMetadataCache {
  private readonly entries = new Map<string, { snapshot: RemoteSnapshot; manifest: SyncManifest | null; parent?: string }>();
  constructor(private readonly measurement?: SyncPerformance) {}
  clear() { this.entries.clear(); }
  get(commit: string) {
    const result = this.entries.get(commit); if (!result) return undefined;
    this.measurement?.cacheHit(); return structuredClone(result);
  }
  remember(snapshot: RemoteSnapshot, manifest: SyncManifest | null, parent?: string) {
    this.entries.set(snapshot.remoteHeadSha, structuredClone({ snapshot, manifest, parent: parent ?? this.entries.get(snapshot.remoteHeadSha)?.parent }));
    if (this.entries.size > 4) this.entries.delete(this.entries.keys().next().value!);
  }
}
