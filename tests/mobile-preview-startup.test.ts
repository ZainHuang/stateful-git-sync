import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import LocalMirrorSyncPlugin from '../src/main';
import { PreviewError, safeError } from '../src/errors';
import type { Progress } from '../src/vault/VaultScanner';
import { target } from './helpers';

vi.mock('obsidian', () => {
  class Plugin {
    constructor(public app: unknown) {}
    loadData() { return Promise.resolve(target); }
    registerEvent() {} registerView() {} registerDomEvent() {} addSettingTab() {} addCommand() {}
    addRibbonIcon() { return { addClass() {}, setAttribute() {} }; }
  }
  return { Plugin, Modal: class {}, ItemView: class {}, PluginSettingTab: class {}, Setting: class {}, Notice: class {}, TFile: class {},
    Platform: { isMobile: true, isAndroidApp: true }, requestUrl: vi.fn(), setIcon: vi.fn() };
});
vi.mock('../src/ui/PreviewModal', () => ({
  PreviewModal: class {
    messages: string[] = []; controller = new AbortController(); outcome = vi.fn(); pending?: Promise<void>;
    constructor(_app: unknown, _target: unknown, private run: (progress: Progress, signal: AbortSignal) => Promise<unknown>) {}
    onClose() { this.controller.abort(); }
    close() { this.onClose(); }
    open() { this.pending = this.run(message => this.messages.push(message), this.controller.signal)
      .then(value => { this.outcome(value); }, error => { this.outcome(safeError(error)); }); }
  },
}));

type PendingPlugin = { metadataPending: Promise<unknown>; productPending: Promise<unknown>; previewModal: {
  messages: string[]; outcome: ReturnType<typeof vi.fn>; pending: Promise<void>; close(): void;
} };
async function setup() {
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('document', { hidden: false });
  const disk = new Map<string, string>(); const listeners = new Map<string, (file: { path: string }, oldPath?: string) => void>();
  const ready: (() => void)[] = [];
  const write = vi.fn(async (path: string, contents: string) => { disk.set(path, contents); });
  const app = { vault: { configDir: '.obsidian', adapter: {
    exists: async (path: string) => disk.has(path), read: async (path: string) => disk.get(path), write,
    mkdir: async (path: string) => { disk.set(path, ''); },
  }, on: (event: string, callback: (file: { path: string }, oldPath?: string) => void) => { listeners.set(event, callback); return {}; } },
  workspace: { onLayoutReady: (callback: () => void) => { ready.push(callback); } },
  } as unknown as App;
  const plugin = new LocalMirrorSyncPlugin(app, { id: 'local-mirror-sync', name: 'Stateful Git Sync', version: 'test', minAppVersion: '1.6.0',
    author: 'fixture', description: 'Isolated startup test' });
  plugin.refreshDashboard = vi.fn(); await plugin.onload(); write.mockClear();
  const pending = plugin as unknown as PendingPlugin;
  const drain = async () => { await pending.metadataPending; await pending.productPending; };
  return { plugin, pending, listeners, ready, write, drain };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Android Preview startup events', () => {
  it('ignores content-only edits outside the sync scope while retaining ignored-file identity events', async () => {
    const a = await setup(); a.plugin.settings.ignorePatterns = '/02_工作空间/';
    a.listeners.get('modify')?.({ path: '02_工作空间/笔记.md' }); await a.drain();
    expect(a.write).not.toHaveBeenCalled(); expect(a.plugin.product.revision).toBe(0);
    const file = { fileId: 'ignored', path: '02_工作空间/笔记.md', deleted: false };
    await a.plugin.syncState.save({ ...a.plugin.syncState.current(), localFiles: { [file.fileId]: file } });
    a.listeners.get('rename')?.({ path: '02_工作空间/改名.md' }, '02_工作空间/笔记.md'); await a.drain();
    expect(a.plugin.syncState.current().localFiles![file.fileId]?.path).toBe('02_工作空间/改名.md');
    expect(a.plugin.product.revision).toBe(0); a.plugin.onunload();
  });
  it('does not enqueue identity/cache writes for existing files announced during Vault startup', async () => {
    const a = await setup(); const before = a.plugin.syncState.current();
    for (let n = 0; n < 100; n++) a.listeners.get('create')?.({ path: `existing/${n}.md` });
    await a.drain();
    expect(a.write.mock.calls.length).toBe(0);
    expect(a.plugin.product.revision).toBe(0);
    expect(a.plugin.syncState.current()).toEqual(before);
  });
  it('records real create/rename/delete events after layout ready and retains fresh identities for recreated paths', async () => {
    const a = await setup(); const initial = a.plugin.syncState.current();
    await a.plugin.syncState.save({ ...initial, localFiles: { old: { fileId: 'old', path: 'note.md', deleted: true } } });
    a.ready.forEach(callback => callback());
    a.listeners.get('create')?.({ path: 'note.md' }); await a.drain();
    const fresh = Object.values(a.plugin.syncState.current().localFiles!).find(entry => !entry.deleted)!;
    expect(fresh.fileId).not.toBe('old'); expect(fresh.path).toBe('note.md');
    a.listeners.get('rename')?.({ path: 'renamed.md' }, 'note.md'); await a.drain();
    expect(a.plugin.syncState.current().localFiles![fresh.fileId]?.path).toBe('renamed.md');
    a.listeners.get('delete')?.({ path: 'renamed.md' }); await a.drain();
    expect(a.plugin.syncState.current().localFiles![fresh.fileId]?.deleted).toBe(true);
    expect(a.plugin.syncState.current().localFiles!.old?.deleted).toBe(true);
  });
  it('does not attach a delayed create handler after plugin unload', async () => {
    const a = await setup(); a.plugin.onunload(); a.ready.forEach(callback => callback());
    expect(a.listeners.has('create')).toBe(false);
  });
});

