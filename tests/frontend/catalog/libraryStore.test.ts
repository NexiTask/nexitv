// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  migrateLibraryState,
  useLibraryStore,
  type WatchProgress,
} from '@/modules/library/store/useLibraryStore';
import { useNotificationStore } from '@/shared/notifications/useNotificationStore';
import { useSettingsStore } from '@/modules/settings/store/useSettingsStore';
import { groupSavedTitles } from '@/modules/library/data/savedTitles';

const movie = { id: 'movie-1', title: 'Movie', posterUrl: 'poster', type: 'vod' as const };

const progress = (overrides: Partial<WatchProgress> = {}): WatchProgress => ({
  id: 'movie-1',
  title: 'Movie',
  posterUrl: 'poster',
  type: 'vod',
  currentTime: 200,
  duration: 1000,
  ...overrides,
});

beforeEach(() => {
  localStorage.clear();
  useSettingsStore.getState().resetSettings();
  useNotificationStore.setState({ notifications: [] });
  useLibraryStore.setState({
    savedItems: [],
    favorites: [],
    collections: [],
    history: [],
    watched: [],
    startedSeries: [],
  });
  vi.setSystemTime(new Date('2026-08-10T12:00:00Z'));
});

describe('library store', () => {
  it('persists saved items without stream transport and preserves custom lists when moving them', async () => {
    const item = {
      ...movie,
      sourceId: 'm3u-source',
      sourceItemId: 'item-1',
      streamUrl: 'https://stream.test/movie?token=secret',
      httpHeaders: { Authorization: 'secret' },
      fallbacks: [{ streamUrl: 'https://stream.test/fallback' }],
      catchupSource: 'https://stream.test/catchup',
    };
    const library = useLibraryStore.getState();
    library.toggleSavedItem(item);
    expect(useLibraryStore.getState().favorites).toEqual([]);
    expect(useLibraryStore.getState().collections).toEqual([]);
    window.dispatchEvent(new Event('beforeunload'));

    const snapshot = JSON.parse(localStorage.getItem('iptv-library-storage')!);
    const safeItem = { ...movie, sourceId: item.sourceId, sourceItemId: item.sourceItemId };
    expect(snapshot.state.savedItems).toEqual([safeItem]);
    useLibraryStore.setState({ savedItems: [] });
    await useLibraryStore.persist.rehydrate();
    expect(useLibraryStore.getState().savedItems).toEqual([safeItem]);

    const list = library.createCollection('Weekend');
    library.addToCollection(list, movie);
    library.addFavorite(safeItem);
    expect(useLibraryStore.getState()).toMatchObject({
      savedItems: [],
      favorites: [safeItem],
      collections: [{ id: list, items: [movie] }],
    });
    library.removeFavorite(item.id);
    library.removeFavorite(item.id);
    expect(useLibraryStore.getState()).toMatchObject({
      savedItems: [safeItem],
      favorites: [],
      collections: [{ id: list, items: [movie] }],
    });
    library.clearAllData();
    expect(useLibraryStore.getState().savedItems).toEqual([]);
  });

  it('keeps old favorites and discards overlapping or malformed saved entries during hydration', async () => {
    localStorage.setItem(
      'iptv-library-storage',
      JSON.stringify({ version: 3, state: { favorites: [movie] } }),
    );
    await useLibraryStore.persist.rehydrate();
    expect(useLibraryStore.getState().favorites).toEqual([movie]);
    expect(useLibraryStore.getState().savedItems).toEqual([]);

    const savedOnly = { ...movie, id: 'saved-only' };
    localStorage.setItem(
      'iptv-library-storage',
      JSON.stringify({
        version: 4,
        state: {
          favorites: [movie],
          savedItems: [null, 3, { id: 'no-title' }, movie, savedOnly, savedOnly],
        },
      }),
    );
    await useLibraryStore.persist.rehydrate();
    expect(useLibraryStore.getState().favorites).toEqual([movie]);
    expect(useLibraryStore.getState().savedItems).toEqual([savedOnly]);
  });
  it('deduplicates favorites and toggles watched state', () => {
    const store = useLibraryStore.getState();
    store.addFavorite(movie);
    store.addFavorite(movie);
    store.toggleWatched(movie);

    expect(useLibraryStore.getState().favorites).toEqual([movie]);
    expect(useLibraryStore.getState().savedItems).toEqual([]);
    expect(useLibraryStore.getState().isWatched(movie.id)).toBe(true);
    useLibraryStore.getState().toggleWatched(movie);
    expect(useLibraryStore.getState().isWatched(movie.id)).toBe(false);
  });

  it('recognizes started versions of a saved title without combining different releases', () => {
    const show = {
      id: 'show-one',
      title: 'Show',
      type: 'series' as const,
      year: '2026',
      posterUrl: '',
      imdbId: 'tt1111111',
    };
    const translatedVersion = { ...show, id: 'show-language', title: 'Le feuilleton' };
    const unidentifiedVersion = { ...show, id: 'show-4k', imdbId: undefined };
    const remake = { ...unidentifiedVersion, id: 'show-remake', year: '2027' };
    const differentShow = { ...show, id: 'different-show', imdbId: 'tt2222222' };
    const store = useLibraryStore.getState();
    store.toggleSavedItem(show);
    expect(store.isSavedItem(translatedVersion)).toBe(true);
    store.saveStartedTitle(unidentifiedVersion);
    store.saveStartedTitle(remake);
    store.saveStartedTitle(differentShow);
    expect(useLibraryStore.getState().savedItems).toEqual([show, remake, differentShow]);
    expect(store.isSavedItem(unidentifiedVersion)).toBe(false);
    const anotherUnidentified = { ...unidentifiedVersion, id: 'unknown-show' };
    expect(groupSavedTitles([unidentifiedVersion, anotherUnidentified])).toEqual([
      unidentifiedVersion,
      anotherUnidentified,
    ]);
    expect(
      groupSavedTitles([show, translatedVersion, unidentifiedVersion, remake, differentShow]),
    ).toEqual([show, unidentifiedVersion, remake, differentShow]);
  });

  it('saves newly watched movies and the series of a watched episode only once', () => {
    const store = useLibraryStore.getState();
    const episode = {
      id: 'episode-1',
      type: 'series' as const,
      title: 'Show S01E01',
      posterUrl: 'still',
      seriesId: 'show-1',
      seriesTitle: 'Show',
      seriesPosterUrl: 'cover',
      seriesSourceItemId: '24',
      sourceId: 'xtream-one',
      streamUrl: 'https://stream.test/episode?token=secret',
    };
    store.toggleWatched(movie);
    store.toggleWatched(episode);
    store.setWatched(['episode-2'], true, { item: episode });
    store.toggleWatched(movie);

    expect(useLibraryStore.getState().watched).toEqual(['episode-1', 'episode-2']);
    const saved = useLibraryStore.getState().savedItems;
    expect(saved).toHaveLength(2);
    expect(saved[0]).toMatchObject(movie);
    expect(saved[1]).toMatchObject({
      id: 'show-1',
      title: 'Show',
      posterUrl: 'cover',
      sourceId: 'xtream-one',
      sourceItemId: '24',
    });
    expect(saved[1]).not.toHaveProperty('streamUrl');
  });

  it('ignores accidental starts without overwriting a real resume point', () => {
    useLibraryStore.getState().updateHistory(progress());
    useLibraryStore.getState().updateHistory(progress({ currentTime: 10 }));

    expect(useLibraryStore.getState().history[0]).toMatchObject({
      id: 'movie-1',
      currentTime: 200,
      progressPercentage: 20,
    });
  });

  it('marks completed movies watched and removes their resume card', () => {
    useLibraryStore.getState().updateHistory(progress());
    useLibraryStore.getState().updateHistory(progress({ currentTime: 900 }));

    expect(useLibraryStore.getState().history).toEqual([]);
    expect(useLibraryStore.getState().watched).toContain('movie-1');
  });

  it('groups series history by series and advances completed episodes', () => {
    useLibraryStore.getState().updateHistory(
      progress({
        id: 'episode-1',
        seriesId: 'series-1',
        type: 'series',
        title: 'Series',
        seasonNum: 1,
        episodeNum: 1,
        episodeTitle: 'Pilot',
        currentTime: 900,
        nextEpisode: { id: 'episode-2', seasonNum: 1, episodeNum: 2, episodeTitle: 'Next' },
      }),
    );

    expect(useLibraryStore.getState().history).toHaveLength(1);
    expect(useLibraryStore.getState().history[0]).toMatchObject({
      id: 'series-1',
      episodeId: 'episode-2',
      seasonNum: 1,
      episodeNum: 2,
      currentTime: 0,
      progressPercentage: 0,
    });
    expect(useLibraryStore.getState().watched).toContain('episode-1');
  });

  it('retains direct playlist playback data without leaking it into identifiers', () => {
    useLibraryStore.getState().updateHistory(
      progress({
        id: 'm3u-item',
        streamUrl: 'https://stream.test/movie?token=secret',
        httpHeaders: { Referer: 'https://portal.test/' },
        sourceId: 'm3u-source',
      }),
    );

    expect(useLibraryStore.getState().history[0]).toMatchObject({
      id: 'm3u-item',
      streamUrl: 'https://stream.test/movie?token=secret',
      httpHeaders: { Referer: 'https://portal.test/' },
      sourceId: 'm3u-source',
    });
    const persisted = localStorage.getItem('iptv-library-storage') ?? '';
    expect(persisted).not.toContain('stream.test');
    expect(persisted).not.toContain('portal.test');
    expect(persisted).not.toContain('secret');
  });

  it('caps history items to MAX_HISTORY_ITEMS (200) to prevent unbounded memory growth', () => {
    for (let i = 0; i < 250; i++) {
      useLibraryStore.getState().updateHistory(
        progress({
          id: `movie-${i}`,
          title: `Movie ${i}`,
          currentTime: 50,
          duration: 1000,
        }),
      );
    }

    expect(useLibraryStore.getState().history).toHaveLength(200);
    expect(useLibraryStore.getState().history[0]!.id).toBe('movie-249');
  });
});

