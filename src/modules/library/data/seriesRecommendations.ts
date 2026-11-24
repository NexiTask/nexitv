import { CATALOG_GENRES, catalogGenreMask } from '@/modules/catalog/public/lib/catalogGenres';
import { getDisplayTitle } from '@/modules/catalog/public/lib/titleParser';
import type { MediaItem } from '@/modules/catalog/public/model/media';
import type { UpcomingRelease } from '@/modules/guide/public/data/useUpcomingReleases';
import type { SeriesRecommendationKind, SeriesRecommendationRequest } from '@/platform/tauri';
import { isQueuedEpisode, type HistoryItem, type TrackedSeries } from '../store/useLibraryStore';

interface Candidate {
  key: string;
  kind: SeriesRecommendationKind;
  item: MediaItem;
  genres: readonly string[];
  release?: UpcomingRelease | undefined;
}

interface Inputs {
  catalogue: MediaItem[];
  favorites: MediaItem[];
  history: HistoryItem[];
  trackedSeries: Record<string, TrackedSeries>;
  started: string[];
  next: HistoryItem[];
  upcoming: UpcomingRelease[];
  categories: Map<string, string>;
  today: string;
}

function seriesKey(item: MediaItem) {
  return JSON.stringify([
    getDisplayTitle(item.title, 'series').normalize('NFKC').toLowerCase(),
    item.year ?? '',
  ]);
}

function genres(item: MediaItem, categories: Map<string, string>): readonly string[] {
  const mask = catalogGenreMask(item, categories);
  return CATALOG_GENRES.filter((_, bit) => (mask & (1 << bit)) !== 0);
}

function summarize(items: MediaItem[], categories: Map<string, string>): string[] {
  const counts = new Map<string, number>();
  const seen = new Set<string>();
  for (const item of items) {
    const key = seriesKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    for (const genre of genres(item, categories)) counts.set(genre, (counts.get(genre) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([genre]) => genre);
}

function episodeKey(item: HistoryItem) {
  return item.episodeId ?? JSON.stringify([item.seasonNum, item.episodeNum]);
}

export function collectSeriesRecommendations(input: Inputs) {
  const catalogue = input.catalogue.filter((item) => item.type === 'series');
  const byId = new Map(catalogue.map((item) => [item.id, item]));
  const current = (item: MediaItem) => byId.get(item.seriesId ?? item.id) ?? byId.get(item.id);
  const favoriteSeries = input.favorites
    .filter((item) => item.type === 'series')
    .map((item) => current(item) ?? item);
  const watching = input.history.filter((item) => item.type === 'series' && !isQueuedEpisode(item));
  const tracked = Object.values(input.trackedSeries).sort(
    (a, b) => b.lastWatchedAt - a.lastWatchedAt,
  );
  const recentlyViewed = [...watching, ...tracked.map(({ item }) => item)].map(
    (item) => current(item) ?? item,
  );
  const favoriteGenres = summarize(favoriteSeries, input.categories);
  const watchingGenres = summarize(recentlyViewed.slice(0, 40), input.categories);
  const preferences = new Set([...favoriteGenres, ...watchingGenres]);
  const seen = new Set(
    [
      ...favoriteSeries,
      ...recentlyViewed,
      ...input.started.flatMap((id) => byId.get(id) ?? []),
    ].map(seriesKey),
  );

  const candidates = new Map<string, Candidate>();
  const add = (candidate: Candidate) => candidates.set(candidate.key, candidate);
  const activity = (kind: 'resume' | 'next', entries: HistoryItem[]) => {
    const result: Candidate[] = [];
    const titles = new Set<string>();
    for (const entry of entries) {
      const series = current(entry);
      if (!series || titles.has(seriesKey(series))) continue;
      titles.add(seriesKey(series));
      const key = JSON.stringify([kind, series.id, episodeKey(entry)]);
      const item = {
        ...series,
        seasonNum: entry.seasonNum,
        episodeNum: entry.episodeNum,
        episodeTitle: entry.episodeTitle,
        progress: kind === 'resume' ? entry.progressPercentage / 100 : undefined,
      };
      const candidate = { key, kind, item, genres: genres(series, input.categories) };
      add(candidate);
      if (result.length < 8) result.push(candidate);
    }
    return result;
  };
  const resume = activity('resume', watching);
  const next = activity('next', input.next);
  const upcoming: Candidate[] = [];
  const upcomingTitles = new Set<string>();
  for (const release of input.upcoming) {
    if (release.kind !== 'episode' || release.airDate < input.today) continue;
    const series = current(release.favorite);
    if (!series) continue;
    const key = JSON.stringify([
      'upcoming',
      series.id,
      release.seasonNumber,
      release.episodeNumber,
    ]);
    const candidate: Candidate = {
      key,
      kind: 'upcoming',
      item: series,
      genres: genres(series, input.categories),
      release,
    };
    add(candidate);
    const title = seriesKey(series);
    if (upcoming.length < 8 && !upcomingTitles.has(title)) {
      upcomingTitles.add(title);
      upcoming.push(candidate);
    }
  }

  const titles = new Set<string>();
  // Resolve all current series by ID even when a new catalogue changes the shortlist.
  const ranked = catalogue.flatMap((item) => {
    const title = seriesKey(item);
    return seen.has(title) ? [] : [{ item, title, added: Number(item.added) || 0 }];
  });
  ranked.sort((a, b) => b.added - a.added);
  const recentCutoff = new Date(`${input.today}T00:00:00`).getTime() / 1000 - 30 * 86_400;
  const newItems: Candidate[] = [];
  const discoveries: { candidate: Candidate; matches: number; rating: number }[] = [];
  for (const { item, title, added } of ranked) {
    const first = !titles.has(title);
    titles.add(title);
    const key = JSON.stringify(['series', item.id]);
    const isNew = first && added >= recentCutoff && newItems.length < 12;
    const itemGenres = genres(item, input.categories);
    const candidate: Candidate = {
      key,
      item,
      kind: isNew ? 'new' : 'discover',
      genres: itemGenres,
    };
    add(candidate);
    if (isNew) newItems.push(candidate);
    else if (first)
      discoveries.push({
        candidate,
        matches: itemGenres.filter((genre) => preferences.has(genre)).length,
        rating: item.rating ?? 0,
      });
  }
  discoveries.sort((a, b) => b.matches - a.matches || b.rating - a.rating);

  const request: SeriesRecommendationRequest = {
    favorites: favoriteGenres,
    watching: watchingGenres,
    candidates: [
      ...resume,
      ...next,
      ...upcoming,
      ...newItems,
      ...discoveries.slice(0, 12).map(({ candidate }) => candidate),
    ].map(({ key, kind, genres }) => ({ localKey: key, kind, genres })),
  };
  return { candidates, request };
}
