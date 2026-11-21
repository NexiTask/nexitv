// @vitest-environment happy-dom

import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const xc = vi.hoisted(() => ({
  getSeriesInfo: vi.fn(),
  getVodInfo: vi.fn(),
  getStreamUrl: vi.fn(
    (_credentials: unknown, type: string, id: string | number, extension: string) =>
      `https://provider.test/${type}/${id}.${extension}`,
  ),
}));
vi.mock('@/modules/sources/data/xtreamClient', () => xc);

import { quickPlay } from '@/modules/catalog/lib/quickPlay';
import { useAuthStore } from '@/modules/sources/store/useAuthStore';
import { useLibraryStore } from '@/modules/library/store/useLibraryStore';
import { usePlayerStore } from '@/modules/playback/store/usePlayerStore';
import { xtreamItemId } from '@/modules/sources/lib/sourceIdentity';

const sourceId = 'xtream-quick';
const credentials = { sourceId, url: 'https://provider.test', username: 'a', password: 'b' };
const playStream = vi.fn();

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const episode = (id: number, num: number) => ({
  id: String(id),
  episode_num: num,
  title: `Episode ${num}`,
  container_extension: 'mkv',
  info: {},
});

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({
    profiles: [],
    runtimes: { [sourceId]: { credentials, status: 'ready', error: null, revision: 1 } },
  } as never);
  useLibraryStore.setState({ history: [], watched: [] });
  usePlayerStore.setState({ playStream } as never);
  xc.getVodInfo.mockResolvedValue({
    info: { name: 'The Godfather' },
    movie_data: { stream_id: 7, container_extension: 'mp4' },
  });
  xc.getSeriesInfo.mockResolvedValue({
    info: { name: 'Breaking Bad' },
    episodes: {
      '0': [episode(900, 1)],
      '1': [episode(102, 2), episode(101, 1)],
      '2': [episode(201, 1)],
    },
  });
});

const movie = {
  id: xtreamItemId(sourceId, 'vod', '7'),
  sourceItemId: '7',
  sourceId,
  title: 'The Godfather',
  posterUrl: '',
  type: 'vod' as const,
};
const series = {
  id: xtreamItemId(sourceId, 'series', '55'),
  sourceItemId: '55',
  sourceId,
  title: 'Breaking Bad',
  posterUrl: '',
  type: 'series' as const,
};

describe('quick play from a card', () => {
  it('starts a new movie from the beginning', async () => {
    expect(await quickPlay(client(), movie)).toBe(true);
    expect(playStream).toHaveBeenCalledWith(
      expect.objectContaining({
        streamUrl: 'https://provider.test/vod/7.mp4',
        startPosition: 0,
      }),
    );
  });

  it('resumes a movie where it was left', async () => {
    useLibraryStore.setState({
      history: [
        { ...movie, progressPercentage: 40, lastWatchedAt: 1, currentTime: 3000, duration: 7000 },
      ],
    } as never);
    await quickPlay(client(), movie);
    expect(playStream).toHaveBeenCalledWith(expect.objectContaining({ startPosition: 3000 }));
  });

  it('starts an unwatched series at S1E1, not the specials', async () => {
    await quickPlay(client(), series);
    expect(playStream).toHaveBeenCalledWith(
      expect.objectContaining({ sourceItemId: '101', seasonNum: '1', startPosition: 0 }),
    );
  });

  it('resumes the saved episode at its position', async () => {
    useLibraryStore.setState({
      history: [
        {
          ...series,
          progressPercentage: 50,
          lastWatchedAt: 1,
          currentTime: 1200,
          duration: 2400,
          episodeId: '102',
          seasonNum: '1',
          episodeNum: 2,
        },
      ],
    } as never);
    await quickPlay(client(), series);
    expect(playStream).toHaveBeenCalledWith(
      expect.objectContaining({ sourceItemId: '102', startPosition: 1200 }),
    );
  });

  it('moves on to the first unwatched episode when nothing is saved', async () => {
    useLibraryStore.setState({
      watched: [xtreamItemId(sourceId, 'episode', '101'), xtreamItemId(sourceId, 'episode', '102')],
    });
    await quickPlay(client(), series);
    expect(playStream).toHaveBeenCalledWith(
      expect.objectContaining({ sourceItemId: '201', seasonNum: '2', startPosition: 0 }),
    );
  });

  it('hands M3U titles and provider failures back to the details sheet', async () => {
    expect(await quickPlay(client(), { ...movie, sourceId: 'm3u-1' })).toBe(false);
    xc.getVodInfo.mockRejectedValueOnce(new Error('timeout'));
    expect(await quickPlay(client(), movie)).toBe(false);
    expect(playStream).not.toHaveBeenCalled();
  });
});
