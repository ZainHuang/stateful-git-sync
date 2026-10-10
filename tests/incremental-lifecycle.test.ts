import { describe, expect, it, vi } from 'vitest';
import { LocalChangeIndex } from '../src/vault/LocalChangeIndex';
import { indexedDevice } from './v12-harness';

describe('V1.2 identity events survive execution and lifecycle interruption', () => {
  it('coalesces an event burst durably without dropping the final dirty revision', async () => {
    const a = await indexedDevice({ 'A.md': 'a' }); await a.run(); const writes = vi.spyOn(a.storage, 'write');
    for (let i = 0; i < 100; i++) a.index.record('modify', 'A.md');
    await a.index.flush(); expect(writes.mock.calls.length).toBeLessThan(3);
    const restart = new LocalChangeIndex(a.storage); await restart.load(); expect(restart.snapshot().dirtyPaths).toContain('A.md'); expect(restart.snapshot().revision).toBe(a.index.snapshot().revision);
  });
  it('durably journals rename/create/delete evidence until the existing state store acknowledges it', async () => {
    const a = await indexedDevice({ 'A.md': 'a' }); await a.run();
    a.index.record('rename', 'B.md', 'A.md', true);
    a.index.record('delete', 'B.md', undefined, true);
    a.index.record('create', 'B.md', undefined, true); await a.index.flush();
    const restart = new LocalChangeIndex(a.storage); await restart.load();
    const events = restart.identityEvents(); expect(events.map(e => e.kind)).toEqual(['rename', 'delete', 'create']);
    restart.acknowledgeIdentity(events[0]!.revision); await restart.flush();
    const again = new LocalChangeIndex(a.storage); await again.load(); expect(again.identityEvents().map(e => e.kind)).toEqual(['delete', 'create']);
  });
  it('standalone manual Verify performs a full byte audit even with a trusted event cache', async () => {
    const a = await indexedDevice({ 'A.md': 'a' }); await a.run(); a.vault.reads = [];
    await a.service.preview({ owner: 'test-owner', repository: 'test-repository', branch: 'main', includeObsidian: false, ignorePatterns: '', deleteSafetyThreshold: 100 }, 'fixture', () => {}, undefined, {}, true);
    expect(a.vault.reads).toContain('A.md'); expect(a.service.performanceSnapshot().verification).toBe('Full Integrity Verified');
  });
});
