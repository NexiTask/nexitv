import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { imdbFactsQueryOptions, withImdbFacts } from '@/modules/catalog/public/data/useImdbFacts';
import { useUpcomingReleases } from '@/modules/guide/public/data/useUpcomingReleases';
import { useSettingsStore } from '@/modules/settings/public/store/useSettingsStore';
import { desktopApi } from '@/platform/desktop';
import { collectAutomatedRecommendations } from './seriesRecommendations';
import { useLibraryStore, type HistoryItem } from '../store/useLibraryStore';

export function useAutomatedRecommendations(next: HistoryItem[], enabled: boolean, limit?: number) {
  const saved = useLibraryStore((state) => state.savedItems);
  const favorites = useLibraryStore((state) => state.favorites);
  const collections = useLibraryStore((state) => state.collections);
  const history = useLibraryStore((state) => state.history);
  const trackedSeries = useLibraryStore((state) => state.trackedSeries);
  const started = useLibraryStore((state) => state.startedSeries);
  const watched = useLibraryStore((state) => state.watched);
  const hideAdult = useSettingsStore((state) => state.catalogHideAdult);
  const upcoming = useUpcomingReleases({ enabled, cachedOnly: true });
  const today = new Date().toLocaleDateString('sv-SE');
  const items = useMemo(() => {
    if (!enabled) return [];
    const library = [...saved, ...favorites, ...collections.flatMap(({ items }) => items)];
    return collectAutomatedRecommendations(library, {
      history,
      trackedSeries,
      started,
      watched,
      next,
      upcoming: upcoming.data ?? [],
      today,
    })
      .filter((item) => !hideAdult || !('adult' in item && item.adult === true))
      .slice(0, limit);
  }, [
    enabled,
    saved,
    favorites,
    collections,
    history,
    trackedSeries,
    started,
    watched,
    next,
    upcoming.data,
    today,
    hideAdult,
    limit,
  ]);
  const imdb = useQueries({
    queries: desktopApi.isDesktop()
      ? items.map((item) => imdbFactsQueryOptions('series', item.id))
      : [],
  });
  return items.map((item, index) => {
    const facts = imdb[index]?.data;
    return facts ? withImdbFacts(item, facts) : item;
  });
}
