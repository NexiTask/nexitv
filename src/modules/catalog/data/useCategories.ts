import { perfLog } from '@/platform/perf';
import { useMemo } from 'react';
import { queryOptions, useQuery, type QueryClient } from '@tanstack/react-query';
import { queryClient } from '@/shared/query/queryClient';
import { desktopApi } from '@/platform/desktop';
import {
  getVodCategories,
  getSeriesCategories,
  getLiveCategories,
} from '@/modules/sources/public/data/xtreamClient';
import {
  useSettingsStore,
  type CatalogType,
} from '@/modules/settings/public/store/useSettingsStore';
import { parseProviderCategoryName } from '@/shared/lib/categoryName';
import { useCatalogByType } from './useCatalog';
import { CATALOG_FRESH_MS } from './catalogFreshness';
import { queryKeys } from '@/modules/sources/public/model/queryKeys';
import {
  useEnabledSources,
  type EnabledSourcesSnapshot,
} from '@/modules/sources/public/hooks/useEnabledSources';
import { xtreamCategoryId } from '@/modules/sources/public/lib/sourceIdentity';
import { notify } from '@/shared/notifications/useNotificationStore';
import { getErrorMessage } from '@/shared/lib/error';

export interface SourceCategory {
  category_id: string;
  category_name: string;
  parent_id: number;
}

const SAVED_CATEGORIES_PREFIX = 'movena.categories.v1:';

interface SavedCategories {
  savedAt: number;
  list: SourceCategory[];
}

function readSavedCategories(key: string): SavedCategories | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const saved = JSON.parse(raw) as Partial<SavedCategories>;
    return typeof saved.savedAt === 'number' && Array.isArray(saved.list)
      ? { savedAt: saved.savedAt, list: saved.list }
      : null;
  } catch {
    return null;
  }
}

function writeSavedCategories(key: string, list: SourceCategory[]): void {
  try {
    localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), list }));
  } catch {
    // Best effort: without a saved copy the next start simply asks the provider.
  }
}

const categoryRefreshes = new Set<string>();

/**
 * The category list for one catalogue. A saved copy is used first, on the same
 * freshness rule as the catalogue itself, so start-up never waits on a request
 * queued behind the large catalogue downloads.
 */
export function categoriesQueryOptions(
  type: CatalogType,
  sources: EnabledSourcesSnapshot,
  client: QueryClient = queryClient,
) {
  const queryKey = queryKeys.categories(type, sources.queryScope);
  const savedKey = `${SAVED_CATEGORIES_PREFIX}${JSON.stringify(queryKey)}`;
  return queryOptions({
    queryKey,
    queryFn: async ({ signal }): Promise<SourceCategory[]> => {
      const refreshLater = () => {
        if (categoryRefreshes.has(savedKey)) return;
        categoryRefreshes.add(savedKey);
        window.setTimeout(() => {
          fetchCategories(type, sources)
            .then((list) => {
              writeSavedCategories(savedKey, list);
              client.setQueryData(queryKey, list);
            })
            .catch(() => undefined)
            .finally(() => categoryRefreshes.delete(savedKey));
        }, 5_000);
      };
      const saved = desktopApi.isDesktop() ? readSavedCategories(savedKey) : null;
      if (saved) {
        if (Date.now() - saved.savedAt >= CATALOG_FRESH_MS) refreshLater();
        perfLog(`categories:disk:${type}`);
        return saved.list;
      }
      try {
        const list = await fetchCategories(type, sources, signal);
        if (desktopApi.isDesktop()) writeSavedCategories(savedKey, list);
        return list;
      } catch (error: unknown) {
        // On a first start the small category request can time out while the
        // catalogue is being prepared. Try once more when things are quiet, so
        // the next start has a saved copy.
        if (desktopApi.isDesktop()) refreshLater();
        throw error;
      }
    },
    staleTime: CATALOG_FRESH_MS,
    gcTime: 1000 * 60 * 60 * 12,
    retry: false,
  });
}

async function fetchCategories(
  type: CatalogType,
  sources: EnabledSourcesSnapshot,
  signal?: AbortSignal,
): Promise<SourceCategory[]> {
  const perfStart = performance.now();
  try {
    const groups = new Map<string, SourceCategory>();
    for (const source of sources.availableM3uSources) {
      for (const entry of source.runtime?.playlist?.entries ?? []) {
        if (entry.type !== type) continue;
        groups.set(entry.categoryId, {
          category_id: entry.categoryId,
          category_name: entry.groupTitle,
          parent_id: 0,
        });
      }
    }
    const results = await Promise.allSettled(
      sources.availableXtreamSources.map(async (source) => {
        let res;
        if (type === 'vod') res = await getVodCategories(source.credentials!, signal);
        else if (type === 'series') res = await getSeriesCategories(source.credentials!, signal);
        else res = await getLiveCategories(source.credentials!, signal);
        return (Array.isArray(res) ? res : []).map((category) => ({
          ...category,
          category_id: xtreamCategoryId(source.id, category.category_id)!,
          category_name: category.category_name,
        }));
      }),
    );
    const providerCategories = results.flatMap((result) =>
      result.status === 'fulfilled' ? result.value : [],
    );
    const providerFailures = results.flatMap((result, index) =>
      result.status === 'rejected'
        ? [
            `${sources.availableXtreamSources[index]?.profile.name ?? `Source ${index + 1}`}: ${getErrorMessage(result.reason, 'Category request failed without an error message.')}`,
          ]
        : [],
    );
    const failedProviders = providerFailures.length;
    if (groups.size === 0 && results.length > 0 && failedProviders === results.length) {
      throw new Error(providerFailures.join('\n'));
    }
    if (failedProviders > 0 && (providerCategories.length > 0 || groups.size > 0)) {
      notify.warning(
        'Some Categories Unavailable',
        `${failedProviders} enabled source${failedProviders === 1 ? '' : 's'} could not load categories. Available categories are still shown.\n${providerFailures.join('\n')}`,
        undefined,
        undefined,
        'connection',
      );
    }
    return [...providerCategories, ...groups.values()];
  } finally {
    perfLog(`categories:fetch:${type}`, performance.now() - perfStart);
  }
}

