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
  it('includes watched titles even without favorites and only offers eligible series for validation', () => {
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
    expect(request.library).toEqual([]);
    expect(request.watching.map(({ title, genres }) => ({ title, genres }))).toEqual([
      { title: 'finished show', genres: ['Crime'] },
      { title: 'started show', genres: ['Drama'] },
    ]);
    expect(request.catalogue.map(({ title }) => title)).toEqual(['new show']);
  });

  it('includes saved series and safe metadata and leaves comparison to the model', () => {
    const watched = {
      ...series('watched', 'Crime'),
      categoryId: 'crime',
      description:
        'Detectives investigate corruption inside a police precinct. A retired investigator returns to uncover the facts.',
    };
    const favorite = series('favorite', 'Comedy');
    const related = {
      ...series('related', 'Crime'),
      categoryId: 'crime',
      imdbId: 'tt1234567',
      imdbRating: 8,
      description: '<p>Detectives uncover corruption.</p> https://example.test/private',
      streamUrl: 'https://example.test/stream',
    };
    const generic = {
      ...series('generic', 'Drama'),
      description: 'Comedy and crime are words in the listing.',
    };
    const input = collectSeriesRecommendations({
      catalogue: [watched, favorite, generic, related],
      favorites: [favorite],
      saved: [related],
      history: [],
      trackedSeries: { watched: { item: watched, lastWatchedAt: 1 } },
      started: ['watched'],
      next: [],
      upcoming: [],
      categories: new Map(),
      today: '2026-11-24',
    });
    const request = input.createRequest();
    expect(request.library.map(({ title }) => title)).toEqual(['favorite', 'related']);
    expect(request.catalogue.map(({ title }) => title)).toEqual(['generic', 'related']);
    expect(request.library[1]).toEqual({
      title: 'related',
      localKey: JSON.stringify(['series', 'related']),
      genres: ['Crime'],
      description: 'Detectives uncover corruption.',
      imdbUrl: 'https://www.imdb.com/title/tt1234567/',
      year: undefined,
    });
  });
});

it('filters all three viewing lists across catalogue copies while grouping other picks', () => {
  const resume = series('resume', 'Drama');
  const next = { ...series('next', 'Sci-Fi'), title: 'Silo', year: '2023' };
  const nextDub = { ...next, id: 'next-dub', title: 'IR - Silo سیلو' };
  const scheduled = series('scheduled', 'Comedy');
  const judge = {
    ...series('judge', 'Crime'),
    title: 'EN - The Judge From Hell (2024) (KR)',
    year: '2024',
  };
  const dub = { ...judge, id: 'judge-dub', title: 'IR - The Judge From Hell قاضی جهنمی (DUB)' };
  const remake = { ...judge, id: 'remake', title: 'The Judge From Hell', year: '2030' };
  const input = collectSeriesRecommendations({
    catalogue: [resume, nextDub, scheduled, judge, dub, remake],
    favorites: [],
    history: [
      {
        ...resume,
        id: 'episode-1',
        seriesId: resume.id,
        episodeId: '1',
        progressPercentage: 50,
        lastWatchedAt: 1,
      },
    ],
    trackedSeries: {},
    next: [{ ...next, episodeId: '10', progressPercentage: 0, lastWatchedAt: 1 }],
    started: [],
    upcoming: [
      {
        favorite: scheduled,
        tmdbId: 1,
        airDate: '2027-07-09',
        kind: 'episode',
        title: 'Premiere',
        seasonNumber: 4,
        episodeNumber: 1,
        artworkUrl: null,
        exactAirTime: null,
        timeSource: 'tmdb',
      },
    ],
    categories: new Map(),
    today: '2026-11-24',
  });
  const cards = input.groupPicks(
    [
      ['series', 'judge-dub'],
      ['resume', 'resume', '1'],
      ['series', 'resume'],
      ['next', 'next', '10'],
      ['series', 'next-dub'],
      ['series', 'judge'],
      ['upcoming', 'scheduled', 4, 1],
      ['series', 'scheduled'],
      ['series', 'remake'],
    ].map((parts) => ({ key: JSON.stringify(parts), genreMatch: true })),
  );
  expect(cards.map(({ item }) => item.id)).toEqual(['judge-dub', 'remake']);
  expect(input.createRequest().catalogue.map(({ localKey }) => localKey)).toEqual([
    JSON.stringify(['series', 'judge']),
    JSON.stringify(['series', 'remake']),
  ]);
});
