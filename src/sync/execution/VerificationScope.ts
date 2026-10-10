import type { SyncTransaction } from './TransactionStore';

/** The existing full before/after maps remain authoritative. This narrows byte
 * work only; removals are still checked against the complete local inventory. */
export function changedVerificationPaths(t: Pick<SyncTransaction, 'before' | 'after' | 'originalState'>): string[] {
  const base = Object.fromEntries(Object.values(t.originalState.baseManifest?.files ?? {}).filter(f => !f.deleted).map(f => [f.path, f.blobSha]));
  return [...new Set([...Object.keys(t.before), ...Object.keys(t.after), ...Object.keys(base)])]
    .filter(path => t.before[path] !== t.after[path] || t.before[path] !== base[path] || t.after[path] !== base[path]);
}
export function recoveryHashes(t: SyncTransaction): string[] {
  return t.retainedHashes ?? [...new Set([...Object.values(t.before), ...Object.values(t.after)])];
}
