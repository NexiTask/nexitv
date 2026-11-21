import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { desktopApi } from '@/platform/desktop';
import {
  tauriApi,
  type CatalogKeyRow,
  type CatalogPageKind,
  type CatalogPageQuery,
  type CatalogPageResult,
  type CatalogPageSource,
  type CatalogPageStats,
} from '@/platform/tauri';
import { perfSync } from '@/platform/perf';
import {
  useEnabledSources,
  type EnabledSourcesSnapshot,
  type EnabledXtreamSource,
} from '@/modules/sources/public/hooks/useEnabledSources';
import type { CatalogItem } from '../model/catalogItem';
import type { MediaItem } from '../model/media';
import {
  buildCatalogPageQuery,
  catalogQuerySignature,
  lookupOverrides,
} from '../lib/catalogPageQuery';
import type { RatingLookups } from '../lib/smartCatalogFilter';
import { mapXtreamList } from './useCatalog';
import { buildCatalogFacets, onCatalogFacetsBuilt } from './catalogFacetBuilder';
import type { RatingHeadSource } from './useTmdbRatingChecks';

const STATUS_ROOT = 'catalog_index_page_status';
const PAGE_ROOT = 'catalog_index_page';
const STATS_ROOT = 'catalog_index_page_stats';
/** Waiting on a build this close to done beats loading the whole catalogue. */
const WAIT_FOR_BUILD_FRACTION = 0.1;
const WAIT_FOR_BUILD_MS = 15_000;
const ORD_BITS = 23;
/** Rows fetched beyond the visible window, so scrolling rarely meets a gap. */
const ROW_PREFETCH = 60;
const KEY_SOURCE_SHIFT = 2 ** ORD_BITS;

export type CatalogPageMode = 'pending' | 'index' | 'legacy';

function isPageKind(type: 'live' | 'vod' | 'series'): type is CatalogPageKind {
  return type === 'vod' || type === 'series';
}

function pageSources(sources: EnabledSourcesSnapshot): CatalogPageSource[] {
  return sources.availableXtreamSources.map((source) => ({
    sourceId: source.id,
    scope: source.queryScope,
  }));
}

/** Whether these sources could be served from the index at all. */
function indexCandidate(type: 'live' | 'vod' | 'series', sources: EnabledSourcesSnapshot) {
  return (
    isPageKind(type) &&
    desktopApi.isDesktop() &&
    sources.m3uSources.length === 0 &&
    sources.availableXtreamSources.length > 0
  );
}

