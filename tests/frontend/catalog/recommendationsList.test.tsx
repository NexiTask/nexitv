// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import { DataActivityStatus } from '@/app/components/DataActivityStatus';
import { RecommendationsList } from '@/modules/library/pages/RecommendationsList';
import { useSeriesRecommendations } from '@/modules/library/public/data/useSeriesRecommendations';
import { useLibraryStore, type HistoryItem } from '@/modules/library/public/store/useLibraryStore';
import { useAuthStore } from '@/modules/sources/store/useAuthStore';
import { useSourceStore } from '@/modules/sources/store/useSourceStore';
import { tauriApi } from '@/platform/tauri';
import { useDataActivities } from '@/shared/lib/dataActivity';

const catalogMocks = vi.hoisted(() => ({
  useVisibleCatalog: vi.fn((_type?: string, _options?: { enabled?: boolean }) => ({
    data: [
      { id: 'test-series', title: 'The Fixture', type: 'series', posterUrl: '', genres: ['Crime'] },
    ],
    isLoading: false,
  })),
  useCategories: vi.fn((_type?: string, _options?: { enabled?: boolean }) => ({ data: [] })),
  useHiddenCategoryState: vi.fn(() => ({
    ids: new Set<string>(),
    originIds: new Set<string>(),
    isResolved: true,
  })),
}));

vi.mock('@/platform/desktop', () => ({ desktopApi: { isDesktop: () => true } }));
vi.mock('@/modules/catalog/public/data/useCategories', () => ({
  useVisibleCatalog: catalogMocks.useVisibleCatalog,
  useCategories: catalogMocks.useCategories,
  useHiddenCategoryIds: () => new Set<string>(),
}));
vi.mock('@/modules/catalog/data/useCategories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/catalog/data/useCategories')>();
  return {
    ...actual,
    useHiddenCategoryState: catalogMocks.useHiddenCategoryState,
  };
});
vi.mock('@/modules/guide/public/data/useUpcomingReleases', () => ({
  useUpcomingReleases: () => ({ data: [] }),
}));

it('shows both sources together and keeps cached picks when a manual refresh fails', async () => {
  const previousSaved = useLibraryStore.getState().savedItems;
  useLibraryStore.setState({
    savedItems: [{ id: 'local-series', title: 'Saved Series', type: 'series', posterUrl: '' }],
  });
  const status = vi.spyOn(tauriApi, 'chatGptStatus').mockResolvedValue({
    activeClient: 'client',
    accounts: [{ clientId: 'client', label: 'Test', planPermission: true }],
  });
  const read = vi.spyOn(tauriApi, 'recommendationsCached').mockResolvedValue({
    generatedAt: 1780000000,
    picks: [{ key: JSON.stringify(['series', 'test-series']), genreMatch: false }],
  });
  let reportStage: Parameters<typeof tauriApi.recommendationsGenerate>[2] = () => {};
  let rejectGeneration: (reason: string) => void = () => {};
  const rank = vi
    .spyOn(tauriApi, 'recommendationsGenerate')
    .mockImplementation((_clientId, _request, report) => {
      reportStage = report;
      return new Promise((_, reject) => {
        rejectGeneration = reject;
      });
    });
  const imdb = vi
    .spyOn(tauriApi, 'catalogIndexImdb')
    .mockResolvedValue({ id: 'tt1234567', rating: 8.5, votes: 12500 });
  const openSeries = vi.fn();
  const open = () =>
    render(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient()}>
          <DataActivityStatus compact={false} />
          <RecommendationsList next={[]} onOpen={openSeries} />
        </QueryClientProvider>
      </MemoryRouter>,
    );
  try {
    const first = open();
    const smartCard = await screen.findByRole('group', { name: 'Preview The Fixture' });
    const smart = within(smartCard);
    expect(await smart.findByText('IMDb')).toBeTruthy();
    expect(smart.getByText('8.5')).toBeTruthy();
    expect(smart.getByTitle('IMDb rating 8.5 out of 10 from 12,500 votes')).toBeTruthy();
    expect(
      screen.getByRole('group', {
        name: 'Preview Saved Series',
        description: 'Recommended from your Library',
      }),
    ).toBeTruthy();
    expect(imdb).toHaveBeenCalledWith('series', 'test-series');
    first.unmount();
    open();
    const poster = await screen.findByRole('group', {
      name: 'Preview The Fixture',
      description: 'Recommended using your ChatGPT account Discover a series',
    });
    fireEvent.keyDown(poster, { key: 'Enter' });
    expect(poster.getAttribute('aria-current')).toBe('true');
    expect(openSeries).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Series details' }));
    expect(openSeries).toHaveBeenCalledWith(expect.objectContaining({ id: 'test-series' }));
    expect(read).toHaveBeenCalledTimes(2);
    expect(rank).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh recommendations' }));
    const sidebar = within(screen.getByRole('status'));
    expect(await sidebar.findByText('Generating recommendations…')).toBeTruthy();
    expect(sidebar.getByText('Preparing viewing history and available series')).toBeTruthy();
    for (const [stage, label] of [
      ['connecting', 'Connecting to ChatGPT'],
      ['ranking', 'Finding series that fit your taste'],
      ['checking', 'Checking which titles are available'],
      ['searching', 'Searching more of your catalogue'],
      ['saving', 'Saving your recommendations'],
    ] as const) {
      act(() => reportStage(stage));
      expect(sidebar.getByText(label)).toBeTruthy();
    }
    act(() => rejectGeneration('Test refresh failed.'));
    expect((await screen.findByRole('alert')).textContent).toContain('Test refresh failed.');
    expect(sidebar.queryByText('Generating recommendations…')).toBeNull();
    act(() => reportStage('saving'));
    expect(
      [...useDataActivities.getState().details.values()].some(
        ({ activity }) => activity === 'recommendations',
      ),
    ).toBe(false);
    await waitFor(() => expect(rank).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('group', { name: 'Preview The Fixture' })).toBeTruthy();
  } finally {
    useLibraryStore.setState({ savedItems: previousSaved });
    status.mockRestore();
    read.mockRestore();
    rank.mockRestore();
    imdb.mockRestore();
  }
});

