import { create } from 'zustand';

export type DataActivity = 'catalog' | 'index' | 'playlist' | 'guide';

type SourceRefreshResult = 'complete' | 'incomplete' | 'failed';
type SourceRefresh = { phase: 'refreshing' | SourceRefreshResult; percent?: number };
type ImdbImport = { phase: 'importing' | 'ratings' | 'titles' | 'matching'; percent?: number };
export type ReportDataProgress = (percent: number | null) => void;
type Progress = { activity: DataActivity; percent: number };
type DataActivities = Record<DataActivity, number> & {
  sourceRefresh: SourceRefresh | null;
  imdbImport: ImdbImport | null;
  progress: ReadonlyMap<symbol, Progress>;
};

const REFRESH_RESULT_MS = 3_000;

export const useDataActivities = create<DataActivities>(() => ({
  catalog: 0,
  index: 0,
  playlist: 0,
  guide: 0,
  sourceRefresh: null,
  imdbImport: null,
  progress: new Map(),
}));

export function beginSourceRefresh(total: number) {
  let refresh: SourceRefresh = { phase: 'refreshing', percent: 0 };
  let settled = 0;
  useDataActivities.setState({ sourceRefresh: refresh });

  function reportSettled(count = 1) {
    if (useDataActivities.getState().sourceRefresh !== refresh || total <= 0) return;
    settled = Math.min(total, settled + count);
    refresh = { phase: 'refreshing', percent: Math.floor((settled / total) * 100) };
    useDataActivities.setState({ sourceRefresh: refresh });
  }

  function finish(phase: SourceRefreshResult) {
    if (useDataActivities.getState().sourceRefresh !== refresh) return;
    const result: SourceRefresh = { phase };
    useDataActivities.setState({ sourceRefresh: result });
    window.setTimeout(() => {
      if (useDataActivities.getState().sourceRefresh === result) {
        useDataActivities.setState({ sourceRefresh: null });
      }
    }, REFRESH_RESULT_MS);
  }

  return { reportSettled, finish };
}

export async function trackDataActivity<T>(
  activity: DataActivity,
  task: (reportProgress: ReportDataProgress) => Promise<T>,
): Promise<T> {
  const id = Symbol();
  const reportProgress: ReportDataProgress = (percent) => {
    useDataActivities.setState((state) => {
      if (state.progress.get(id)?.percent === (percent ?? undefined)) return state;
      const progress = new Map(state.progress);
      if (percent === null) progress.delete(id);
      else progress.set(id, { activity, percent });
      return { progress };
    });
  };
  useDataActivities.setState((state) => ({ [activity]: state[activity] + 1 }));
  try {
    return await task(reportProgress);
  } finally {
    useDataActivities.setState((state) => {
      const progress = new Map(state.progress);
      progress.delete(id);
      return { [activity]: state[activity] - 1, progress };
    });
  }
}
