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
    const request = input.createRequest();
    expect(request.favorites).toEqual([]);
    expect(request.watching).toEqual(['Crime', 'Drama']);
    expect(request.candidates.map(({ kind }) => kind)).toEqual(['resume', 'next', 'discover']);
    expect(
      request.candidates.map(({ localKey }) => input.candidates.get(localKey)?.item.id),
    ).toEqual(['started show', 'finished show', 'new show']);
  });

  it('prioritizes specific similarities to completed shows over unrelated recent entries', () => {
    const watched = {
      ...series('watched', 'Crime'),
      categoryId: 'crime',
      description:
        'Detectives investigate corruption inside a police precinct. A retired investigator returns to uncover the facts.',
    };
    const alias = {
      ...watched,
      id: 'alternate-copy',
      title: 'Another catalogue title',
      rating: 10,
    };
    const favorite = series('favorite', 'Comedy');
    const related = {
      ...series('related', 'Crime'),
      categoryId: 'crime',
      description: 'Detectives in a local precinct uncover police corruption.',
    };
    const otherCrime = {
      ...series('other-crime', 'Crime'),
      categoryId: 'crime',
      rating: 10,
      description: 'Smugglers take over a seaside vacation town.',
    };
    const recent = { ...series('recent-comedy', 'Comedy', '1795478400'), rating: 10 };
    const generic = {
      ...series('generic', 'Drama'),
      description: 'Comedy and crime are words in the listing.',
    };
    const input = collectSeriesRecommendations({
      catalogue: [watched, alias, favorite, otherCrime, recent, generic, related],
      favorites: [favorite],
      history: [],
      trackedSeries: { watched: { item: watched, lastWatchedAt: 1 } },
      started: ['watched'],
      next: [],
      upcoming: [],
      categories: new Map(),
      today: '2026-11-24',
    });
    const picks = input.createRequest().candidates;
    expect(picks.map(({ localKey }) => input.candidates.get(localKey)?.item.id)).toEqual([
      'related',
      'other-crime',
      'recent-comedy',
    ]);
  });
});
