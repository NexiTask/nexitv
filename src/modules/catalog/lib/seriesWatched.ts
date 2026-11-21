import { queryClient } from '@/shared/query/queryClient';
import { resolveXtreamSourceId } from '@/modules/sources/public/store/useAuthStore';
import { xtreamItemId } from '@/modules/sources/public/lib/sourceIdentity';
import { useLibraryStore } from '@/modules/library/public/store/useLibraryStore';
import { seriesInfoQuery, sourceCredentials } from '../data/useDetails';
import type { MediaItem } from '../model/media';

/** A series card, as opposed to one of its episodes (which carry a seriesId). */
export const isSeriesCard = (item: MediaItem) => item.type === 'series' && !item.seriesId;

/**
 * Marks a whole series watched (or unwatched): the series itself and every
 * episode of every season, so the info view shows them as watched too.
 * When the episode list cannot be fetched (an M3U source, no credentials, a
 * provider error) only the series itself is marked.
 */
export async function setSeriesWatched(item: MediaItem, watched: boolean): Promise<void> {
  const ids = [item.id];
  try {
    const credentials = sourceCredentials(item.sourceId);
    if (credentials && !item.sourceId?.startsWith('m3u-')) {
      const providerSeriesId = item.seriesSourceItemId || item.sourceItemId || item.id;
      const data = await queryClient.fetchQuery(
        seriesInfoQuery(providerSeriesId, item.sourceId, credentials),
      );
      const sourceId = resolveXtreamSourceId(item.sourceId);
      for (const episodes of Object.values(data.episodes ?? {})) {
        for (const episode of episodes) {
          ids.push(sourceId ? xtreamItemId(sourceId, 'episode', episode.id) : String(episode.id));
        }
      }
    }
  } catch {
    // Fall back to the series alone.
  }
  const library = useLibraryStore.getState();
  library.setWatched(ids, watched);
  library.setSeriesStarted(item.id, watched);
}
