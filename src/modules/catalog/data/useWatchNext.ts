import { useEffect } from 'react';
import { useQueries } from '@tanstack/react-query';
import { useAuthStore } from '@/modules/sources/public/store/useAuthStore';
import { xtreamItemId } from '@/modules/sources/public/lib/sourceIdentity';
import {
  isQueuedEpisode,
  useLibraryStore,
  type TrackedSeries,
} from '@/modules/library/public/store/useLibraryStore';
import { pickWatchNext, regularEpisodeCount } from '../lib/watchNext';
import { seriesInfoQuery } from './useDetails';
import { readWatchNextEpisodes } from './watchNextCache';

/** Started shows checked for a next episode at a time (one provider call each). */
const MAX_CHECKED = 12;

type Bookkeeping = { id: string; patch: Partial<Omit<TrackedSeries, 'item'>> };

/**
 * Watch Next: shows the viewer has started (and that are not already in
 * Continue Watching) that have an episode to watch, most recently watched
 * first. A dismissed show stays away until the provider lists more episodes.
 */
export function useWatchNext() {
  const tracked = useLibraryStore((state) => state.trackedSeries);
  const history = useLibraryStore((state) => state.history);
  const watched = useLibraryStore((state) => state.watched);
  const updateTrackedSeries = useLibraryStore((state) => state.updateTrackedSeries);
  const legacySourceId = useAuthStore((state) => state.profiles[0]?.id);
  const runtimes = useAuthStore((state) => state.runtimes);
  const resolveSourceId = (sourceId?: string) =>
    !sourceId || sourceId === 'xtream' ? legacySourceId : sourceId;
  const watchedSet = new Set(watched);
  const resuming = new Set(history.filter((item) => !isQueuedEpisode(item)).map((item) => item.id));
  const queued = history.filter((item) => {
    if (!isQueuedEpisode(item) || tracked[item.id]?.muted) return false;
    if (!item.episodeId) return true;
    const sourceId = resolveSourceId(item.sourceId);
    const episodeId = sourceId ? xtreamItemId(sourceId, 'episode', item.episodeId) : item.episodeId;
    return !watchedSet.has(episodeId) && !watchedSet.has(item.episodeId);
  });
  const queuedIds = new Set(queued.map((item) => item.id));

  const candidates = Object.entries(tracked)
    .filter(
      ([id, entry]) =>
        !entry.item.sourceId?.startsWith('m3u-') && !resuming.has(id) && !queuedIds.has(id),
    )
    .sort(([, left], [, right]) => right.lastWatchedAt - left.lastWatchedAt)
    .slice(0, MAX_CHECKED);

  const queries = candidates.map(([, entry]) => {
    const sourceId = resolveSourceId(entry.item.sourceId);
    const credentials = sourceId ? (runtimes[sourceId]?.credentials ?? null) : null;
    const providerSeriesId = entry.item.seriesSourceItemId || entry.item.sourceItemId;
    return {
      ...seriesInfoQuery(providerSeriesId ?? entry.item.id, entry.item.sourceId, credentials),
      enabled: Boolean(credentials),
    };
  });
  const results = useQueries({ queries });

  const items = [...queued];
  const bookkeeping: Bookkeeping[] = [];
  let savedEpisodes: ReturnType<typeof readWatchNextEpisodes> | undefined;
  candidates.forEach(([id, entry], index) => {
    const query = queries[index];
    let episodes = results[index]?.data?.episodes;
    // Keep dismissal counts tied to the provider response, even on a cold start.
    if (!episodes && !entry.muted && query?.enabled) {
      savedEpisodes ??= readWatchNextEpisodes();
      episodes = savedEpisodes.get(JSON.stringify(query.queryKey));
    }
    if (!episodes) return;
    const total = regularEpisodeCount(episodes);
    if (entry.muted) {
      if (entry.knownEpisodes === undefined) {
        bookkeeping.push({ id, patch: { knownEpisodes: total } });
        return;
      }
      if (total <= entry.knownEpisodes) return;
      bookkeeping.push({ id, patch: { muted: false } });
    }
    const sourceId = resolveSourceId(entry.item.sourceId);
    const pick = pickWatchNext(episodes, (episode) =>
      watchedSet.has(sourceId ? xtreamItemId(sourceId, 'episode', episode.id) : String(episode.id)),
    );
    if (!pick) return;
    const providerSeriesId = entry.item.seriesSourceItemId || entry.item.sourceItemId;
    items.push({
      ...entry.item,
      id,
      type: 'series',
      progressPercentage: 0,
      lastWatchedAt: entry.lastWatchedAt,
      seriesId: id,
      sourceItemId: providerSeriesId,
      seriesSourceItemId: providerSeriesId,
      seasonNum: pick.season,
      episodeNum: pick.episode.episode_num,
      episodeId: String(pick.episode.id),
      episodeTitle: pick.episode.title,
    });
  });

  // Dismissal bookkeeping only ever settles (each patch is applied once).
  const pending = JSON.stringify(bookkeeping);
  useEffect(() => {
    for (const { id, patch } of JSON.parse(pending) as Bookkeeping[]) {
      updateTrackedSeries(id, patch);
    }
  }, [pending, updateTrackedSeries]);

  return {
    items: items.sort((left, right) => right.lastWatchedAt - left.lastWatchedAt),
    isLoading: results.some((result) => result.isLoading),
    error: results.find((result) => result.isError)?.error ?? null,
    retry: () => {
      for (const result of results) if (result.isError) void result.refetch();
    },
  };
}