/** Reload index-backed views of `kind` when the index or its facets change. */
function useIndexInvalidation(kind: CatalogPageKind | null) {
  const client = useQueryClient();
  useEffect(() => {
    if (!kind || !desktopApi.isDesktop()) return;
    const invalidate = (changed: string) => {
      if (changed !== kind) return;
      for (const root of [STATUS_ROOT, PAGE_ROOT, STATS_ROOT]) {
        void client.invalidateQueries({ queryKey: [root, kind] });
      }
    };
    const stopBuilt = onCatalogFacetsBuilt(invalidate);
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void desktopApi
      .onCatalogIndexUpdated(invalidate)
      .then((stop) => {
        if (cancelled) stop();
        else unlisten = stop;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      stopBuilt();
      unlisten?.();
    };
  }, [client, kind]);
}

/**
 * Whether a catalogue page is served from the index or from the full
 * catalogue in memory. Decided once per visit: the answer never flips while
 * the page is open, so the list cannot change source under the user.
 */
export function useCatalogPageMode(type: 'live' | 'vod' | 'series'): {
  mode: CatalogPageMode;
  fallBack: () => void;
} {
  const sources = useEnabledSources();
  const candidate = indexCandidate(type, sources);
  const kind = isPageKind(type) ? type : null;
  const [decided, setDecided] = useState<CatalogPageMode | null>(null);
  const [waitedOut, setWaitedOut] = useState(false);
  useIndexInvalidation(candidate ? kind : null);

  const status = useQuery({
    queryKey: [STATUS_ROOT, kind, sources.queryScope],
    queryFn: () => tauriApi.catalogIndexPageStatus(kind!, pageSources(sources)),
    enabled: candidate && decided === null && !sources.isLoading,
    // Index and facet changes invalidate it (useIndexInvalidation).
    staleTime: Infinity,
    retry: false,
  });

  const state = status.data?.state;
  const nearlyBuilt =
    state === 'building' &&
    (status.data!.total === 0 ||
      status.data!.pending / status.data!.total <= WAIT_FOR_BUILD_FRACTION);

  useEffect(() => {
    if (state !== 'building' || !kind) return;
    void buildCatalogFacets(
      kind,
      sources.availableXtreamSources.map(({ id, queryScope }) => ({ id, queryScope })),
    );
  }, [kind, sources.availableXtreamSources, state]);

  useEffect(() => {
    if (!nearlyBuilt || decided !== null) return;
    const timer = window.setTimeout(() => setWaitedOut(true), WAIT_FOR_BUILD_MS);
    return () => window.clearTimeout(timer);
  }, [decided, nearlyBuilt]);

  let current: CatalogPageMode;
  if (decided) current = decided;
  else if (!candidate) current = sources.isLoading && isPageKind(type) ? 'pending' : 'legacy';
  else if (sources.isLoading || status.isPending) current = 'pending';
  else if (status.isError || state === 'unavailable') current = 'legacy';
  else if (state === 'ready') current = 'index';
  else if (nearlyBuilt && !waitedOut) current = 'pending';
  else current = 'legacy';

  useEffect(() => {
    if (decided === null && current !== 'pending') setDecided(current);
  }, [current, decided]);

  const fallBack = useCallback(() => setDecided('legacy'), []);
  return { mode: current, fallBack };
}

function keySource(key: number): number {
  return Math.floor(key / KEY_SOURCE_SHIFT);
}

/** Maps raw index rows with the catalogue's own mapping, per source. */
function mapKeyRows(
  type: CatalogPageKind,
  sources: readonly EnabledXtreamSource[],
  rows: readonly CatalogKeyRow[],
): Map<number, CatalogItem> {
  const bySource = new Map<number, CatalogKeyRow[]>();
  for (const row of rows) {
    const position = keySource(row.key);
    const list = bySource.get(position) ?? [];
    list.push(row);
    bySource.set(position, list);
  }
  const items = new Map<number, CatalogItem>();
  for (const [position, list] of bySource) {
    const source = sources[position];
    if (!source) continue;
    const mapped = mapXtreamList(
      type,
      source,
      list.map((row) => row.raw),
    );
    list.forEach((row, index) => items.set(row.key, mapped[index]!));
  }
  return items;
}

export interface IndexedPageParams {
  activeCategoryId: string | null;
  hiddenCategoryIds: ReadonlySet<string>;
  favorites: readonly { id: string }[];
  categories: readonly { category_id: string | number; category_name: string }[];
  categoryGenres: Record<string, number>;
  ultraHd: Record<string, boolean>;
  ratingLookups: RatingLookups;
  genre: string | null;
  sort: string;
}

export interface IndexedPage {
  result: CatalogPageResult | undefined;
  isLoading: boolean;
  isError: boolean;
  /** The item at a list position, once its row has been loaded. */
  getItem: (index: number) => MediaItem | undefined;
  /** Load the rows of a visible window (plus some runway). */
  requestRange: (start: number, end: number) => void;
  /** Changes whenever more rows have arrived. */
  rowsVersion: number;
}

/** One catalogue page from the index: its ordered keys, and rows on demand. */
export function useIndexedCatalogPage(
  type: 'live' | 'vod' | 'series',
  params: IndexedPageParams,
  enabled: boolean,
): IndexedPage {
  const sources = useEnabledSources();
  const kind = isPageKind(type) ? type : 'vod';
  const query = useMemo(() => buildCatalogPageQuery(params), [params]);
  const signature = useMemo(() => catalogQuerySignature(query), [query]);
  const xtream = sources.availableXtreamSources;
  const requestSources = useMemo(() => pageSources(sources), [sources]);

  const page = useQuery({
    queryKey: [PAGE_ROOT, kind, sources.queryScope, signature],
    queryFn: async () => {
      const result = await tauriApi.catalogIndexPage(kind, requestSources, query);
      if (!result.ready) throw new Error('The catalogue index is being updated.');
      return result;
    },
    enabled,
    staleTime: Infinity,
    placeholderData: keepPreviousData,
    retry: false,
  });

  // Rows by key, per index generation; a page's keys only mean something
  // under the generation they were made for.
  const rowsRef = useRef<{ generation: string; items: Map<number, CatalogItem> }>({
    generation: '',
    items: new Map(),
  });
  const inFlight = useRef(new Set<number>());
  const [rowsVersion, setRowsVersion] = useState(0);
  const result = page.data;

  const rowsFor = useCallback((generation: string) => {
    if (rowsRef.current.generation !== generation) {
      rowsRef.current = { generation, items: new Map() };
      inFlight.current = new Set();
    }
    return rowsRef.current.items;
  }, []);

  const headItems = useMemo(() => {
    if (!result) return null;
    return perfSync(`index:page_head:${kind}`, () => mapKeyRows(kind, xtream, result.head));
  }, [kind, result, xtream]);

  if (result && headItems) {
    const items = rowsFor(result.generation);
    for (const [key, item] of headItems) if (!items.has(key)) items.set(key, item);
  }

  const client = useQueryClient();
  const requestRange = useCallback(
    (start: number, end: number) => {
      if (!result) return;
      const items = rowsFor(result.generation);
      const from = Math.max(0, start - ROW_PREFETCH);
      const to = Math.min(result.keys.length, end + ROW_PREFETCH);
      const missing: number[] = [];
      for (let index = from; index < to; index += 1) {
        const key = result.keys[index]!;
        if (!items.has(key) && !inFlight.current.has(key)) missing.push(key);
      }
      if (missing.length === 0) return;
      for (const key of missing) inFlight.current.add(key);
      const generation = result.generation;
      void tauriApi
        .catalogIndexPageRows(kind, requestSources, generation, missing)
        .then((answer) => {
          if (rowsRef.current.generation !== generation) return;
          if (answer.stale) {
            void client.invalidateQueries({ queryKey: [PAGE_ROOT, kind] });
            return;
          }
          for (const [key, item] of mapKeyRows(kind, xtream, answer.rows)) items.set(key, item);
          setRowsVersion((version) => version + 1);
        })
        .catch(() => undefined)
        .finally(() => {
          for (const key of missing) inFlight.current.delete(key);
        });
    },
    [client, kind, requestSources, result, rowsFor, xtream],
  );

  const getItem = useCallback(
    (index: number) => {
      if (!result) return undefined;
      const key = result.keys[index];
      return key === undefined ? undefined : rowsFor(result.generation).get(key);
    },
    // rowsVersion: a new identity tells the grid that more rows arrived.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [result, rowsFor, rowsVersion],
  );

  return {
    result,
    isLoading: enabled && !result && page.isPending,
    isError: page.isError && !result,
    getItem,
    requestRange,
    rowsVersion,
  };
}

/** The category sidebar's counts from the index. */
export function useIndexedCatalogStats(
  type: 'live' | 'vod' | 'series',
  params: Pick<IndexedPageParams, 'hiddenCategoryIds' | 'favorites' | 'ultraHd'>,
  enabled: boolean,
): CatalogPageStats | undefined {
  const sources = useEnabledSources();
  const kind = isPageKind(type) ? type : 'vod';
  const query = useMemo<CatalogPageQuery>(
    () => ({
      hiddenCategoryIds: [...params.hiddenCategoryIds].sort(),
      category: null,
      targetCategoryIds: null,
      favoriteIds: params.favorites.map((favorite) => favorite.id),
      ultraHd: params.ultraHd,
      ratings: {},
      tmdbGenres: {},
      categoryGenres: {},
      genre: null,
      sort: 'default',
    }),
    [params.favorites, params.hiddenCategoryIds, params.ultraHd],
  );
  const signature = useMemo(() => catalogQuerySignature(query), [query]);
  const stats = useQuery({
    queryKey: [STATS_ROOT, kind, sources.queryScope, signature],
    queryFn: async () => {
      const answer = await tauriApi.catalogIndexPageStats(kind, pageSources(sources), query);
      if (!answer) throw new Error('The catalogue index is being updated.');
      return answer;
    },
    enabled,
    staleTime: Infinity,
    placeholderData: keepPreviousData,
    retry: false,
  });
  return stats.data;
}

/** The TMDB rating checks' ranking head, from the index. */
export function useIndexedRatingHead(
  type: 'live' | 'vod' | 'series',
  params: IndexedPageParams,
  generation: string,
): RatingHeadSource {
  const sources = useEnabledSources();
  const kind = isPageKind(type) ? type : 'vod';
  // The pool is the category judged on provider data, so its scope leaves
  // TMDB's verdicts, the genre and the sort out.
  const baseQuery = useMemo(
    () =>
      buildCatalogPageQuery({
        ...params,
        ratingLookups: new Map(),
        genre: null,
        sort: 'rating',
      }),
    [params],
  );
  const scope = useMemo(
    () => `index-${generation}-${catalogQuerySignature(baseQuery)}`,
    [baseQuery, generation],
  );
  const xtream = sources.availableXtreamSources;
  const requestSources = useMemo(() => pageSources(sources), [sources]);
  return useMemo<RatingHeadSource>(
    () => ({
      scope,
      hasCandidates: true,
      head: async (lookups, genre, limit) => {
        const query: CatalogPageQuery = {
          ...baseQuery,
          ...lookupOverrides(lookups),
          genre: buildCatalogPageQuery({
            ...params,
            ratingLookups: new Map(),
            genre,
            sort: 'rating',
          }).genre,
        };
        const answer = await tauriApi.catalogIndexRatingHead(
          kind,
          requestSources,
          query,
          [...lookups.keys()],
          limit,
        );
        if (!answer.ready) return [];
        const mapped = mapKeyRows(kind, xtream, answer.rows);
        return answer.rows.flatMap((row) => {
          const item = mapped.get(row.key);
          return item ? [item] : [];
        });
      },
    }),
    [baseQuery, kind, params, requestSources, scope, xtream],
  );
}

/**
 * Keeps the index's page facets up to date in the background: after start-up
 * and whenever a catalogue list is stored again.
 */
export function useCatalogFacetBuilds(delayMs = 3_000): void {
  const sources = useEnabledSources();
  const client = useQueryClient();
  const queryScope = sources.queryScope;
  const eligible =
    desktopApi.isDesktop() &&
    !sources.isLoading &&
    sources.m3uSources.length === 0 &&
    sources.availableXtreamSources.length > 0;
  const buildSources = useMemo(
    () => sources.availableXtreamSources.map(({ id, queryScope }) => ({ id, queryScope })),
    [sources.availableXtreamSources],
  );

  useEffect(() => {
    if (!eligible) return;
    const run = (kind: CatalogPageKind) => {
      void buildCatalogFacets(kind, buildSources).then(() =>
        // Warm the facet cache, so the first page visit only filters and sorts.
        tauriApi
          .catalogIndexPageStatus(
            kind,
            buildSources.map(({ id, queryScope: scope }) => ({ sourceId: id, scope })),
          )
          .then((status) => client.setQueryData([STATUS_ROOT, kind, queryScope], status))
          .catch(() => undefined),
      );
    };
    const timer = window.setTimeout(() => {
      run('vod');
      run('series');
    }, delayMs);
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void desktopApi
      .onCatalogIndexUpdated((kind) => {
        if (kind === 'vod' || kind === 'series') run(kind);
      })
      .then((stop) => {
        if (cancelled) stop();
        else unlisten = stop;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      unlisten?.();
    };
  }, [buildSources, client, delayMs, eligible, queryScope]);
}
