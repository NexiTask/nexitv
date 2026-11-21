import { describe, expect, it } from 'vitest';
import {
  catalogItemFacets,
  FACET_KIDS,
  FACET_NEWS,
  FACET_SPORTS,
  FACET_ULTRA_HD,
  rankTitles,
  xtreamFacetRows,
} from '@/modules/catalog/lib/catalogFacets';
import { runCatalogFacetTask } from '@/modules/catalog/lib/catalogFacetTasks';
import {
  buildCatalogPageQuery,
  catalogQuerySignature,
  categoryGenreMasks,
  lookupOverrides,
  ultraHdOverrides,
} from '@/modules/catalog/lib/catalogPageQuery';
import {
  CATALOG_GENRES,
  catalogGenreMask,
  sortCatalogItems,
} from '@/modules/catalog/lib/smartCatalogFilter';
import { xtreamSeriesItem, xtreamVodFields } from '@/modules/catalog/lib/xtreamItemFields';
import type { MediaItem } from '@/modules/catalog/model/media';
import type { TmdbRatingLookup } from '@/shared/lib/rating';

const bit = (genre: string) => 1 << CATALOG_GENRES.indexOf(genre as never);

function encode(value: unknown): ArrayBuffer {
  return new TextEncoder().encode(JSON.stringify(value)).buffer as ArrayBuffer;
}

describe('catalogue index facets', () => {
  it('derives a movie row from the mapped catalogue item', () => {
    const [row] = xtreamFacetRows('vod', 'xtream-one', [
      [
        4,
        {
          stream_id: 42,
          name: 'EN - Horror Night 4K (2019)',
          added: '1700000000',
          rating: '7.6',
          category_id: 12,
        },
      ],
    ]);
    expect(row).toEqual([
      4,
      'xtream-one:vod:42',
      'EN - Horror Night 4K (2019)',
      'xtream-one:category:12',
      1_700_000_000,
      1,
      2019,
      7.6,
      FACET_ULTRA_HD,
      bit('Horror'),
      null,
      0,
    ]);
  });

  it('derives a series row with its genre field, plot and release date', () => {
    const [row] = xtreamFacetRows('series', 'xtream-one', [
      [
        0,
        {
          series_id: '9',
          name: 'Sports Desk',
          plot: 'A comedy about news anchors.',
          genre: 'Drama / Krimi',
          releaseDate: '2021-06-01',
          last_modified: '',
        },
      ],
    ]);
    const [, id, title, category, added, hasAdded, year, rating, flags, genres] = row!;
    expect([id, title, category, added, hasAdded, year, rating]).toEqual([
      'xtream-one:series:9',
      'Sports Desk',
      null,
      0,
      0,
      2021,
      null,
    ]);
    expect(flags).toBe(FACET_SPORTS);
    expect(genres).toBe(bit('Drama') | bit('Crime') | bit('Comedy'));
  });

  it('flags news and kids titles and leaves undated, unnamed ones empty', () => {
    const item = xtreamVodFields('s', '', { stream_id: 1, name: 'BBC Kids Club' } as never, 0);
    expect(catalogItemFacets(0, item)[8]).toBe(FACET_NEWS | FACET_KIDS);
    const unnamed = xtreamVodFields('s', '', { stream_id: 2 } as never, 0);
    const facets = catalogItemFacets(3, unnamed);
    expect(facets[2]).toBe('Unknown Movie');
    expect(facets[6]).toBeNull();
    expect(facets[5]).toBe(0);
  });

  it('maps series exactly like the catalogue mapping', () => {
    const series = xtreamSeriesItem(
      's',
      'Provider',
      { series_id: 3, name: 'X (2020)' } as never,
      7,
    );
    expect(series).toMatchObject({ id: 's:series:3', year: '2020', subtitle: 'Provider' });
  });

  it('ranks titles densely in the collator order the pages sort by', () => {
    const titles = ['b', 'A', 'a', 'Item 10', 'Item 2', 'é', 'e'];
    const ranks = rankTitles(titles);
    expect([...ranks]).toEqual([1, 0, 0, 4, 3, 2, 2]);
    const items = titles.map((title, index) => ({ id: String(index), title, posterUrl: '' }));
    const byName = sortCatalogItems(items, 'name-asc').map((item) => Number(item.id));
    const byRank = titles.map((_, index) => index).sort((a, b) => ranks[a]! - ranks[b]!);
    expect(byRank).toEqual(byName);
    expect([...rankTitles([])]).toEqual([]);
  });

  it('runs worker tasks on the index JSON', () => {
    const facets = runCatalogFacetTask({
      op: 'facets',
      kind: 'vod',
      sourceId: 's',
      payload: encode({ ready: true, generation: 3, rows: [[0, { stream_id: 1, name: 'A' }]] }),
    });
    expect(facets).toMatchObject({ op: 'facets', ready: true, generation: 3 });
    const ranks = runCatalogFacetTask({
      op: 'ranks',
      payload: encode({ needed: true, token: 't', titles: ['b', 'a'] }),
    });
    expect(ranks.op === 'ranks' && [...ranks.ranks]).toEqual([1, 0]);
    const none = runCatalogFacetTask({
      op: 'ranks',
      payload: encode({ needed: false, token: 't', titles: [] }),
    });
    expect(none).toMatchObject({ needed: false });
  });
});

