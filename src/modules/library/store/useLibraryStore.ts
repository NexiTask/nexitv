import { create } from 'zustand';
import { persist, type PersistStorage } from 'zustand/middleware';

/**
 * Debounced localStorage wrapper for Zustand persist.
 *
 * During video playback the watch-progress hook updates the library store
 * every 3 seconds. Without debouncing, each update triggers a synchronous
 * `sanitizedLibraryData` → `JSON.stringify` → `localStorage.setItem` cycle
 * on the entire library state, causing frame drops on large histories.
 *
 * This wrapper coalesces writes so at most one flush happens per
 * `DEBOUNCE_MS` window, while reads remain immediate.
 */
const PERSIST_DEBOUNCE_MS = 5000;
const MAX_HISTORY_ITEMS = 200;
const MAX_RECENT_CHANNELS = 30;

function createDebouncedStorage<T>(): PersistStorage<T> {
  let pendingValue: string | null = null;
  let pendingKey: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function flush() {
    if (pendingKey !== null && pendingValue !== null) {
      try {
        localStorage.setItem(pendingKey, pendingValue);
      } catch {
        // Storage full — silently drop. The next successful write will
        // persist the latest state.
      }
    }
    pendingKey = null;
    pendingValue = null;
    timer = null;
  }

  // Ensure pending data is flushed on page unload (tab close, refresh).
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', flush);
  }

  return {
    getItem(name) {
      const raw = localStorage.getItem(name);
      if (raw === null) return null;
      try {
        const parsed = JSON.parse(raw) as { state: T; version?: number | undefined };
        return {
          state: parsed.state,
          ...(parsed.version !== undefined ? { version: parsed.version } : {}),
        };
      } catch {
        return null;
      }
    },
    setItem(name, value) {
      pendingKey = name;
      pendingValue = JSON.stringify(value);
      if (timer === null) {
        timer = setTimeout(flush, PERSIST_DEBOUNCE_MS);
      }
    },
    removeItem(name) {
      // Cancel any pending write for this key.
      if (pendingKey === name) {
        pendingKey = null;
        pendingValue = null;
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
      }
      localStorage.removeItem(name);
    },
  };
}
import type { MediaItem } from '@/modules/catalog/public/model/media';
import { getDisplayTitle } from '@/modules/catalog/public/lib/titleParser';

export interface HistoryItem extends MediaItem {
  progressPercentage: number;
  lastWatchedAt: number;
  currentTime?: number | undefined;
  duration?: number | undefined;
  seriesId?: string | undefined;
  seriesSourceItemId?: string | undefined;
  seasonNum?: string | number | undefined;
  episodeNum?: string | number | undefined;
  episodeId?: string | undefined;
  episodeTitle?: string | undefined;
}

/** Saved pointers to the next episode are not playback positions. */
export function isQueuedEpisode(item: HistoryItem): boolean {
  return (
    item.type === 'series' &&
    (Boolean(item.episodeId) || (item.seasonNum != null && item.episodeNum != null)) &&
    !((item.currentTime ?? 0) > 0 || item.progressPercentage > 0)
  );
}

/**
 * A series the viewer has watched episodes of, with what a card needs to show
 * it again. Watch Next draws on these when a new episode appears.
 */
export interface TrackedSeries {
  item: MediaItem;
  lastWatchedAt: number;
  /** Dismissed from Watch Next until the show gets more episodes. */
  muted?: boolean | undefined;
  /** The episode count seen when it was dismissed. */
  knownEpisodes?: number | undefined;
}

/** A playback position reported by the player. */
export interface WatchProgress {
  /** The thing being played: a movie id, or an episode id for series. */
  id: string;
  seriesId?: string | undefined;
  title: string;
  posterUrl: string;
  type: 'vod' | 'series';
  currentTime: number;
  duration: number;
  tags?: string[] | undefined;
  country?: string | null | undefined;
  streamUrl?: string | undefined;
  httpHeaders?: Record<string, string> | undefined;
  sourceId?: string | undefined;
  sourceItemId?: string | undefined;
  seriesSourceItemId?: string | undefined;
  seasonNum?: string | number | undefined;
  episodeNum?: string | number | undefined;
  episodeTitle?: string | undefined;
  /**
   * The episode after this one, if the caller already knows it (the player
   * has the series' episode list loaded while something is playing). When
   * this episode turns out to be finished, Continue Watching advances to
   * this instead of just dropping the show.
   */
  nextEpisode?:
    | {
        id: string;
        seasonNum: string | number;
        episodeNum: string | number;
        episodeTitle?: string | undefined;
        streamUrl?: string | undefined;
        httpHeaders?: Record<string, string> | undefined;
        sourceId?: string | undefined;
      }
    | undefined;
}

