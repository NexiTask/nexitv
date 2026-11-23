import { queryOptions, useQuery, type QueryClient } from '@tanstack/react-query';
import { queryClient } from '@/shared/query/queryClient';
import { trackDataActivity } from '@/shared/lib/dataActivity';
import {
  getLiveStreams,
  getSeries,
  getStreamUrl,
  getVodStreams,
  type XtreamLiveStream,
  type XtreamSeries,
  type XtreamVodStream,
} from '@/modules/sources/public/data/xtreamClient';
import { desktopApi } from '@/platform/desktop';
import { debugLog } from '@/modules/diagnostics/public/store/useDebugStore';
import { loadProviderList, rememberProviderList, storeProviderList } from './catalogDiskCache';
import { CATALOG_FRESH_MS } from './catalogFreshness';
import { perfAsync, perfSync } from '@/platform/perf';
import { queryKeys } from '@/modules/sources/public/model/queryKeys';
import { parseLiveChannelTitle, parseMediaTitle } from '../lib/titleParser';
import {
  useEnabledSources,
  type EnabledSourcesSnapshot,
  type EnabledXtreamSource,
} from '@/modules/sources/public/hooks/useEnabledSources';
import {
  getM3uSeriesGroups,
  type M3uEntry,
  type M3uPlaylist,
} from '@/modules/sources/public/data/m3uClient';
import { foldLiveChannels } from '../lib/streamFolding';
import { useSettingsStore } from '@/modules/settings/public/store/useSettingsStore';
import { notify } from '@/shared/notifications/useNotificationStore';
import { getErrorMessage } from '@/shared/lib/error';

import type { CatalogItem } from '../model/catalogItem';
import { xtreamLiveFields, xtreamSeriesItem, xtreamVodFields } from '../lib/xtreamItemFields';

export type { CatalogItem } from '../model/catalogItem';

const foldedLiveCatalogs = new WeakMap<CatalogItem[], CatalogItem[]>();

/** Share the expensive stream-folding result across every observer of one catalog. */
export function selectFoldedLiveCatalog(data: CatalogItem[]): CatalogItem[] {
  const cached = foldedLiveCatalogs.get(data);
  if (cached) return cached;
  const folded = foldLiveChannels(data) as CatalogItem[];
  foldedLiveCatalogs.set(data, folded);
  return folded;
}

