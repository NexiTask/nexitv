import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseM3u } from '@/modules/sources/data/m3uClient';
import { QueryClient } from '@tanstack/react-query';
import { CATALOG_FRESH_MS } from '@/modules/catalog/data/catalogFreshness';
import { catalogQueryOptions, selectFoldedLiveCatalog } from '@/modules/catalog/data/useCatalog';
import { queryKeys } from '@/modules/sources/model/queryKeys';
import { categoriesQueryOptions } from '@/modules/catalog/data/useCategories';
import type { EnabledSourcesSnapshot } from '@/modules/sources/hooks/useEnabledSources';

const xc = vi.hoisted(() => ({
  getLiveCategories: vi.fn(),
  getLiveStreams: vi.fn(),
  getSeries: vi.fn(),
  getSeriesCategories: vi.fn(),
  getVodCategories: vi.fn(),
  getVodStreams: vi.fn(),
  getStreamUrl: vi.fn(
    (credentials: { url: string }, type: string, id: string | number, extension?: string) =>
      `${credentials.url}/${type}/${id}.${extension || 'mp4'}`,
  ),
}));

vi.mock('@/modules/sources/data/xtreamClient', () => xc);

const disk = vi.hoisted(() => ({ rememberProviderList: vi.fn(), loadProviderList: vi.fn() }));
const desktop = vi.hoisted(() => ({ value: true }));
vi.mock('@/modules/catalog/data/catalogDiskCache', () => disk);
vi.mock('@/platform/desktop', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/platform/desktop')>();
  return { ...actual, desktopApi: { ...actual.desktopApi, isDesktop: () => desktop.value } };
});

const credentials = {
  sourceId: 'xtream-one',
  url: 'https://provider.test',
  username: 'alice',
  password: 'secret',
};

const xtreamProfile = {
  id: 'xtream-one',
  kind: 'xtream',
  name: 'Provider',
  locationLabel: 'provider.test',
  username: 'alice',
  userInfo: { auth: 1 },
  serverInfo: {},
  createdAt: 1,
  updatedAt: 1,
};

function sources(overrides: Partial<EnabledSourcesSnapshot> = {}): EnabledSourcesSnapshot {
  const xtreamSource = {
    id: 'xtream-one',
    profile: xtreamProfile,
    runtime: { credentials, status: 'ready', error: null, revision: 1 },
    credentials,
    queryScope: 'xtream-scope',
    isAvailable: true,
  };
  return {
    enabledSourceIds: ['xtream-one'],
    xtreamEnabled: true,
    xtreamAvailable: true,
    xtreamSources: [xtreamSource],
    availableXtreamSources: [xtreamSource],
    m3uSources: [],
    availableM3uSources: [],
    isAvailable: true,
    isLoading: false,
    errors: [],
    queryScope: 'sources-scope',
    ...overrides,
  } as EnabledSourcesSnapshot;
}

async function runQuery<T>(options: { queryFn?: unknown }): Promise<T> {
  const queryFn = options.queryFn as (context: { signal?: AbortSignal }) => Promise<T>;
  return queryFn({ signal: new AbortController().signal });
}

