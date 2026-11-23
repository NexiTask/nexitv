import { useEffect } from 'react';
import { useQueries } from '@tanstack/react-query';
import { resolveXtreamSourceId } from '@/modules/sources/public/store/useAuthStore';
import { xtreamItemId } from '@/modules/sources/public/lib/sourceIdentity';
import {
  isQueuedEpisode,
  useLibraryStore,
  type HistoryItem,
  type TrackedSeries,
} from '@/modules/library/public/store/useLibraryStore';
import { pickWatchNext, regularEpisodeCount } from '../lib/watchNext';
import { seriesInfoQuery, sourceCredentials } from './useDetails';

/** Started shows checked for a next episode at a time (one provider call each). */
const MAX_CHECKED = 12;

type Bookkeeping = { id: string; patch: Partial<Omit<TrackedSeries, 'item'>> };

/**
 * Watch Next: shows the viewer has started (and that are not already in
 * Continue Watching) that have an episode to watch, most recently watched
 * first. A dismissed show stays away until the provider lists more episodes.
 */
export function useWatchNext(): HistoryItem[] {
  const tracked = useLibraryStore((state) => state.trackedSeries);
  const history = useLibraryStore((state) => state.history);
  const watched = useLibraryStore((state) => state.watched);
  const updateTrackedSeries = useLibraryStore((state) => state.updateTrackedSeries);
  const watchedSet = new Set(watched);
  const resuming = new Set(history.filter((item) => !isQueuedEpisode(item)).map((item) => item.id));
  const queued = history.filter((item) => {
    if (!isQueuedEpisode(item) || tracked[item.id]?.muted) return false;
    if (!item.episodeId) return true;
    const sourceId = resolveXtreamSourceId(item.sourceId);
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

  const results = useQueries({
    queries: candidates.map(([, entry]) => {
      const credentials = sourceCredentials(entry.item.sourceId);
      const providerSeriesId = entry.item.seriesSourceItemId || entry.item.sourceItemId;
      return {
        ...seriesInfoQuery(providerSeriesId ?? entry.item.id, entry.item.sourceId, credentials),
        enabled: Boolean(credentials),
      };
    }),
  });

  const items = [...queued];
  const bookkeeping: Bookkeeping[] = [];
  candidates.forEach(([id, entry], index) => {
    const episodes = results[index]?.data?.episodes;
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
    const sourceId = resolveXtreamSourceId(entry.item.sourceId);
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

  return items.sort((left, right) => right.lastWatchedAt - left.lastWatchedAt);
}
