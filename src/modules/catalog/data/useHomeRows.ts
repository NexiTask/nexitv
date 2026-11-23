import { useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { desktopApi } from '@/platform/desktop';
import { tauriApi, type CatalogIndexOrder } from '@/platform/tauri';
import { perfSync } from '@/platform/perf';
import {
  useEnabledSources,
  type EnabledSourcesSnapshot,
} from '@/modules/sources/public/hooks/useEnabledSources';
import { mapXtreamList, playlistCatalog, type CatalogItem } from './useCatalog';
import { useHiddenCategoryState } from './useCategories';
import { CATALOG_FRESH_MS } from './catalogFreshness';

export const INDEX_ROWS_ROOT = 'catalog_index_rows';

export interface IndexPool {
  /**
   * Candidates for a Home row, in index order, with hidden categories left
   * out. `null` until known, and when the index cannot serve this catalogue
   * yet, in which case the caller falls back to the full catalogue.
   */
  items: CatalogItem[] | null;
  /** True once the index answered (with a pool or with "not ready"). */
  settled: boolean;
  error: unknown;
}

function providerCategoryIds(hidden: Set<string>, sourceId: string): string[] {
  const prefix = `${sourceId}:category:`;
  const ids: string[] = [];
  for (const id of hidden) if (id.startsWith(prefix)) ids.push(id.slice(prefix.length));
  return ids.sort();
}

async function loadPool(
  type: 'live' | 'vod' | 'series',
  sources: EnabledSourcesSnapshot,
  hidden: Set<string>,
  order: CatalogIndexOrder,
  limit: number,
): Promise<CatalogItem[] | null> {
  const xtream = sources.availableXtreamSources;
  const answer = await tauriApi.catalogIndexRows(
    type,
    xtream.map((source) => ({
      sourceId: source.id,
      scope: source.queryScope,
      hiddenCategoryIds: providerCategoryIds(hidden, source.id),
    })),
    order,
    limit,
  );
  if (!answer.ready) return null;
  return perfSync(`index:map:${type}:${order}`, () => {
    const bySource = new Map<string, unknown[]>();
    for (const row of answer.rows) {
      const list = bySource.get(row.sourceId) ?? [];
      list.push(row.raw);
      bySource.set(row.sourceId, list);
    }
    const playlist = playlistCatalog(type, sources).filter(
      (item) => !item.categoryId || !hidden.has(item.categoryId),
    );
    return [
      ...xtream.flatMap((source) => mapXtreamList(type, source, bySource.get(source.id) ?? [])),
      ...playlist,
    ];
  });
}

/**
 * A small candidate pool for one Home row, served by the Rust catalogue index
 * instead of mapping the whole catalogue in the webview. The caller ranks the
 * pool with the same functions it uses on the full catalogue.
 */
export function useIndexPool(
  type: 'live' | 'vod' | 'series',
  order: CatalogIndexOrder,
  limit: number,
): IndexPool {
  const sources = useEnabledSources();
  const client = useQueryClient();
  const { ids: hidden, isResolved } = useHiddenCategoryState(type);
  const desktop = desktopApi.isDesktop();
  const hiddenKey = useMemo(() => [...hidden].sort().join('|'), [hidden]);

  useEffect(() => {
    if (!desktop) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void desktopApi
      .onCatalogIndexUpdated((kind) => {
        void client.invalidateQueries({ queryKey: [INDEX_ROWS_ROOT, kind] });
      })
      .then((stop) => {
        if (cancelled) stop();
        else unlisten = stop;
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [client, desktop]);

  const query = useQuery({
    queryKey: [INDEX_ROWS_ROOT, type, order, limit, sources.queryScope, hiddenKey],
    queryFn: () => loadPool(type, sources, hidden, order, limit),
    enabled: desktop && sources.isAvailable && isResolved,
    staleTime: CATALOG_FRESH_MS,
    retry: false,
  });

  return {
    items: desktop && !query.isError ? (query.data ?? null) : null,
    settled: !desktop || query.isSuccess || query.isError,
    error: query.error,
  };
}