describe('source-scoped catalog and category queries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    disk.loadProviderList.mockResolvedValue(null);
    desktop.value = true;
    localStorage.clear();
  });

  it('maps Xtream and M3U live items without leaking source identity', async () => {
    xc.getLiveStreams.mockResolvedValue([
      {
        stream_id: 42,
        name: 'DE | News HD',
        stream_icon: 'provider-logo',
        category_id: '7',
        epg_channel_id: 'news',
        num: 1,
        stream_type: 'radio',
        direct_source: 'https://provider.test/direct/42',
        tv_archive: 1,
        tv_archive_duration: 7,
      },
    ]);
    const playlist = parseM3u(
      '#EXTM3U\n#EXTINF:-1 tvg-id="m3u-news" group-title="News",Local News\nhttps://m3u.test/news.ts',
      { sourceId: 'm3u-one' },
    );
    const m3uSource = {
      id: 'm3u-one',
      profile: { id: 'm3u-one', name: 'Local', kind: 'm3u' },
      runtime: { playlist, connection: null, status: 'ready', error: null, revision: 1 },
      queryScope: 'm3u-scope',
      isAvailable: true,
    } as any;

    const result = await runQuery<any>(
      catalogQueryOptions(
        'live',
        sources({
          availableM3uSources: [m3uSource],
          m3uSources: [m3uSource],
        }),
      ),
    );

    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'xtream-one:live:42',
          sourceId: 'xtream-one',
          categoryId: 'xtream-one:category:7',
          radio: true,
        }),
        expect.objectContaining({
          id: expect.stringMatching(/^m3u-/),
          sourceId: 'm3u-one',
          streamUrl: 'https://m3u.test/news.ts',
        }),
      ]),
    );
    expect(result).toHaveLength(2);
  });

  it('maps provider ratings on the ten-point scale without inflating weak titles', async () => {
    xc.getVodStreams.mockResolvedValue([
      { stream_id: 1, name: 'Weak Film', rating: '4.8', rating_5based: 2.4 },
      { stream_id: 2, name: 'Five Point Panel', rating: '4.5', rating_5based: 4.5 },
      { stream_id: 3, name: 'One Vote Wonder', rating: '10', rating_5based: 5 },
      { stream_id: 4, name: 'Companion Only', rating: '', rating_5based: 3.7 },
      { stream_id: 5, name: 'Unrated', rating: '0', rating_5based: 0 },
    ]);
    xc.getSeries.mockResolvedValue([
      { series_id: 8, name: 'Weak Show', rating: '4.9', rating_5based: 2.45 },
      { series_id: 9, name: 'Placeholder Show', rating: '10', rating_5based: 5 },
    ]);

    const movies = await runQuery<any[]>(catalogQueryOptions('vod', sources()));
    const series = await runQuery<any[]>(catalogQueryOptions('series', sources()));

    expect(movies.map((item) => [item.title, item.rating])).toEqual([
      ['Weak Film', 4.8],
      ['Five Point Panel', 9],
      ['One Vote Wonder', undefined],
      ['Companion Only', 7.4],
      ['Unrated', undefined],
    ]);
    expect(series.map((item) => [item.title, item.rating])).toEqual([
      ['Weak Show', 4.9],
      ['Placeholder Show', undefined],
    ]);
  });

  it('shares one folded live result between observers of the same catalog', () => {
    const catalog = [
      {
        id: 'one',
        title: 'News HD',
        posterUrl: '',
        type: 'live' as const,
        streamUrl: 'https://one.test',
      },
      {
        id: 'two',
        title: 'News HD',
        posterUrl: '',
        type: 'live' as const,
        streamUrl: 'https://two.test',
      },
    ];

    const first = selectFoldedLiveCatalog(catalog);
    expect(selectFoldedLiveCatalog(catalog)).toBe(first);
  });

  it('keeps successful providers when another enabled provider fails, but errors when none work', async () => {
    const second = {
      id: 'xtream-two',
      profile: { ...xtreamProfile, id: 'xtream-two', name: 'Backup' },
      runtime: {
        credentials: { ...credentials, sourceId: 'xtream-two', url: 'https://backup.test' },
        status: 'ready',
        error: null,
        revision: 1,
      },
      credentials: { ...credentials, sourceId: 'xtream-two', url: 'https://backup.test' },
      queryScope: 'backup',
      isAvailable: true,
    } as any;
    xc.getVodStreams.mockRejectedValueOnce(new Error('primary offline')).mockResolvedValueOnce([
      {
        stream_id: 8,
        name: 'Backup Movie',
        stream_icon: '',
        category_id: '3',
        container_extension: 'mkv',
      },
    ]);

    const result = await runQuery<any>(
      catalogQueryOptions(
        'vod',
        sources({
          xtreamSources: [sources().xtreamSources[0], second],
          availableXtreamSources: [sources().availableXtreamSources[0], second],
        }),
      ),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 'xtream-two:vod:8', sourceId: 'xtream-two' });

    xc.getVodStreams.mockRejectedValue(new Error('all offline'));
    await expect(runQuery<any>(catalogQueryOptions('vod', sources()))).rejects.toThrow(
      'all offline',
    );
  });

  it('retains every provider name and technical failure when all catalog sources fail', async () => {
    const backup = {
      id: 'xtream-two',
      profile: { ...xtreamProfile, id: 'xtream-two', name: 'Backup' },
      runtime: {
        credentials: { ...credentials, sourceId: 'xtream-two', url: 'https://backup.test' },
        status: 'ready',
        error: null,
        revision: 1,
      },
      credentials: { ...credentials, sourceId: 'xtream-two', url: 'https://backup.test' },
      queryScope: 'backup',
      isAvailable: true,
    } as any;
    xc.getVodStreams
      .mockRejectedValueOnce(new Error('HTTP 503 Service Unavailable'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(
      runQuery<any>(
        catalogQueryOptions(
          'vod',
          sources({
            xtreamSources: [sources().xtreamSources[0], backup],
            availableXtreamSources: [sources().availableXtreamSources[0], backup],
          }),
        ),
      ),
    ).rejects.toThrow('Provider: HTTP 503 Service Unavailable\nBackup: ECONNREFUSED');
  });

  it('merges provider and playlist categories with source-scoped provider ids', async () => {
    xc.getLiveCategories.mockResolvedValue([
      { category_id: '7', category_name: 'DE | News', parent_id: 0 },
    ]);
    const playlist = parseM3u(
      '#EXTM3U\n#EXTINF:-1 group-title="Local News",One\nhttps://m3u.test/one.ts',
      { sourceId: 'm3u-one' },
    );
    const m3uSource = {
      id: 'm3u-one',
      profile: { id: 'm3u-one', name: 'Local', kind: 'm3u' },
      runtime: { playlist, connection: null, status: 'ready', error: null, revision: 1 },
      queryScope: 'm3u-scope',
      isAvailable: true,
    } as any;

    const result = await runQuery<any>(
      categoriesQueryOptions(
        'live',
        sources({
          availableM3uSources: [m3uSource],
          m3uSources: [m3uSource],
        }),
      ),
    );

    expect(result).toEqual(
      expect.arrayContaining([
        { category_id: 'xtream-one:category:7', category_name: 'DE | News', parent_id: 0 },
        expect.objectContaining({
          category_id: expect.stringMatching(/^m3u-category-/),
          category_name: 'Local News',
        }),
      ]),
    );
  });

  it('fails category loading only when every available provider fails', async () => {
    xc.getSeriesCategories.mockRejectedValue(new Error('series categories offline'));

    await expect(runQuery<any>(categoriesQueryOptions('series', sources()))).rejects.toThrow(
      'series categories offline',
    );

    xc.getSeriesCategories.mockResolvedValue([
      { category_id: '9', category_name: 'Drama', parent_id: 0 },
    ]);
    await expect(runQuery<any>(categoriesQueryOptions('series', sources()))).resolves.toEqual([
      { category_id: 'xtream-one:category:9', category_name: 'Drama', parent_id: 0 },
    ]);
  });

  describe('saved catalogues', () => {
    const streams = [
      { stream_id: 7, name: 'DE - Saved Film (2020)', rating: '7.1', category_id: '3' },
      { stream_id: 8, name: 'Second Film', rating: '', category_id: '3' },
    ];
    const vodKey = queryKeys.catalog('vod', 'sources-scope');
    let client: QueryClient;

    beforeEach(() => {
      desktop.value = true;
      client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    });

    it('keeps each provider list for the next start under its account scope', async () => {
      xc.getVodStreams.mockResolvedValue(streams);

      await runQuery<any[]>(catalogQueryOptions('vod', sources()));

      expect(disk.rememberProviderList).toHaveBeenCalledWith(
        'xtream-one',
        'vod',
        'xtream-scope',
        streams,
      );
    });

    it('uses a fresh saved copy without asking the provider', async () => {
      disk.loadProviderList.mockResolvedValue({ list: streams, savedAt: Date.now() - 1_000 });

      const items = await runQuery<any[]>(catalogQueryOptions('vod', sources(), client));

      expect(items.map((item) => [item.id, item.title, item.rating])).toEqual([
        ['xtream-one:vod:7', 'DE - Saved Film (2020)', 7.1],
        ['xtream-one:vod:8', 'Second Film', undefined],
      ]);
      // Stream URLs come from the vault's credentials, never from the copy.
      expect(items[0].streamUrl).toBe('https://provider.test/vod/7.mp4');
      expect(disk.loadProviderList).toHaveBeenCalledWith('xtream-one', 'vod', 'xtream-scope');
      expect(xc.getVodStreams).not.toHaveBeenCalled();
    });

    it('shows a stale copy at once and swaps in the provider list later', async () => {
      vi.useFakeTimers();
      try {
        disk.loadProviderList.mockResolvedValue({
          list: streams,
          savedAt: Date.now() - CATALOG_FRESH_MS - 1,
        });
        xc.getVodStreams.mockResolvedValue([{ stream_id: 9, name: 'New Film', category_id: '3' }]);

        const items = await runQuery<any[]>(catalogQueryOptions('vod', sources(), client));
        client.setQueryData(vodKey, items);
        expect(items).toHaveLength(2);
        expect(xc.getVodStreams).not.toHaveBeenCalled();

        await vi.runAllTimersAsync();

        expect(xc.getVodStreams).toHaveBeenCalledTimes(1);
        expect(client.getQueryData<any[]>(vodKey)!.map((item) => item.id)).toEqual([
          'xtream-one:vod:9',
        ]);
        expect(disk.rememberProviderList).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps the saved copy when the background refresh fails', async () => {
      vi.useFakeTimers();
      try {
        disk.loadProviderList.mockResolvedValue({
          list: streams,
          savedAt: Date.now() - CATALOG_FRESH_MS - 1,
        });
        xc.getVodStreams.mockRejectedValue(new Error('offline'));

        const items = await runQuery<any[]>(catalogQueryOptions('vod', sources(), client));
        client.setQueryData(vodKey, items);
        await vi.runAllTimersAsync();

        expect(client.getQueryData<any[]>(vodKey)).toHaveLength(2);
        expect(disk.rememberProviderList).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('asks the provider when a source has no saved copy or it is unreadable', async () => {
      xc.getVodStreams.mockResolvedValue(streams);
      disk.loadProviderList.mockRejectedValueOnce(new Error('The catalog cache is invalid'));

      await expect(
        runQuery<any[]>(catalogQueryOptions('vod', sources(), client)),
      ).resolves.toHaveLength(2);
      await expect(
        runQuery<any[]>(catalogQueryOptions('vod', sources(), client)),
      ).resolves.toHaveLength(2);

      expect(xc.getVodStreams).toHaveBeenCalledTimes(2);
    });

    it('skips the saved copy outside the desktop app', async () => {
      desktop.value = false;
      xc.getVodStreams.mockResolvedValue(streams);

      await runQuery<any[]>(catalogQueryOptions('vod', sources(), client));

      expect(disk.loadProviderList).not.toHaveBeenCalled();
    });

    it('uses saved categories on the next start', async () => {
      xc.getSeriesCategories.mockResolvedValue([
        { category_id: '9', category_name: 'Drama', parent_id: 0 },
      ]);
      const first = await runQuery<any[]>(categoriesQueryOptions('series', sources(), client));
      xc.getSeriesCategories.mockRejectedValue(new Error('offline'));

      await expect(
        runQuery<any[]>(categoriesQueryOptions('series', sources(), client)),
      ).resolves.toEqual(first);
      expect(xc.getSeriesCategories).toHaveBeenCalledTimes(1);
    });
  });
});
