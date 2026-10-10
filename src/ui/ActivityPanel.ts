import { Modal, type App } from 'obsidian';
import type LocalMirrorSyncPlugin from '../main';
import { SyncProgressView } from './SyncProgressView';
import { keepModalAboveKeyboard } from './MobileModalViewport';

/** Subscribes through the plugin's existing ProductStore callback; no IO. */
export class ActivityPanel extends Modal {
  private flow?: SyncProgressView;
  private error?: HTMLElement;
  private heading?: HTMLElement;
  private releaseViewport?: () => void;
  constructor(app: App, private readonly plugin: LocalMirrorSyncPlugin) { super(app); }
  onOpen(): void {
    this.modalEl.addClasses(['lms-modal', 'lms-activity-dialog']); this.setTitle('Sync activity');
    this.contentEl.addClass('lms-activity-panel');
    this.heading = this.contentEl.createEl('p', { cls: 'lms-activity-health', attr: { role: 'status', 'aria-live': 'polite' } });
    this.flow = new SyncProgressView(this.contentEl);
    this.error = this.contentEl.createEl('p', { cls: 'lms-warning lms-activity-error', attr: { role: 'alert' } });
    this.releaseViewport = keepModalAboveKeyboard(this);
    const actions = this.contentEl.createDiv({ cls: 'lms-device-actions' });
    actions.createEl('button', { text: 'Review in Preview' }).onclick = () => { this.close(); this.plugin.openPreview(); };
    actions.createEl('button', { text: 'Recovery' }).onclick = () => { this.close(); this.plugin.openRecovery(); };
    actions.createEl('button', { text: 'Dashboard' }).onclick = () => { this.close(); void this.plugin.openDashboard(); };
    this.render();
  }
  render(): void {
    if (!this.contentEl.isConnected) return;
    const a = this.plugin.product.activitySnapshot(); const cache = this.plugin.product.snapshot();
    const indicator = this.plugin.activityStatus();
    this.heading?.setText(a.running || a.verified && !a.error ? '' : indicator.label);
    this.heading?.toggleClass('lms-hidden', a.running || a.verified && !a.error);
    this.contentEl.querySelectorAll<HTMLButtonElement>('.lms-device-actions button').forEach(b => { b.disabled = a.running && b.textContent !== 'Dashboard'; });
    const error = a.error ?? cache.auto.reason;
    this.error?.setText(error ? `Recent error / review: ${error}` : '');
    this.error?.toggleClass('lms-hidden', !error);
    this.flow?.render(a);
  }
  onClose(): void { this.releaseViewport?.(); this.contentEl.empty(); }
}
