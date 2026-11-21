import type { QueryClient } from '@tanstack/react-query';
import { getStreamUrl, type XtreamEpisode } from '@/modules/sources/public/data/xtreamClient';
import { resolveXtreamSourceId } from '@/modules/sources/public/store/useAuthStore';
import { xtreamItemId } from '@/modules/sources/public/lib/sourceIdentity';
import { usePlayerStore } from '@/modules/playback/public/store/usePlayerStore';
import {
  playableFromDownloadedItem,
  resolveEpisodePlayback,
} from '@/modules/playback/public/lib/playback';
import { useLibraryStore } from '@/modules/library/public/store/useLibraryStore';
import { useDownloadStore } from '@/modules/downloads/public/store/useDownloadStore';
import { mergeMediaTags } from '@/shared/lib/mediaTags';
import { seriesInfoQuery, sourceCredentials, vodInfoQuery } from '../data/useDetails';
import {
  formatEpisodePlaybackTitle,
  parseEpisodeTitle,
  parseMediaDisplayTitle,
} from './titleParser';
import type { MediaItem } from '../model/media';

/**
 * The card's play button: start the title without the details sheet.
 *
 * - A movie resumes where it was left, or starts from the beginning.
 * - A series resumes the episode Continue Watching holds (which already moved
 *   on to the next episode when the last one finished), or else plays the
 *   first episode not yet watched, or the very first one.
 *
 * Playback is built exactly as the details dialogs build it, from the same
 * cached detail queries. Resolves `false` when the title cannot be started
 * this way (an M3U source, no credentials, a failed provider call), so the
 * caller can open the details sheet instead.
 */
export async function quickPlay(client: QueryClient, item: MediaItem): Promise<boolean> {
  if (item.sourceId?.startsWith('m3u-')) return false;
  try {
    if (item.type === 'vod') return await playMovie(client, item);
    if (item.type === 'series') return await playSeries(client, item);
  } catch {
    // A provider error falls back to the details sheet, which explains it.
  }
  return false;
}

async function playMovie(client: QueryClient, item: MediaItem): Promise<boolean> {
  const credentials = sourceCredentials(item.sourceId);
  if (!credentials) return false;
  const movieId = item.id;
  const providerMovieId = item.sourceItemId || movieId;
  const data = await client.fetchQuery(vodInfoQuery(providerMovieId, item.sourceId, credentials));
  const streamUrl =
    data.movie_data.direct_stream_url ||
    getStreamUrl(credentials, 'vod', providerMovieId, data.movie_data.container_extension || 'mp4');
  if (!streamUrl) return false;
  const history = useLibraryStore.getState().history.find((entry) => entry.id === movieId);
  const parsedTitle = parseMediaDisplayTitle(data.info.name || item.title, item.year);
  usePlayerStore.getState().playStream({
    id: movieId,
    sourceItemId: providerMovieId,
    title: parsedTitle.cleanTitle,
    type: 'vod',
    streamUrl,
    httpHeaders: data.movie_data.http_headers,
    sourceId: data.movie_data.source_id || item.sourceId,
    posterUrl: data.info.movie_image || item.posterUrl,
    startPosition: history?.currentTime || 0,
    knownDuration: history?.duration,
    tags: parsedTitle.tags,
    country: parsedTitle.country,
  });
  return true;
}

function sortedSeasons(episodes: Record<string, XtreamEpisode[]>): string[] {
  const seasons = Object.keys(episodes).sort((left, right) => Number(left) - Number(right));
  // Season 0 holds specials; a show starts at season 1 when it has one.
  const regular = seasons.filter((season) => Number(season) > 0);
  return regular.length > 0 ? [...regular, ...seasons.filter((s) => Number(s) <= 0)] : seasons;
}

function sortedEpisodes(episodes: XtreamEpisode[]): XtreamEpisode[] {
  return [...episodes].sort((left, right) => Number(left.episode_num) - Number(right.episode_num));
}

async function playSeries(client: QueryClient, item: MediaItem): Promise<boolean> {
  const credentials = sourceCredentials(item.sourceId);
  if (!credentials) return false;
  const seriesId = item.id;
  const providerSeriesId = item.seriesSourceItemId || item.sourceItemId || seriesId;
  const data = await client.fetchQuery(
    seriesInfoQuery(providerSeriesId, item.sourceId, credentials),
  );
  const seasons = sortedSeasons(data.episodes ?? {});
  if (seasons.length === 0) return false;

  const resolvedSourceId = resolveXtreamSourceId(item.sourceId);
  const libraryId = (episode: XtreamEpisode) =>
    resolvedSourceId ? xtreamItemId(resolvedSourceId, 'episode', episode.id) : String(episode.id);
  const { history, watched } = useLibraryStore.getState();
  const saved = history.find((entry) => entry.id === seriesId);

  // In episode order: the saved episode, else the first unwatched, else the
  // first of all.
  const ordered = seasons.flatMap((season) =>
    sortedEpisodes(data.episodes[season] ?? []).map((episode) => ({ season, episode })),
  );
  const savedEpisode = saved
    ? (ordered.find(({ episode }) => String(episode.id) === String(saved.episodeId)) ??
      ordered.find(
        ({ season, episode }) =>
          String(season) === String(saved.seasonNum) &&
          String(episode.episode_num) === String(saved.episodeNum),
      ))
    : undefined;
  const watchedIds = new Set(watched ?? []);
  const target =
    savedEpisode ??
    ordered.find(({ episode }) => !watchedIds.has(libraryId(episode))) ??
    ordered[0];
  if (!target) return false;
  const { season, episode } = target;
  const startPosition = savedEpisode ? saved?.currentTime || 0 : 0;

  const downloaded = useDownloadStore.getState().downloadedByLibraryId[libraryId(episode)];
  if (downloaded) {
    usePlayerStore.getState().playStream(playableFromDownloadedItem(downloaded, startPosition));
    return true;
  }
  const playback = resolveEpisodePlayback(episode, credentials);
  if (!playback) return false;

  const parsedTitle = parseMediaDisplayTitle(data.info?.name || item.title, item.year);
  const seriesTitle = parsedTitle.cleanTitle;
  const parsedEpisode = parseEpisodeTitle(episode.title, {
    seriesTitle,
    seasonNum: season,
    episodeNum: episode.episode_num,
  });
  usePlayerStore.getState().playStream({
    id: libraryId(episode),
    sourceItemId: episode.id.toString(),
    title: formatEpisodePlaybackTitle(seriesTitle, season, episode.episode_num, episode.title),
    type: 'series',
    ...playback,
    posterUrl: episode.info?.movie_image || item.posterUrl,
    seriesPosterUrl: data.info?.cover || item.posterUrl,
    seriesId,
    seriesSourceItemId: providerSeriesId,
    seriesTitle,
    seasonNum: season,
    episodeNum: episode.episode_num,
    episodeTitle: parsedEpisode.cleanTitle,
    startPosition,
    knownDuration: savedEpisode ? saved?.duration : undefined,
    tags: mergeMediaTags(...parsedTitle.tags, ...parsedEpisode.tags),
    country: parsedTitle.country ?? parsedEpisode.country,
  });
  return true;
}
