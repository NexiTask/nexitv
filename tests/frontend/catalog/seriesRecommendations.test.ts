import { describe, expect, it } from 'vitest';
import { collectSeriesRecommendations } from '@/modules/library/data/seriesRecommendations';
import type { MediaItem } from '@/modules/catalog/public/model/media';

const series = (id: string, genre: string, added?: string): MediaItem => ({
  id,
  title: id,
  posterUrl: '',
  type: 'series',
  genres: [genre],
  added,
});

describe('series recommendation inputs', () => {
  it('learns genres from playback even without favorites and only sends eligible series', () => {
    const inProgress = series('started show', 'Drama');
    const finished = series('finished show', 'Crime');
    const discovery = series('new show', 'Drama');
    const input = collectSeriesRecommendations({
      catalogue: [
        inProgress,
        finished,
        discovery,
        { id: 'movie', title: 'movie', posterUrl: '', type: 'vod' },
      ],
      favorites: [],
      history: [
        { ...inProgress, episodeId: 'episode-1', progressPercentage: 50, lastWatchedAt: 1 },
      ],
      trackedSeries: { watched: { item: finished, lastWatchedAt: 2 } },
      started: ['finished show'],
      next: [{ ...finished, episodeId: 'episode-2', progressPercentage: 0, lastWatchedAt: 2 }],
      upcoming: [],
      categories: new Map(),
      today: '2026-11-24',
    });
    expect(input.request.favorites).toEqual([]);
    expect(input.request.watching).toEqual(['Drama', 'Crime']);
    expect(input.request.candidates.map(({ kind }) => kind)).toEqual([
      'resume',
      'next',
      'discover',
    ]);
    expect(
      input.request.candidates.map(({ localKey }) => input.candidates.get(localKey)?.item.id),
    ).toEqual(['started show', 'finished show', 'new show']);
  });
});
