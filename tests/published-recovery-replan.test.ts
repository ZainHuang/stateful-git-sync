import { describe, expect, it, vi } from 'vitest';
import { PreviewError } from '../src/errors';
import { SyncService } from '../src/sync/execution/SyncService';
import { LocalStateStore } from '../src/sync/state/LocalStateStore';
import { MANIFEST_PATH } from '../src/sync/manifest/ManifestSchema';
import { bytes, target } from './helpers';
import { GitFixture, WritableVault } from './v1-harness';

const options = { ...target, includeObsidian: false, ignorePatterns: '', deleteSafetyThreshold: 20 };
const pointer = '.local-mirror-sync/transactions/active.json';
async function device(remote: GitFixture, files: Record<string, string>) {
  const vault = new WritableVault(files);
  const state = new LocalStateStore({ read: () => vault.readInternal('state'), write: s => vault.writeInternal('state', s) });
  await state.load();
  const service = new SyncService(vault, r => remote.transport(r), '.obsidian', state);
  const sync = async () => service.execute(await service.preview(options, 'test'), 'test');
  return { remote, vault, state, service, sync };
}
async function interruptedPull(bootstrap = false) {
  const remote = new GitFixture();
  const a = await device(remote, { 'note.md': 'base', 'keep.md': 'keep' }); await a.sync();
  const b = await device(remote, { 'note.md': 'base', 'keep.md': 'keep' }); await b.sync();
  b.vault.files.set('note.md', bytes('remote edit')); await b.sync();
  const d = bootstrap ? await device(remote, {}) : a;
  d.vault.failPath = 'note.md'; await expect(d.sync()).rejects.toThrow('disk failure'); d.vault.failPath = undefined;
  const t = (await d.service.transactions.active())!; expect(t.phase).toBe('published');
  d.vault.files.set('note.md', bytes('mobile edit'));
  // Mirror the production adapter's typed precondition error.
  const apply = d.vault.apply.bind(d.vault);
  vi.spyOn(d.vault, 'apply').mockImplementation(async (path, data, expected, recovery) => {
    try { await apply(path, data, expected, recovery); }
    catch (error) { if (error instanceof Error && error.message === 'local changed') throw new PreviewError('LOCAL_APPLY', 'LOCAL_CHANGED', `Local content changed at ${path}.`); throw error; }
  });
  return { ...d, t };
}

