import { useQuery } from '@tanstack/react-query';
import {
  getXtreamCredentials,
  resolveXtreamSourceId,
  useAuthStore,
} from '@/modules/sources/public/store/useAuthStore';
import {
  getSeriesInfo,
  getVodInfo,
  type XtreamSeriesInfoResponse,
  type XtreamVodInfo,
} from '@/modules/sources/public/data/xtreamClient';
import type { XtreamCredentials } from '@/modules/sources/public/model/xtream';
import { getXtreamQueryScope, queryKeys } from '@/modules/sources/public/model/queryKeys';
import { saveWatchNextEpisodes } from './watchNextCache';

export const detailQueryKeys = {
  vod: queryKeys.vodInfo,
  series: queryKeys.seriesInfo,
};

function useSourceCredentials(sourceId?: string) {
  const resolvedSourceId = resolveXtreamSourceId(sourceId);
  return useAuthStore((state) =>
    resolvedSourceId
      ? (state.runtimes[resolvedSourceId]?.credentials ?? null)
      : getXtreamCredentials(),
  );
}

/** A source's credentials outside React (the card's quick play). */
export function sourceCredentials(sourceId?: string): XtreamCredentials | null {
  const resolvedSourceId = resolveXtreamSourceId(sourceId);
  return resolvedSourceId
    ? (useAuthStore.getState().runtimes[resolvedSourceId]?.credentials ?? null)
    : getXtreamCredentials();
}

/** The movie details query: shared by the dialog and the card's quick play,
 * so both read and fill the same cache entry. */
export function vodInfoQuery(
  vodId: string | number | undefined,
  sourceId: string | undefined,
  credentials: XtreamCredentials | null,
) {
  const resolvedSourceId = resolveXtreamSourceId(sourceId);
  const authScope = getXtreamQueryScope(resolvedSourceId, credentials);
  return {
    queryKey: detailQueryKeys.vod(vodId, authScope),
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<XtreamVodInfo> => {
      const data = await getVodInfo(credentials!, vodId!, signal);
      return { ...data, movie_data: { ...data.movie_data, source_id: resolvedSourceId } };
    },
    staleTime: 1000 * 60 * 15,
    gcTime: 1000 * 60 * 30,
    retry: false,
  } as const;
}

/** The series details query (episodes per season); see `vodInfoQuery`. */
export function seriesInfoQuery(
  seriesId: string | number | undefined,
  sourceId: string | undefined,
  credentials: XtreamCredentials | null,
) {
  const resolvedSourceId = resolveXtreamSourceId(sourceId);
  const authScope = getXtreamQueryScope(resolvedSourceId, credentials);
  const queryKey = detailQueryKeys.series(seriesId, authScope);
  return {
    queryKey,
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<XtreamSeriesInfoResponse> => {
      const data = await getSeriesInfo(credentials!, seriesId!.toString(), signal);
      const episodes = Object.fromEntries(
        Object.entries(data.episodes ?? {}).map(([season, list]) => [
          season,
          list.map((episode) => ({ ...episode, source_id: resolvedSourceId })),
        ]),
      );
      if (!signal.aborted) saveWatchNextEpisodes(queryKey, episodes);
      return { ...data, episodes };
    },
    staleTime: 1000 * 60 * 15,
    gcTime: 1000 * 60 * 30,
    retry: false,
  } as const;
}

/** One canonical, source-isolated query per detail resource. */
export function useVodInfo(vodId: string | number | undefined, sourceId?: string, enabled = true) {
  const credentials = useSourceCredentials(sourceId);
  return useQuery<XtreamVodInfo>({
    ...vodInfoQuery(vodId, sourceId, credentials),
    enabled: enabled && !!credentials && vodId !== undefined && vodId !== '',
  });
}

export function useSeriesInfo(
  seriesId: string | number | undefined,
  sourceId?: string,
  enabled = true,
) {
  const credentials = useSourceCredentials(sourceId);
  return useQuery<XtreamSeriesInfoResponse>({
    ...seriesInfoQuery(seriesId, sourceId, credentials),
    enabled: enabled && !!credentials && seriesId !== undefined && seriesId !== '',
  });
}
