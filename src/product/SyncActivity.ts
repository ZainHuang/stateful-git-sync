import type { ProductCache } from './ProductStore';
import type { PerformanceSnapshot, VerificationLevel } from './SyncPerformance';

export type ActivityStage = 'Scan local' | 'Read remote' | 'Build plan' | 'Revalidate' | 'Stage recovery copies' | 'Backup remote' | 'Upload blobs' | 'Create tree' | 'Create commit' | 'Check candidate' | 'Publish' | 'Verify remote' | 'Apply local' | 'Verify local' | 'Save BASE' | 'Finalize transaction' | 'Complete';
export interface ActivitySnapshot {
  running: boolean; operation?: 'preview' | 'sync'; stage?: ActivityStage;
  steps: { stage: ActivityStage; at: number }[];
  startedAt?: number; endedAt?: number; transactionId?: string; generation?: number;
  processed?: number; total?: number; error?: string; verified: boolean; review?: boolean;
  performance?: PerformanceSnapshot; verification?: VerificationLevel; pendingChanges?: boolean;
}
export type ActivityEvent =
  | { type: 'start'; operation: 'preview' | 'sync' }
  | { type: 'stage'; stage: ActivityStage; processed?: number; total?: number; transactionId?: string; generation?: number; completedSteps?: ActivitySnapshot['steps'] }
  | { type: 'end'; error?: string; performance?: PerformanceSnapshot; pendingChanges?: boolean };

export const BUSINESS_STAGES = ['检查差异', '同步文件', '安全校验'] as const;
export function businessStage(stage?: ActivityStage): typeof BUSINESS_STAGES[number] {
  if (!stage || ['Scan local', 'Read remote', 'Build plan', 'Revalidate'].includes(stage)) return BUSINESS_STAGES[0];
  if (['Verify local', 'Save BASE', 'Finalize transaction', 'Complete'].includes(stage)) return BUSINESS_STAGES[2];
  return BUSINESS_STAGES[1];
}

/** Pure presentation of existing ProductStore data. Never authorizes execution. */
export function activityIndicator(cache: ProductCache, activity: ActivitySnapshot, now = Date.now(), error?: string) {
  const result = (label: string, destination: 'activity' | 'preview' | 'recovery' = 'activity', animated = false) => ({ label, destination, animated });
  if (activity.running) {
    const files = activity.processed !== undefined && activity.total !== undefined ? ` · ${activity.processed} / ${activity.total} files` : '';
    const elapsed = activity.startedAt !== undefined ? ` · ${Math.max(0, Math.floor((now - activity.startedAt) / 1000))}s` : '';
    return result(`${businessStage(activity.stage)}${files}${elapsed}`, 'activity', true);
  }
  if (cache.status === 'Recovery Required') return result('Review required · Recovery required', 'recovery');
  if (cache.status === 'Conflict') return result('Review required · Conflict', 'preview');
  if (error || activity.error || cache.status === 'Offline' || cache.auto.result === 'Offline') return result('Error');
  if (cache.auto.result === 'Manual confirmation required' || activity.review) return result('Review required', 'preview');
  if (cache.auto.scheduledAt !== undefined) return result(`Auto sync in ${Math.max(0, Math.ceil((cache.auto.scheduledAt - now) / 1000))}s`);
  if (cache.status === 'Healthy' && activity.verified && !activity.pendingChanges) return result('Verified');
  return result(cache.status === 'Healthy' ? 'Healthy' : cache.lastChangeAt ? 'Local changes' : 'Review required', cache.lastChangeAt || cache.status === 'Healthy' ? 'activity' : 'preview');
}