it('loads saved Home cards when enabled and removes them if they enter Watch Next', async () => {
  const status = vi.spyOn(tauriApi, 'chatGptStatus').mockResolvedValue({
    activeClient: 'client',
    accounts: [{ clientId: 'client', label: 'Test', planPermission: true }],
  });
  const read = vi.spyOn(tauriApi, 'recommendationsCached').mockResolvedValue({
    generatedAt: 1780000000,
    picks: [{ key: JSON.stringify(['series', 'test-series']), genreMatch: false }],
  });
  const generate = vi.spyOn(tauriApi, 'recommendationsGenerate');
  const imdb = vi
    .spyOn(tauriApi, 'catalogIndexImdb')
    .mockResolvedValue({ id: 'tt1234567', rating: 8.5, votes: 12500 });
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  try {
    const { result, rerender } = renderHook(
      ({ enabled, next }) => useSeriesRecommendations(next, enabled),
      { initialProps: { enabled: false, next: [] as HistoryItem[] }, wrapper },
    );
    expect(status).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(imdb).not.toHaveBeenCalled();
    rerender({ enabled: true, next: [] });
    await waitFor(() =>
      expect(result.current.cards[0]?.item).toMatchObject({
        id: 'test-series',
        imdbRating: 8.5,
        imdbVotes: 12500,
      }),
    );
    expect(read).toHaveBeenCalledOnce();
    expect(generate).not.toHaveBeenCalled();
    rerender({
      enabled: true,
      next: [
        {
          id: 'test-series',
          title: 'The Fixture',
          type: 'series',
          posterUrl: '',
          episodeId: 'episode-2',
          lastWatchedAt: 1,
          progressPercentage: 0,
        },
      ],
    });
    expect(result.current.cards).toEqual([]);
    expect(read).toHaveBeenCalledOnce();
    expect(generate).not.toHaveBeenCalled();
    rerender({ enabled: false, next: [] });
    expect(result.current.cards).toEqual([]);
  } finally {
    status.mockRestore();
    read.mockRestore();
    generate.mockRestore();
    imdb.mockRestore();
  }
});

