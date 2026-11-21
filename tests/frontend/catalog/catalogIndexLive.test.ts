import { describe, expect, it } from 'vitest';
import {
  FACET_BADGE_UHD,
  FACET_TITLE_UHD,
  FACET_ULTRA_HD,
  xtreamFacetRows,
} from '@/modules/catalog/lib/catalogFacets';
import { foldLiveChannels } from '@/modules/catalog/lib/streamFolding';
import { mapXtreamList } from '@/modules/catalog/data/useCatalog';
import { mapKeyRows } from '@/modules/catalog/data/useIndexedCatalog';
import type { EnabledXtreamSource } from '@/modules/sources/public/hooks/useEnabledSources';

const source = {
  id: 'xtream-one',
  profile: { name: 'Provider' },
  runtime: null,
  credentials: { url: 'http://provider.test', username: 'user', password: 'secret' },
  queryScope: 'scope',
  isAvailable: true,
} as unknown as EnabledXtreamSource;

const channels = [
  { stream_id: 10, num: 1, name: 'DE: Sport One HD', category_id: 5, added: '9' },
  { stream_id: 11, name: 'DE: News 24', category_id: 5 },
  {
    stream_id: 12,
    num: 3,
    name: 'DE: Sport One 4K',
    category_id: 5,
    direct_source: 'http://cdn.test/a',
  },
  { stream_id: 13, num: 4, name: 'DE: Sport One FHD', category_id: 6 },
];

describe('live channel facets', () => {
  it('carry the fold group, quality rank and 4K claims of each variant', () => {
    const rows = xtreamFacetRows(
      'live',
      'xtream-one',
      channels.map((channel, ord) => [ord, channel] as const),
    );
    const [hd, news, uhd, otherCategory] = rows;
    expect(hd![1]).toBe('xtream-one:live:10');
    expect(hd![10]).toBe(uhd![10]);
    expect(hd![10]).not.toBe(otherCategory![10]);
    expect(news![10]).not.toBe(hd![10]);
    expect(uhd![11]).toBeGreaterThan(hd![11]);
    expect(uhd![8] & (FACET_ULTRA_HD | FACET_TITLE_UHD | FACET_BADGE_UHD)).toBe(
      FACET_ULTRA_HD | FACET_TITLE_UHD | FACET_BADGE_UHD,
    );
    expect(hd![8] & (FACET_TITLE_UHD | FACET_BADGE_UHD)).toBe(0);
    expect(news![5]).toBe(0);
  });
});

describe('index rows for live channels', () => {
  const full = mapXtreamList('live', source, channels);
  const folded = foldLiveChannels(full);

  it('fold a channel from its variants exactly like the full catalogue', () => {
    // The group's best variant (ord 2) carries all variants in provider order.
    const items = mapKeyRows(
      'live',
      [source],
      [
        {
          key: 2,
          raw: channels[2],
          group: [0, 2].map((ord) => ({ key: ord, raw: channels[ord] })),
        },
        { key: 1, raw: channels[1] },
      ],
    );
    expect(items.get(2)).toEqual(folded[0]);
    expect(items.get(1)).toEqual(folded[1]);
  });

  it('keep positional channel numbers from the provider list', () => {
    const items = mapKeyRows('live', [source], [{ key: 1, raw: channels[1] }]);
    expect(items.get(1)?.channelNum).toBe(2);
    expect(items.get(1)).toEqual(full[1]);
  });

  it('place rows of a second source under its own credentials', () => {
    const second = { ...source, id: 'xtream-two' } as EnabledXtreamSource;
    const key = 2 ** 23 + 3;
    const items = mapKeyRows('live', [source, second], [{ key, raw: channels[3] }]);
    expect(items.get(key)?.id).toBe('xtream-two:live:13');
    expect(items.get(key)?.channelNum).toBe(4);
  });
});