function m3uEntryItem(entry: M3uEntry, sourceName?: string): CatalogItem {
  const liveMetadata = entry.type === 'live' ? parseLiveChannelTitle(entry.title) : null;
  const mediaMetadata = entry.type === 'live' ? null : parseMediaTitle(entry.title);
  return {
    id: entry.id,
    sourceItemId: entry.id,
    title: entry.title,
    posterUrl: entry.logo || '',
    type: entry.type === 'series' ? 'series' : entry.type,
    channelNum: entry.channelNumber,
    year: entry.year,
    rating: entry.rating,
    categoryId: entry.categoryId,
    epgChannelId: entry.tvgId,
    tags: liveMetadata?.qualityBadges ?? mediaMetadata?.tags,
    country: liveMetadata?.country ?? mediaMetadata?.country,
    streamUrl: entry.url,
    httpHeaders: entry.headers,
    sourceId: entry.sourceId,
    subtitle: sourceName,
    description: entry.description,
    radio: entry.radio,
    radioMetadata: entry.radioMetadata,
    catchup: entry.catchup,
    catchupSource: entry.catchupSource,
    catchupDays: entry.catchupDays,
    containerExtension: entry.url.match(/\.([a-z0-9]{2,5})(?:[?#]|$)/i)?.[1],
  };
}

export function mapM3uCatalog(
  playlist: M3uPlaylist,
  type: 'live' | 'vod' | 'series',
  sourceName?: string,
): CatalogItem[] {
  if (type !== 'series') {
    return playlist.entries
      .filter((entry) => entry.type === type)
      .map((entry) => m3uEntryItem(entry, sourceName));
  }
  return [...getM3uSeriesGroups(playlist).entries()].map(([id, episodes]) => {
    const first = episodes[0]!;
    const title = first.episode?.seriesTitle || first.title;
    const metadata = parseMediaTitle(title);
    return {
      id,
      sourceItemId: id,
      title,
      posterUrl: first.logo || '',
      type: 'series',
      rating: first.rating,
      year: first.year,
      categoryId: first.categoryId,
      tags: metadata.tags,
      country: metadata.country,
      sourceId: first.sourceId,
      subtitle: sourceName,
      description: first.description,
    };
  });
}

export function playlistCatalog(
  type: 'live' | 'vod' | 'series',
  sources: EnabledSourcesSnapshot,
): CatalogItem[] {
  return sources.availableM3uSources.flatMap((source) =>
    source.runtime?.playlist
      ? mapM3uCatalog(source.runtime.playlist, type, source.profile.name)
      : [],
  );
}

/** The provider's raw list for one catalogue type, as the provider sent it. */
function fetchXtreamList(
  type: 'live' | 'vod' | 'series',
  source: EnabledXtreamSource,
  signal?: AbortSignal,
): Promise<unknown[]> {
  return trackDataActivity('catalog', async (reportProgress) => {
    const credentials = source.credentials!;
    const response =
      type === 'live'
        ? await getLiveStreams(credentials, undefined, signal, reportProgress)
        : type === 'vod'
          ? await getVodStreams(credentials, undefined, signal, reportProgress)
          : await getSeries(credentials, undefined, signal, reportProgress);
    return Array.isArray(response) ? response : [];
  });
}

/**
 * Maps a provider list. `indexes` gives each row's position in the full
 * provider list when `list` is only part of it (rows served by the index),
 * so positional fallbacks such as channel numbers come out the same.
 */
export function mapXtreamList(
  type: 'live' | 'vod' | 'series',
  source: EnabledXtreamSource,
  list: unknown[],
  indexes?: readonly number[],
): CatalogItem[] {
  return type === 'live'
    ? mapXtreamLive(source, list as XtreamLiveStream[], indexes)
    : type === 'vod'
      ? mapXtreamVod(source, list as XtreamVodStream[], indexes)
      : mapXtreamSeries(source, list as XtreamSeries[], indexes);
}

/** Saved copies older than this are still shown, but flagged as outdated. */
const CATALOG_OUTDATED_MS = 7 * 24 * 60 * 60 * 1000;
/** Background refreshes wait until the saved catalogue has rendered. */
const BACKGROUND_REFRESH_DELAY_MS = 5_000;

type CatalogType = 'live' | 'vod' | 'series';

const catalogTypes = ['live', 'vod', 'series'] as const;
const providerRefreshes = new Map<string, Promise<unknown[]>>();

function fetchProviderRefresh(type: CatalogType, source: EnabledXtreamSource) {
  const key = `${type}:${source.id}:${source.queryScope}`;
  const inFlight = providerRefreshes.get(key);
  if (inFlight) return inFlight;
  const request = fetchXtreamList(type, source).finally(() => providerRefreshes.delete(key));
  providerRefreshes.set(key, request);
  return request;
}

export function providerCatalogCount(sources: EnabledSourcesSnapshot): number {
  return sources.xtreamSources.length * catalogTypes.length;
}

/** Fetch each enabled provider list from the network, leaving failed lists in place. */
export async function refreshProviderCatalogs(
  sources: EnabledSourcesSnapshot,
  onListSettled: () => void,
  client: QueryClient = queryClient,
): Promise<string[]> {
  const failed = new Map<string, string>();
  const targets = sources.xtreamSources;
  for (const type of catalogTypes) {
    const queryKey = queryKeys.catalog(type, sources.queryScope);
    const refreshed = await Promise.allSettled(
      targets.map(async (source) => {
        try {
          if (!source.credentials || !source.isAvailable) {
            throw new Error('The saved credential is unavailable');
          }
          const list = await fetchProviderRefresh(type, source);
          if (list.length === 0) {
            const current = client.getQueryData<CatalogItem[]>(queryKey);
            const saved = desktopApi.isDesktop()
              ? await loadProviderList(source.id, type, source.queryScope)
              : null;
            if (saved?.list.length || current?.some((item) => item.sourceId === source.id)) {
              throw new Error('The provider returned an empty catalogue');
            }
          }
          const items = mapXtreamList(type, source, list);
          await storeProviderList(source.id, type, source.queryScope, list);
          return { sourceId: source.id, items };
        } finally {
          onListSettled();
        }
      }),
    );
    const lists = refreshed.flatMap((result, i) => {
      if (result.status === 'fulfilled') return [result.value];
      const source = targets[i]!;
      failed.set(source.id, source.profile.name);
      return [];
    });
    if (!lists.length) continue;
    await client.cancelQueries({ queryKey, exact: true });
    client.setQueryData<CatalogItem[]>(queryKey, (current) => {
      const base =
        current ?? (lists.length === targets.length ? playlistCatalog(type, sources) : undefined);
      return (
        base &&
        lists.reduce(
          (items, list) => replaceSourceItems(items, list.sourceId, list.items, sources),
          base,
        )
      );
    });
  }
  return [...failed.values()];
}

const backgroundRefreshes = new Set<string>();

/**
 * Fetch one source's list from the provider after start-up and swap that
 * source's items into the catalogue query. A failure keeps the saved copy.
 */
function scheduleBackgroundRefresh(
  client: QueryClient,
  type: CatalogType,
  source: EnabledXtreamSource,
  sources: EnabledSourcesSnapshot,
  savedAt: number,
): void {
  const queryKey = queryKeys.catalog(type, sources.queryScope);
  const refreshId = `${JSON.stringify(queryKey)}:${source.id}`;
  if (backgroundRefreshes.has(refreshId)) return;
  backgroundRefreshes.add(refreshId);
  window.setTimeout(() => {
    void (async () => {
      try {
        const list = await perfAsync(
          `bg:fetch_json:${type}`,
          () => fetchProviderRefresh(type, source),
          (l) => `items=${l.length}`,
        );
        if (list.length === 0) throw new Error('The provider returned an empty catalogue');
        rememberProviderList(source.id, type, source.queryScope, list);
        const fresh = perfSync(`bg:map:${type}`, () => mapXtreamList(type, source, list));
        client.setQueryData<CatalogItem[]>(queryKey, (current) =>
          current ? replaceSourceItems(current, source.id, fresh, sources) : current,
        );
      } catch (error: unknown) {
        debugLog.warn('api', 'Catalogue refresh failed; keeping the saved copy', {
          type,
          error: getErrorMessage(error, 'Refreshing the catalogue failed.'),
        });
        if (Date.now() - savedAt > CATALOG_OUTDATED_MS) {
          const days = Math.floor((Date.now() - savedAt) / (24 * 60 * 60 * 1000));
          notify.warning(
            'Showing a Saved Catalogue',
            `${source.profile.name} could not be reached. Its ${type === 'vod' ? 'movie' : type} list is from ${days} days ago.`,
            undefined,
            undefined,
            'connection',
          );
        }
      } finally {
        backgroundRefreshes.delete(refreshId);
      }
    })();
  }, BACKGROUND_REFRESH_DELAY_MS);
}

/** Replace one source's items, keeping the order the sources are listed in. */
function replaceSourceItems(
  current: CatalogItem[],
  sourceId: string,
  fresh: CatalogItem[],
  sources: EnabledSourcesSnapshot,
): CatalogItem[] {
  const xtreamIds = new Set(sources.availableXtreamSources.map((source) => source.id));
  const bySource = new Map<string, CatalogItem[]>();
  const others: CatalogItem[] = [];
  for (const item of current) {
    if (item.sourceId && xtreamIds.has(item.sourceId)) {
      const list = bySource.get(item.sourceId) ?? [];
      list.push(item);
      bySource.set(item.sourceId, list);
    } else {
      others.push(item);
    }
  }
  bySource.set(sourceId, fresh);
  return [
    ...sources.availableXtreamSources.flatMap((source) => bySource.get(source.id) ?? []),
    ...others,
  ];
}

/**
 * The saved copy for one source when there is one; the provider otherwise.
 * A stale copy is returned at once and refreshed in the background.
 */
async function loadSourceList(
  client: QueryClient,
  type: CatalogType,
  source: EnabledXtreamSource,
  sources: EnabledSourcesSnapshot,
  signal: AbortSignal | undefined,
): Promise<CatalogItem[]> {
  if (desktopApi.isDesktop()) {
    const saved = await loadProviderList(source.id, type, source.queryScope).catch(
      (error: unknown) => {
        debugLog.warn('api', 'Saved catalogue could not be read; asking the provider', {
          type,
          error: getErrorMessage(error, 'Reading the saved catalogue failed.'),
        });
        return null;
      },
    );
    if (saved) {
      if (Date.now() - saved.savedAt >= CATALOG_FRESH_MS) {
        scheduleBackgroundRefresh(client, type, source, sources, saved.savedAt);
      }
      return perfSync(`disk:map:${type}`, () => mapXtreamList(type, source, saved.list));
    }
  }
  const list = await perfAsync(
    `net:fetch_json:${type}`,
    () => fetchXtreamList(type, source, signal),
    (l) => `items=${l.length}`,
  );
  rememberProviderList(source.id, type, source.queryScope, list);
  return perfSync(`net:map:${type}`, () => mapXtreamList(type, source, list));
}

export function catalogQueryOptions(
  type: CatalogType,
  sources: EnabledSourcesSnapshot,
  client: QueryClient = queryClient,
) {
  return queryOptions({
    queryKey: queryKeys.catalog(type, sources.queryScope),
    queryFn: async ({ signal }): Promise<CatalogItem[]> => {
      const playlistItems = playlistCatalog(type, sources);
      const results = await Promise.allSettled(
        sources.availableXtreamSources.map((source) =>
          loadSourceList(client, type, source, sources, signal),
        ),
      );
      const providerItems = successful(results);
      const providerFailures = results.flatMap((result, index) =>
        result.status === 'rejected'
          ? [
              `${sources.availableXtreamSources[index]?.profile.name ?? `Source ${index + 1}`}: ${getErrorMessage(result.reason, 'Request failed without an error message.')}`,
            ]
          : [],
      );
      const failedProviders = providerFailures.length;
      if (!playlistItems.length && results.length > 0 && failedProviders === results.length) {
        throw new Error(providerFailures.join('\n'));
      }
      if (failedProviders > 0 && (providerItems.length > 0 || playlistItems.length > 0)) {
        notify.warning(
          'Some Sources Unavailable',
          `${failedProviders} enabled source${failedProviders === 1 ? '' : 's'} could not load. Results from the remaining sources are shown.\n${providerFailures.join('\n')}`,
          undefined,
          undefined,
          'connection',
        );
      }
      return [...providerItems, ...playlistItems];
    },
    // The saved copy decides freshness (CATALOG_FRESH_MS). Matching it here
    // keeps a long-running session from asking again before that copy would.
    staleTime: CATALOG_FRESH_MS,
    gcTime: 1000 * 60 * 60 * 12,
    retry: false,
  });
}

export function isCatalogAvailable(
  type: 'live' | 'vod' | 'series',
  sources: EnabledSourcesSnapshot,
): boolean {
  void type;
  return sources.isAvailable;
}

function successful<T>(results: PromiseSettledResult<T[]>[]): T[] {
  return results.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
}

function mapXtreamLive(
  source: EnabledXtreamSource,
  response: XtreamLiveStream[],
  indexes?: readonly number[],
): CatalogItem[] {
  const credentials = source.credentials!;
  return response.map((stream, position) => {
    const fields = xtreamLiveFields(
      source.id,
      source.profile.name,
      stream,
      indexes?.[position] ?? position,
    );
    const providerId = fields.sourceItemId;
    return {
      ...fields,
      streamUrl: stream.direct_source || getStreamUrl(credentials, 'live', providerId),
      fallbacks: stream.direct_source
        ? [{ streamUrl: getStreamUrl(credentials, 'live', providerId) }]
        : undefined,
    };
  });
}

function mapXtreamVod(
  source: EnabledXtreamSource,
  streams: XtreamVodStream[],
  indexes?: readonly number[],
): CatalogItem[] {
  const credentials = source.credentials!;
  return streams.map((stream, position) => {
    const fields = xtreamVodFields(
      source.id,
      source.profile.name,
      stream,
      indexes?.[position] ?? position,
    );
    return {
      ...fields,
      streamUrl:
        stream.direct_source ||
        getStreamUrl(credentials, 'vod', fields.sourceItemId!, stream.container_extension || 'mp4'),
      containerExtension: stream.container_extension,
    };
  });
}

function mapXtreamSeries(
  source: EnabledXtreamSource,
  streams: XtreamSeries[],
  indexes?: readonly number[],
): CatalogItem[] {
  return streams.map((stream, position) =>
    xtreamSeriesItem(source.id, source.profile.name, stream, indexes?.[position] ?? position),
  );
}

export function useLiveStreams(options?: { enabled?: boolean | undefined }) {
  const sources = useEnabledSources();
  const streamFoldingEnabled = useSettingsStore((s) => s.streamFoldingEnabled);
  return useQuery({
    ...catalogQueryOptions('live', sources),
    enabled: sources.isAvailable && (options?.enabled ?? true),
    ...(streamFoldingEnabled ? { select: selectFoldedLiveCatalog } : {}),
  });
}

export function useVodStreams(options?: { enabled?: boolean | undefined }) {
  const sources = useEnabledSources();
  return useQuery({
    ...catalogQueryOptions('vod', sources),
    enabled: sources.isAvailable && (options?.enabled ?? true),
  });
}

export function useSeriesList(options?: { enabled?: boolean | undefined }) {
  const sources = useEnabledSources();
  return useQuery({
    ...catalogQueryOptions('series', sources),
    enabled: sources.isAvailable && (options?.enabled ?? true),
  });
}

/** Picks the catalogue that belongs to a category sidebar's type. */
export function useCatalogByType(
  type: 'live' | 'vod' | 'series',
  options?: { enabled?: boolean | undefined },
) {
  const enabled = options?.enabled ?? true;
  const live = useLiveStreams({ enabled: enabled && type === 'live' });
  const vod = useVodStreams({ enabled: enabled && type === 'vod' });
  const series = useSeriesList({ enabled: enabled && type === 'series' });
  return type === 'live' ? live : type === 'vod' ? vod : series;
}
