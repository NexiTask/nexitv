import { queryOptions, useQuery } from '@tanstack/react-query';
import { tauriApi, type ImdbFacts } from '@/platform/tauri';
import type { MediaItem } from '../model/media';

export const IMDB_FACTS_QUERY_KEY = ['catalog-title-imdb'] as const;

export function imdbFactsQueryOptions(type: 'vod' | 'series', itemId: string | undefined) {
  return queryOptions({
    queryKey: [...IMDB_FACTS_QUERY_KEY, type, itemId],
    queryFn: () => tauriApi.catalogIndexImdb(type, itemId!),
    enabled: Boolean(itemId),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
}

export function withImdbFacts<T extends MediaItem>(item: T, imdb: ImdbFacts): T {
  return {
    ...item,
    imdbId: imdb.id,
    ...(imdb.rating !== null ? { imdbRating: imdb.rating } : {}),
    ...(imdb.votes !== null ? { imdbVotes: imdb.votes } : {}),
  };
}

/**
 * A title's IMDb match from the catalogue index, for the details sheet: the
 * same rating the Movies/Series pages sort and filter by. Null while the
 * title is unmatched or the index has nothing on it.
 */
export function useImdbFacts(type: 'vod' | 'series', itemId: string | undefined): ImdbFacts | null {
  const query = useQuery(imdbFactsQueryOptions(type, itemId));
  return query.data ?? null;
}