describe('Published local-write Recovery can explicitly return to reviewed Preview', () => {
  it('reports the affected path instead of hiding LOCAL_CHANGED inside a generic environment error', async () => {
    const a = await interruptedPull(); const before = a.state.current(); const files = new Map(a.vault.files);
    await expect(a.service.resume(options, 'test', undefined, a.t)).rejects.toMatchObject({ code: 'RECOVERY_LOCAL_CHANGED',
      message: expect.stringContaining('note.md') });
    expect(a.state.current()).toEqual(before); expect(a.vault.files).toEqual(files);
    expect(await a.service.transactions.active()).toEqual(a.t);
  });

  it.each([false, true])('preserves current mobile bytes and BASE, retains a verified audit, and replans with bootstrap=%s', async bootstrap => {
    const a = await interruptedPull(bootstrap); const before = a.state.current(); const files = new Map(a.vault.files);
    const stored = new Map(a.vault.internal); const head = a.remote.head; const calls = a.remote.calls.length;
    const save = vi.spyOn(a.state, 'save'); const apply = vi.spyOn(a.vault, 'apply'); apply.mockClear();
    await a.service.startFreshPreviewFromCurrentHead(options, 'test', undefined, a.t);
    expect(a.state.current()).toEqual(before); expect(a.vault.files).toEqual(files);
    expect(save).not.toHaveBeenCalled(); expect(apply).not.toHaveBeenCalled();
    expect(a.remote.head).toBe(head); expect(await a.service.transactions.active()).toBeNull();
    for (const [path, value] of stored) if (path !== pointer) expect(a.vault.internal.get(path)).toBe(value);
    const auditPath = [...a.vault.internal.keys()].find(p => p.startsWith(a.service.transactions.directory(a.t.id) + '/fresh-preview-'))!;
    expect(auditPath).toBeTruthy();
    const audit = JSON.parse(JSON.parse(a.vault.internal.get(auditPath)!).payload);
    expect(audit).toMatchObject({ action: 'START_FRESH_PREVIEW', head, baseState: before, transactionId: a.t.id });
    expect(audit.differences.some((d: string) => d.includes('note.md'))).toBe(true);
    expect(await a.service.transactions.blob(a.t.id, audit.local['note.md'])).toEqual(bytes('mobile edit'));
    await a.state.load(); const p = await a.service.preview(options, 'test');
    expect(p.mode).toBe(bootstrap ? 'ATTACH' : 'SYNC'); expect(p.canExecute).toBe(false);
    expect(p.plan.entries).toContainEqual(expect.objectContaining({ path: 'note.md', category: bootstrap ? 'CONFLICT_ADD_ADD' : 'CONFLICT_CONTENT' }));
    expect(a.remote.calls.slice(calls).every(c => c.method === 'GET')).toBe(true);
  });

  it('retains a partial Pull and later additions without replaying old writes', async () => {
    const a = await interruptedPull(true);
    a.vault.files.set('keep.md', bytes('keep')); a.vault.files.set('later.md', bytes('later'));
    const files = new Map(a.vault.files); const before = a.state.current();
    await a.service.startFreshPreviewFromCurrentHead(options, 'test', undefined, a.t);
    expect(a.vault.files).toEqual(files); expect(a.state.current()).toEqual(before);
    const p = await a.service.preview(options, 'test');
    expect(p.plan.entries).toContainEqual(expect.objectContaining({ path: 'later.md', category: 'PUSH_ADD' }));
    expect(p.plan.entries).toContainEqual(expect.objectContaining({ path: 'keep.md', category: 'ALREADY_CONVERGED' }));
  });

  it('replans against a verified descendant while preserving the original BASE and unresolved both-device edits', async () => {
    const a = await interruptedPull();
    const b = await device(a.remote, { 'note.md': 'remote edit', 'keep.md': 'keep' }); await b.sync();
    b.vault.files.set('note.md', bytes('newer remote edit')); await b.sync();
    const head = a.remote.head; const before = a.state.current(); const files = new Map(a.vault.files);
    await a.service.startFreshPreviewFromCurrentHead(options, 'test', undefined, a.t);
    expect(a.state.current()).toEqual(before); expect(a.vault.files).toEqual(files); expect(a.remote.head).toBe(head);
    const p = await a.service.preview(options, 'test');
    expect(p.plan.entries).toContainEqual(expect.objectContaining({ path: 'note.md', category: 'CONFLICT_CONTENT' }));
  });

  it.each(['rename', 'delete'] as const)('preserves a recorded local %s across replan and reload', async kind => {
    const a = await interruptedPull(); const id = Object.values(a.t.originalState.baseManifest!.files).find(f => f.path === 'note.md')!.fileId;
    if (kind === 'rename') { a.vault.files.set('moved.md', a.vault.files.get('note.md')!); a.vault.files.delete('note.md'); await a.state.recordRename('note.md', 'moved.md'); }
    else { a.vault.files.delete('note.md'); await a.state.recordDelete('note.md'); }
    const before = a.state.current(); const files = new Map(a.vault.files);
    await a.service.startFreshPreviewFromCurrentHead(options, 'test'); await a.state.load();
    expect(a.state.current()).toEqual(before); expect(a.vault.files).toEqual(files);
    const p = await a.service.preview(options, 'test');
    expect(p.plan.entries).toContainEqual(expect.objectContaining({ fileId: id, category: kind === 'rename' ? 'CONFLICT_CONTENT' : 'CONFLICT_DELETE_MODIFY' }));
  });

  it.each([false, true])('preserves published Use Remote adoption; missing backup=%s cannot clear Recovery', async missingBackup => {
    const a = await device(new GitFixture({ 'note.md': 'remote adoption' }), { 'note.md': 'original local' });
    const p = a.service.selectAdoption(await a.service.preview(options, 'test'), 'remote');
    a.vault.failPath = 'note.md'; await expect(a.service.execute(p, 'test', undefined, undefined, 'USE REMOTE')).rejects.toThrow(); a.vault.failPath = undefined;
    const t = (await a.service.transactions.active())!; a.vault.files.set('note.md', bytes('mobile adoption edit'));
    if (missingBackup) a.remote.refs.delete(t.backupRef!);
    const before = a.state.current(); const files = new Map(a.vault.files); const head = a.remote.head; const calls = a.remote.calls.length;
    if (missingBackup) { await expect(a.service.startFreshPreviewFromCurrentHead(options, 'test')).rejects.toThrow(); expect(await a.service.transactions.active()).toEqual(t); }
    else {
      await expect(a.service.resume(options, 'test')).rejects.toMatchObject({ code: 'RECOVERY_LOCAL_CHANGED', message: expect.stringContaining('note.md') });
      await a.service.startFreshPreviewFromCurrentHead(options, 'test', undefined, t);
      expect(await a.service.transactions.active()).toBeNull();
      expect((await a.service.preview(options, 'test')).plan.entries).toContainEqual(expect.objectContaining({ path: 'note.md', category: 'CONFLICT_ADD_ADD' }));
    }
    expect(a.state.current()).toEqual(before); expect(a.vault.files).toEqual(files); expect(a.remote.head).toBe(head);
    expect(a.remote.calls.slice(calls).every(c => c.method === 'GET')).toBe(true);
  });

  it('does not record success or change the original transaction phase when explicitly replanning', async () => {
    const a = await interruptedPull();
    const observer = { revision: 0, preview: vi.fn(async () => {}), prepare: () => { throw new Error('Must not execute a new sync'); }, verified: vi.fn(async () => {}), recoveryCleared: vi.fn(async () => {}) };
    const service = new SyncService(a.vault, r => a.remote.transport(r), '.obsidian', a.state, observer);
    await service.startFreshPreviewFromCurrentHead(options, 'test', undefined, a.t);
    expect(observer.verified).not.toHaveBeenCalled(); expect(observer.recoveryCleared).toHaveBeenCalledOnce();
    const retained = JSON.parse(JSON.parse(a.vault.internal.get(`${service.transactions.directory(a.t.id)}/journal.json`)!).payload);
    expect(retained).toEqual(a.t); expect(retained.phase).toBe('published');
  });

  it.each(['prepared', 'target', 'device', 'scope', 'diverged', 'candidate', 'manifest', 'backup blob', 'BASE'] as const)('cannot bypass %s through fresh Preview', async failure => {
    const a = await interruptedPull(); let settings = options;
    if (failure === 'prepared') { a.t.phase = 'prepared'; await a.service.transactions.save(a.t); }
    if (failure === 'target') settings = { ...options, repository: 'another' };
    if (failure === 'device') await a.state.save({ ...a.state.current(), deviceId: crypto.randomUUID() });
    if (failure === 'scope') settings = { ...options, ignorePatterns: '*.md' };
    if (failure === 'diverged') a.remote.head = a.t.originalState.baseRemoteCommit!;
    if (failure === 'candidate') a.remote.contents()['note.md'] = a.remote.blob(bytes('corrupt'));
    if (failure === 'manifest') a.remote.external({ 'note.md': 'remote edit', 'keep.md': 'keep', [MANIFEST_PATH]: '{}' });
    if (failure === 'backup blob') a.vault.internal.delete(`.local-mirror-sync/transactions/objects/blobs/${a.t.before['note.md']}`);
    if (failure === 'BASE') await a.state.save({ ...a.state.current(), baseRemoteCommit: 'f'.repeat(40) });
    const before = a.state.current(); const files = new Map(a.vault.files); const pointerValue = a.vault.internal.get(pointer); const head = a.remote.head; const calls = a.remote.calls.length;
    await expect(a.service.startFreshPreviewFromCurrentHead(settings, 'test', undefined, a.t)).rejects.toThrow();
    expect(a.state.current()).toEqual(before); expect(a.vault.files).toEqual(files); expect(a.remote.head).toBe(head);
    expect(a.vault.internal.get(pointer)).toBe(pointerValue); expect(await a.service.transactions.active()).toEqual(a.t);
    expect(a.remote.calls.slice(calls).every(c => c.method === 'GET')).toBe(true);
  });

  it.each(['head', 'local', 'transaction', 'audit readback'] as const)('rechecks %s before clearing the pending pointer', async failure => {
    const a = await interruptedPull(); const before = a.state.current(); const pointerValue = a.vault.internal.get(pointer);
    const write = a.vault.writeInternal.bind(a.vault);
    vi.spyOn(a.vault, 'writeInternal').mockImplementation(async (path, text) => {
      await write(path, text);
      if (!path.includes('/fresh-preview-')) return;
      if (failure === 'head') a.remote.external(Object.fromEntries(Object.keys(a.remote.contents()).map(p => [p, a.remote.text(p)])));
      if (failure === 'local') a.vault.files.set('note.md', bytes('edit during review'));
      if (failure === 'transaction') { a.t.phase = 'verified'; await a.service.transactions.save(a.t); }
      if (failure === 'audit readback') a.vault.internal.set(path, 'torn');
    });
    await expect(a.service.startFreshPreviewFromCurrentHead(options, 'test')).rejects.toThrow();
    expect(a.state.current()).toEqual(before); expect(a.vault.internal.get(pointer)).toBe(pointerValue);
    expect(a.vault.files.get('note.md')).toEqual(bytes(failure === 'local' ? 'edit during review' : 'mobile edit'));
  });
});