describe('catalogue page queries', () => {
  it('turns TMDB verdicts into rating and genre overrides', () => {
    const lookups = new Map<string, TmdbRatingLookup>([
      ['a', { status: 'matched', voteAverage: 8.24, voteCount: 50, genres: ['Drama', 'Other'] }],
      ['b', { status: 'matched', voteAverage: 9.9, voteCount: 2 }],
      ['c', { status: 'pending' }],
      ['d', { status: 'unmatched' }],
      ['e', { status: 'failed' }],
    ]);
    expect(lookupOverrides(lookups)).toEqual({
      ratings: {
        a: { value: 8.2, votes: 50 },
        b: { value: null, votes: 0 },
        c: { value: null, votes: 0 },
      },
      tmdbGenres: { a: bit('Drama') },
    });
    expect(lookupOverrides(new Map())).toEqual({ ratings: {}, tmdbGenres: {} });
  });

  it('reduces verified resolutions to the 4K decision', () => {
    const verified = new Map([
      ['a', '4K'],
      ['b', 'FHD'],
      ['c', '2160p'],
      ['d', ''],
    ]);
    expect(ultraHdOverrides(verified)).toEqual({ a: true, b: false, c: true });
  });

  it('masks only the genres category names name', () => {
    const categories = [
      { category_id: 'c1', category_name: 'DE | Komödie' },
      { category_id: 'c2', category_name: 'EN | Movies' },
    ];
    const names = new Map(categories.map((c) => [c.category_id, c.category_name]));
    expect(categoryGenreMasks(categories, names)).toEqual({ c1: bit('Comedy') });
    const item: MediaItem & { categoryId: string } = {
      id: 'x',
      title: 'Plain',
      posterUrl: '',
      categoryId: 'c1',
    };
    expect(catalogGenreMask(item, names)).toBe(bit('Comedy'));
  });

  it('builds the page query the index runs', () => {
    const categories = [
      { category_id: 'c1', category_name: 'DE | Action' },
      { category_id: 'c2', category_name: 'DE: Action' },
      { category_id: 'c3', category_name: 'EN | Drama' },
    ];
    const query = buildCatalogPageQuery({
      activeCategoryId: 'c1',
      hiddenCategoryIds: new Set(['c9', 'c3']),
      favorites: [{ id: 'f' }],
      categories,
      categoryGenres: {},
      ultraHd: {},
      ratingLookups: new Map(),
      genre: 'Drama',
      sort: 'year-asc',
      fold: false,
    });
    expect(query).toMatchObject({
      hiddenCategoryIds: ['c3', 'c9'],
      category: 'c1',
      targetCategoryIds: ['c1', 'c2'],
      favoriteIds: ['f'],
      genre: CATALOG_GENRES.indexOf('Drama'),
      sort: 'year-asc',
      fold: false,
    });
    const smart = buildCatalogPageQuery({
      activeCategoryId: 'smart:4k',
      hiddenCategoryIds: new Set(),
      favorites: [],
      categories,
      categoryGenres: {},
      ultraHd: {},
      ratingLookups: new Map(),
      genre: 'All',
      sort: 'default',
      fold: true,
    });
    expect(smart.targetCategoryIds).toBeNull();
    expect(smart.genre).toBeNull();
    expect(catalogQuerySignature(query)).toBe(catalogQuerySignature({ ...query }));
    expect(catalogQuerySignature(query)).not.toBe(catalogQuerySignature(smart));
  });
});
