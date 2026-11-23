import { tauriApi, type CatalogPageKind } from '@/platform/tauri';
import { perfLog } from '@/platform/perf';
import { debugLog } from '@/modules/diagnostics/public/store/useDebugStore';
import { getErrorMessage } from '@/shared/lib/error';
import { trackDataActivity, type ReportDataProgress } from '@/shared/lib/dataActivity';
import {
  runCatalogFacetTask,
  type CatalogFacetTask,
  type CatalogFacetTaskResult,
} from '../lib/catalogFacetTasks';

/** Rows per worker round trip: a few dozen milliseconds of mapping each. */
const FACET_BATCH_ROWS = 4_000;
/** A list that keeps changing under the build is left for the next run. */
const MAX_ATTEMPTS = 3;

export interface FacetBuildSource {
  id: string;
  queryScope: string;
}

interface WorkerReply {
  id: number;
  result?: CatalogFacetTaskResult | undefined;
  error?: string | undefined;
}

let facetWorker: Worker | null = null;
let nextTaskId = 1;
const pendingTasks = new Map<
  number,
  { resolve: (result: CatalogFacetTaskResult) => void; reject: (error: Error) => void }
>();

function getFacetWorker(): Worker | null {
  if (facetWorker) return facetWorker;
  if (typeof Worker === 'undefined') return null;
  try {
    const worker = new Worker(new URL('../workers/catalogFacets.worker', import.meta.url), {
      type: 'module',
    });
    worker.addEventListener('message', (event: MessageEvent<WorkerReply>) => {
      const pending = pendingTasks.get(event.data.id);
      if (!pending) return;
      pendingTasks.delete(event.data.id);
      if (event.data.result) pending.resolve(event.data.result);
      else pending.reject(new Error(event.data.error || 'The facet worker failed.'));
    });
    worker.addEventListener('error', () => {
      for (const pending of pendingTasks.values()) {
        pending.reject(new Error('The facet worker stopped unexpectedly.'));
      }
      pendingTasks.clear();
      worker.terminate();
      if (facetWorker === worker) facetWorker = null;
    });
    facetWorker = worker;
    return worker;
  } catch {
    return null;
  }
}

/** Runs a facet task in the worker, or inline where there is none (tests). */
function runTask(task: CatalogFacetTask): Promise<CatalogFacetTaskResult> {
  const worker = getFacetWorker();
  if (!worker) return Promise.resolve().then(() => runCatalogFacetTask(task));
  const id = nextTaskId++;
  return new Promise((resolve, reject) => {
    pendingTasks.set(id, { resolve, reject });
    worker.postMessage({ id, task }, [task.payload]);
  });
}

const listeners = new Set<(kind: CatalogPageKind) => void>();
const runs = new Map<CatalogPageKind, Promise<void>>();
const rerun = new Map<CatalogPageKind, FacetBuildSource[]>();

/** Called after a build stored anything, so pages waiting on the index reload. */
export function onCatalogFacetsBuilt(listener: (kind: CatalogPageKind) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function buildSource(
  kind: CatalogPageKind,
  source: FacetBuildSource,
  reportProgress?: ReportDataProgress,
): Promise<boolean> {
  let stored = false;
  let attempts = 0;
  let progressGeneration: number | undefined;
  let total = 0;
  let processed = 0;
  while (attempts < MAX_ATTEMPTS) {
    const payload = await tauriApi.catalogIndexFacetBatch(
      source.id,
      kind,
      source.queryScope,
      FACET_BATCH_ROWS,
      progressGeneration,
    );
    const batch = await runTask({ op: 'facets', kind, sourceId: source.id, payload });
    if (batch.op !== 'facets' || !batch.ready || batch.facets.length === 0) break;
    if (batch.remaining !== null) {
      total = batch.remaining;
      processed = 0;
      reportProgress?.(total > 0 ? 0 : null);
    }
    const saved = await tauriApi.catalogIndexStoreFacets(
      source.id,
      kind,
      batch.generation,
      batch.facets,
    );
    if (saved) {
      stored = true;
      // Storing facets advances the generation once. A different generation in
      // the next batch means the native side must count the remaining rows again.
      progressGeneration = batch.generation + 1;
      processed += batch.facets.length;
      if (total > 0) reportProgress?.(Math.floor((Math.min(total, processed) / total) * 100));
    } else {
      attempts += 1;
      progressGeneration = undefined;
      reportProgress?.(null);
    }
  }
  return stored;
}

async function buildRanks(kind: CatalogPageKind): Promise<boolean> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const payload = await tauriApi.catalogIndexTitles(kind);
    const ranked = await runTask({ op: 'ranks', payload });
    if (ranked.op !== 'ranks' || !ranked.needed) return false;
    if (await tauriApi.catalogIndexStoreRanks(kind, ranked.token, Array.from(ranked.ranks))) {
      return true;
    }
  }
  return false;
}

async function build(
  kind: CatalogPageKind,
  sources: FacetBuildSource[],
  reportProgress: ReportDataProgress,
): Promise<void> {
  const start = performance.now();
  let changed = false;
  try {
    for (const source of sources) {
      if (await buildSource(kind, source, sources.length === 1 ? reportProgress : undefined)) {
        changed = true;
      }
    }
    reportProgress(null);
    if (await buildRanks(kind)) changed = true;
  } catch (error: unknown) {
    debugLog.warn('api', 'Catalogue index facets were not built', {
      kind,
      error: getErrorMessage(error, 'Building catalogue facets failed.'),
    });
  }
  perfLog(`index:facets:${kind}`, performance.now() - start, `changed=${changed}`);
  if (changed) for (const listener of listeners) listener(kind);
}

/**
 * Derive the facets the Movies or Series page needs for every indexed row
 * that lacks them, then the name ranks. One build per kind runs at a time; a
 * request during a build runs once more after it.
 */
export function buildCatalogFacets(
  kind: CatalogPageKind,
  sources: FacetBuildSource[],
): Promise<void> {
  const running = runs.get(kind);
  if (running) {
    rerun.set(kind, sources);
    return running;
  }
  const run = trackDataActivity('index', (reportProgress) =>
    build(kind, sources, reportProgress),
  ).finally(() => {
    runs.delete(kind);
    const next = rerun.get(kind);
    if (next) {
      rerun.delete(kind);
      void buildCatalogFacets(kind, next);
    }
  });
  runs.set(kind, run);
  return run;
}

/** Clears module state between isolated tests. */
export function resetCatalogFacetBuilderForTests(): void {
  facetWorker?.terminate();
  facetWorker = null;
  pendingTasks.clear();
  listeners.clear();
  runs.clear();
  rerun.clear();
  nextTaskId = 1;
}