export function useCategories(type: CatalogType, options?: { enabled?: boolean | undefined }) {
  const sources = useEnabledSources();

  return useQuery({
    ...categoriesQueryOptions(type, sources),
    enabled: sources.isAvailable && (options?.enabled ?? true),
  });
}

/** Stable empty list so an unresolved query does not thrash memo identities. */
const EMPTY_LIST: never[] = [];

export interface HiddenCategoryState {
  ids: Set<string>;
  /**
   * False while the answer is still incomplete — a hidden country only maps to
   * category ids once the category list has arrived. Callers must hold items
   * back until then, or they would show exactly what the user hid.
   */
  isResolved: boolean;
}

export function useHiddenCategoryState(
  type: CatalogType,
  options?: { enabled?: boolean | undefined },
): HiddenCategoryState {
  const query = useCategories(type, options);
  const categories = query.data;
  const settled = query.isSuccess || query.isError;
  const categoryPrefs = useSettingsStore((s) => s.categoryPrefs);
  const hiddenKeywords = useSettingsStore((s) => s.catalogHiddenKeywords);

  return useMemo(() => {
    const hidden = categoryPrefs?.hidden?.[type] ?? [];
    const hiddenCountries = categoryPrefs?.hiddenCountries?.[type] ?? [];
    // Settings' content filter keywords apply to Movies and Series.
    const keywords =
      type === 'live' ? [] : (hiddenKeywords ?? []).map((keyword) => keyword.toLowerCase());
    const ids = new Set(hidden);
    // Direct ids need no lookup, so nothing is pending unless a country or a
    // keyword is hidden.
    if (hiddenCountries.length === 0 && keywords.length === 0) return { ids, isResolved: true };

    const hiddenCountrySet = new Set(hiddenCountries);
    for (const cat of categories ?? EMPTY_LIST) {
      const name = cat.category_name || '';
      const { country } = parseProviderCategoryName(name);
      const lowered = name.toLowerCase();
      if (
        hiddenCountrySet.has(country ?? 'other') ||
        keywords.some((keyword) => lowered.includes(keyword))
      ) {
        ids.add(String(cat.category_id));
      }
    }
    // A failed category request is as resolved as it will get: fall back to the
    // ids we do know rather than leaving every surface permanently empty.
    return { ids, isResolved: settled };
  }, [categories, categoryPrefs, hiddenKeywords, settled, type]);
}

/**
 * Every category id the user has hidden — directly, or by hiding the whole
 * country it belongs to.
 *
 * Shared between the sidebar and the catalogue pages on purpose. Hiding used to
 * be a sidebar-only affair, so a hidden country vanished from the list while its
 * channels carried on appearing under "All". The rule lives in one place now, so
 * the list and what it filters cannot disagree.
 */
export function useHiddenCategoryIds(
  type: CatalogType,
  options?: { enabled?: boolean | undefined },
): Set<string> {
  return useHiddenCategoryState(type, options).ids;
}

export interface VisibleItems<T> {
  data: T[];
  /**
   * True while it is not yet known what to drop. `data` is empty then, so a
   * surface should show its loading state instead of "nothing found".
   */
  isPending: boolean;
}

/**
 * Drops the items that sit in a hidden category from a catalogue fetched
 * elsewhere — for surfaces such as search that run their own queries.
 *
 * `enabled` gates the category lookup, so a surface that is idle (a search box
 * nobody has typed into) does not trigger category requests of its own.
 */
export function useWithoutHiddenCategories<T extends { categoryId?: string | undefined }>(
  type: CatalogType,
  items: T[],
  options?: { enabled?: boolean | undefined },
): VisibleItems<T> {
  const { ids, isResolved } = useHiddenCategoryState(type, options);

  return useMemo(() => {
    if (!isResolved) return { data: EMPTY_LIST as T[], isPending: true };
    const data =
      ids.size === 0
        ? items
        : items.filter((item) => !item.categoryId || !ids.has(item.categoryId));
    return { data, isPending: false };
  }, [items, ids, isResolved]);
}

/**
 * A catalogue with the user's hidden categories already removed.
 *
 * For browsing surfaces such as the home screen, which have no category
 * selection and should simply never surface hidden material. The catalogue
 * pages deliberately keep the unfiltered list: there, picking a hidden category
 * outright still has to show it, or "show hidden" would lead nowhere.
 */
export function useVisibleCatalog(type: CatalogType, options?: { enabled?: boolean | undefined }) {
  const query = useCatalogByType(type, options);
  const { data, isPending } = useWithoutHiddenCategories(type, query.data ?? EMPTY_LIST, options);

  return { ...query, data, isLoading: query.isLoading || isPending };
}