describe('recently played channels', () => {
  beforeEach(() => {
    useLibraryStore.setState({ recentChannels: [] });
  });

  it('keeps the newest first, once each, and at most thirty', () => {
    const { addRecentChannel } = useLibraryStore.getState();
    addRecentChannel('a');
    addRecentChannel('b');
    addRecentChannel('a');
    addRecentChannel('');
    expect(useLibraryStore.getState().recentChannels).toEqual(['a', 'b']);
    for (let index = 0; index < 40; index += 1) addRecentChannel(`c${index}`);
    const recent = useLibraryStore.getState().recentChannels;
    expect(recent).toHaveLength(30);
    expect(recent[0]).toBe('c39');
  });

  it('is cleared with the watch history', () => {
    useLibraryStore.getState().addRecentChannel('a');
    useLibraryStore.getState().clearHistory();
    expect(useLibraryStore.getState().recentChannels).toEqual([]);
  });

  it('migrates missing or malformed lists to a clean one', () => {
    expect(migrateLibraryState({}).recentChannels).toEqual([]);
    expect(migrateLibraryState({ recentChannels: 'x' }).recentChannels).toEqual([]);
    expect(migrateLibraryState({ recentChannels: ['a', 3, '', 'b'] }).recentChannels).toEqual([
      'a',
      'b',
    ]);
  });

  it('remembers which series have watched episodes', () => {
    const store = useLibraryStore.getState();
    store.setSeriesStarted('series-1', true);
    store.setSeriesStarted('series-1', true);
    expect(useLibraryStore.getState().startedSeries).toEqual(['series-1']);
    store.setSeriesStarted('series-1', false);
    expect(useLibraryStore.getState().startedSeries).toEqual([]);
  });

  it('counts a series as started once one of its episodes is finished', () => {
    useLibraryStore.getState().updateHistory(
      progress({
        id: 'episode-1',
        type: 'series',
        seriesId: 'series-1',
        currentTime: 990,
        duration: 1000,
      }),
    );
    expect(useLibraryStore.getState().startedSeries).toEqual(['series-1']);
  });

  it('migrates a missing started-series list', () => {
    expect(migrateLibraryState({}).startedSeries).toEqual([]);
    expect(migrateLibraryState({ startedSeries: ['a', 3] }).startedSeries).toEqual(['a']);
  });

  it('keeps a series card for Watch Next once an episode is finished', () => {
    useLibraryStore.getState().updateHistory(
      progress({
        id: 'episode-1',
        title: 'Show',
        type: 'series',
        seriesId: 'series-1',
        seriesSourceItemId: '55',
        currentTime: 990,
        duration: 1000,
      }),
    );
    const tracked = useLibraryStore.getState().trackedSeries['series-1'];
    expect(tracked?.item).toMatchObject({ id: 'series-1', title: 'Show', sourceItemId: '55' });
  });

  it('forgets a series when it is no longer started', () => {
    const store = useLibraryStore.getState();
    store.setSeriesStarted('series-1', true, { id: 'series-1', title: 'Show', posterUrl: '' });
    expect(useLibraryStore.getState().trackedSeries['series-1']?.item.title).toBe('Show');
    store.updateTrackedSeries('series-1', { muted: true });
    expect(useLibraryStore.getState().trackedSeries['series-1']?.muted).toBe(true);
    store.setSeriesStarted('series-1', false);
    expect(useLibraryStore.getState().trackedSeries).toEqual({});
  });
});