it('looks up Home recommendation picks by id from the index without loading the full series catalogue', async () => {
  const previousAuth = useAuthStore.getState();
  const previousSources = useSourceStore.getState();
  const sourceId = 'xtream-home-idx';
  useAuthStore.setState({
    profiles: [
      {
        id: sourceId,
        kind: 'xtream',
        name: 'Provider',
        locationLabel: 'provider.test',
        username: 'user',
        userInfo: { auth: 1 } as never,
        serverInfo: {} as never,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    runtimes: {
      [sourceId]: {
        credentials: {
          sourceId,
          url: 'https://provider.test',
          username: 'user',
          password: 'secret',
        },
        status: 'ready',
        error: null,
        revision: 1,
      },
    },
    isInitializing: false,
  });
  useSourceStore.setState({
    profiles: [],
    runtimes: {},
    enabledSourceIds: [sourceId],
    isInitializing: false,
  });
  catalogMocks.useVisibleCatalog.mockClear();

  const status = vi.spyOn(tauriApi, 'chatGptStatus').mockResolvedValue({
    activeClient: 'client',
    accounts: [{ clientId: 'client', label: 'Test', planPermission: true }],
  });
  const read = vi.spyOn(tauriApi, 'recommendationsCached').mockResolvedValue({
    generatedAt: 1780000000,
    picks: [{ key: JSON.stringify(['series', `${sourceId}:series:42`]), genreMatch: false }],
  });
  const byIds = vi.spyOn(tauriApi, 'catalogIndexItemsByIds').mockResolvedValue({
    ready: true,
    rows: [
      {
        sourceId,
        raw: { series_id: 42, name: 'Indexed Pick', cover: '', last_modified: '1700000000' },
        imdb: { id: 'tt7654321', rating: 8.8, votes: 25000 },
      },
    ],
  });
  const imdb = vi.spyOn(tauriApi, 'catalogIndexImdb');
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  try {
    const { result } = renderHook(() => useSeriesRecommendations([], true), { wrapper });
    await waitFor(() =>
      expect(result.current.cards[0]?.item).toMatchObject({
        id: `${sourceId}:series:42`,
        title: 'Indexed Pick',
        imdbId: 'tt7654321',
        imdbRating: 8.8,
        imdbVotes: 25000,
      }),
    );
    expect(byIds).toHaveBeenCalledWith(
      'series',
      [expect.objectContaining({ sourceId })],
      [`${sourceId}:series:42`],
    );
    expect(imdb).not.toHaveBeenCalled();
    expect(catalogMocks.useVisibleCatalog).not.toHaveBeenCalledWith('series', { enabled: true });
  } finally {
    useAuthStore.setState({
      profiles: previousAuth.profiles,
      runtimes: previousAuth.runtimes,
      isInitializing: previousAuth.isInitializing,
    });
    useSourceStore.setState({
      profiles: previousSources.profiles,
      runtimes: previousSources.runtimes,
      enabledSourceIds: previousSources.enabledSourceIds,
      isInitializing: previousSources.isInitializing,
    });
    status.mockRestore();
    read.mockRestore();
    byIds.mockRestore();
    imdb.mockRestore();
  }
});

it('shows a non-blocking loading indicator on RecommendationsList while saved picks load', async () => {
  const previousSaved = useLibraryStore.getState().savedItems;
  useLibraryStore.setState({ savedItems: [] });
  let resolveCached!: (value: { generatedAt: number; picks: [] } | null) => void;
  const status = vi.spyOn(tauriApi, 'chatGptStatus').mockResolvedValue({
    activeClient: 'client',
    accounts: [{ clientId: 'client', label: 'Test', planPermission: true }],
  });
  const read = vi.spyOn(tauriApi, 'recommendationsCached').mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveCached = resolve;
      }),
  );
  try {
    render(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient()}>
          <RecommendationsList next={[]} onOpen={vi.fn()} />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText('Loading recommendations…')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'No recommendations to show' })).toBeNull();
    await waitFor(() => expect(read).toHaveBeenCalledOnce());
    act(() => resolveCached(null));
    expect(await screen.findByRole('heading', { name: 'No recommendations to show' })).toBeTruthy();
  } finally {
    useLibraryStore.setState({ savedItems: previousSaved });
    status.mockRestore();
    read.mockRestore();
  }
});
