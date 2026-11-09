import { afterEach, describe, expect, it, vi } from 'vitest';
import { PreviewError } from '../src/errors';
import { AutoSyncController, type AutoStatus } from '../src/product/AutoSyncController';
import { ProductStore } from '../src/product/ProductStore';
import { activityIndicator } from '../src/product/SyncActivity';
import { DEFAULT_SETTINGS } from '../src/settings/settings';
import { SyncService } from '../src/sync/execution/SyncService';
import { indexedDevice, v12Options } from './v12-harness';

async function setup() {
  const a = await indexedDevice({ 'A.md': 'original' }); await a.run();
  const product = new ProductStore({ read: p => a.vault.readInternal(p), write: (p, s) => a.vault.writeInternal(p, s) });
  await product.load(a.state.current().deviceId, 'Retry test', 'desktop');
  const service = new SyncService(a.vault, r => a.remote.transport(r), '.obsidian', a.state, product, a.index);
  const check = async () => ({ preview: await service.preview(v12Options, 'fixture') });
  await service.execute((await check()).preview, 'fixture');
  const settings = { ...DEFAULT_SETTINGS, autoSync: true };
  const statuses: AutoStatus[] = [];
  const createAuto = (runCheck = check, initial?: AutoStatus) => new AutoSyncController({
    settings: () => settings, busy: () => service.running, check: runCheck,
    execute: p => service.execute(p, 'fixture'), retryError: e => service.retryableError(e),
    status: async s => { statuses.push(s); await product.auto(s); },
  }, initial, globalThis as unknown as Window);
  return { ...a, service, product, settings, statuses, check, createAuto };
}

afterEach(() => vi.useRealTimers());

describe('Automatic retry after recoverable sync failures', () => {
  it('retries a real scan/event collision from a Healthy state and replaces Error with a retry countdown', async () => {
    const a = await setup(); a.edit('A.md', 'pending upload'); await a.index.flush();
    const read = a.vault.readBinary.bind(a.vault); let collided = false;
    vi.spyOn(a.vault, 'readBinary').mockImplementation(async path => {
      const value = await read(path);
      if (path === 'A.md' && !collided) { collided = true; a.index.record('modify', path); }
      return value;
    });
    vi.useFakeTimers(); const auto = a.createAuto(); await auto.run();
    expect(collided).toBe(true); expect(a.settings.autoSync).toBe(true);
    expect(a.statuses.at(-1)).toMatchObject({ result: 'Waiting to retry', scheduledAt: Date.now() + 30000 });
    expect(a.product.activitySnapshot()).toMatchObject({ running: false, verified: false, retrying: true });
    expect(a.product.activitySnapshot().error).toBeUndefined();
    expect(activityIndicator(a.product.snapshot(), a.product.activitySnapshot()).label).toContain('等待自动重试');
    expect(await a.service.transactions.active()).toBeNull();
    await vi.advanceTimersByTimeAsync(30000);
    expect(a.remote.text('A.md')).toBe('pending upload'); expect(a.statuses.at(-1)?.result).toBe('Verified');
    expect(a.product.activitySnapshot().retrying).toBeFalsy(); auto.stop();
  });

  it.each(['NETWORK_ERROR', 'NETWORK_TIMEOUT', 'READ_TIMEOUT', 'HTTP_408', 'HTTP_429', 'HTTP_503'])('retries %s on a timer without requiring another file event', async code => {
    const a = await setup(); a.edit('A.md', 'latest'); await a.index.flush();
    let remaining = 2;
    const check = async () => { if (remaining-- > 0) throw new PreviewError('REMOTE_HEAD', code, 'Temporary failure'); return a.check(); };
    vi.useFakeTimers(); const auto = a.createAuto(check); await auto.run();
    expect(a.statuses.at(-1)?.result).toBe('Waiting to retry'); expect(a.remote.text('A.md')).toBe('original');
    await vi.advanceTimersByTimeAsync(30000); expect(a.statuses.at(-1)?.result).toBe('Waiting to retry');
    await vi.advanceTimersByTimeAsync(30000);
    expect(a.remote.text('A.md')).toBe('latest'); expect(a.statuses.at(-1)?.result).toBe('Verified');
    expect(a.settings.autoSync).toBe(true); auto.stop();
  });

  it('restores a saved retry after reload without restoring a previously running operation', async () => {
    const a = await setup(); a.edit('A.md', 'after restart'); await a.index.flush(); vi.useFakeTimers();
    const auto = a.createAuto(undefined, { result: 'Waiting to retry', reason: 'LOCAL_SCAN · LOCAL_CHANGED: Editing' });
    expect(a.statuses.at(-1)?.scheduledAt).toBe(Date.now() + 30000);
    await vi.advanceTimersByTimeAsync(30000);
    expect(a.remote.text('A.md')).toBe('after restart'); expect(a.statuses.at(-1)?.result).toBe('Verified'); auto.stop();
  });

  it('can leave a legacy transient-error latch while retaining a real review latch', async () => {
    const a = await setup(); vi.useFakeTimers();
    const retry = a.createAuto(undefined, { result: 'Manual confirmation required', reason: 'LOCAL_SCAN · LOCAL_CHANGED: Editing' });
    expect(a.statuses.at(-1)?.result).toBe('Waiting to retry'); retry.stop();
    const check = vi.fn(a.check);
    const review = a.createAuto(check, { result: 'Manual confirmation required', reason: 'Delete threshold requires manual confirmation.' });
    await review.run(); await vi.advanceTimersByTimeAsync(60000); expect(check).not.toHaveBeenCalled(); review.stop();
  });

  it('does not retry an uncertain publication with a retained transaction or bypass recovery', async () => {
    const a = await setup(); a.edit('A.md', 'uncertain'); a.remote.losePatchResponse = true;
    await expect(a.service.execute((await a.check()).preview, 'fixture')).rejects.toThrow();
    expect(await a.service.transactions.active()).not.toBeNull();
    const calls = a.remote.calls.length; vi.useFakeTimers();
    const auto = a.createAuto(async () => { throw new PreviewError('SYNC', 'NETWORK_UNCERTAIN', 'Publication needs recovery'); });
    await auto.run(); expect(a.statuses.at(-1)?.result).toBe('Manual confirmation required');
    expect(a.statuses.at(-1)?.scheduledAt).toBeUndefined();
    await vi.advanceTimersByTimeAsync(60000); expect(a.remote.calls).toHaveLength(calls); auto.stop();
  });

  it('cancels a queued retry when the user disables automatic sync', async () => {
    const a = await setup(); const check = vi.fn(async () => { throw new PreviewError('REMOTE_HEAD', 'NETWORK_ERROR', 'Offline'); });
    vi.useFakeTimers(); const auto = a.createAuto(check); await auto.run();
    a.settings.autoSync = false; auto.configure();
    expect(a.statuses.at(-1)?.scheduledAt).toBeUndefined();
    await vi.advanceTimersByTimeAsync(60000); expect(check).toHaveBeenCalledOnce(); auto.stop();
  });
});