describe('Preview preflight waits', () => {
  it('queues a recoverable manual Preview error without disabling automatic sync or retaining Error', async () => {
    const a = await setup(); vi.useFakeTimers(); a.plugin.settings.autoSync = true;
    const preview = vi.spyOn(a.plugin.sync, 'preview').mockRejectedValue(new PreviewError('LOCAL_SCAN', 'LOCAL_CHANGED', 'Editing during Preview'));
    a.plugin.openPreview(); await a.pending.previewModal.pending;
    expect(a.plugin.settings.autoSync).toBe(true);
    expect(a.plugin.product.snapshot().auto).toMatchObject({ result: 'Waiting to retry', scheduledAt: Date.now() + 30000 });
    expect(a.plugin.product.activitySnapshot()).toMatchObject({ running: false, retrying: true });
    expect(a.plugin.product.activitySnapshot().error).toBeUndefined();
    await vi.advanceTimersByTimeAsync(30000); expect(preview).toHaveBeenCalledTimes(2);
    expect(a.plugin.product.snapshot().auto.result).toBe('Waiting to retry'); a.plugin.onunload();
  });
  it('identifies and times out pending local metadata without bypassing the queue or starting sync', async () => {
    const a = await setup(); vi.useFakeTimers();
    const saving = new Promise(() => {}); a.pending.metadataPending = saving;
    const preview = vi.spyOn(a.plugin.sync, 'preview'); a.plugin.openPreview();
    await vi.advanceTimersByTimeAsync(30_000);
    const modal = a.pending.previewModal;
    expect(modal.messages).toContain('Waiting for local file identity updates');
    expect(modal.outcome).toHaveBeenCalledWith(expect.stringContaining('LOCAL_STATE · READ_TIMEOUT'));
    expect(a.pending.metadataPending).toBe(saving); expect(preview).not.toHaveBeenCalled();
    await modal.pending; expect(vi.getTimerCount()).toBe(0);
  });
  it('Cancel stops waiting for metadata immediately and starts no scan/network work', async () => {
    const a = await setup(); vi.useFakeTimers(); a.pending.metadataPending = new Promise(() => {});
    const preview = vi.spyOn(a.plugin.sync, 'preview'); a.plugin.openPreview();
    const modal = a.pending.previewModal; modal.close(); await vi.advanceTimersByTimeAsync(0);
    expect(modal.outcome).toHaveBeenCalledWith(expect.stringContaining('CANCELLED'));
    expect(preview).not.toHaveBeenCalled(); await modal.pending; expect(vi.getTimerCount()).toBe(0);
  });
  it('times out pending recovery reads, releases the Preview lock and keeps BASE unchanged', async () => {
    const a = await setup(); vi.useFakeTimers(); const before = a.plugin.syncState.current();
    vi.spyOn(a.plugin.sync.transactions, 'active').mockImplementation(() => new Promise(() => {}));
    const outcome = vi.fn();
    const pending = a.plugin.sync.preview({ ...target, includeObsidian: false, ignorePatterns: '', deleteSafetyThreshold: 20 }, '')
      .then(value => outcome(value), error => outcome(safeError(error)));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(outcome).toHaveBeenCalledWith(expect.stringContaining('RECOVERY · READ_TIMEOUT'));
    await pending; expect(a.plugin.sync.running).toBe(false);
    expect(a.plugin.syncState.current()).toEqual(before); expect(a.write.mock.calls.length).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
