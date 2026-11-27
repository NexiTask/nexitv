import type { SeriesRecommendationRequest } from '@/platform/tauri';
import { collectSeriesRecommendations, type RecommendationInputs } from './seriesRecommendations';
import type { WorkerRecommendationInput } from '../workers/seriesRecommendations.worker';

interface WorkerReply {
  request?: SeriesRecommendationRequest | undefined;
  error?: string | undefined;
}

/**
 * Prepares the ChatGPT recommendation payload off the main thread when Web
 * Workers are available so scanning 90k+ series never blocks scrolling or clicks.
 * The worker terminates immediately after replying to avoid holding idle memory.
 */
export function buildRecommendationRequestAsync(
  input: RecommendationInputs,
): Promise<SeriesRecommendationRequest> {
  if (typeof Worker === 'undefined') {
    return Promise.resolve().then(() => collectSeriesRecommendations(input).createRequest());
  }
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('../workers/seriesRecommendations.worker', import.meta.url), {
        type: 'module',
      });
    } catch {
      resolve(collectSeriesRecommendations(input).createRequest());
      return;
    }
    const finish = (outcome: () => void) => {
      worker.terminate();
      outcome();
    };
    worker.addEventListener('message', (event: MessageEvent<WorkerReply>) => {
      if (event.data.request) finish(() => resolve(event.data.request!));
      else
        finish(() => reject(new Error(event.data.error || 'Could not prepare recommendations.')));
    });
    worker.addEventListener('error', () => {
      finish(() => {
        try {
          resolve(collectSeriesRecommendations(input).createRequest());
        } catch (error: unknown) {
          reject(error instanceof Error ? error : new Error('Could not prepare recommendations.'));
        }
      });
    });
    const payload: WorkerRecommendationInput = {
      ...input,
      categories: [...input.categories.entries()],
    };
    worker.postMessage(payload);
  });
}
