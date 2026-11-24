import { parseProviderCategoryName } from '@/shared/lib/categoryName';
import type { MediaItem } from '@/modules/catalog/public/model/media';

interface SeriesSignals {
  item: MediaItem;
  genres: readonly string[];
}

interface Affinity {
  genres: Map<string, number>;
  categories: Map<string, number>;
  countries: Map<string, number>;
}

const COMMON_WORDS = new Set(
  'about after against along also another around because before being could during every first from have into many more most only other over people same series show some story such than that their them then there these they this those through time together under very what when where which while will with would years your dans avec cette comme dans elle elles leur leurs mais même nous plus pour que sont tout tous toute très une vous auch auch dass deine diese einer eines ihre nach noch oder sich sind über und eine einem gegen wenn wird werden maar niet voor zijn deze door over geen werd worden zoals este esta esse esto para pero porque como donde cada mundo quando sobre mais muito pelo pela'.split(
    ' ',
  ),
);

function synopsisTerms(description?: string): Set<string> {
  const terms =
    description
      ?.slice(0, 1_200)
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .match(/\p{L}{4,}/gu) ?? [];
  return new Set(terms.filter((term) => !COMMON_WORDS.has(term)).slice(0, 100));
}

function synopsisKey(description?: string) {
  const text = description
    ?.normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  return text && text.length >= 96 ? text : undefined;
}

function increment(map: Map<string, number>, key: string | undefined, weight: number) {
  if (key) map.set(key, (map.get(key) ?? 0) + weight);
}

function country(item: MediaItem, categories: Map<string, string>) {
  return (
    item.country?.toUpperCase() ||
    (item.categoryId
      ? parseProviderCategoryName(categories.get(item.categoryId) ?? '').country
      : null) ||
    undefined
  );
}

function affinity(shows: SeriesSignals[], categories: Map<string, string>): Affinity {
  const result: Affinity = { genres: new Map(), categories: new Map(), countries: new Map() };
  shows.forEach(({ item, genres }, index) => {
    const weight = 1 - index / Math.max(1, 2 * shows.length);
    increment(result.categories, item.categoryId, weight);
    increment(result.countries, country(item, categories), weight);
    for (const genre of genres) {
      // A catalogue entry tagged Drama or with many genre labels supplies less evidence.
      increment(
        result.genres,
        genre,
        (weight * (genre === 'Drama' ? 0.3 : 1)) / Math.sqrt(genres.length),
      );
    }
  });
  for (const counts of Object.values(result)) {
    const highest = Math.max(1, ...counts.values());
    for (const [key, count] of counts) counts.set(key, count / highest);
  }
  return result;
}

function match(
  { item, genres }: SeriesSignals,
  profile: Affinity,
  categories: Map<string, string>,
): number {
  const genresMatch =
    genres.reduce((total, genre) => total + (profile.genres.get(genre) ?? 0), 0) /
    Math.sqrt(Math.max(1, genres.length));
  const categoryMatch = profile.categories.get(item.categoryId ?? '') ?? 0;
  const countryMatch = profile.countries.get(country(item, categories) ?? '') ?? 0;
  return genresMatch * 2 + categoryMatch * 3 + (genresMatch > 0 ? countryMatch : 0);
}

function plotSimilarity(
  terms: Set<string>,
  anchors: Set<string>[],
  frequency: Map<string, number>,
) {
  let best = 0;
  for (const anchor of anchors) {
    let shared = 0;
    let weight = 0;
    for (const word of terms) {
      if (anchor.has(word)) {
        shared++;
        weight += 1 / Math.sqrt(frequency.get(word) ?? 1);
      }
    }
    if (shared >= 3) best = Math.max(best, weight / Math.min(terms.size, anchor.size));
  }
  return best;
}

function closestGenreMatch(genres: readonly string[], anchors: SeriesSignals[]) {
  let best = 0;
  for (const anchor of anchors) {
    const combined = new Set([...genres, ...anchor.genres]);
    if (combined.size === 0) continue;
    const shared = genres.filter((genre) => anchor.genres.includes(genre));
    const weight = shared.reduce((total, genre) => total + (genre === 'Drama' ? 0.25 : 1), 0);
    best = Math.max(best, weight / combined.size);
  }
  return best;
}

export function rankDiscoveries<T extends SeriesSignals>(
  candidates: T[],
  watched: SeriesSignals[],
  favorites: SeriesSignals[],
  categories: Map<string, string>,
): T[] {
  const watchProfile = affinity(watched, categories);
  const favoriteProfile = affinity(favorites, categories);
  const hasWatchSignals = watchProfile.genres.size > 0 || watchProfile.categories.size > 0;
  const byRelevance = candidates.map((candidate) => ({
    candidate,
    watchedScore: match(candidate, watchProfile, categories),
    favoriteScore: match(candidate, favoriteProfile, categories),
  }));
  const byRating = (a: T, b: T) => (b.item.rating ?? 0) - (a.item.rating ?? 0);
  const scores = byRelevance.map(({ candidate, watchedScore, favoriteScore }) => ({
    candidate,
    score: watchedScore + favoriteScore * (hasWatchSignals ? 0.25 : 1),
  }));
  scores.sort((a, b) => b.score - a.score || byRating(a.candidate, b.candidate));

  const examples = watched.length ? watched : favorites;
  const knownPlots = new Set(
    [...watched, ...favorites].map(({ item }) => synopsisKey(item.description)),
  );
  // Inspect summaries only in a bounded pool, and skip alternate catalogue entries for known shows.
  const shortlist = scores
    .slice(0, 400)
    .filter(({ candidate }) => {
      const key = synopsisKey(candidate.item.description);
      return !key || !knownPlots.has(key);
    })
    .slice(0, 200);
  const anchors = examples
    .map(({ item }) => synopsisTerms(item.description))
    .filter((terms) => terms.size > 0);
  const plots = shortlist.map(({ candidate }) => synopsisTerms(candidate.item.description));
  const anchorTerms = new Set(anchors.flatMap((terms) => [...terms]));
  const frequency = new Map<string, number>();
  for (const words of plots) {
    for (const term of words) if (anchorTerms.has(term)) increment(frequency, term, 1);
  }
  const ranked = shortlist.map(({ candidate, score }, index) => ({
    candidate,
    score:
      score +
      closestGenreMatch(candidate.genres, examples) * 3 +
      plotSimilarity(plots[index]!, anchors, frequency) * 5,
  }));
  ranked.sort((a, b) => b.score - a.score || byRating(a.candidate, b.candidate));
  const hasEvidence = ranked.some(({ score }) => score > 0);
  const seenPlots = new Set<string>();
  return ranked.flatMap(({ candidate, score }) => {
    if (hasEvidence && score <= 0) return [];
    const plot = synopsisKey(candidate.item.description);
    if (plot && seenPlots.has(plot)) return [];
    if (plot) seenPlots.add(plot);
    return [candidate];
  });
}
