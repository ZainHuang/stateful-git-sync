import { describe, expect, it, vi } from 'vitest';
import { VaultScanner } from '../src/vault/VaultScanner';
import { IgnoreService } from '../src/vault/IgnoreService';
import { LocalChangeIndex } from '../src/vault/LocalChangeIndex';
import { indexedDevice, v12Options } from './v12-harness';
import { bytes } from './helpers';
const files = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`note-${i}.md`, `unique ${i}`]));

describe('V1.2 dirty-file pipeline and bounded integrity audits', () => {
  it('does not repeat per-file stat IO at every Preview revalidation checkpoint', async () => {
    const a = await indexedDevice(files, undefined, { sampleSize: 0 }); await a.run();
    const p = await a.service.preview(v12Options, 'fixture'); const scanStats = a.service.performanceSnapshot().statCalls;
    await a.service.execute(p, 'fixture');
    expect(scanStats + a.service.performanceSnapshot().statCalls).toBeLessThan(100);
  });
  it('does not repeatedly read/hash every unchanged file; only hashes dirty files plus audit samples', async () => {
    const a = await indexedDevice(files); await a.run(); a.vault.reads = [];
    await a.run();
    expect(a.vault.reads.length).toBeLessThan(20);
    expect(a.service.performanceSnapshot().verification).toBe('Incremental Verified');
    expect(a.service.performanceSnapshot().reusedHashes).toBeGreaterThan(30);
    a.vault.reads = []; a.edit('note-20.md', 'changed content'); await a.run();
    expect(a.remote.text('note-20.md')).toBe('changed content');
    expect(new Set(a.vault.reads).size).toBeLessThan(20);
    expect(a.service.performanceSnapshot().verification).toBe('Incremental Verified');
  });
  it('syncs add, modify, attachment, delete, and rename-plus-edit with stable IDs and tombstones', async () => {
    const a = await indexedDevice({ 'A.md': 'a', 'image.bin': 'one' }); await a.run();
    const originalId = Object.values(a.state.current().baseManifest!.files).find(f => f.path === 'A.md')!.fileId;
    await a.move('A.md', 'nested/B.md'); a.edit('nested/B.md', 'rename and edit'); a.edit('image.bin', 'binary update'); a.edit('new.md', 'new');
    await a.run(); expect(a.remote.text('nested/B.md')).toBe('rename and edit'); expect(a.remote.text('image.bin')).toBe('binary update'); expect(a.remote.text('new.md')).toBe('new');
    expect(a.state.current().baseManifest!.files[originalId]!.path).toBe('nested/B.md'); expect(a.remote.contents()['A.md']).toBeUndefined();
    await a.remove('nested/B.md'); await a.run(); expect(a.state.current().baseManifest!.files[originalId]!.deleted).toBe(true);
  });
  it.each(['plugin-restart', 'mobile-resume', 'events-lost', 'index-corrupt'])('fully reconciles %s instead of trusting equal mtime/size', async reason => {
    const a = await indexedDevice(files); await a.run();
    a.vault.files.set('note-30.md', bytes('tamper 30')); // same length and stat, no event
    a.index.invalidate(reason); a.vault.reads = []; await a.run();
    expect(a.remote.text('note-30.md')).toBe('tamper 30');
    expect(new Set(a.vault.reads).size).toBe(40);
    expect(a.service.performanceSnapshot().verification).toBe('Full Integrity Verified');
  });
  it('never trusts a checksum-valid saved index across a plugin restart', async () => {
    const a = await indexedDevice(files); await a.run(); await a.index.flush();
    const restart = new LocalChangeIndex(a.storage); await restart.load();
    expect(restart.snapshot().trusted).toBe(false); expect(restart.snapshot().reason).toBe('plugin-restart');
  });
  it('rejects damaged envelopes and schema even if the file exists', async () => {
    const a = await indexedDevice(files); await a.run(); a.vault.internal.set('index', '{broken');
    const restart = new LocalChangeIndex(a.storage); await restart.load();
    expect(restart.snapshot()).toMatchObject({ trusted: false, reason: 'index-corrupt' });
  });
  it('discovers missed add/delete events from inventories and falls back to a full scan', async () => {
    const a = await indexedDevice(files); await a.run(); a.vault.files.set('missed.md', bytes('lost create event'));
    await a.run(); expect(a.remote.text('missed.md')).toBe('lost create event');
    a.vault.files.delete('note-1.md'); await a.run(); expect(a.remote.contents()['note-1.md']).toBeUndefined();
    expect(a.service.performanceSnapshot().verification).toBe('Full Integrity Verified');
  });
  it('audits equal-stat missed edits by bytes and escalates a sample mismatch to full reconciliation', async () => {
    const a = await indexedDevice(files, undefined, { sampleSize: 4, auditEvery: 100 }); await a.run();
    a.vault.files.set('note-0.md', bytes('tamper 0'));
    await a.run(); expect(a.remote.text('note-0.md')).toBe('tamper 0');
    expect(a.service.performanceSnapshot().verification).toBe('Full Integrity Verified');
  });
  it('forces periodic full audit by successful-cycle budget', async () => {
    const a = await indexedDevice(files, undefined, { auditEvery: 2, sampleSize: 0 }); await a.run(); await a.run();
    a.vault.files.set('note-39.md', bytes('tamper 39')); await a.run();
    expect(a.remote.text('note-39.md')).toBe('tamper 39'); expect(a.service.performanceSnapshot().verification).toBe('Full Integrity Verified');
  });
  it.each(['time-expiry', 'clock-rollback'])('forces full content audit on %s with equal-stat missed bytes', async reason => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const time = Date.parse('2026-10-10T00:00:00Z'); vi.setSystemTime(time);
      const a = await indexedDevice(files, undefined, { sampleSize: 0 }); await a.run();
      a.vault.files.set('note-39.md', bytes('tamper 39'));
      vi.setSystemTime(reason === 'time-expiry' ? time + 24 * 60 * 60 * 1000 : time - 1);
      await a.run(); expect(a.remote.text('note-39.md')).toBe('tamper 39');
      expect(a.service.performanceSnapshot().verification).toBe('Full Integrity Verified');
    } finally { vi.useRealTimers(); }
  });
  it('invalidates ignore scope; does not infer deletion of excluded files', async () => {
    const a = await indexedDevice(files); await a.run(); const before = a.remote.contents()['note-39.md'];
    await a.run({ ...v12Options, ignorePatterns: 'note-39.md' });
    expect(a.remote.contents()['note-39.md']).toBe(before); expect(a.service.performanceSnapshot().verification).toBe('Full Integrity Verified');
  });
  it('retains a later dirty event when the persisted cache write is delayed', async () => {
    const a = await indexedDevice(files); await a.run();
    const write = a.storage.write; let during = false;
    a.storage.write = async text => { if (!during) { during = true; a.edit('note-39.md', 'later edit'); } await write(text); };
    a.index.record('modify', 'note-0.md'); await a.index.flush();
    expect(a.index.snapshot().dirtyPaths).toContain('note-39.md');
    await a.run(); expect(a.remote.text('note-39.md')).toBe('later edit');
  });
  it('blocks a concurrent dirty change during scanning before publication and keeps it queued', async () => {
    const a = await indexedDevice(files); await a.run(); a.edit('note-0.md', 'first edit');
    const read = a.vault.readBinary.bind(a.vault); let once = false;
    vi.spyOn(a.vault, 'readBinary').mockImplementation(async path => { const result = await read(path); if (!once) { once = true; a.edit('note-39.md', 'during scan'); } return result; });
    const calls = a.remote.calls.length;
    await expect(a.service.preview(v12Options, 'fixture')).rejects.toMatchObject({ code: 'LOCAL_CHANGED' });
    expect(a.remote.calls.slice(calls).every(c => c.method === 'GET')).toBe(true); expect(a.index.snapshot().dirtyPaths).toContain('note-39.md');
  });
  it('invalidates unobserved stat changes instead of using metadata as an eternal hash proof', async () => {
    const a = await indexedDevice(files); await a.run(); const original = a.vault.stat.bind(a.vault);
    a.vault.files.set('note-39.md', bytes('changed'));
    vi.spyOn(a.vault, 'stat').mockImplementation(async path => { const s = await original(path); return path === 'note-39.md' && s ? { ...s, mtime: 9 } : s; });
    await a.run(); expect(a.remote.text('note-39.md')).toBe('changed'); expect(a.service.performanceSnapshot().verification).toBe('Full Integrity Verified');
  });
  it('uses full byte verification when index persistence is unavailable', async () => {
    const a = await indexedDevice(files); a.storage.write = async () => { throw new Error('storage offline'); };
    await a.run(); expect(a.index.snapshot().trusted).toBe(false); expect(a.service.performanceSnapshot().verification).toBe('Full Integrity Verified');
  });
  it('detects on-disk index damage while running and forces full verification', async () => {
    const a = await indexedDevice(files); await a.run(); await a.index.flush(); a.vault.internal.set('index', '{damaged');
    a.vault.files.set('note-39.md', bytes('tamper 39')); await a.run();
    expect(a.remote.text('note-39.md')).toBe('tamper 39'); expect(a.service.performanceSnapshot().verification).toBe('Full Integrity Verified');
  });
  it('tracks directory rename/delete descendants; never reads protected state', async () => {
    const a = await indexedDevice({ 'folder/A.md': 'a', 'folder/B.md': 'b' }); await a.run();
    a.index.record('rename', 'next', 'folder'); expect(a.index.snapshot().dirtyPaths).toEqual(expect.arrayContaining(['folder/A.md', 'folder/B.md', 'next/A.md', 'next/B.md']));
    const ignore = new IgnoreService({ configDir: '.obsidian', includeObsidian: true, gitignore: '', patterns: '!**' });
    await new VaultScanner(a.vault).scan(ignore); expect(a.vault.reads.some(p => p.includes('transactions/'))).toBe(false);
  });
});