/**
 * Below this, there is nothing worth resuming — someone opened the wrong thing
 * or watched the studio logo. Deliberately in seconds: the previous rule used
 * 2% of the runtime, which is nearly two and a half minutes into a two hour
 * film, so short sessions vanished without a trace.
 */
const MIN_RESUMABLE_SECONDS = 20;

/** Within this much of the end, treat it as finished rather than resumable. */
const FINISHED_TAIL_SECONDS = 120;

interface Collection {
  id: string;
  name: string;
  items: MediaItem[];
}

interface LibraryState {
  savedItems: MediaItem[];
  favorites: MediaItem[];
  collections: Collection[];
  history: HistoryItem[];
  watched: string[];
  /**
   * Series with at least one episode watched. Watched is recorded per
   * episode, which carries no link back to its show, so the Not started
   * filter reads this list instead.
   */
  startedSeries: string[];
  /**
   * Series marked watched as a whole whose episodes have all been marked too
   * (see `setSeriesWatched`); older marks are filled in once at start.
   */
  syncedSeries: string[];
  markSeriesSynced: (seriesId: string) => void;
  /** Records (or clears) that a series has watched episodes; `item` is what
   * a card needs to show it (kept the first time it is given). */
  setSeriesStarted: (seriesId: string, started: boolean, item?: MediaItem) => void;
  /** The started series by id, for Watch Next. */
  trackedSeries: Record<string, TrackedSeries>;
  updateTrackedSeries: (seriesId: string, patch: Partial<Omit<TrackedSeries, 'item'>>) => void;
  dismissWatchNext: (seriesId: string) => void;
  /**
   * Live channels played most recently, newest first (ids only). Live
   * playback never enters `history`, which needs a duration.
   */
  recentChannels: string[];
  addRecentChannel: (id: string) => void;

  toggleSavedItem: (item: MediaItem) => void;
  addFavorite: (item: MediaItem) => void;
  removeFavorite: (id: string) => void;
  isFavorite: (id: string) => boolean;

  toggleWatched: (id: string) => void;
  isWatched: (id: string) => boolean;
  /** Marks many items (a season's episodes) at once, with one notice. */
  setWatched: (ids: readonly string[], watched: boolean, quiet?: boolean) => void;
  /** Points the saved series entry at the episode to watch next,
   * or drops it when there is none (the show is finished). */
  advanceSeriesHistory: (
    seriesId: string,
    next: {
      id: string;
      seasonNum: string | number;
      episodeNum: string | number;
      episodeTitle?: string | undefined;
    } | null,
  ) => void;

  createCollection: (name: string) => string;
  renameCollection: (id: string, newName: string) => void;
  deleteCollection: (id: string) => void;
  addToCollection: (collectionId: string, item: MediaItem) => void;
  removeFromCollection: (collectionId: string, itemId: string) => void;

  updateHistory: (progress: WatchProgress) => void;
  removeFromHistory: (id: string) => void;
  clearHistory: () => void;
  clearFavorites: () => void;
  clearCollections: () => void;
  clearAllData: () => void;
}

/** What a card needs to show the series a progress report belongs to. */
function trackedItem(progress: WatchProgress, seriesId: string): MediaItem {
  return {
    id: seriesId,
    title: progress.title,
    posterUrl: progress.posterUrl,
    type: 'series',
    sourceId: progress.sourceId,
    sourceItemId: progress.seriesSourceItemId,
    seriesSourceItemId: progress.seriesSourceItemId,
    tags: progress.tags,
    country: progress.country,
  };
}

function withoutPlaybackTransport<T extends MediaItem>(item: T): T {
  const safe: MediaItem = { ...item };
  delete safe.streamUrl;
  delete safe.httpHeaders;
  delete safe.fallbacks;
  delete safe.catchupSource;
  return safe as T;
}

