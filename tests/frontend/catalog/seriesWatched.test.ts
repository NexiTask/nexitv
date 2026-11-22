// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';

const xc = vi.hoisted(() => ({ getSeriesInfo: vi.fn() }));
vi.mock('@/modules/sources/data/xtreamClient', () => xc);

import { isSeriesCard, setSeriesWatched } from '@/modules/catalog/lib/seriesWatched';
import { useAuthStore } from '@/modules/sources/store/useAuthStore';
import { useLibraryStore } from '@/modules/library/store/useLibraryStore';
import { queryClient } from '@/shared/query/queryClient';
import { xtreamItemId } from '@/modules/sources/lib/sourceIdentity';

const sourceId = 'xtream-watched';
const credentials = { sourceId, url: 'https://provider.test', username: 'a', password: 'b' };
const episode = (id: number, num: number) => ({
  id: String(id),
  episode_num: num,
  title: `Episode ${num}`,
  container_extension: 'mkv',
  info: {},
});
const series = {
  id: xtreamItemId(sourceId, 'series', '55'),
  sourceItemId: '55',
  sourceId,
  title: 'Breaking Bad',
  posterUrl: '',
  type: 'series' as const,
};

beforeEach(() => {
  queryClient.clear();
  xc.getSeriesInfo.mockReset();
  useAuthStore.setState({
    profiles: [],
    runtimes: { [sourceId]: { credentials, status: 'ready', error: null, revision: 1 } },
  } as never);
  useLibraryStore.setState({ history: [], watched: [], startedSeries: [], syncedSeries: [] });
  xc.getSeriesInfo.mockResolvedValue({
    info: { name: 'Breaking Bad' },
    episodes: { '1': [episode(101, 1), episode(102, 2)], '2': [episode(201, 1)] },
  });
});

describe('setSeriesWatched', () => {
  it('marks the series and every episode of every season', async () => {
    await setSeriesWatched(series, true);
    const { watched, startedSeries } = useLibraryStore.getState();
    expect(watched).toEqual(
      expect.arrayContaining([
        series.id,
        xtreamItemId(sourceId, 'episode', '101'),
        xtreamItemId(sourceId, 'episode', '102'),
        xtreamItemId(sourceId, 'episode', '201'),
      ]),
    );
    expect(watched).toHaveLength(4);
    expect(startedSeries).toEqual([series.id]);
  });

  it('unmarks all of it again', async () => {
    await setSeriesWatched(series, true);
    await setSeriesWatched(series, false);
    expect(useLibraryStore.getState().watched).toEqual([]);
    expect(useLibraryStore.getState().startedSeries).toEqual([]);
  });

  it('falls back to the series alone when the episodes cannot be fetched', async () => {
    xc.getSeriesInfo.mockRejectedValue(new Error('offline'));
    await setSeriesWatched(series, true);
    expect(useLibraryStore.getState().watched).toEqual([series.id]);
  });

  it('tells a series card from an episode', () => {
    expect(isSeriesCard(series)).toBe(true);
    expect(isSeriesCard({ ...series, seriesId: series.id })).toBe(false);
  });
});

describe('migrateWatchedSeries', () => {
  it('fills in the episodes of a series that was only flagged on its card', async () => {
    const { migrateWatchedSeries } =
      await import('@/modules/catalog/data/useSeriesWatchedMigration');
    useLibraryStore.setState({ watched: [series.id], syncedSeries: [], startedSeries: [] });
    expect(await migrateWatchedSeries()).toBe(1);
    const state = useLibraryStore.getState();
    expect(state.watched).toHaveLength(4);
    expect(state.watched).toContain(xtreamItemId(sourceId, 'episode', '201'));
    expect(state.startedSeries).toEqual([series.id]);
    expect(state.syncedSeries).toEqual([series.id]);

    // Done once: a second run neither fetches nor changes anything.
    xc.getSeriesInfo.mockClear();
    expect(await migrateWatchedSeries()).toBe(0);
    expect(xc.getSeriesInfo).not.toHaveBeenCalled();
  });

  it('retries later when the episodes cannot be fetched', async () => {
    const { migrateWatchedSeries } =
      await import('@/modules/catalog/data/useSeriesWatchedMigration');
    xc.getSeriesInfo.mockRejectedValue(new Error('offline'));
    useLibraryStore.setState({ watched: [series.id], syncedSeries: [], startedSeries: [] });
    expect(await migrateWatchedSeries()).toBe(0);
    expect(useLibraryStore.getState().syncedSeries).toEqual([]);
  });
});
