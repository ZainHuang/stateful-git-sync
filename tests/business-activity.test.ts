import { describe, expect, it } from 'vitest';
import { BUSINESS_STAGES, businessStage, activityIndicator } from '../src/product/SyncActivity';
import type { ActivitySnapshot, ActivityStage } from '../src/product/SyncActivity';
import { ProductStore, type ProductCache } from '../src/product/ProductStore';
const cache: ProductCache = { status: 'Healthy', currentDevice: { deviceId: 'device', deviceName: 'test', deviceType: 'desktop' }, devices: [], auto: { result: 'Verified' } };
describe('V1.2 three business stages from the existing activity events', () => {
  it('has exactly the requested labels and maps every technical step without estimated percentages', () => {
    expect(BUSINESS_STAGES).toEqual(['检查差异', '同步文件', '安全校验']);
    const examples: [ActivityStage, string][] = [['Scan local', '检查差异'], ['Read remote', '检查差异'], ['Revalidate', '检查差异'], ['Stage recovery copies', '同步文件'], ['Publish', '同步文件'], ['Apply local', '同步文件'], ['Verify local', '安全校验'], ['Save BASE', '安全校验']];
    examples.forEach(([stage, label]) => expect(businessStage(stage)).toBe(label));
  });
  it('keeps a static Verified result after completion and carries the exact verification level', () => {
    const a: ActivitySnapshot = { running: false, verified: true, steps: [], stage: 'Complete', startedAt: 0, endedAt: 100, verification: 'Incremental Verified' };
    expect(activityIndicator(cache, a, 1_000_000)).toMatchObject({ label: 'Verified', animated: false, destination: 'activity' });
  });
  it('shows actual file counts and elapsed time during a phase', () => {
    const a: ActivitySnapshot = { running: true, verified: false, steps: [], stage: 'Verify local', startedAt: 1000, operation: 'sync', processed: 3, total: 10 };
    const status = activityIndicator(cache, a, 6500); expect(status.label).toContain('安全校验'); expect(status.label).toContain('3 / 10'); expect(status.label).toContain('5s'); expect(status.label).not.toContain('%');
  });
  it('prioritizes actionable Recovery and conflict over a stale verified badge', () => {
    const a: ActivitySnapshot = { running: false, verified: true, steps: [] };
    expect(activityIndicator({ ...cache, status: 'Recovery Required' }, a).destination).toBe('recovery');
    expect(activityIndicator({ ...cache, status: 'Conflict' }, a).destination).toBe('preview');
  });
  it('clears the shared Verified display on later edits while preserving a running phase', async () => {
    const values = new Map<string, string>();
    const store = new ProductStore({ read: async p => values.get(p) ?? null, write: async (p, s) => { values.set(p, s); } });
    await store.load(crypto.randomUUID(), 'test', 'desktop');
    store.activity({ type: 'start', operation: 'sync' }); store.activity({ type: 'stage', stage: 'Complete' }); store.activity({ type: 'end' });
    expect(store.activitySnapshot().verified).toBe(true); await store.dirty();
    expect(store.activitySnapshot()).toMatchObject({ verified: false, pendingChanges: true });
    store.activity({ type: 'start', operation: 'sync' }); store.activity({ type: 'stage', stage: 'Publish' }); await store.dirty();
    expect(store.activitySnapshot()).toMatchObject({ running: true, stage: 'Publish', verified: false });
    expect(store.activitySnapshot().pendingChanges).toBeUndefined();
  });
});
