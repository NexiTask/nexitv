// @vitest-environment happy-dom

import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useWatchNext } from '@/modules/catalog/data/useWatchNext';
import { seriesInfoQuery } from '@/modules/catalog/data/useDetails';
import { readWatchNextEpisodes } from '@/modules/catalog/data/watchNextCache';
import { HomePage } from '@/modules/catalog/pages/HomePage';
import { WatchNextFeature } from '@/modules/catalog/components/WatchNextFeature';
import { pickWatchNext, regularEpisodeCount } from '@/modules/catalog/lib/watchNext';
import {
  isQueuedEpisode,
  useLibraryStore,
  type HistoryItem,
} from '@/modules/library/store/useLibraryStore';
import { useAuthStore } from '@/modules/sources/store/useAuthStore';
import { xtreamItemId } from '@/modules/sources/lib/sourceIdentity';
import { getSeriesInfo, type XtreamSeriesInfoResponse } from '@/modules/sources/data/xtreamClient';

vi.mock('@/modules/sources/data/xtreamClient', { spy: true });
vi.mock('@/modules/catalog/data/useHomeRows', () => ({
  useIndexPool: () => ({ items: null, settled: false, error: null }),
}));
vi.mock('@/modules/sources/public/hooks/useEnabledSources', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/modules/sources/public/hooks/useEnabledSources')>();
  return { useEnabledSources: () => ({ ...actual.useEnabledSources(), isAvailable: true }) };
});

const cacheKey = 'nexitv-watch-next-episodes-v1';

const episode = (id: number, num: number) => ({
  id: String(id),
  episode_num: num,
  title: `Episode ${num}`,
  container_extension: 'mkv',
  info: {},
});
const episodes = {
  '0': [episode(900, 1)],
  '1': [episode(102, 2), episode(101, 1)],
  '2': [episode(201, 1), episode(202, 2)],
};
const watching =
  (...ids: number[]) =>
  (e: { id: string | number }) =>
    ids.includes(Number(e.id));

describe('pickWatchNext', () => {
  it('offers the first episode after the furthest one watched', () => {
    const pick = pickWatchNext(episodes, watching(101, 102));
    expect(pick?.season).toBe('2');
    expect(pick?.episode.id).toBe('201');
  });

  it('moves on within a season', () => {
    expect(pickWatchNext(episodes, watching(101))?.episode.id).toBe('102');
  });

  it('leaves earlier gaps alone', () => {
    // 101 was skipped; 102 was the furthest watched, so 201 comes next.
    expect(pickWatchNext(episodes, watching(102))?.episode.id).toBe('201');
  });

  it('has nothing to offer when caught up or not started', () => {
    expect(pickWatchNext(episodes, watching(101, 102, 201, 202))).toBeNull();
    expect(pickWatchNext(episodes, watching())).toBeNull();
  });

  it('ignores specials', () => {
    expect(pickWatchNext({ '0': [episode(900, 1)] }, watching(900))).toBeNull();
    expect(regularEpisodeCount(episodes)).toBe(4);
  });
});

