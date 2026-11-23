import { create } from 'zustand';

export type DataActivity = 'catalog' | 'index' | 'playlist' | 'guide';
type CatalogKind = 'live' | 'vod' | 'series';

export type ActivityDetail =
  | { phase: 'fetch-catalog' | 'check-index' | 'save-index' | 'sort-titles'; kind: CatalogKind }
  | { phase: 'index-titles'; kind: CatalogKind; completed?: number; total?: number }
  | { phase: 'download-playlist' | 'read-playlist' | 'restore-playlist' | 'parse-playlist' };

type SourceRefreshResult = 'complete' | 'incomplete' | 'failed';
type RefreshSummary = { updated: number; failed: number; kept: number };
type SourceRefresh =
  | {
      phase: 'refreshing';
      percent: number;
      settled: number;
      total: number;
      kind?: CatalogKind | undefined;
    }
  | { phase: SourceRefreshResult; summary?: RefreshSummary };
type ImdbImport = {
  phase: 'checking' | 'importing' | 'ratings' | 'titles' | 'matching';
  percent?: number;
};
export type ReportDataProgress = (percent: number | null) => void;
export type ReportActivityDetail = (detail: ActivityDetail) => void;
type Progress = { activity: DataActivity; percent: number };
type DataActivities = Record<DataActivity, number> & {
  sourceRefresh: SourceRefresh | null;
  imdbImport: ImdbImport | null;
  progress: ReadonlyMap<symbol, Progress>;
  details: ReadonlyMap<symbol, { activity: DataActivity; detail: ActivityDetail }>;
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
  details: new Map(),
}));

export function beginSourceRefresh(total: number) {
  let refresh: Extract<SourceRefresh, { phase: 'refreshing' }> = {
    phase: 'refreshing',
    percent: 0,
    settled: 0,
    total,
  };
  useDataActivities.setState({ sourceRefresh: refresh });

  function reportSettled(count = 1) {
    if (useDataActivities.getState().sourceRefresh !== refresh || total <= 0) return;
    const settled = Math.min(total, refresh.settled + count);
    refresh = { ...refresh, settled, percent: Math.floor((settled / total) * 100) };
    useDataActivities.setState({ sourceRefresh: refresh });
  }

  function setCatalogKind(kind?: CatalogKind) {
    if (useDataActivities.getState().sourceRefresh !== refresh) return;
    refresh = { ...refresh, kind };
    useDataActivities.setState({ sourceRefresh: refresh });
  }

  function finish(phase: SourceRefreshResult, summary?: RefreshSummary) {
    if (useDataActivities.getState().sourceRefresh !== refresh) return;
    const result: SourceRefresh = { phase, ...(summary && { summary }) };
    useDataActivities.setState({ sourceRefresh: result });
    window.setTimeout(() => {
      if (useDataActivities.getState().sourceRefresh === result) {
        useDataActivities.setState({ sourceRefresh: null });
      }
    }, REFRESH_RESULT_MS);
  }

  return { reportSettled, setCatalogKind, finish };
}

export async function trackDataActivity<T>(
  activity: DataActivity,
  task: (reportProgress: ReportDataProgress, reportDetail: ReportActivityDetail) => Promise<T>,
  detail?: ActivityDetail,
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
  const reportDetail: ReportActivityDetail = (detail) => {
    useDataActivities.setState((state) => ({
      details: new Map(state.details).set(id, { activity, detail }),
    }));
  };
  useDataActivities.setState((state) => ({
    [activity]: state[activity] + 1,
    details: detail ? new Map(state.details).set(id, { activity, detail }) : state.details,
  }));
  try {
    return await task(reportProgress, reportDetail);
  } finally {
    useDataActivities.setState((state) => {
      const progress = new Map(state.progress);
      progress.delete(id);
      const details = new Map(state.details);
      details.delete(id);
      return { [activity]: state[activity] - 1, progress, details };
    });
  }
}
