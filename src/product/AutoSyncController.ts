import { isRetryableSyncError, PreviewError, safeError } from '../errors';
import type { Settings } from '../settings/settings';
import type { SyncPreview } from '../sync/execution/SyncService';

export interface AutoStatus { scheduledAt?: number; result: string; lastCheckAt?: string; lastSyncAt?: string; reason?: string }
interface AutoHost {
  settings(): Settings;
  busy(): boolean;
  check(): Promise<{ preview: SyncPreview; block?: string }>;
  execute(preview: SyncPreview): Promise<void>;
  status(status: AutoStatus): unknown;
  retryError(error: unknown): Promise<boolean>;
}

/** Single-flight scheduling with delayed retries, never automatic recovery/resolution. */
export class AutoSyncController {
  private timer?: number;
  private stopped = false;
  private running = false;
  private pending = false;
  private manual = false;
  private state: AutoStatus = { result: 'Waiting for changes' };
  constructor(private readonly host: AutoHost, initial?: AutoStatus,
    private readonly timerWindow: Pick<Window, 'setTimeout' | 'clearTimeout'> = window) {
    if (initial) this.state = { ...initial };
    this.manual = initial?.result === 'Manual confirmation required';
    const saved = initial?.reason?.match(/^([^·]+) · ([A-Z0-9_]+): ([\s\S]*)$/);
    const transient = saved && isRetryableSyncError(new PreviewError(saved[1]!, saved[2]!, saved[3]!));
    if (initial?.result === 'Waiting to retry' || transient && (this.manual || initial?.result === 'Offline')) {
      this.manual = false; this.pending = true; this.state.result = 'Waiting to retry';
      if (this.host.settings().autoSync) this.schedule();
    }
  }
  changed(): void {
    if (this.stopped || !this.host.settings().autoSync || this.manual) return;
    this.pending = true;
    this.schedule();
  }
  private schedule(): void {
    this.timerWindow.clearTimeout(this.timer);
    this.state.scheduledAt = Date.now() + this.host.settings().autoSyncDebounceSeconds * 1000;
    this.reportSchedule();
    this.timer = this.timerWindow.setTimeout(() => { void this.run(); }, this.host.settings().autoSyncDebounceSeconds * 1000);
  }
  private reportSchedule(): void {
    void Promise.resolve(this.host.status({ ...this.state })).catch(() => { this.manual = true; this.timerWindow.clearTimeout(this.timer); });
  }
  configure(): void {
    this.timerWindow.clearTimeout(this.timer);
    if (!this.host.settings().autoSync && this.state.result === 'Waiting to retry') {
      this.state.result = 'Waiting for changes'; this.state.reason = undefined;
    }
    this.state.scheduledAt = undefined; this.reportSchedule();
    if (this.host.settings().autoSync && this.pending && !this.manual) this.schedule();
  }
  reviewed(): void {
    this.manual = false; this.state.result = 'Waiting for changes'; this.state.reason = undefined;
    void Promise.resolve(this.host.status({ ...this.state })).catch(() => { this.manual = true; });
  }
  async retry(error: unknown): Promise<boolean> {
    if (this.stopped || !this.host.settings().autoSync || !isRetryableSyncError(error) || !await this.host.retryError(error)) return false;
    if (this.stopped || !this.host.settings().autoSync) return false;
    this.manual = false; this.pending = true;
    this.state.result = 'Waiting to retry'; this.state.reason = safeError(error);
    if (!this.running) this.schedule();
    return true;
  }
  stop(): void { this.stopped = true; this.pending = false; this.timerWindow.clearTimeout(this.timer); this.state.scheduledAt = undefined; this.reportSchedule(); }
  async run(): Promise<void> {
    this.timerWindow.clearTimeout(this.timer); this.state.scheduledAt = undefined;
    if (this.stopped || !this.host.settings().autoSync || this.manual) return;
    if (this.running || this.host.busy()) { this.pending = true; this.schedule(); return; }
    this.running = true; this.pending = false;
    const settingsKey = JSON.stringify(this.host.settings());
    this.state = { ...this.state, lastCheckAt: new Date().toISOString(), result: 'Checking', reason: undefined };
    try {
      await this.host.status({ ...this.state });
      const { preview, block } = await this.host.check();
      if (this.stopped || !this.host.settings().autoSync) return;
      if (settingsKey !== JSON.stringify(this.host.settings())) throw new PreviewError('AUTO', 'SETTINGS_CHANGED', 'Settings changed during automatic Preview. Review the new plan.');
      if (block) { this.manual = true; this.state.result = 'Manual confirmation required'; this.state.reason = block; }
      else if (!preview.plan.entries.some(e => /^(PUSH|PULL)_/.test(e.category))) this.state.result = 'Up to date';
      else {
        this.state.result = 'Syncing'; await this.host.status({ ...this.state });
        await this.host.execute(preview);
        this.state.result = 'Verified'; this.state.lastSyncAt = new Date().toISOString();
      }
    } catch (error) {
      if (!await this.retry(error)) {
        this.manual = true; this.state.result = 'Manual confirmation required'; this.state.reason = safeError(error);
      }
    } finally {
      this.running = false;
      // A reporting failure must never start an unhandled background rejection.
      if (!this.stopped) { try { await this.host.status({ ...this.state }); } catch { this.manual = true; } }
      if (this.pending && !this.stopped && !this.manual && this.host.settings().autoSync) this.schedule();
    }
  }
}
