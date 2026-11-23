// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { useWatchNext } from '@/modules/catalog/data/useWatchNext';
import { pickWatchNext, regularEpisodeCount } from '@/modules/catalog/lib/watchNext';
import {
  isQueuedEpisode,
  useLibraryStore,
  type HistoryItem,
} from '@/modules/library/store/useLibraryStore';

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
  afterEach(() => {
    useLibraryStore.setState({
      history: original.history,
      trackedSeries: original.trackedSeries,
      watched: original.watched,
    });
  });

  it('offers the queued episode immediately and keeps started episodes in resume history', () => {
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
    const resumed: HistoryItem = {
      ...queued,
      id: 'show-b',
      episodeId: 'episode-9',
      currentTime: 90,
      progressPercentage: 3,
    };
    useLibraryStore.setState({ history: [queued, resumed], trackedSeries: {}, watched: [] });
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
    const { result } = renderHook(useWatchNext, { wrapper });

    expect(result.current.items).toEqual([queued]);
    expect(useLibraryStore.getState().history.filter((item) => !isQueuedEpisode(item))).toEqual([
      resumed,
    ]);

    act(() => useLibraryStore.getState().dismissWatchNext(queued.id));
    expect(result.current.items).toEqual([]);
    expect(useLibraryStore.getState().history).toEqual([queued, resumed]);
  });
});
