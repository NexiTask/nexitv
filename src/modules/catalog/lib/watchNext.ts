import type { XtreamEpisode } from '@/modules/sources/public/data/xtreamClient';

export interface WatchNextPick {
  season: string;
  episode: XtreamEpisode;
  /** Every regular episode the show lists, for spotting new ones. */
  total: number;
}

/**
 * The episode to watch next in a show the viewer has started: the first
 * unwatched one after the furthest they have got. Earlier gaps (a skipped
 * episode) are left alone, so only what lies ahead (typically a new episode
 * or season) comes up. Specials (season 0) never count. `null` when nothing
 * has been watched yet or the viewer is caught up.
 */
export function pickWatchNext(
  episodes: Record<string, XtreamEpisode[]>,
  isWatched: (episode: XtreamEpisode) => boolean,
): WatchNextPick | null {
  const ordered = Object.keys(episodes)
    .filter((season) => Number(season) > 0)
    .sort((left, right) => Number(left) - Number(right))
    .flatMap((season) =>
      [...(episodes[season] ?? [])]
        .sort((left, right) => Number(left.episode_num) - Number(right.episode_num))
        .map((episode) => ({ season, episode })),
    );
  let furthest = -1;
  ordered.forEach(({ episode }, index) => {
    if (isWatched(episode)) furthest = index;
  });
  if (furthest < 0) return null;
  const next = ordered.slice(furthest + 1).find(({ episode }) => !isWatched(episode));
  return next ? { ...next, total: ordered.length } : null;
}

/** How many regular episodes a show lists. */
export function regularEpisodeCount(episodes: Record<string, XtreamEpisode[]>): number {
  return Object.entries(episodes)
    .filter(([season]) => Number(season) > 0)
    .reduce((count, [, list]) => count + list.length, 0);
}
