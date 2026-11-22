import { useEffect, useRef } from 'react';
import { queryClient } from '@/shared/query/queryClient';
import { useAuthStore } from '@/modules/sources/public/store/useAuthStore';
import { xtreamItemId } from '@/modules/sources/public/lib/sourceIdentity';
import { useLibraryStore } from '@/modules/library/public/store/useLibraryStore';
import { seriesInfoQuery, sourceCredentials } from './useDetails';

const SERIES_ID = /^(.+):series:([^:]+)$/;

/**
 * Series marked watched as a whole before every episode was marked with them
 * only have the card flagged. This marks their episodes too, once per series
 * (quietly), as soon as the source they belong to is ready. A series whose
 * episodes cannot be fetched is tried again next time.
 */
export async function migrateWatchedSeries(): Promise<number> {
  const { watched, syncedSeries } = useLibraryStore.getState();
  const done = new Set(syncedSeries);
  let migrated = 0;
  for (const id of watched) {
    const match = SERIES_ID.exec(id);
    if (!match || done.has(id)) continue;
    const [, sourceId, providerSeriesId] = match as unknown as [string, string, string];
    const credentials = sourceCredentials(sourceId);
    if (!credentials) continue;
    try {
      const data = await queryClient.fetchQuery(
        seriesInfoQuery(providerSeriesId, sourceId, credentials),
      );
      const library = useLibraryStore.getState();
      const episodeIds = Object.values(data.episodes ?? {}).flatMap((episodes) =>
        episodes.map((episode) => xtreamItemId(sourceId, 'episode', episode.id)),
      );
      library.setWatched(episodeIds, true, true);
      library.setSeriesStarted(id, true, {
        id,
        title: data.info?.name ?? '',
        posterUrl: data.info?.cover ?? '',
        type: 'series',
        sourceId,
        sourceItemId: providerSeriesId,
        seriesSourceItemId: providerSeriesId,
      });
      library.markSeriesSynced(id);
      migrated += 1;
    } catch {
      // Left for the next start.
    }
  }
  return migrated;
}

/** Runs the migration at start, and again as sources become ready. */
export function useSeriesWatchedMigration() {
  const runtimes = useAuthStore((state) => state.runtimes);
  const running = useRef(false);
  useEffect(() => {
    if (running.current) return;
    running.current = true;
    void migrateWatchedSeries().finally(() => {
      running.current = false;
    });
  }, [runtimes]);
}
