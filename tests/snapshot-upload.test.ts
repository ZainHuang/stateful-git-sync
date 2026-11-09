import { afterEach, describe, expect, it, vi } from 'vitest';
import { indexedDevice, v12Options } from './v12-harness';
import { SyncService } from '../src/sync/execution/SyncService';
import { ProductStore } from '../src/product/ProductStore';
import { AutoSyncController, type AutoStatus } from '../src/product/AutoSyncController';
import { DEFAULT_SETTINGS } from '../src/settings/settings';
import { PreviewError } from '../src/errors';
import { bytes } from './helpers';

async function device() {
  const a = await indexedDevice({ 'A.md': 'original', 'B.md': 'other', 'image.bin': 'binary' }); await a.run();
  const product = new ProductStore({ read: p => a.vault.readInternal(p), write: (p, s) => a.vault.writeInternal(p, s) });
  await product.load(a.state.current().deviceId, 'Snapshot test', 'desktop');
  const service = new SyncService(a.vault, r => a.remote.transport(r), '.obsidian', a.state, product, a.index);
  const run = async () => service.execute(await service.preview(v12Options, 'fixture'), 'fixture');
  return { ...a, service, product, run };
}
afterEach(() => vi.useRealTimers());

describe('Editing during snapshot uploads', () => {
  it('reuses a verified event watermark instead of recursively listing unchanged upload directories again', async () => {
    const a = await device(); a.edit('nested/A.md', 'snapshot');
    const p = await a.service.preview(v12Options, 'fixture'); a.vault.listings = [];
    await a.service.execute(p, 'fixture');
    expect(a.vault.listings.filter(path => !path.startsWith('.local-mirror-sync/'))).toEqual([]);
    expect(a.remote.text('nested/A.md')).toBe('snapshot');
  });
  it('does not reuse the scan when a file event arrives after Preview', async () => {
    const a = await device(); a.edit('A.md', 'snapshot'); const p = await a.service.preview(v12Options, 'fixture');
    a.edit('A.md', 'newer before snapshot'); const calls = a.remote.calls.length;
    await expect(a.service.execute(p, 'fixture')).rejects.toMatchObject({ code: 'LOCAL_CHANGED' });
    expect(await a.service.transactions.active()).toBeNull(); expect(a.remote.calls.slice(calls).every(c => c.method === 'GET')).toBe(true);
    expect(await a.service.retryableError(new PreviewError('SYNC', 'LOCAL_CHANGED', 'changed'))).toBe(true);
    await a.run(); expect(a.remote.text('A.md')).toBe('newer before snapshot');
  });
  it('invalidates checkpoint reuse after lifecycle invalidation, even if content changes have no event', async () => {
    const a = await device(); a.edit('A.md', 'snapshot'); const p = await a.service.preview(v12Options, 'fixture');
    a.index.invalidate('mobile-resume'); a.vault.files.set('B.md', bytes('unobserved edit')); const calls = a.remote.calls.length;
    await expect(a.service.execute(p, 'fixture')).rejects.toMatchObject({ code: 'LOCAL_CHANGED' });
    expect(await a.service.transactions.active()).toBeNull(); expect(a.remote.calls.slice(calls).every(c => c.method === 'GET')).toBe(true);
  });
  it('still checks ignore rules and staged content when the event watermark is unchanged', async () => {
    for (const path of ['.gitignore', 'A.md']) {
      const a = await device(); a.edit('A.md', 'snapshot'); const p = await a.service.preview(v12Options, 'fixture');
      a.vault.files.set(path, bytes(path === '.gitignore' ? '*.md' : 'unobserved edit')); const calls = a.remote.calls.length;
      await expect(a.service.execute(p, 'fixture')).rejects.toMatchObject({ code: 'LOCAL_CHANGED' });
      expect(await a.service.transactions.active()).toBeNull(); expect(a.remote.calls.slice(calls).every(c => c.method === 'GET')).toBe(true);
    }
  });
  it('retains final local verification for a no-op, including additions without events', async () => {
    const a = await device(); const p = await a.service.preview(v12Options, 'fixture'); const write = a.vault.writeInternal.bind(a.vault);
    vi.spyOn(a.vault, 'writeInternal').mockImplementation(async (path, text) => {
      if (path.endsWith('/active.json') && text !== 'null') a.vault.files.set('unobserved.md', bytes('never discard'));
      await write(path, text);
    });
    await expect(a.service.execute(p, 'fixture')).rejects.toMatchObject({ code: 'LOCAL_VERIFY_FAILED' });
    expect(a.vault.files.get('unobserved.md')).toEqual(bytes('never discard')); expect(await a.service.transactions.active()).not.toBeNull();
  });
  it('never automatically retries LOCAL_CHANGED when a durable transaction is active', async () => {
    const a = await device(); a.edit('A.md', 'snapshot'); const p = await a.service.preview(v12Options, 'fixture');
    a.remote.losePatchResponse = true; await expect(a.service.execute(p, 'fixture')).rejects.toThrow();
    expect(await a.service.retryableError(new PreviewError('SYNC', 'LOCAL_CHANGED', 'changed'))).toBe(false);
    a.edit('A.md', 'later while offline'); const commits = a.remote.calls.filter(c => c.method === 'POST' && c.resource === 'commits').length;
    await a.service.resume(v12Options, 'fixture'); expect(a.vault.files.get('A.md')).toEqual(bytes('later while offline'));
    expect(a.remote.text('A.md')).toBe('snapshot'); expect(a.remote.calls.filter(c => c.method === 'POST' && c.resource === 'commits')).toHaveLength(commits);
    await a.run(); expect(a.remote.text('A.md')).toBe('later while offline');
  });
  it.each(['blobs', 'trees', 'commits', 'publish', 'verify', 'finalize'])('keeps later edits queued during %s and publishes only the frozen bytes', async checkpoint => {
    const a = await device(); a.edit('A.md', 'snapshot'); a.edit('image.bin', 'snapshot binary');
    const preview = await a.service.preview(v12Options, 'fixture');
    let edited = false;
    const edit = () => { if (edited) return; edited = true; a.edit('A.md', 'later'); a.edit('B.md', 'later other'); a.edit('new.md', 'later addition'); a.edit('image.bin', 'later binary'); };
    const transport = a.remote.transport;
    a.remote.transport = async r => {
      const resource = r.url.split('/git/')[1]!;
      if (r.method === 'POST' && resource === checkpoint || checkpoint === 'verify' && r.method === 'GET' && edited === false && a.remote.text('A.md') === 'snapshot') edit();
      return transport(r);
    };
    if (checkpoint === 'publish') a.remote.beforePatch = edit;
    const write = a.vault.writeInternal.bind(a.vault);
    if (checkpoint === 'finalize') vi.spyOn(a.vault, 'writeInternal').mockImplementation(async (p, s) => { if (p.endsWith('/active.json') && s === 'null') edit(); await write(p, s); });
    await a.service.execute(preview, 'fixture');
    expect(edited).toBe(true); expect(a.remote.text('A.md')).toBe('snapshot'); expect(a.remote.text('image.bin')).toBe('snapshot binary');
    expect(a.vault.files.get('A.md')).toEqual(bytes('later')); expect(a.remote.contents()['new.md']).toBeUndefined();
    expect(a.index.snapshot().dirtyPaths).toEqual(expect.arrayContaining(['A.md', 'B.md', 'new.md', 'image.bin']));
    expect(a.product.activitySnapshot()).toMatchObject({ verified: true, pendingChanges: true, verification: 'Published Snapshot Verified' });
    expect(a.product.snapshot().status).toBe('Sync Required'); expect(await a.service.transactions.active()).toBeNull();
    expect(a.state.current().baseRemoteCommit).toBe(a.remote.head);
    await a.run();
    expect(a.remote.text('A.md')).toBe('later'); expect(a.remote.text('B.md')).toBe('later other'); expect(a.remote.text('new.md')).toBe('later addition');
    expect(a.remote.text('image.bin')).toBe('later binary'); expect(a.product.activitySnapshot().pendingChanges).toBe(false);
  });
  it('queues a rename and deletion during upload and preserves identity for the next round', async () => {
    const a = await device(); const id = Object.values(a.state.current().baseManifest!.files).find(f => f.path === 'A.md')!.fileId;
    a.edit('A.md', 'snapshot'); const p = await a.service.preview(v12Options, 'fixture');
    a.remote.beforePatch = () => {
      a.vault.files.set('moved.md', bytes('later renamed edit')); a.vault.files.delete('A.md'); a.vault.files.delete('B.md');
      a.index.record('rename', 'moved.md', 'A.md', true); a.index.record('delete', 'B.md', undefined, true);
    };
    await a.service.execute(p, 'fixture');
    expect(a.remote.text('A.md')).toBe('snapshot'); expect(a.vault.files.has('A.md')).toBe(false);
    await a.index.flush(); await a.index.load();
    for (const e of a.index.identityEvents()) {
      if (e.kind === 'rename') await a.state.recordRename(e.oldPath!, e.path);
      else if (e.kind === 'delete') await a.state.recordDelete(e.path);
      a.index.acknowledgeIdentity(e.revision);
    }
    await a.run(); expect(a.state.current().baseManifest!.files[id]!.path).toBe('moved.md');
    expect(a.remote.text('moved.md')).toBe('later renamed edit'); expect(a.remote.contents()['A.md']).toBeUndefined(); expect(a.remote.contents()['B.md']).toBeUndefined();
  });
  it('retains strict protection for a mixed download when the incoming file is edited locally', async () => {
    const a = await device(); const b = await indexedDevice({}, a.remote); await b.run(); b.edit('B.md', 'remote'); await b.run();
    a.edit('A.md', 'push'); const p = await a.service.preview(v12Options, 'fixture'); const base = a.state.current().baseRemoteCommit;
    a.remote.beforePatch = () => a.edit('B.md', 'local during download');
    await expect(a.service.execute(p, 'fixture')).rejects.toThrow();
    expect(a.vault.files.get('B.md')).toEqual(bytes('local during download')); expect(a.state.current().baseRemoteCommit).toBe(base);
    expect(await a.service.transactions.active()).not.toBeNull();
  });
  it('requeues a pre-snapshot edit without latching automatic sync into manual review', async () => {
    const a = await device(); a.edit('A.md', 'snapshot'); vi.useFakeTimers();
    const statuses: AutoStatus[] = []; let first = true;
    const auto = new AutoSyncController({ settings: () => ({ ...DEFAULT_SETTINGS, autoSync: true }), busy: () => a.service.running,
      check: async () => { if (first) { first = false; throw new PreviewError('LOCAL_SCAN', 'LOCAL_CHANGED', 'editing'); } return { preview: await a.service.preview(v12Options, 'fixture') }; },
      execute: p => a.service.execute(p, 'fixture'), status: s => { statuses.push(s); }, retryError: error => a.service.retryableError(error) }, undefined, globalThis as unknown as Window);
    await auto.run(); expect(statuses.at(-1)?.result).toBe('Waiting to retry'); expect(statuses.at(-1)?.scheduledAt).toBeDefined();
    await vi.advanceTimersByTimeAsync(30000); expect(a.remote.text('A.md')).toBe('snapshot'); expect(statuses.at(-1)?.result).toBe('Verified'); auto.stop();
  });
});
