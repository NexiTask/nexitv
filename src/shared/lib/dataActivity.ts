import { create } from 'zustand';

export type DataActivity = 'catalog' | 'index' | 'playlist' | 'guide';

type SourceRefreshResult = 'complete' | 'incomplete' | 'failed';
type SourceRefresh = { phase: 'refreshing' | SourceRefreshResult };
type DataActivities = Record<DataActivity, number> & { sourceRefresh: SourceRefresh | null };

const REFRESH_RESULT_MS = 3_000;

export const useDataActivities = create<DataActivities>(() => ({
  catalog: 0,
  index: 0,
  playlist: 0,
  guide: 0,
  sourceRefresh: null,
}));

export function beginSourceRefresh(): (phase: SourceRefreshResult) => void {
  const refresh: SourceRefresh = { phase: 'refreshing' };
  useDataActivities.setState({ sourceRefresh: refresh });

  return (phase) => {
    if (useDataActivities.getState().sourceRefresh !== refresh) return;
    const result: SourceRefresh = { phase };
    useDataActivities.setState({ sourceRefresh: result });
    window.setTimeout(() => {
      if (useDataActivities.getState().sourceRefresh === result) {
        useDataActivities.setState({ sourceRefresh: null });
      }
    }, REFRESH_RESULT_MS);
  };
}

export async function trackDataActivity<T>(
  activity: DataActivity,
  task: () => Promise<T>,
): Promise<T> {
  useDataActivities.setState((state) => ({ [activity]: state[activity] + 1 }));
  try {
    return await task();
  } finally {
    useDataActivities.setState((state) => ({ [activity]: state[activity] - 1 }));
  }
}
