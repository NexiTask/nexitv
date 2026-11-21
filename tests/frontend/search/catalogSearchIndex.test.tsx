// @vitest-environment happy-dom

import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopApi } from '@/platform/desktop';
import { tauriApi, type CatalogPageKind, type CatalogSearchResult } from '@/platform/tauri';
import * as enabledSourcesHook from '@/modules/sources/hooks/useEnabledSources';
import * as catalogApi from '@/modules/catalog/data/useCatalog';
import * as categoriesApi from '@/modules/catalog/data/useCategories';
import { useCatalogSearch } from '@/modules/search/data/useCatalogSearch';

const source = {
  id: 'xtream-one',
  profile: { name: 'Provider' },
  runtime: null,
  credentials: { url: 'http://provider.test', username: 'u', password: 'p' },
  queryScope: 'scope',
  isAvailable: true,
};

function result(rows: Array<{ key: number; raw: object; score: number }>): CatalogSearchResult {
  return {
    ready: true,
    generation: '1',
    total: rows.length,
    head: rows.map(({ key, raw }) => ({ key, raw })),
    keys: Uint32Array.from(rows.map((row) => row.key)),
    scores: Uint32Array.from(rows.map((row) => row.score)),
  };
}

const answers: Record<CatalogPageKind, CatalogSearchResult> = {
  vod: result([
    { key: 0, raw: { stream_id: 1, name: 'Sport Movie' }, score: 950 },
    { key: 1, raw: { stream_id: 2, name: 'Sporting Life' }, score: 600 },
  ]),
  series: result([{ key: 0, raw: { series_id: 3, name: 'Sport Series' }, score: 950 }]),
  live: result([
    { key: 4, raw: { stream_id: 5, name: 'SPORT' }, score: 1350 },
    { key: 5, raw: { stream_id: 6, name: 'Sport 2' }, score: 600 },
  ]),
};

let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);

beforeEach(() => {
  vi.restoreAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(desktopApi, 'isDesktop').mockReturnValue(true);
  // The fallback asks the provider for its list; stay offline.
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
  vi.spyOn(enabledSourcesHook, 'useEnabledSources').mockReturnValue({
    enabledSourceIds: ['xtream-one'],
    xtreamEnabled: true,
    xtreamAvailable: true,
    xtreamSources: [source],
    availableXtreamSources: [source],
    m3uSources: [],
    availableM3uSources: [],
    isAvailable: true,
    isLoading: false,
    errors: [],
    queryScope: 'all',
  } as never);
  vi.spyOn(categoriesApi, 'useHiddenCategoryIds').mockReturnValue(new Set(['h']));
});

describe('catalogue search through the index', () => {
  it('ranks every catalogue by score, movies before series before channels on a tie', async () => {
    const search = vi
      .spyOn(tauriApi, 'catalogIndexSearch')
      .mockImplementation(async (kind) => answers[kind]);
    const full = vi.spyOn(catalogApi, 'useVodStreams');

    const { result: hook } = renderHook(
      () => useCatalogSearch('sport', 'all', { enabled: true, limit: 4 }),
      {
        wrapper,
      },
    );

    await waitFor(() => expect(hook.current.count).toBe(4));
    const titles = Array.from({ length: 4 }, (_, index) => hook.current.getItem(index)?.title);
    expect(titles).toEqual(['SPORT', 'Sport Movie', 'Sport Series', 'Sporting Life']);
    expect(search).toHaveBeenCalledWith(
      'live',
      [{ sourceId: 'xtream-one', scope: 'scope' }],
      expect.objectContaining({ hiddenCategoryIds: ['h'], fold: true }),
      'sport',
      4,
    );
    // The full catalogues are never asked for.
    for (const [options] of full.mock.calls) expect(options?.enabled).toBe(false);
  });

  it('searches only the chosen catalogue', async () => {
    const search = vi
      .spyOn(tauriApi, 'catalogIndexSearch')
      .mockImplementation(async (kind) => answers[kind]);

    const { result: hook } = renderHook(
      () => useCatalogSearch('sport', 'live', { enabled: true }),
      {
        wrapper,
      },
    );

    await waitFor(() => expect(hook.current.count).toBe(2));
    expect(search.mock.calls.map(([kind]) => kind)).toEqual(['live']);
    expect(hook.current.getItem(1)?.title).toBe('Sport 2');
  });

  it('falls back to the full lists while the index cannot answer', async () => {
    vi.spyOn(tauriApi, 'catalogIndexSearch').mockResolvedValue({
      ...result([]),
      ready: false,
    });
    const live = vi.spyOn(catalogApi, 'useLiveStreams');

    renderHook(() => useCatalogSearch('sport', 'live', { enabled: true }), { wrapper });

    await waitFor(() =>
      expect(live.mock.calls.some(([options]) => options?.enabled === true)).toBe(true),
    );
  });
});