function sanitizedLibraryData(
  state: Pick<LibraryState, 'savedItems' | 'favorites' | 'collections' | 'history' | 'watched'>,
) {
  return {
    savedItems: state.savedItems.map(withoutPlaybackTransport),
    favorites: state.favorites.map(withoutPlaybackTransport),
    collections: state.collections.map((collection) => ({
      ...collection,
      items: collection.items.map(withoutPlaybackTransport),
    })),
    history: state.history.map(withoutPlaybackTransport),
    watched: state.watched,
  };
}

function normalizeSavedItems(value: unknown): MediaItem[] {
  if (!Array.isArray(value)) return [];
  const items = new Map<string, MediaItem>();
  for (const item of value) {
    if (
      item &&
      typeof item.id === 'string' &&
      item.id.length > 0 &&
      typeof item.title === 'string' &&
      typeof item.posterUrl === 'string' &&
      !items.has(item.id)
    ) {
      items.set(item.id, withoutPlaybackTransport(item));
    }
  }
  return [...items.values()];
}

export function migrateLibraryState(persistedState: unknown): LibraryState {
  const state = (
    persistedState && typeof persistedState === 'object' ? persistedState : {}
  ) as Partial<LibraryState> & { downloads?: unknown | undefined };
  const nextState = { ...state };
  delete nextState.downloads;

  const normalized = {
    ...nextState,
    savedItems: normalizeSavedItems(state.savedItems),
    favorites: Array.isArray(state.favorites) ? state.favorites : [],
    collections: Array.isArray(state.collections) ? state.collections : [],
    history: Array.isArray(state.history) ? state.history : [],
    watched: Array.isArray(state.watched) ? state.watched : [],
    startedSeries: Array.isArray(state.startedSeries)
      ? state.startedSeries.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [],
    syncedSeries: Array.isArray(state.syncedSeries)
      ? state.syncedSeries.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [],
    trackedSeries:
      state.trackedSeries &&
      typeof state.trackedSeries === 'object' &&
      !Array.isArray(state.trackedSeries)
        ? state.trackedSeries
        : {},
    recentChannels: Array.isArray(state.recentChannels)
      ? state.recentChannels
          .filter((id): id is string => typeof id === 'string' && id.length > 0)
          .slice(0, MAX_RECENT_CHANNELS)
      : [],
  } as LibraryState;
  return { ...normalized, ...sanitizedLibraryData(normalized) };
}

import { notify } from '@/shared/notifications/useNotificationStore';
import { debugLog } from '@/modules/diagnostics/public/store/useDebugStore';

