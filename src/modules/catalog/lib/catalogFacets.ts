import type {
  XtreamLiveStream,
  XtreamSeries,
  XtreamVodStream,
} from '@/modules/sources/public/data/xtreamClient';
import { isUltraHdQuality, mergeMediaTags } from '@/shared/lib/mediaTags';
import { providerRatingValue } from '@/shared/lib/rating';
import type { CatalogItem } from '../model/catalogItem';
import {
  catalogAddedValue,
  catalogGenreMask,
  catalogYearValue,
  SMART_TITLE_PATTERNS,
} from './smartCatalogFilter';
import { liveFoldFacts } from './streamFolding';
import { xtreamLiveFields, xtreamSeriesItem, xtreamVodFields } from './xtreamItemFields';

/**
 * What the catalogue index needs to filter and sort one title the way the
 * catalogue pages do, derived from the mapped catalogue item with the pages'
 * own functions:
 *
 * `[ord, id, title, categoryId, added, hasAdded, year, providerRating, flags, genreMask,
 *   foldKey, foldRank]`
 *
 * Channels also carry what stream folding reads: the group they fold into
 * and their quality rank (null and 0 for movies and series).
 */
export type CatalogFacetRow = [
  ord: number,
  id: string,
  title: string,
  categoryId: string | null,
  added: number,
  hasAdded: 0 | 1,
  year: number | null,
  rating: number | null,
  flags: number,
  genres: number,
  foldKey: string | null,
  foldRank: number,
];

/** Declared 4K or 8K (the title/quality/tags path of `isUltraHdQuality`). */
export const FACET_ULTRA_HD = 1;
export const FACET_SPORTS = 2;
export const FACET_NEWS = 4;
export const FACET_KIDS = 8;
/** The title (and quality) alone declare 4K or 8K: a folded channel's own claim. */
export const FACET_TITLE_UHD = 16;
/** The quality badges this variant brings to a folded channel declare 4K or 8K. */
export const FACET_BADGE_UHD = 32;

const isUltraHdTag = (tags: readonly string[]) => tags.includes('4K') || tags.includes('8K');

export function catalogItemFacets(ord: number, item: CatalogItem): CatalogFacetRow {
  let flags = 0;
  let foldKey: string | null = null;
  let foldRank = 0;
  if (item.type === 'live') {
    const fold = liveFoldFacts(item);
    foldKey = fold.groupKey;
    foldRank = fold.rank;
    // A folded channel is its best variant with every variant's badges, so
    // it declares 4K when its own title does or any variant's badges do.
    if (isUltraHdTag(mergeMediaTags(item.title, item.quality))) flags |= FACET_TITLE_UHD;
    if (isUltraHdTag(mergeMediaTags(...fold.qualityBadges))) flags |= FACET_BADGE_UHD;
  }
  if (isUltraHdQuality(item)) flags |= FACET_ULTRA_HD;
  if (SMART_TITLE_PATTERNS['smart:sports'].test(item.title)) flags |= FACET_SPORTS;
  if (SMART_TITLE_PATTERNS['smart:news'].test(item.title)) flags |= FACET_NEWS;
  if (SMART_TITLE_PATTERNS['smart:kids'].test(item.title)) flags |= FACET_KIDS;
  return [
    ord,
    item.id,
    item.title || '',
    item.categoryId ?? null,
    catalogAddedValue(item),
    item.added ? 1 : 0,
    catalogYearValue(item),
    providerRatingValue(item.rating) ?? null,
    flags,
    catalogGenreMask(item),
    foldKey,
    foldRank,
  ];
}

/**
 * Facets for raw provider rows (`[ord, raw]`), mapped exactly as the
 * catalogue maps them. `ord` is the row's position in the provider's list,
 * which is also the index the catalogue mapping sees.
 */
export function xtreamFacetRows(
  kind: 'live' | 'vod' | 'series',
  sourceId: string,
  rows: ReadonlyArray<readonly [number, unknown]>,
): CatalogFacetRow[] {
  return rows.map(([ord, raw]) => {
    const item =
      kind === 'live'
        ? xtreamLiveFields(sourceId, '', raw as XtreamLiveStream, ord)
        : kind === 'vod'
          ? xtreamVodFields(sourceId, '', raw as XtreamVodStream, ord)
          : xtreamSeriesItem(sourceId, '', raw as XtreamSeries, ord);
    return catalogItemFacets(ord, item);
  });
}

/**
 * Dense name ranks: equal ranks for titles the catalogue's title collator
 * calls equal, increasing in its order. Sorting by rank (stable) gives the
 * same order as sorting by the collator.
 */
export function rankTitles(titles: readonly string[]): Uint32Array {
  const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
  const order = Array.from(titles.keys()).sort((a, b) => collator.compare(titles[a]!, titles[b]!));
  const ranks = new Uint32Array(titles.length);
  let rank = 0;
  order.forEach((index, position) => {
    if (position > 0 && collator.compare(titles[order[position - 1]!]!, titles[index]!) !== 0) {
      rank += 1;
    }
    ranks[index] = rank;
  });
  return ranks;
}
