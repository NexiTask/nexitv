import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchTmdbDetails,
  fetchTmdbTitleMatch,
} from '@/modules/metadata/public/data/tmdbTitleLookup';
import { useTmdbLookupSettings } from '@/modules/metadata/public/hooks/useTmdbLookupSettings';
import { tmdbTitleKey } from '@/modules/metadata/public/model/tmdbMatch';
import { queryKeys } from '@/modules/sources/public/model/queryKeys';

const POSTER_STALE_TIME = 1000 * 60 * 60 * 24;

/**
 * The TMDB poster for a card whose provider copy has no usable one (an empty
 * cover, or a link that no longer loads). Silent by design: a card TMDB
 * cannot help just stays a placeholder, without an error toast per card.
 */
export function useTmdbPosterFallback(
  mediaType: 'movie' | 'tv' | undefined,
  lookup: { title: string; year?: string | undefined } | undefined,
): string | null {
  const queryClient = useQueryClient();
  const tmdb = useTmdbLookupSettings();
  const title = lookup?.title.trim() ?? '';
  const year = lookup?.year ? Number(lookup.year) : null;
  const active = (mediaType === 'movie' || mediaType === 'tv') && tmdb.enabled && title.length > 0;

  const query = useQuery({
    queryKey: queryKeys.tmdbTitleDetails(
      mediaType ?? 'movie',
      tmdbTitleKey(title),
      year,
      null,
      tmdb.options.language,
      tmdb.options.includeAdult,
      tmdb.options.imageSize,
    ),
    enabled: active,
    staleTime: POSTER_STALE_TIME,
    retry: false,
    queryFn: async () => {
      const match = await fetchTmdbTitleMatch(
        queryClient,
        tmdb.apiKey,
        { mediaType: mediaType as 'movie' | 'tv', title, year },
        tmdb.options,
      );
      return match
        ? fetchTmdbDetails(
            queryClient,
            tmdb.apiKey,
            mediaType as 'movie' | 'tv',
            match.id,
            tmdb.options,
          )
        : null;
    },
  });

  return query.data?.posterUrl ?? null;
}
