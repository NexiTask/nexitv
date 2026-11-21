import type { CatalogType } from '@/modules/settings/store/useSettingsStore';
import type { EnabledSourcesSnapshot } from '@/modules/sources/hooks/useEnabledSources';
import { isCatalogAvailable } from '@/modules/catalog/data/useCatalog';
import { categoriesQueryOptions } from '@/modules/catalog/data/useCategories';
import { queryClient } from '@/shared/query/queryClient';
import { preloadRouteModule } from '../router/routeModules';

const ROUTE_CATEGORIES: Record<string, readonly CatalogType[]> = {
  '/': ['live', 'vod', 'series'],
  '/live': ['live'],
  '/epg': ['live'],
  '/movies': ['vod'],
  '/series': ['series'],
};

/**
 * Warm cheap data for a likely navigation (route code and categories).
 *
 * Full catalogs are deliberately not prefetched: a large Xtream catalog is
 * hundreds of thousands of items mapped on the main thread, so warming it on
 * a sidebar hover froze the UI for seconds (NTV-1). The XMLTV guide is not
 * fetched speculatively either.
 */
export async function prefetchNavigationData(
  path: string,
  sources: EnabledSourcesSnapshot,
): Promise<void> {
  const types = (ROUTE_CATEGORIES[path] ?? []).filter((type) => isCatalogAvailable(type, sources));
  await Promise.all([
    preloadRouteModule(path),
    ...types.map((type) => queryClient.prefetchQuery(categoriesQueryOptions(type, sources))),
  ]);
}
