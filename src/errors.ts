export class PreviewError extends Error {
  constructor(public readonly stage: string, public readonly code: string, message: string) {
    super(message);
    this.name = 'PreviewError';
  }
}

// Never surface transport errors: they may contain Authorization headers or bodies.
export function safeError(error: unknown): string {
  return error instanceof PreviewError
    ? `${error.stage} · ${error.code}: ${error.message}`
    : 'PREVIEW · FAILED: Preview failed. Check settings and retry.';
}

export function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PreviewError('PREVIEW', 'CANCELLED', 'Preview cancelled.');
}

/** Bound read-only waits. Native reads may finish later; their results cannot resume the caller. */
export function readWithTimeout<T>(read: () => Promise<T>, stage: string, signal?: AbortSignal,
  message = 'The read did not finish within 30 seconds. Check the connection or local storage, then retry Preview.'): Promise<T> {
  assertActive(signal);
  const timerWindow: Pick<Window, 'setTimeout' | 'clearTimeout'> = typeof window === 'undefined' ? { setTimeout, clearTimeout } : window;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true; timerWindow.clearTimeout(timer); signal?.removeEventListener('abort', cancel); complete();
    };
    const cancel = () => finish(() => reject(new PreviewError('PREVIEW', 'CANCELLED', 'Preview cancelled.')));
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = timerWindow.setTimeout(() => finish(() => reject(new PreviewError(stage, 'READ_TIMEOUT', message))), 30_000);
    const failed = (error: unknown) => finish(() => reject(error instanceof Error ? error : new PreviewError(stage, 'READ_FAILED', 'The read failed. Retry Preview.')));
    try { read().then(value => finish(() => resolve(value)), failed); }
    catch (error) { failed(error); }
  });
}
