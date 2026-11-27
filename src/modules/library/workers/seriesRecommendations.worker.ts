import {
  collectSeriesRecommendations,
  type RecommendationInputs,
} from '../data/seriesRecommendations';

export type WorkerRecommendationInput = Omit<RecommendationInputs, 'categories'> & {
  categories: [string, string][];
};

self.addEventListener('message', (event: MessageEvent<WorkerRecommendationInput>) => {
  try {
    const request = collectSeriesRecommendations({
      ...event.data,
      categories: new Map(event.data.categories),
    }).createRequest();
    self.postMessage({ request });
  } catch (error: unknown) {
    self.postMessage({
      error: error instanceof Error ? error.message : 'Could not prepare recommendations.',
    });
  }
});
