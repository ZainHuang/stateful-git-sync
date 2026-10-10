import { describe, expect, it } from 'vitest';
import { SyncService } from '../src/sync/execution/SyncService';
import { indexedDevice, v12Options } from './v12-harness';
import { bytes } from './helpers';

describe('V1.2 verification, publication and BASE safety', () => {
  it('uses fresh mutable HEAD reads but caches immutable remote metadata for the same HEAD', async () => {
    const a = await indexedDevice({ 'A.md': 'a' }); await a.run();
    const first = a.remote.calls.length; await a.run();
    const calls = a.remote.calls.slice(first);
    expect(calls.some(c => c.resource.startsWith('ref/'))).toBe(true);
    expect(calls.some(c => c.resource.startsWith('trees/') || c.resource.startsWith('blobs/') || c.resource.startsWith('commits/'))).toBe(false);
  });
  it('does not advance BASE on incremental verify failure; keeps exact diagnostics and Recovery', async () => {
    const a = await indexedDevice({ 'A.md': 'a', 'B.md': 'b' }); await a.run(); const base = a.state.current().baseRemoteCommit;
    a.edit('A.md', 'reviewed'); const p = await a.service.preview(v12Options, 'fixture');
    a.remote.beforePatch = () => a.edit('B.md', 'concurrent');
    await expect(a.service.execute(p, 'fixture')).rejects.toMatchObject({ code: 'LOCAL_VERIFY_FAILED', diagnostics: expect.arrayContaining([expect.objectContaining({ path: 'B.md' })]) });
    expect(a.state.current().baseRemoteCommit).toBe(base); expect(await a.service.transactions.active()).not.toBeNull();
    expect(a.index.snapshot().dirtyPaths).toContain('B.md');
  });
  it('fully verifies local-write Recovery after a lost publication without a second business commit', async () => {
    const a = await indexedDevice({ 'A.md': 'a' }); await a.run();
    const b = await indexedDevice({}, a.remote); await b.run(); a.edit('A.md', 'remote'); await a.run();
    const p = await b.service.preview(v12Options, 'fixture'); b.vault.failPath = 'A.md'; await expect(b.service.execute(p, 'fixture')).rejects.toThrow();
    const commits = a.remote.calls.filter(c => c.method === 'POST' && c.resource === 'commits').length;
    b.vault.failPath = undefined; const restart = new SyncService(b.vault, a.remote.transport, '.obsidian', b.state, undefined, b.index);
    await restart.resume(v12Options, 'fixture'); expect(b.vault.files.get('A.md')).toEqual(bytes('remote'));
    expect(restart.performanceSnapshot().verification).toBe('Full Integrity Verified');
    expect(a.remote.calls.filter(c => c.method === 'POST' && c.resource === 'commits')).toHaveLength(commits);
  });
  it('checks changed recovery blobs again and fails on corruption before an overwrite', async () => {
    const a = await indexedDevice({ 'A.md': 'a' }); await a.run(); const b = await indexedDevice({}, a.remote); await b.run();
    a.edit('A.md', 'remote change'); await a.run(); const p = await b.service.preview(v12Options, 'fixture');
    b.vault.failPath = 'A.md'; await expect(b.service.execute(p, 'fixture')).rejects.toThrow();
    const t = (await b.service.transactions.active())!;
    b.vault.internal.set(`.local-mirror-sync/transactions/objects/blobs/${t.after['A.md']}`, 'invalid'); b.vault.failPath = undefined;
    await expect(b.service.resume(v12Options, 'fixture')).rejects.toThrow(); expect(b.vault.files.get('A.md')).toEqual(bytes('a'));
  });
  it('pinned Push-only Recovery is labeled Published Snapshot Verified, never Full Integrity Verified', async () => {
    const a = await indexedDevice({ 'A.md': 'a' }); await a.run(); a.edit('A.md', 'push'); const p = await a.service.preview(v12Options, 'fixture');
    a.remote.losePatchResponse = true; await expect(a.service.execute(p, 'fixture')).rejects.toThrow();
    a.edit('A.md', 'later offline edit'); await a.service.resume(v12Options, 'fixture');
    expect(a.service.performanceSnapshot().verification).toBe('Published Snapshot Verified');
    expect(a.vault.files.get('A.md')).toEqual(bytes('later offline edit')); expect(a.index.snapshot().dirtyPaths).toContain('A.md');
  });
  it('legacy full Recovery refreshes the derived index and reports its actual full proof', async () => {
    const a = await indexedDevice({ 'A.md': 'a', 'B.md': 'b' }); await a.run(); a.edit('A.md', 'push');
    const p = await a.service.preview(v12Options, 'fixture'); a.remote.losePatchResponse = true;
    await expect(a.service.execute(p, 'fixture')).rejects.toThrow();
    const t = (await a.service.transactions.active())!; delete t.createdAt; delete t.observation; t.phase = 'published';
    await a.service.transactions.save(t); a.index.record('modify', 'A.md'); a.vault.reads = [];
    const calls = a.remote.calls.length; await a.service.resume(v12Options, 'fixture');
    expect(a.service.performanceSnapshot().verification).toBe('Full Integrity Verified');
    expect(a.index.snapshot().dirtyPaths).toEqual([]); expect(new Set(a.vault.reads)).toEqual(new Set(['A.md', 'B.md']));
    expect(a.remote.calls.slice(calls).every(c => c.method === 'GET')).toBe(true);
  });
});
