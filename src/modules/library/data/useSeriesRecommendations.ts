import { useMemo } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useCategories, useVisibleCatalog } from '@/modules/catalog/public/data/useCategories';
import { imdbFactsQueryOptions, withImdbFacts } from '@/modules/catalog/public/data/useImdbFacts';
import { useUpcomingReleases } from '@/modules/guide/public/data/useUpcomingReleases';
import { useSettingsStore } from '@/modules/settings/public/store/useSettingsStore';
import { desktopApi } from '@/platform/desktop';
import { tauriApi } from '@/platform/tauri';
import { collectSeriesRecommendations } from './seriesRecommendations';
import { useLibraryStore, type HistoryItem } from '../store/useLibraryStore';

export const chatGptAccountQueryKey = ['chatgpt', 'accounts'] as const;
export const seriesRecommendationQueryKey = (clientId: string | null) =>
  ['chatgpt', 'series-recommendations', clientId] as const;

export function useSeriesRecommendations(
  next: HistoryItem[],
  enabled: boolean,
  prepareEmpty = false,
) {
  const desktop = desktopApi.isDesktop();
  const accounts = useQuery({
    queryKey: chatGptAccountQueryKey,
    queryFn: tauriApi.chatGptStatus,
    enabled: enabled && desktop,
    retry: false,
  });
  const activeId = accounts.data?.activeClient ?? null;
  const permission = accounts.data?.accounts.some(
    ({ clientId, planPermission }) => clientId === activeId && planPermission,
  );
  const snapshot = useQuery({
    queryKey: seriesRecommendationQueryKey(activeId),
    queryFn: () => tauriApi.recommendationsCached(activeId!),
    enabled: enabled && desktop && activeId !== null,
    retry: false,
  });

  const loadCandidates =
    enabled && desktop && (prepareEmpty || Boolean(snapshot.data?.picks.length));
  const savedSeriesIds = useMemo(() => {
    const ids = new Set<string>();
    for (const { key } of snapshot.data?.picks ?? []) {
      try {
        const parts: unknown = JSON.parse(key);
        if (Array.isArray(parts) && typeof parts[1] === 'string') ids.add(parts[1]);
      } catch {
        // An unreadable cached pick has no catalogue card to show.
      }
    }
    return ids;
  }, [snapshot.data]);
  const favorites = useLibraryStore((state) => state.favorites);
  const history = useLibraryStore((state) => state.history);
  const trackedSeries = useLibraryStore((state) => state.trackedSeries);
  const started = useLibraryStore((state) => state.startedSeries);
  const hideAdult = useSettingsStore((state) => state.catalogHideAdult);
  const catalogue = useVisibleCatalog('series', { enabled: loadCandidates });
  const categoryList = useCategories('series', { enabled: loadCandidates });
  const favoriteIds = useMemo(
    () => favorites.filter(({ type }) => type === 'series').map(({ id }) => id),
    [favorites],
  );
  const upcoming = useUpcomingReleases({
    favoriteIds,
    enabled: loadCandidates,
    cachedOnly: !prepareEmpty,
  });
  const today = new Date().toLocaleDateString('sv-SE');

  const data = useMemo(
    () =>
      collectSeriesRecommendations({
        catalogue: loadCandidates
          ? catalogue.data.filter(
              (item) =>
                (!hideAdult || !item.adult) && (prepareEmpty || savedSeriesIds.has(item.id)),
            )
          : [],
        favorites: loadCandidates ? favorites : [],
        history: loadCandidates ? history : [],
        trackedSeries: loadCandidates ? trackedSeries : {},
        started: loadCandidates ? started : [],
        next: loadCandidates ? next : [],
        upcoming: loadCandidates ? (upcoming.data ?? []) : [],
        categories: new Map(
          categoryList.data?.map(({ category_id, category_name }) => [category_id, category_name]),
        ),
        today,
      }),
    [
      loadCandidates,
      prepareEmpty,
      savedSeriesIds,
      catalogue.data,
      hideAdult,
      favorites,
      history,
      trackedSeries,
      started,
      next,
      upcoming.data,
      categoryList.data,
      today,
    ],
  );
  const cards = useMemo(
    () => (enabled ? data.groupPicks(snapshot.data?.picks ?? []) : []),
    [enabled, data, snapshot.data],
  );
  const imdb = useQueries({
    queries: cards.map(({ item }) => imdbFactsQueryOptions('series', item.id)),
  });
  const ratedCards = cards.map((card, index) => {
    const facts = imdb[index]?.data;
    return facts ? { ...card, item: withImdbFacts(card.item, facts) } : card;
  });
  return { accounts, activeId, permission, snapshot, catalogue, data, cards: ratedCards };
}
