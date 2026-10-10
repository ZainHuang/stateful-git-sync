import { describe, expect, it } from 'vitest';
import { SyncService } from '../src/sync/execution/SyncService';
import { LocalStateStore } from '../src/sync/state/LocalStateStore';
import { GitFixture, WritableVault } from './v1-harness';
import { target } from './helpers';
const options = { ...target, includeObsidian: false, ignorePatterns: '', deleteSafetyThreshold: 20 };

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
    const stale = await a.service.preview(options, 'fixture');
    a.vault.files.set('A.md', new TextEncoder().encode('changed'));
    await expect(a.service.execute(stale, 'fixture')).rejects.toThrow();
    expect(a.service.performanceSnapshot().outcome).toBe('failed');
  });
});
