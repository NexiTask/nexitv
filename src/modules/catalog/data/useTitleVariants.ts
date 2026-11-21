import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { tauriApi } from '@/platform/tauri';
import { useEnabledSources } from '@/modules/sources/hooks/useEnabledSources';
import { mapXtreamList } from './useCatalog';
import type { CatalogItem } from '../model/catalogItem';

/**
 * The provider variants behind one grouped card, mapped with the catalogue's
 * own mapping. Empty while the title has no IMDb identity, or none of the
 * variant sources is enabled.
 */
export function useTitleVariants(
  type: 'vod' | 'series' | undefined,
  itemId: string | undefined,
): CatalogItem[] {
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

  return useMemo(() => {
    const variants: CatalogItem[] = [];
    for (const [sourceId, raw] of rows.data ?? []) {
      const source = sourcesById.get(sourceId);
      if (!source) continue;
      try {
        const item = mapXtreamList(type as 'vod' | 'series', source, [JSON.parse(raw)])[0];
        if (item) variants.push(item);
      } catch {
        // A broken row just does not offer a version.
      }
    }
    return variants;
  }, [rows.data, sourcesById, type]);
}
