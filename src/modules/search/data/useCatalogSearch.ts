import { useCallback, useMemo } from 'react';
import type { MediaItem } from '@/modules/catalog/public/model/media';
import {
  useLiveStreams,
  useSeriesList,
  useVodStreams,
} from '@/modules/catalog/public/data/useCatalog';
import {
  useHiddenCategoryIds,
  useWithoutHiddenCategories,
} from '@/modules/catalog/public/data/useCategories';
import {
  useIndexedSearch,
  useLiveIndexAvailable,
} from '@/modules/catalog/public/data/useIndexedCatalog';
import { useSettingsStore } from '@/modules/settings/public/store/useSettingsStore';
import { getCombinedErrorMessage } from '@/shared/lib/error';
import { smartSearch } from '../lib/search';

export type SearchScope = 'all' | 'movies' | 'series' | 'live';

export interface CatalogSearch {
  /** How many titles match. */
  count: number;
  /** The match at a rank, once its row is loaded. */
  getItem: (index: number) => MediaItem | undefined;
  /** Load the rows of the ranks `[start, end)`. */
  requestRange: (start: number, end: number) => void;
  /** True while the answer for the current text is not in yet. */
  isPending: boolean;
  error: string;
  /** Ask the failed catalogues again. */
  retry: () => void;
  isRetrying: boolean;
}

interface RankedMatch {
  kind: 0 | 1 | 2;
  /** Rank within its own catalogue. */
  index: number;
  score: number;
}

const NO_ITEMS: MediaItem[] = [];

/**
 * `smartSearch` across the catalogues. Served by the catalogue index (never
 * loading a full catalogue) when it can; otherwise over the full lists as
 * before. Both rank the same way: by score, ties in catalogue order with
 * movies before series before channels.
 */
export function useCatalogSearch(
  text: string,
  scope: SearchScope,
  { enabled, limit }: { enabled: boolean; limit?: number | undefined },
): CatalogSearch {
  const indexAvailable = useLiveIndexAvailable();
  const fold = useSettingsStore((state) => state.streamFoldingEnabled);
  const wants = (kind: SearchScope) => enabled && (scope === 'all' || scope === kind);

  // Index path.
  const hiddenVod = useHiddenCategoryIds('vod', { enabled: indexAvailable && wants('movies') });
  const hiddenSeries = useHiddenCategoryIds('series', {
    enabled: indexAvailable && wants('series'),
  });
  const hiddenLive = useHiddenCategoryIds('live', { enabled: indexAvailable && wants('live') });
  const head = limit ?? 40;
  const vod = useIndexedSearch('vod', text, {
    enabled: indexAvailable && wants('movies'),
    fold: false,
    hiddenCategoryIds: hiddenVod,
    head,
  });
  const series = useIndexedSearch('series', text, {
    enabled: indexAvailable && wants('series'),
    fold: false,
    hiddenCategoryIds: hiddenSeries,
    head,
  });
  const live = useIndexedSearch('live', text, {
    enabled: indexAvailable && wants('live'),
    fold,
    hiddenCategoryIds: hiddenLive,
    head,
  });
  const indexed = [vod, series, live] as const;
  const useIndex = indexAvailable && !indexed.some((search) => search.isError);

  const ranked = useMemo<RankedMatch[]>(() => {
    if (!useIndex) return [];
    const matches: RankedMatch[] = [];
    indexed.forEach((search, kind) => {
      const result = search.result;
      if (!result) return;
      const count = limit === undefined ? result.total : Math.min(limit, result.total);
      for (let index = 0; index < count; index += 1) {
        matches.push({ kind: kind as 0 | 1 | 2, index, score: result.scores[index]! });
      }
    });
    // Stable: equal scores keep movies, series, channels, each in rank order.
    matches.sort((a, b) => b.score - a.score);
    return limit === undefined ? matches : matches.slice(0, limit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useIndex, limit, vod.result, series.result, live.result]);

  const versions = `${vod.rows.rowsVersion}:${series.rows.rowsVersion}:${live.rows.rowsVersion}`;
  const indexedGetItem = useCallback(
    (index: number) => {
      const match = ranked[index];
      return match ? indexed[match.kind].rows.getItem(match.index) : undefined;
    },
    // versions: a new identity tells the grid that more rows arrived.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ranked, versions],
  );
  const indexedRequestRange = useCallback(
    (start: number, end: number) => {
      const spans = new Map<number, [number, number]>();
      for (const match of ranked.slice(start, end)) {
        const span = spans.get(match.kind);
        spans.set(
          match.kind,
          span
            ? [Math.min(span[0], match.index), Math.max(span[1], match.index)]
            : [match.index, match.index],
        );
      }
      for (const [kind, [from, to]] of spans) indexed[kind]!.rows.requestRange(from, to + 1);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ranked, vod.rows, series.rows, live.rows],
  );

  // Full-catalogue path (M3U sources, or no index).
  const legacy = !useIndex;
  const moviesQuery = useVodStreams({ enabled: legacy && wants('movies') });
  const seriesQuery = useSeriesList({ enabled: legacy && wants('series') });
  const liveQuery = useLiveStreams({ enabled: legacy && wants('live') });
  const visibleMovies = useWithoutHiddenCategories('vod', moviesQuery.data ?? NO_ITEMS, {
    enabled: legacy && wants('movies'),
  });
  const visibleSeries = useWithoutHiddenCategories('series', seriesQuery.data ?? NO_ITEMS, {
    enabled: legacy && wants('series'),
  });
  const visibleLive = useWithoutHiddenCategories('live', liveQuery.data ?? NO_ITEMS, {
    enabled: legacy && wants('live'),
  });
  const legacyResults = useMemo(() => {
    if (!legacy || !enabled || !text.trim()) return NO_ITEMS;
    const source = [
      ...(wants('movies') ? visibleMovies.data : []),
      ...(wants('series') ? visibleSeries.data : []),
      ...(wants('live') ? visibleLive.data : []),
    ];
    const results = smartSearch(source, text.trim());
    return limit === undefined ? results : results.slice(0, limit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    legacy,
    enabled,
    text,
    scope,
    limit,
    visibleMovies.data,
    visibleSeries.data,
    visibleLive.data,
  ]);

  if (useIndex) {
    return {
      count: ranked.length,
      getItem: indexedGetItem,
      requestRange: indexedRequestRange,
      isPending: indexed.some((search) => search.isLoading),
      error: '',
      retry: () => undefined,
      isRetrying: false,
    };
  }
  const queries = [
    ...(wants('movies') ? [moviesQuery] : []),
    ...(wants('series') ? [seriesQuery] : []),
    ...(wants('live') ? [liveQuery] : []),
  ];
  return {
    count: legacyResults.length,
    getItem: (index) => legacyResults[index],
    requestRange: () => undefined,
    isPending:
      queries.some((query) => query.isLoading) ||
      (wants('movies') && visibleMovies.isPending) ||
      (wants('series') && visibleSeries.isPending) ||
      (wants('live') && visibleLive.isPending),
    error: getCombinedErrorMessage(
      queries.map((query) => query.error),
      '',
    ),
    retry: () => {
      void Promise.all(queries.filter((query) => query.isError).map((query) => query.refetch()));
    },
    isRetrying: queries.some((query) => query.isError && query.isFetching),
  };
}
