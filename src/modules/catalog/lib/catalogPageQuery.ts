import type { CatalogPageQuery } from '@/platform/tauri';
import { isUltraHdQuality } from '@/shared/lib/mediaTags';
import { resolveMediaRating } from '@/shared/lib/rating';
import {
  CATALOG_GENRES,
  catalogGenreMask,
  RECENT_CHANNELS_CATEGORY,
  smartCategoryTargetIds,
  type CategoryLike,
  type RatingLookups,
} from './smartCatalogFilter';

/**
 * TMDB's verdicts as the index applies them: a rating for every title TMDB
 * found or is still looking up (both replace the provider's), and the genres
 * of every title it found.
 */
export function lookupOverrides(
  lookups: RatingLookups,
): Pick<CatalogPageQuery, 'ratings' | 'tmdbGenres'> {
  const ratings: CatalogPageQuery['ratings'] = {};
  const tmdbGenres: CatalogPageQuery['tmdbGenres'] = {};
  for (const [id, lookup] of lookups) {
    if (lookup.status !== 'matched' && lookup.status !== 'pending') continue;
    const rating = resolveMediaRating(lookup, undefined);
    ratings[id] = { value: rating?.value ?? null, votes: rating?.voteCount ?? 0 };
    if (lookup.status === 'matched' && lookup.genres) {
      let mask = 0;
      CATALOG_GENRES.forEach((genre, bit) => {
        if (lookup.genres!.includes(genre)) mask |= 1 << bit;
      });
      if (mask !== 0) tmdbGenres[id] = mask;
    }
  }
  return { ratings, tmdbGenres };
}

/** Verified resolutions decide the 4K grouping on their own (see `isUltraHdQuality`). */
export function ultraHdOverrides(
  verifiedResolutions: ReadonlyMap<string, string>,
): Record<string, boolean> {
  const overrides: Record<string, boolean> = {};
  for (const [id, badge] of verifiedResolutions) {
    if (badge) overrides[id] = isUltraHdQuality({ title: '' }, badge);
  }
  return overrides;
}

/** The genres each category's name names, as masks (only non-empty ones). */
export function categoryGenreMasks(
  categories: readonly CategoryLike[],
  categoryNameMap: Map<string, string>,
): Record<string, number> {
  const masks: Record<string, number> = {};
  for (const category of categories) {
    const categoryId = String(category.category_id);
    const mask = catalogGenreMask(
      { id: '', title: '', posterUrl: '', categoryId },
      categoryNameMap,
    );
    if (mask !== 0) masks[categoryId] = mask;
  }
  return masks;
}

export interface CatalogPageQueryInput {
  activeCategoryId: string | null;
  hiddenCategoryIds: ReadonlySet<string>;
  favorites: readonly { id: string }[];
  categories: readonly CategoryLike[];
  categoryGenres: Record<string, number>;
  ultraHd: Record<string, boolean>;
  ratingLookups: RatingLookups;
  genre: string | null;
  sort: string;
  fold: boolean;
  orderedIds?: readonly string[] | null | undefined;
  titleFilter?: string | null | undefined;
  /** The library's recently played channels, for the recent-channels hub. */
  recentChannelIds?: readonly string[] | undefined;
  /** The quality view, served by the index only (see CatalogPage). */
  imdbMinRating?: number | null | undefined;
  imdbMinVotes?: number | null | undefined;
  excludeAdult?: boolean | undefined;
}

/** The index query for exactly what CatalogPage would compute in memory. */
export function buildCatalogPageQuery(input: CatalogPageQueryInput): CatalogPageQuery {
  const targets = smartCategoryTargetIds(input.activeCategoryId, [...input.categories]);
  const genreBit =
    input.genre && input.genre !== 'All'
      ? CATALOG_GENRES.indexOf(input.genre as (typeof CATALOG_GENRES)[number])
      : -1;
  return {
    hiddenCategoryIds: [...input.hiddenCategoryIds].sort(),
    category: input.activeCategoryId,
    targetCategoryIds: targets ? [...targets].sort() : null,
    favoriteIds: input.favorites.map((favorite) => favorite.id),
    ultraHd: input.ultraHd,
    categoryGenres: input.categoryGenres,
    genre: genreBit >= 0 ? genreBit : null,
    sort: input.sort,
    fold: input.fold,
    ...(input.orderedIds
      ? { orderedIds: [...input.orderedIds] }
      : input.activeCategoryId === RECENT_CHANNELS_CATEGORY
        ? { orderedIds: [...(input.recentChannelIds ?? [])] }
        : {}),
    ...(input.titleFilter?.trim() ? { titleFilter: input.titleFilter } : {}),
    ...(input.imdbMinRating != null ? { imdbMinRating: input.imdbMinRating } : {}),
    ...(input.imdbMinRating != null ? { imdbMinVotes: input.imdbMinVotes ?? 0 } : {}),
    ...(input.excludeAdult ? { excludeAdult: true } : {}),
    ...lookupOverrides(input.ratingLookups),
  };
}

/** A short, stable fingerprint of a query, for query keys. */
export function catalogQuerySignature(value: unknown): string {
  const text = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${text.length}-${(hash >>> 0).toString(36)}`;
}
