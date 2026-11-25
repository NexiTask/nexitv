import type { WatchNextEpisode, WatchNextEpisodes } from '../lib/watchNext';

const STORAGE_KEY = 'nexitv-watch-next-episodes-v1';
const MAX_SERIES = 24;
const MAX_CHARS = 256 * 1024;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface CachedSeries {
  key: string;
  savedAt: number;
  episodes: WatchNextEpisodes;
}

let lastRead: { raw: string; entries: CachedSeries[] } | undefined;

function isEpisode(value: unknown): value is WatchNextEpisode {
  if (!value || typeof value !== 'object') return false;
  const { id, episode_num, title } = value as Partial<WatchNextEpisode>;
  return (
    (typeof id === 'string' || typeof id === 'number') &&
    (typeof episode_num === 'string' || typeof episode_num === 'number') &&
    (title === undefined || typeof title === 'string')
  );
}

function isCachedSeries(value: unknown): value is CachedSeries {
  if (!value || typeof value !== 'object') return false;
  const { key, savedAt, episodes } = value as Partial<CachedSeries>;
  return (
    typeof key === 'string' &&
    typeof savedAt === 'number' &&
    !!episodes &&
    typeof episodes === 'object' &&
    !Array.isArray(episodes) &&
    Object.entries(episodes).every(
      ([season, list]) => Number(season) > 0 && Array.isArray(list) && list.every(isEpisode),
    )
  );
}

function readCache(): CachedSeries[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw || raw.length > MAX_CHARS) {
      lastRead = undefined;
      return [];
    }
    if (lastRead?.raw === raw) return lastRead.entries;
    const parsed: unknown = JSON.parse(raw);
    const entries = Array.isArray(parsed) ? parsed.filter(isCachedSeries).slice(0, MAX_SERIES) : [];
    lastRead = { raw, entries };
    return entries;
  } catch {
    return [];
  }
}

function isRecent(entry: CachedSeries, now: number): boolean {
  return entry.savedAt <= now && now - entry.savedAt < MAX_AGE_MS;
}

export function readWatchNextEpisodes(): ReadonlyMap<string, WatchNextEpisodes> {
  const now = Date.now();
  return new Map(
    readCache()
      .filter((entry) => isRecent(entry, now))
      .map((entry) => [entry.key, entry.episodes]),
  );
}

/** Keep only the fields needed to pick a card. Full series details stay in memory. */
export function saveWatchNextEpisodes(
  queryKey: readonly unknown[],
  episodes: WatchNextEpisodes,
): void {
  const key = JSON.stringify(queryKey);
  const savedAt = Date.now();
  const entry: CachedSeries = {
    key,
    savedAt,
    episodes: Object.fromEntries(
      Object.entries(episodes)
        .filter(([season]) => Number(season) > 0)
        .map(([season, list]) => [
          season,
          list
            .map(({ id, episode_num, title }) => ({
              id,
              episode_num,
              title: typeof title === 'string' ? title : undefined,
            }))
            .filter(isEpisode),
        ]),
    ),
  };
  try {
    if (JSON.stringify([entry]).length > MAX_CHARS) return;
    const entries = [
      entry,
      ...readCache().filter((cached) => cached.key !== key && isRecent(cached, savedAt)),
    ].slice(0, MAX_SERIES);
    let raw = JSON.stringify(entries);
    while (raw.length > MAX_CHARS) {
      entries.pop();
      raw = JSON.stringify(entries);
    }
    localStorage.setItem(STORAGE_KEY, raw);
    lastRead = { raw, entries };
  } catch {
    // Storage is optional. The provider response can still populate the query.
  }
}
