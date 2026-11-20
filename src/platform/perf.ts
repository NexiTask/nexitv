import { invoke } from '@tauri-apps/api/core';

/**
 * Startup timing probes (NTV-1 step 0). Each call is forwarded to the Rust
 * side, which prints it to stderr only when MOVENA_PERF is set.
 */
export function perfLog(label: string, durationMs?: number, detail?: string): void {
  void invoke('perf_log', {
    label,
    at: Math.round(performance.now()),
    durationMs: durationMs === undefined ? null : Math.round(durationMs),
    detail: detail ?? null,
  }).catch(() => undefined);
}

export function perfSync<T>(label: string, fn: () => T, detail?: (value: T) => string): T {
  const start = performance.now();
  const value = fn();
  perfLog(label, performance.now() - start, detail?.(value));
  return value;
}

export async function perfAsync<T>(
  label: string,
  fn: () => Promise<T>,
  detail?: (value: T) => string,
): Promise<T> {
  const start = performance.now();
  const value = await fn();
  perfLog(label, performance.now() - start, detail?.(value));
  return value;
}
