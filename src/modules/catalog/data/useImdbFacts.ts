import { useQuery } from '@tanstack/react-query';
import { tauriApi, type ImdbFacts } from '@/platform/tauri';

/**
 * A title's IMDb match from the catalogue index, for the details sheet: the
 * same rating the Movies/Series pages sort and filter by. Null while the
 * title is unmatched or the index has nothing on it.
 */
export function useImdbFacts(type: 'vod' | 'series', itemId: string | undefined): ImdbFacts | null {
  const query = useQuery({
    queryKey: ['catalog-title-imdb', type, itemId],
    queryFn: () => tauriApi.catalogIndexImdb(type, itemId as string),
    enabled: !!itemId,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  return query.data ?? null;
}