describe('saved next episodes', () => {
  const original = useLibraryStore.getState();
  const originalRuntimes = useAuthStore.getState().runtimes;
  afterEach(() => {
    useLibraryStore.setState({
      history: original.history,
      trackedSeries: original.trackedSeries,
      watched: original.watched,
    });
    useAuthStore.setState({ runtimes: originalRuntimes });
    localStorage.removeItem(cacheKey);
    vi.mocked(getSeriesInfo).mockReset();
  });

  it('offers the queued episode immediately and keeps started episodes in resume history', async () => {
    const queued: HistoryItem = {
      id: 'show-a',
      title: 'Show A',
      type: 'series',
      posterUrl: '',
      episodeId: 'episode-8',
      seasonNum: 2,
      episodeNum: 8,
      progressPercentage: 0,
      currentTime: 0,
      lastWatchedAt: 2,
    };
    const second: HistoryItem = { ...queued, id: 'show-c', title: 'Show C', lastWatchedAt: 1 };
    const resumed: HistoryItem = {
      ...queued,
      id: 'show-b',
      episodeId: 'episode-9',
      currentTime: 90,
      progressPercentage: 3,
    };
    useLibraryStore.setState({
      history: [queued, resumed, second],
      trackedSeries: {},
      watched: [],
    });
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
    const { result } = renderHook(useWatchNext, { wrapper });

    expect(result.current.items).toEqual([queued, second]);
    expect(useLibraryStore.getState().history.filter((item) => !isQueuedEpisode(item))).toEqual([
      resumed,
    ]);

    function CurrentPath() {
      return createElement('output', { 'aria-label': 'Current path' }, useLocation().pathname);
    }
    const home = render(
      createElement(
        MemoryRouter,
        null,
        createElement(
          QueryClientProvider,
          { client },
          createElement(HomePage),
          createElement(CurrentPath),
        ),
      ),
    );
    expect(screen.getByRole('heading', { name: 'Show A' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Previous episode' }).hasAttribute('disabled')).toBe(
      true,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Next episode' }));
    expect(screen.getByRole('heading', { name: 'Show C' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Next episode' }).hasAttribute('disabled')).toBe(
      true,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Previous episode' }));
    expect(screen.getByRole('heading', { name: 'Show A' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'See all for Watch Next' }));
    expect(screen.getByRole('status', { name: 'Current path' }).textContent).toBe(
      '/library/watch-next',
    );
    home.unmount();

    act(() => useLibraryStore.getState().dismissWatchNext(queued.id));
    expect(result.current.items).toEqual([second]);
    expect(useLibraryStore.getState().history).toEqual([queued, resumed, second]);
  });

  it('rotates while visible, wraps, and pauses for interaction or the pause button', () => {
    vi.useFakeTimers();
    let setVisible: (visible: boolean) => void = () => {};
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(notify: IntersectionObserverCallback) {
          setVisible = (visible) =>
            act(() => {
              notify(
                [
                  {
                    isIntersecting: visible,
                    intersectionRatio: visible ? 1 : 0,
                  } as IntersectionObserverEntry,
                ],
                this as unknown as IntersectionObserver,
              );
            });
        }
        observe() {}
        disconnect() {}
      },
    );
    const items: HistoryItem[] = ['First Show', 'Second Show'].map((title) => ({
      id: title,
      title,
      type: 'series',
      posterUrl: '',
      progressPercentage: 0,
      currentTime: 0,
      lastWatchedAt: 1,
      episodeId: 'episode-1',
      seasonNum: 1,
      episodeNum: 1,
    }));
    const onSeeAll = vi.fn();
    const home = render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(WatchNextFeature, {
          items,
          onOpen: vi.fn(),
          onDismiss: vi.fn(),
          onSeeAll,
        }),
      ),
    );
    const tick = (ms = 12_000) =>
      act(() => {
        vi.advanceTimersByTime(ms);
      });
    try {
      const banner = screen.getByRole('region', { name: 'Watch Next' });
      const sectionHeading = screen.getByRole('heading', { name: 'Watch Next', level: 2 });
      const seeAll = screen.getByRole('button', { name: 'See all for Watch Next' });
      expect(banner.contains(sectionHeading)).toBe(false);
      expect(
        sectionHeading.compareDocumentPosition(banner) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(banner.contains(seeAll)).toBe(false);
      fireEvent.click(seeAll);
      expect(onSeeAll).toHaveBeenCalledOnce();
      const heading = () => screen.getByRole('heading', { level: 3 }).textContent;
      tick();
      expect(heading()).toBe('First Show');
      setVisible(true);
      tick(11_999);
      expect(heading()).toBe('First Show');
      tick(1);
      expect(heading()).toBe('Second Show');
      fireEvent.mouseEnter(banner);
      tick();
      expect(heading()).toBe('Second Show');
      fireEvent.mouseLeave(banner);
      tick();
      expect(heading()).toBe('First Show');
      const next = screen.getByRole('button', { name: 'Next episode' });
      fireEvent.focus(next);
      tick();
      expect(heading()).toBe('First Show');
      fireEvent.blur(next);
      fireEvent.click(screen.getByRole('button', { name: 'Pause Watch Next rotation' }));
      tick();
      expect(heading()).toBe('First Show');
      fireEvent.click(screen.getByRole('button', { name: 'Start Watch Next rotation' }));
      tick();
      expect(heading()).toBe('Second Show');
      setVisible(false);
      tick();
      expect(heading()).toBe('Second Show');
    } finally {
      home.unmount();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it('updates the queue when a tracked series source becomes available', () => {
    const sourceId = 'xtream-other';
    const credentials = {
      sourceId,
      url: 'https://example.test',
      username: 'user',
      password: 'test',
    };
    const item = {
      id: 'show-other',
      sourceId,
      sourceItemId: '7',
      title: 'Other show',
      type: 'series' as const,
      posterUrl: '',
      lastWatchedAt: 1,
    };
    useAuthStore.setState({ runtimes: {} });
    useLibraryStore.setState({
      history: [],
      trackedSeries: { [item.id]: { item, lastWatchedAt: 1 } },
      watched: [xtreamItemId(sourceId, 'episode', 101)],
    });
    const client = new QueryClient();
    client.setQueryData(seriesInfoQuery('7', sourceId, credentials).queryKey, { episodes });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
    const { result } = renderHook(useWatchNext, { wrapper });
    expect(result.current.items).toEqual([]);

    act(() => {
      useAuthStore.setState({
        runtimes: { [sourceId]: { credentials, status: 'ready', error: null, revision: 1 } },
      });
    });
    expect(result.current.items).toEqual([expect.objectContaining({ episodeId: '102' })]);
  });

  it('shows saved episodes on a cold query cache and replaces them when the provider replies', async () => {
    const sourceId = 'xtream-cached';
    const credentials = {
      sourceId,
      url: 'https://provider.test',
      username: 'viewer',
      password: 'account-secret',
    };
    const runtime = { credentials, status: 'ready' as const, error: null, revision: 1 };
    const item = {
      id: 'show-cached',
      sourceId,
      sourceItemId: '7',
      title: 'Cached show',
      type: 'series' as const,
      posterUrl: '',
    };
    useAuthStore.setState({ runtimes: { [sourceId]: runtime } });
    useLibraryStore.setState({
      history: [],
      trackedSeries: { [item.id]: { item, lastWatchedAt: 1 } },
      watched: [xtreamItemId(sourceId, 'episode', 101)],
    });
    const savedResponse = {
      info: {},
      seasons: [],
      episodes: {
        ...episodes,
        '1': [
          ...episodes['1'].slice(1),
          {
            ...episodes['1'][0]!,
            direct_source: 'https://provider.test/private-stream',
            http_headers: { Authorization: 'stream-secret' },
          },
        ],
      },
    };
    vi.mocked(getSeriesInfo).mockResolvedValueOnce(savedResponse);
    const previousClient = new QueryClient();
    await previousClient.fetchQuery(seriesInfoQuery('7', sourceId, credentials));
    previousClient.clear();
    const saved = localStorage.getItem(cacheKey);
    expect(saved).toBeTruthy();
    expect(saved).not.toMatch(/(provider\.test|account-secret|stream-secret)/);

    let resolveRefresh: (data: XtreamSeriesInfoResponse) => void = () => {};
    vi.mocked(getSeriesInfo).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
    const { result, unmount } = renderHook(useWatchNext, { wrapper });
    expect(result.current.items).toEqual([expect.objectContaining({ episodeId: '102' })]);
    expect(result.current.isLoading).toBe(true);
    expect(getSeriesInfo).toHaveBeenCalledTimes(2);

    act(() => useLibraryStore.getState().dismissWatchNext(item.id));
    expect(result.current.items).toEqual([]);
    expect(useLibraryStore.getState().trackedSeries[item.id]?.knownEpisodes).toBeUndefined();
    act(() => useLibraryStore.getState().updateTrackedSeries(item.id, { muted: false }));

    act(() =>
      resolveRefresh({
        info: {},
        seasons: [],
        episodes: { '1': [episode(101, 1), episode(103, 2)] },
      }),
    );
    await waitFor(() =>
      expect(result.current.items).toEqual([expect.objectContaining({ episodeId: '103' })]),
    );
    expect(result.current.isLoading).toBe(false);

    vi.mocked(getSeriesInfo).mockImplementationOnce(() => new Promise(() => {}));
    act(() => {
      useAuthStore.setState({
        runtimes: {
          [sourceId]: { ...runtime, credentials: { ...credentials, username: 'other' } },
        },
      });
    });
    expect(result.current.items).toEqual([]);
    expect(result.current.isLoading).toBe(true);
    unmount();
    client.clear();
  });

  it('ignores malformed or expired cache entries', () => {
    const query = seriesInfoQuery('7', 'xtream-cached', null);
    localStorage.setItem(cacheKey, '{invalid');
    expect(readWatchNextEpisodes().size).toBe(0);
    localStorage.setItem(
      cacheKey,
      JSON.stringify([
        { key: JSON.stringify(query.queryKey), savedAt: Date.now(), episodes: { '1': [null] } },
        { key: JSON.stringify(query.queryKey), savedAt: 1, episodes },
      ]),
    );
    expect(readWatchNextEpisodes().size).toBe(0);
  });
});
