import { CATALOG_GENRES, catalogGenreMask } from '@/modules/catalog/public/lib/catalogGenres';
import { parseMediaDisplayTitle } from '@/modules/catalog/public/lib/titleParser';
import type { MediaItem } from '@/modules/catalog/public/model/media';
import type { UpcomingRelease } from '@/modules/guide/public/data/useUpcomingReleases';
import type { SeriesRecommendationKind, SeriesRecommendationRequest } from '@/platform/tauri';
import { isQueuedEpisode, type HistoryItem, type TrackedSeries } from '../store/useLibraryStore';
import { rankDiscoveries } from './seriesDiscovery';

interface Candidate {
  key: string;
  kind: SeriesRecommendationKind;
  item: MediaItem;
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

function seriesTitle(item: MediaItem) {
  const title = parseMediaDisplayTitle(item.title, item.year);
  return { name: title.cleanTitle.normalize('NFKC').toLowerCase(), year: title.releaseYear ?? '' };
}

function seriesKeys(catalogue: MediaItem[]) {
  const titles = new Map(catalogue.map((item) => [item.id, seriesTitle(item)]));
  const years = new Map<string, Set<string>>();
  for (const { name, year } of titles.values()) {
    const known = years.get(name) ?? new Set<string>();
    if (year) known.add(year);
    years.set(name, known);
  }
  return (item: MediaItem) => {
    let { name, year } = titles.get(item.id) ?? seriesTitle(item);
    // Some providers append a localized title after the same Latin title.
    // Only strip it when that shorter title actually exists in the catalogue.
    const alias = name.match(
      /^([\p{Script=Latin}][\p{Script=Latin}\p{M}\p{P}\p{N} ]+?)\s+(?=[\p{Script=Arabic}\p{Script=Han}\p{Script=Hangul}\p{Script=Cyrillic}\p{Script=Hiragana}\p{Script=Katakana}])/u,
    )?.[1];
    const aliasYears = alias ? years.get(alias) : undefined;
    if (
      alias &&
      aliasYears &&
      (year ? aliasYears.size === 0 || aliasYears.has(year) : aliasYears.size <= 1)
    )
      name = alias;
    const known = years.get(name);
    if (!year && known?.size === 1) year = known.values().next().value ?? '';
    return JSON.stringify([name, year]);
  };
}

function genres(item: MediaItem, categories: Map<string, string>): readonly string[] {
  const metadata = { ...item, title: '', description: undefined };
  const mask = catalogGenreMask(metadata) || catalogGenreMask(metadata, categories);
  return CATALOG_GENRES.filter((_, bit) => (mask & (1 << bit)) !== 0);
}

function uniqueSeries(items: MediaItem[], seriesKey: (item: MediaItem) => string) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = seriesKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function summarize(items: MediaItem[], categories: Map<string, string>): string[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const genre of genres(item, categories)) counts.set(genre, (counts.get(genre) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([genre]) => genre);
}

export function collectSeriesRecommendations(input: Inputs) {
  const catalogue = input.catalogue.filter((item) => item.type === 'series');
  const byId = new Map(catalogue.map((item) => [item.id, item]));
  const current = (item: MediaItem) =>
    byId.get(item.seriesId ?? item.id) ?? byId.get(item.id) ?? item;
  const favoriteSeries = input.favorites.filter((item) => item.type === 'series').map(current);
  const watching = input.history.filter((item) => item.type === 'series' && !isQueuedEpisode(item));
  const tracked = Object.values(input.trackedSeries).sort(
    (a, b) => b.lastWatchedAt - a.lastWatchedAt,
  );
  const recentlyViewed = [
    ...tracked,
    ...watching.map((item) => ({ item, lastWatchedAt: item.lastWatchedAt })),
  ]
    .sort((a, b) => b.lastWatchedAt - a.lastWatchedAt)
    .map(({ item }) => current(item));
  const watchNext = input.next.filter((item) => item.type === 'series').map(current);
  const comingUp = input.upcoming
    .filter(({ kind, airDate }) => kind === 'episode' && airDate >= input.today)
    .map(({ favorite }) => current(favorite));
  const excluded = [...favoriteSeries, ...recentlyViewed, ...watchNext, ...comingUp];
  // Home may only pass the catalogue rows named in saved picks. Include the
  // overlapping rows when establishing title aliases and known release years.
  const seriesKey = seriesKeys([...excluded, ...catalogue]);
  const favoriteAnchors = uniqueSeries(favoriteSeries, seriesKey);
  const favoriteGenres = summarize(favoriteAnchors, input.categories);
  const watchAnchors = uniqueSeries(recentlyViewed, seriesKey).slice(0, 32);
  const watchingGenres = summarize(watchAnchors, input.categories);
  const seen = new Set(
    [...excluded, ...input.started.flatMap((id) => byId.get(id) ?? [])].map(seriesKey),
  );

  const candidates = new Map<string, Candidate>();

  const titles = new Set<string>();
  // Resolve all current series by ID even when a new catalogue changes the shortlist.
  const ranked = catalogue.flatMap((item) => {
    const title = seriesKey(item);
    return seen.has(title) ? [] : [{ item, title, added: Number(item.added) || 0 }];
  });
  ranked.sort((a, b) => b.added - a.added);
  const recentCutoff = new Date(`${input.today}T00:00:00`).getTime() / 1000 - 30 * 86_400;
  const discoveries: Candidate[] = [];
  for (const { item, title, added } of ranked) {
    const first = !titles.has(title);
    titles.add(title);
    const key = JSON.stringify(['series', item.id]);
    const candidate: Candidate = {
      key,
      item,
      kind: added >= recentCutoff ? 'new' : 'discover',
    };
    candidates.set(key, candidate);
    if (first) discoveries.push(candidate);
  }

  function createRequest(): SeriesRecommendationRequest {
    const signals = <T extends { item: MediaItem }>(candidate: T) => ({
      ...candidate,
      genres: genres(candidate.item, input.categories),
    });
    const rankedDiscoveries = rankDiscoveries(
      discoveries.map(signals),
      watchAnchors.map((item) => signals({ item })),
      favoriteAnchors.slice(0, 32).map((item) => signals({ item })),
      input.categories,
    );
    return {
      favorites: favoriteGenres,
      watching: watchingGenres,
      candidates: rankedDiscoveries
        .slice(0, 16)
        .map(({ key, kind, genres }) => ({ localKey: key, kind, genres })),
    };
  }

  function groupPicks(picks: { key: string; genreMatch: boolean }[]) {
    const groups = new Map<string, Candidate & { genreMatch: boolean }>();
    for (const pick of picks) {
      const candidate = candidates.get(pick.key);
      if (!candidate) continue;
      const key = seriesKey(candidate.item);
      const group = groups.get(key);
      const preferred =
        !group || (group.kind !== 'new' && candidate.kind === 'new') ? candidate : group;
      groups.set(key, { ...preferred, key, genreMatch: pick.genreMatch || !!group?.genreMatch });
    }
    return [...groups.values()];
  }
  function matchingGenres(item: MediaItem) {
    const available = genres(item, input.categories);
    const watched = watchingGenres.filter((genre) => available.includes(genre));
    if (watched.length > 0) return { watched: true, genres: watched };
    return { watched: false, genres: favoriteGenres.filter((genre) => available.includes(genre)) };
  }

  return {
    candidates,
    createRequest,
    groupPicks,
    matchingGenres,
    hasCandidates: discoveries.length > 0,
  };
}