export const useLibraryStore = create<LibraryState>()(
  persist(
    (set, get) => ({
      savedItems: [],
      favorites: [],
      collections: [],
      history: [],
      watched: [],
      startedSeries: [],
      trackedSeries: {},
      syncedSeries: [],
      recentChannels: [],

      markSeriesSynced: (seriesId) => {
        const current = get().syncedSeries || [];
        if (!seriesId || current.includes(seriesId)) return;
        set({ syncedSeries: [...current, seriesId] });
      },

      setSeriesStarted: (seriesId, started, item) => {
        if (!seriesId) return;
        const current = get().startedSeries || [];
        const tracked = get().trackedSeries || {};
        if (!started) {
          if (!current.includes(seriesId) && !tracked[seriesId]) return;
          const rest = { ...tracked };
          delete rest[seriesId];
          set({ startedSeries: current.filter((id) => id !== seriesId), trackedSeries: rest });
          return;
        }
        const needsItem = Boolean(item) && !tracked[seriesId];
        if (current.includes(seriesId) && !needsItem) return;
        set({
          startedSeries: current.includes(seriesId) ? current : [...current, seriesId],
          trackedSeries:
            item && !tracked[seriesId]
              ? {
                  ...tracked,
                  [seriesId]: { item: withoutPlaybackTransport(item), lastWatchedAt: Date.now() },
                }
              : tracked,
        });
      },

      updateTrackedSeries: (seriesId, patch) => {
        const tracked = get().trackedSeries || {};
        const existing = tracked[seriesId];
        if (!existing) return;
        set({ trackedSeries: { ...tracked, [seriesId]: { ...existing, ...patch } } });
      },

      dismissWatchNext: (seriesId) =>
        set((state) => {
          const tracked = state.trackedSeries[seriesId];
          const queued = state.history.find(
            (item) => item.id === seriesId && isQueuedEpisode(item),
          );
          const entry =
            tracked ??
            (queued && {
              item: withoutPlaybackTransport(queued),
              lastWatchedAt: queued.lastWatchedAt,
            });
          if (!entry) return state;
          return {
            trackedSeries: {
              ...state.trackedSeries,
              [seriesId]: { ...entry, muted: true, knownEpisodes: undefined },
            },
          };
        }),

      addRecentChannel: (id) => {
        if (!id || get().recentChannels[0] === id) return;
        set((state) => ({
          recentChannels: [id, ...state.recentChannels.filter((other) => other !== id)].slice(
            0,
            MAX_RECENT_CHANNELS,
          ),
        }));
      },

      toggleSavedItem: (item) => {
        const { savedItems } = get();
        const isSaved = savedItems.some((entry) => entry.id === item.id);
        set({
          savedItems: isSaved
            ? savedItems.filter((entry) => entry.id !== item.id)
            : [...savedItems, item],
        });
        notify.info(
          isSaved ? 'Removed from Library' : 'Added to Library',
          getDisplayTitle(item.title, item.type),
          undefined,
          undefined,
          'library',
        );
      },

      addFavorite: (item) => {
        const exists = get().favorites.some((f) => f.id === item.id);
        if (!exists) {
          set((state) => ({ favorites: [...state.favorites, item] }));
          notify.success(
            'Added to Favorites',
            getDisplayTitle(item.title, item.type),
            undefined,
            undefined,
            'library',
          );
          debugLog.info('library', `Added favorite: ${item.title}`, {
            id: item.id,
            type: item.type,
          });
        }
      },

      removeFavorite: (id) => {
        const item = get().favorites.find((f) => f.id === id);
        set((state) => ({ favorites: state.favorites.filter((f) => f.id !== id) }));
        notify.info(
          'Removed from Favorites',
          item ? getDisplayTitle(item.title, item.type) : 'Item removed',
          undefined,
          undefined,
          'library',
        );
        debugLog.info('library', `Removed favorite`, { id });
      },

      isFavorite: (id) => get().favorites.some((f) => f.id === id),

      toggleWatched: (id) => {
        const isCurrentlyWatched = (get().watched || []).includes(id);
        set((state) => ({
          watched: isCurrentlyWatched
            ? (state.watched || []).filter((wId) => wId !== id)
            : [...(state.watched || []), id],
        }));
        notify.info(
          isCurrentlyWatched ? 'Marked as Unwatched' : 'Marked as Watched',
          undefined,
          undefined,
          undefined,
          'library',
        );
        debugLog.info('library', `Toggled watched status`, { id, watched: !isCurrentlyWatched });
      },

      isWatched: (id) => (get().watched || []).includes(id),

      setWatched: (ids, watched, quiet = false) => {
        const targets = new Set(ids);
        if (targets.size === 0) return;
        set((state) => {
          const current = state.watched || [];
          return {
            watched: watched
              ? [...current, ...[...targets].filter((id) => !current.includes(id))]
              : current.filter((id) => !targets.has(id)),
          };
        });
        if (!quiet) {
          notify.info(
            watched ? 'Marked as Watched' : 'Marked as Unwatched',
            undefined,
            undefined,
            undefined,
            'library',
          );
        }
        debugLog.info('library', `Set watched status`, { count: targets.size, watched });
      },

      advanceSeriesHistory: (seriesId, next) =>
        set((state) => {
          const entry = state.history.find((h) => h.id === seriesId);
          if (!entry) return state;
          const others = state.history.filter((h) => h.id !== seriesId);
          if (!next) return { history: others };
          return {
            history: [
              {
                ...entry,
                progressPercentage: 0,
                lastWatchedAt: Date.now(),
                currentTime: 0,
                duration: 0,
                seasonNum: next.seasonNum,
                episodeNum: next.episodeNum,
                episodeId: next.id,
                episodeTitle: next.episodeTitle,
                // The stored stream was the old episode's: quick play and the
                // sheet resolve the new one from the series' episode list.
                streamUrl: undefined,
              },
              ...others,
            ],
          };
        }),

      createCollection: (name) => {
        const newCol = { id: crypto.randomUUID(), name, items: [] };
        set((state) => ({ collections: [...state.collections, newCol] }));
        notify.success(
          'Collection Created',
          `Collection "${name}" ready.`,
          undefined,
          undefined,
          'library',
        );
        debugLog.info('library', `Created collection: ${name}`, { id: newCol.id });
        return newCol.id;
      },

      renameCollection: (id, newName) => {
        const targetCol = get().collections.find((c) => c.id === id);
        if (targetCol) {
          set((state) => ({
            collections: state.collections.map((c) => (c.id === id ? { ...c, name: newName } : c)),
          }));
          notify.success(
            'Collection Renamed',
            `Renamed to "${newName}".`,
            undefined,
            undefined,
            'library',
          );
          debugLog.info('library', `Renamed collection`, { id, newName });
        }
      },

      deleteCollection: (id) => {
        const targetCol = get().collections.find((c) => c.id === id);
        set((state) => ({
          collections: state.collections.filter((c) => c.id !== id),
        }));
        notify.info(
          'Collection Deleted',
          targetCol ? `"${targetCol.name}" removed.` : 'Collection removed.',
          undefined,
          undefined,
          'library',
        );
        debugLog.info('library', `Deleted collection`, { id });
      },

      addToCollection: (collectionId, item) => {
        const targetCol = get().collections.find((c) => c.id === collectionId);
        if (targetCol && !targetCol.items.some((i) => i.id === item.id)) {
          set((state) => ({
            collections: state.collections.map((c) =>
              c.id === collectionId ? { ...c, items: [...c.items, item] } : c,
            ),
          }));
          notify.success(
            'Added to Collection',
            `"${getDisplayTitle(item.title, item.type)}" added to ${targetCol.name}`,
            undefined,
            undefined,
            'library',
          );
          debugLog.info('library', `Added item to collection`, { collectionId, itemId: item.id });
        }
      },

      removeFromCollection: (collectionId, itemId) => {
        const targetCol = get().collections.find((c) => c.id === collectionId);
        set((state) => ({
          collections: state.collections.map((c) =>
            c.id === collectionId ? { ...c, items: c.items.filter((i) => i.id !== itemId) } : c,
          ),
        }));
        notify.info(
          'Removed from Collection',
          targetCol ? `Removed from ${targetCol.name}` : undefined,
          undefined,
          undefined,
          'library',
        );
        debugLog.info('library', `Removed item from collection`, { collectionId, itemId });
      },

      updateHistory: (progress) =>
        set((state) => {
          const { currentTime, duration } = progress;
          if (!(duration > 0) || !(currentTime > 0)) return state;

          // A series is tracked under its *series* id, not the episode's. Both
          // readers — the series modal and the in-player episode drawer — look the
          // entry up by series id, while this used to store it under the episode
          // id, so nothing ever matched and series never resumed. It also keeps
          // Continue Watching to one card per show instead of one per episode.
          const historyId =
            progress.type === 'series' ? (progress.seriesId ?? progress.id) : progress.id;

          const others = state.history.filter((h) => h.id !== historyId);
          const watched = state.watched || [];
          const remaining = duration - currentTime;

          // Finished: remember it as watched. Watched is recorded per episode,
          // so finishing one does not mark a whole series. For a series with a
          // next episode already known, save a pointer for Watch Next and
          // quick play without recording playback for the new episode.
          if (remaining <= FINISHED_TAIL_SECONDS) {
            const nextWatched = watched.includes(progress.id) ? watched : [...watched, progress.id];
            const started = state.startedSeries || [];
            const nextStarted =
              progress.type === 'series' && !started.includes(historyId)
                ? [...started, historyId]
                : started;
            const nextTracked =
              progress.type === 'series'
                ? {
                    ...state.trackedSeries,
                    [historyId]: {
                      item: trackedItem(progress, historyId),
                      lastWatchedAt: Date.now(),
                    },
                  }
                : state.trackedSeries;

            if (progress.type === 'series' && progress.nextEpisode) {
              const next = progress.nextEpisode;
              const nextEntry: HistoryItem = {
                id: historyId,
                title: progress.title,
                // Series cover, not the next episode's still — same reasoning
                // as the currently-playing entry below: the card stands for
                // the whole show.
                posterUrl: progress.posterUrl,
                type: 'series',
                progressPercentage: 0,
                lastWatchedAt: Date.now(),
                currentTime: 0,
                duration: 0,
                seriesId: progress.seriesId,
                sourceItemId: progress.seriesSourceItemId,
                seriesSourceItemId: progress.seriesSourceItemId,
                seasonNum: next.seasonNum,
                episodeNum: next.episodeNum,
                episodeId: next.id,
                episodeTitle: next.episodeTitle,
                tags: progress.tags,
                country: progress.country,
                streamUrl: next.streamUrl,
                httpHeaders: next.httpHeaders,
                sourceId: next.sourceId || progress.sourceId,
              };
              return {
                history: [nextEntry, ...others].slice(0, MAX_HISTORY_ITEMS),
                watched: nextWatched,
                startedSeries: nextStarted,
                trackedSeries: nextTracked,
              };
            }

            return {
              history: others,
              watched: nextWatched,
              startedSeries: nextStarted,
              trackedSeries: nextTracked,
            };
          }

          // Too early to be worth resuming. Leave any existing entry untouched
          // rather than overwriting a real position with a near-zero one.
          if (currentTime < MIN_RESUMABLE_SECONDS) return state;

          const entry: HistoryItem = {
            id: historyId,
            title: progress.title,
            posterUrl: progress.posterUrl,
            type: progress.type,
            progressPercentage: (currentTime / duration) * 100,
            lastWatchedAt: Date.now(),
            currentTime,
            duration,
            seriesId: progress.seriesId,
            sourceItemId:
              progress.type === 'series' ? progress.seriesSourceItemId : progress.sourceItemId,
            seriesSourceItemId: progress.seriesSourceItemId,
            seasonNum: progress.seasonNum,
            episodeNum: progress.episodeNum,
            episodeId:
              progress.type === 'series' ? (progress.sourceItemId ?? progress.id) : undefined,
            episodeTitle: progress.episodeTitle,
            tags: progress.tags,
            country: progress.country,
            streamUrl: progress.streamUrl,
            httpHeaders: progress.httpHeaders,
            sourceId: progress.sourceId,
          };

          return { history: [entry, ...others].slice(0, MAX_HISTORY_ITEMS) };
        }),

      removeFromHistory: (id) => {
        const item = get().history.find((h) => h.id === id);
        set((state) => ({
          history: state.history.filter((h) => h.id !== id),
        }));
        notify.info(
          'Removed from Watch History',
          item ? getDisplayTitle(item.title, item.type) : 'Item removed',
          undefined,
          undefined,
          'library',
        );
        debugLog.info('library', `Removed item from history`, { id });
      },

      clearHistory: () => {
        set({ history: [], recentChannels: [] });
        notify.info(
          'Watch History Cleared',
          'All watch history and progress removed.',
          undefined,
          undefined,
          'library',
        );
        debugLog.info('library', 'Cleared all watch history');
      },

      clearFavorites: () => {
        set({ favorites: [] });
        notify.info(
          'Favorites Cleared',
          'All saved favorites removed.',
          undefined,
          undefined,
          'library',
        );
        debugLog.info('library', 'Cleared all favorites');
      },

      clearCollections: () => {
        set({ collections: [] });
        notify.info(
          'Collections Cleared',
          'All user created collections removed.',
          undefined,
          undefined,
          'library',
        );
        debugLog.info('library', 'Cleared all collections');
      },

      clearAllData: () => {
        set({
          savedItems: [],
          favorites: [],
          collections: [],
          history: [],
          watched: [],
          startedSeries: [],
          trackedSeries: {},
          syncedSeries: [],
          recentChannels: [],
        });
        notify.warning('Library Reset', 'Library data cleared.', undefined, undefined, 'library');
        debugLog.warn('library', 'Cleared all library data');
      },
    }),
    {
      name: 'iptv-library-storage',
      version: 4,
      merge: (persisted, current) => {
        const state = persisted as Partial<LibraryState> | undefined;
        return { ...current, ...state, savedItems: normalizeSavedItems(state?.savedItems) };
      },
      migrate: migrateLibraryState,
      storage: createDebouncedStorage<LibraryState>(),
      partialize: (state) => ({ ...state, ...sanitizedLibraryData(state) }),
    },
  ),
);
