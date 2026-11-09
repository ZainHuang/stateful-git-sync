import { BUSINESS_STAGES, businessStage, type ActivitySnapshot } from '../product/SyncActivity';
import type { PerformanceOperation } from '../product/SyncPerformance';
const OPERATION_LABELS: Record<PerformanceOperation, string> = { 'Directory listing': '列目录', 'File metadata': '查文件信息', 'Content read': '读文件内容',
  'Content hash': '内容哈希', 'Metadata hash': '元数据哈希', 'Index lookup': '索引查找', 'Change tracking': '记录变更',
  'Index serialization': '索引序列化', 'Index persistence': '索引写入及读回', 'Transaction history': '历史事务读取' };

/** One presentation of the existing events for Preview, execution and Activity.
 * Details stay closed by default and retain their open state across redraws. */
export class SyncProgressView {
  private readonly root: HTMLElement;
  private readonly current: HTMLElement;
  private readonly elapsed: HTMLElement;
  private readonly rows: HTMLElement[];
  private readonly verification: HTMLElement;
  private readonly technical: HTMLDetailsElement;
  private readonly diagnostics: HTMLElement;
  private readonly message: HTMLElement;
  private signature = '';
  constructor(container: HTMLElement) {
    this.root = container.createDiv({ cls: 'lms-sync-progress' });
    const stages = this.root.createEl('ol', { cls: 'lms-business-stages', attr: { 'aria-label': '同步阶段' } });
    this.rows = BUSINESS_STAGES.map(text => stages.createEl('li', { text }));
    this.current = this.root.createDiv({ cls: 'lms-activity-current', attr: { role: 'status', 'aria-live': 'polite' } });
    this.elapsed = this.root.createEl('p', { cls: 'lms-muted lms-activity-elapsed' });
    this.verification = this.root.createEl('p', { cls: 'lms-verification-level lms-muted' });
    this.technical = this.root.createEl('details', { cls: 'lms-technical-details' });
    this.technical.createEl('summary', { text: '技术详情' });
    this.message = this.technical.createEl('p', { cls: 'lms-technical-message lms-status' });
    this.diagnostics = this.technical.createDiv();
  }
  setMessage(message: string) { this.message.setText(message); }
  private metricTable(headers: string[], rows: string[][], extraClass = '') {
    const table = this.diagnostics.createEl('table', { cls: `lms-performance-table ${extraClass}` });
    const head = table.createEl('thead').createEl('tr'); headers.forEach(text => head.createEl('th', { text }));
    const body = table.createEl('tbody'); rows.forEach(values => { const row = body.createEl('tr'); values.forEach(text => row.createEl('td', { text })); });
  }
  render(a: ActivitySnapshot): void {
    if (!this.root.isConnected) return;
    const now = a.endedAt ?? Date.now(); const stage = businessStage(a.stage);
    const elapsed = a.startedAt === undefined ? undefined : Math.max(0, Math.floor((now - a.startedAt) / 1000));
    this.elapsed.setText(elapsed === undefined ? 'Elapsed unavailable' : `${a.pendingChanges ? '上轮耗时' : '耗时'} ${elapsed}s`);
    const signature = JSON.stringify([a, a.running ? elapsed : undefined]); if (signature === this.signature) return; this.signature = signature;
    const verified = a.verified && !a.error && !a.pendingChanges;
    const count = a.processed !== undefined && a.total !== undefined ? `${a.processed} / ${a.total} files` : '';
    this.current.empty();
    this.current.createEl('strong', { text: a.error ? '需要处理' : a.retrying ? '等待自动重试' : a.pendingChanges ? a.verified ? '本轮已同步，新的修改等待下一轮' : '有新的本地变更' : verified ? 'Verified' : a.stage ? stage : a.running ? BUSINESS_STAGES[0] : 'No activity in this session.' });
    if (count && a.running) this.current.createSpan({ text: count, cls: 'lms-muted' });
    const index = BUSINESS_STAGES.indexOf(stage);
    this.root.toggleClass('lms-sync-verified', verified);
    this.rows.forEach((row, i) => {
      const state = verified || a.running && a.stage && i < index ? 'done' : a.running && i === index ? 'current' : 'pending';
      row.setAttribute('data-state', state); row.setAttribute('aria-current', state === 'current' ? 'step' : 'false');
    });
    const level = a.verification ?? a.performance?.verification;
    this.verification.setText(level ? `${a.pendingChanges ? '上次校验：' : ''}${level}${level === 'Published Snapshot Verified' ? ' · 后续本地变更留待下一轮' : ''}` : '');
    this.diagnostics.empty();
    this.diagnostics.createEl('p', { text: a.stage ?? 'No observed technical stages.', cls: 'lms-technical-current' });
    if (a.generation !== undefined || a.transactionId) {
      const fields = this.diagnostics.createEl('dl', { cls: 'lms-dashboard-fields' });
      if (a.generation !== undefined) { fields.createEl('dt', { text: 'Generation' }); fields.createEl('dd', { text: String(a.generation) }); }
      if (a.transactionId) { fields.createEl('dt', { text: 'Transaction' }); fields.createEl('dd', { text: a.transactionId }); }
    }
    if (a.steps.length) {
      const steps = this.diagnostics.createEl('ol', { cls: 'lms-activity-steps', attr: { 'aria-label': 'Observed lifecycle stages' } });
      a.steps.forEach((step, i) => {
        const last = i === a.steps.length - 1;
        const state = last ? a.error ? 'Stopped' : a.running ? 'In progress' : 'Finished' : 'Done';
        const end = a.steps[i + 1]?.at ?? now;
        const row = steps.createEl('li', { attr: { 'data-state': state } });
        row.createSpan({ text: step.stage }); row.createSpan({ text: `${state} · ${Math.max(0, (end - step.at) / 1000).toFixed(1)}s`, cls: 'lms-muted' });
      });
    }
    if (a.performance) {
      const metrics = a.performance;
      this.metricTable(['Stage', 'ms', 'Files', 'Bytes', 'API'], Object.entries(metrics.stages).map(([stage, m]) =>
        [stage, m.elapsedMs.toFixed(1), String(m.files), String(m.bytes), String(m.apiRequests)]));
      if (metrics.operations) {
        this.diagnostics.createEl('p', { text: metrics.previewOperations ? '操作明细（本轮预览 + 执行）' : '操作明细（当前检查或执行）', cls: 'lms-muted' });
        this.metricTable(['操作', 'ms', '次数', '失败'], Object.entries(metrics.operations).map(([operation, m]) => {
          const before = metrics.previewOperations?.[operation as PerformanceOperation];
          return [OPERATION_LABELS[operation as PerformanceOperation] ?? operation, (m.elapsedMs + (before?.elapsedMs ?? 0)).toFixed(1),
            String(m.calls + (before?.calls ?? 0)), String(m.failures + (before?.failures ?? 0))];
        }), 'lms-operation-performance');
        this.diagnostics.createEl('p', { text: '操作耗时包含等待，部分包含子项，不能直接相加。', cls: 'lms-muted' });
      }
      this.diagnostics.createEl('p', { text: `Reads ${metrics.localReads} · Hash ${metrics.hashBytes} bytes · Reused ${metrics.reusedHashes} · API ${metrics.apiRequests}`, cls: 'lms-muted' });
      if (metrics.reconciliations.length) this.diagnostics.createEl('p', { text: `Full reconciliation: ${metrics.reconciliations.join(', ')}`, cls: 'lms-muted' });
    }
  }
}
