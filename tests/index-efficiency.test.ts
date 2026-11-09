import { afterEach, describe, expect, it, vi } from 'vitest';
import { indexedDevice } from './v12-harness';

afterEach(() => vi.useRealTimers());
describe('Index write batching and lookup equivalence', () => {
  it('marks every edit immediately and coalesces saves across separate event turns within 100 ms', async () => {
    const a = await indexedDevice({ 'A.md': 'a', 'folder/B.md': 'b' }); await a.run(); await a.index.flush();
    vi.useFakeTimers(); const write = vi.spyOn(a.storage, 'write');
    for (let i = 0; i < 10; i++) { a.index.record('modify', 'A.md'); await vi.advanceTimersByTimeAsync(5); }
    expect(a.index.snapshot().dirtyPaths).toContain('A.md'); expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50); expect(write).toHaveBeenCalledOnce(); await a.index.flush();
    const saved = JSON.parse(JSON.parse(await a.storage.read() as string).payload);
    expect(saved.dirty['A.md']).toBe(a.index.snapshot().revision);
  });
  it('flush bypasses the batching window and identity events persist without waiting', async () => {
    const a = await indexedDevice({ 'A.md': 'a' }); await a.run(); await a.index.flush(); vi.useFakeTimers();
    const write = vi.spyOn(a.storage, 'write'); a.index.record('modify', 'A.md'); await a.index.flush();
    expect(write).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0); write.mockClear();
    a.index.record('modify', 'A.md'); a.index.record('rename', 'next.md', 'A.md', true);
    await Promise.resolve(); expect(write).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0); await a.index.flush();
    const saved = JSON.parse(JSON.parse(await a.storage.read() as string).payload);
    expect(saved.identityEvents).toContainEqual(expect.objectContaining({ kind: 'rename', oldPath: 'A.md', path: 'next.md' }));
  });
  it('matches exact paths and directory descendants without matching similarly named siblings', async () => {
    const a = await indexedDevice({ 'folder/A.md': 'a', 'folder/sub/B.md': 'b', 'folder-other/C.md': 'c' }); await a.run();
    for (const p of ['folder', 'new/note.md', 'space name/中文']) a.index.record('modify', p);
    const t = a.index.ticket('test');
    const paths = ['folder', 'folder/A.md', 'folder/sub/B.md', 'folder-other/C.md', 'folderish', 'new', 'new/note.md', 'new/note.md/child', 'space name/中文/a', 'space name/中'];
    for (let round = 0; round < 3; round++) for (const p of paths) {
      const expected = Object.keys(t.dirty).some(d => d === p || p.startsWith(`${d}/`));
      expect(a.index.isDirty(t, p), p).toBe(expected);
    }
    await a.index.flush();
  });
  it('retains an edit arriving during an index readback and persists the latest revision before flush returns', async () => {
    const a = await indexedDevice({ 'A.md': 'a', 'B.md': 'b' }); await a.run(); await a.index.flush(); vi.useFakeTimers();
    const read = a.storage.read; let once = false;
    a.storage.read = async () => { const value = await read(); if (!once) { once = true; a.index.record('modify', 'B.md'); } return value; };
    a.index.record('modify', 'A.md'); await a.index.flush();
    const saved = JSON.parse(JSON.parse(await read() as string).payload);
    expect(saved.dirty['B.md']).toBe(a.index.snapshot().revision); expect(vi.getTimerCount()).toBe(0);
  });
  it('invalidates the cache on a batched write failure and preserves dirty paths', async () => {
    const a = await indexedDevice({ 'A.md': 'a' }); await a.run(); await a.index.flush(); vi.useFakeTimers();
    a.storage.write = async () => { throw new Error('disk unavailable'); }; a.index.record('modify', 'A.md');
    await vi.advanceTimersByTimeAsync(100); await a.index.flush();
    expect(a.index.snapshot()).toMatchObject({ trusted: false, reason: 'index-storage-failed', dirtyPaths: ['A.md'] });
  });
  it('keeps coalescing ordinary edits while an earlier index write is in flight', async () => {
    const a = await indexedDevice({ 'A.md': 'a' }); await a.run(); await a.index.flush(); vi.useFakeTimers();
    let release!: () => void; let reached!: () => void; const gate = new Promise<void>(r => { release = r; }); const ready = new Promise<void>(r => { reached = r; });
    const original = a.storage.write; let writes = 0;
    a.storage.write = async text => { writes++; if (writes === 1) { reached(); await gate; } await original(text); };
    a.index.record('delete', 'absent.md'); await ready;
    for (let i = 0; i < 4; i++) { a.index.record('modify', 'A.md'); await vi.advanceTimersByTimeAsync(5); }
    release(); await vi.advanceTimersByTimeAsync(0); expect(writes).toBe(1);
    await vi.advanceTimersByTimeAsync(100); await a.index.flush(); expect(writes).toBe(2);
  });
});
