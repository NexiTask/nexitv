import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { tauriApi } from '@/platform/tauri';
import { useEnabledSources } from '@/modules/sources/public/hooks/useEnabledSources';
import { parseProviderCategoryName } from '@/shared/lib/categoryName';
import { mapXtreamList } from './useCatalog';
import { useCategories } from './useCategories';
import type { CatalogItem } from '../model/catalogItem';

/** One provider variant behind a grouped card, with the country its title or
 * category declares — the label's language when the tags say nothing. */
export interface TitleVariant {
  item: CatalogItem;
  country: string | null;
}

/**
 * The provider variants behind one grouped card (the card's own copy
 * included), mapped with the catalogue's own mapping. Empty while the title
 * has no IMDb identity, or none of the variant sources is enabled.
 */
export function useTitleVariants(
  type: 'vod' | 'series' | undefined,
  itemId: string | undefined,
): TitleVariant[] {
  const { availableXtreamSources } = useEnabledSources();
  const sourcesById = useMemo(() => {
    const byId = new Map<string, (typeof availableXtreamSources)[number]>();
    for (const source of availableXtreamSources) byId.set(source.id, source);
    return byId;
  }, [availableXtreamSources]);

  const rows = useQuery({
    queryKey: ['catalog-title-variants', type, itemId],
    queryFn: () => tauriApi.catalogIndexVariants(type as 'vod' | 'series', itemId as string),
    enabled: (type === 'vod' || type === 'series') && !!itemId,
    staleTime: Infinity,
    retry: false,
  });

  // Category names carry what the titles often do not: which language a
  // variant's copy is ("ES - Series", "Spanish", ...).
  const categories = useCategories(type === 'vod' || type === 'series' ? type : 'vod', {
    enabled: type === 'vod' || type === 'series',
  });
  const namesByCategory = useMemo(() => {
    const byId = new Map<string, string>();
    for (const category of categories.data ?? []) {
      byId.set(category.category_id, category.category_name);
    }
    return byId;
  }, [categories.data]);

  return useMemo(() => {
    const variants: TitleVariant[] = [];
    for (const [sourceId, raw] of rows.data ?? []) {
      const source = sourcesById.get(sourceId);
      if (!source) continue;
      try {
        const item = mapXtreamList(type as 'vod' | 'series', source, [JSON.parse(raw)])[0];
        if (!item) continue;
        const categoryName = item.categoryId ? namesByCategory.get(item.categoryId) : undefined;
        const country =
          item.country ?? (categoryName ? parseProviderCategoryName(categoryName).country : null);
        variants.push({ item, country });
      } catch {
        // A broken row just does not offer a version.
      }
    }
    return variants;
  }, [rows.data, sourcesById, namesByCategory, type]);
}
