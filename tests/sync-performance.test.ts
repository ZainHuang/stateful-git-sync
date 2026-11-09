import { afterEach, describe, expect, it, vi } from 'vitest';
import { SyncService } from '../src/sync/execution/SyncService';
import { LocalStateStore } from '../src/sync/state/LocalStateStore';
import { GitFixture, WritableVault } from './v1-harness';
import { target } from './helpers';
import { SyncPerformance } from '../src/product/SyncPerformance';
const options = { ...target, includeObsidian: false, ignorePatterns: '', deleteSafetyThreshold: 20 };
afterEach(() => vi.restoreAllMocks());

describe('Measured IO and CPU operations', () => {
  it('measures awaited directory and stat IO, including failed attempts', async () => {
    let now = 100; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const metrics = new SyncPerformance(); const raw = new WritableVault({ 'A.md': 'a' });
    const list = raw.list.bind(raw); raw.list = async p => { now += 7; return list(p); };
    raw.stat = async () => { now += 11; throw new Error('private disk failure'); };
    const vault = metrics.vault(raw); await vault.list(''); await expect(vault.stat('A.md')).rejects.toThrow();
    expect(metrics.snapshot().operations['Directory listing']).toEqual({ elapsedMs: 7, calls: 1, failures: 0 });
    expect(metrics.snapshot().operations['File metadata']).toEqual({ elapsedMs: 11, calls: 1, failures: 1 });
  });
  it('keeps content hashing separate from metadata hashing and does not double-count calls', () => {
    const metrics = new SyncPerformance(); metrics.onHash(40, 2); metrics.onHash(100, 3, true);
    expect(metrics.snapshot().operations['Content hash']).toEqual({ elapsedMs: 2, calls: 1, failures: 0 });
    expect(metrics.snapshot().operations['Metadata hash']).toEqual({ elapsedMs: 3, calls: 1, failures: 0 });
    expect(metrics.snapshot().hashCalls).toBe(1); expect(metrics.snapshot().metadataHashBytes).toBe(100);
  });
  it('does not attribute a late IO completion to the next performance session', async () => {
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    const metrics = new SyncPerformance(); const raw = new WritableVault(); raw.list = async () => { await gate; return { files: [], folders: [] }; };
    const pending = metrics.vault(raw).list(''); metrics.start(); release(); await pending;
    expect(metrics.snapshot().operations['Directory listing'].calls).toBe(0);
  });
});

describe('V1.2 measured production pipeline', () => {
  it('counts actual reads, hash bytes, API calls and observed stages, including failures', async () => {
    const remote = new GitFixture(); const vault = new WritableVault({ 'A.md': 'one', 'attachment.bin': '12345' });
    const state = new LocalStateStore({ read: () => vault.readInternal('state'), write: s => vault.writeInternal('state', s) }); await state.load();
    const a = { vault, service: new SyncService(vault, remote.transport, '.obsidian', state) };
    const preview = await a.service.preview(options, 'fixture');
    const previewCalls = remote.calls.length;
    await a.service.execute(preview, 'fixture');
    const metrics = a.service.performanceSnapshot();
    expect(metrics.localReads).toBeGreaterThan(0);
    expect(metrics.hashBytes).toBeGreaterThanOrEqual(8);
    expect(metrics.apiRequests).toBe(remote.calls.length - previewCalls);
    expect(metrics.stages.Verify.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(metrics.stages.Hash.files).toBeGreaterThan(0);
    expect(metrics.previewOperations?.['Directory listing'].calls).toBeGreaterThan(0);
    expect(metrics.operations['Transaction history'].calls).toBe(1);
    const stale = await a.service.preview(options, 'fixture');
    a.vault.files.set('A.md', new TextEncoder().encode('changed'));
    await expect(a.service.execute(stale, 'fixture')).rejects.toThrow();
    expect(a.service.performanceSnapshot().outcome).toBe('failed');
  });
});
