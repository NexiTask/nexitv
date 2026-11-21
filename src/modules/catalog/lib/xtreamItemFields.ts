import type {
  XtreamLiveStream,
  XtreamSeries,
  XtreamVodStream,
} from '@/modules/sources/public/data/xtreamClient';
import { xtreamCategoryId, xtreamItemId } from '@/modules/sources/public/lib/sourceIdentity';
import { parseProviderRating } from '@/shared/lib/rating';
import type { CatalogItem } from '../model/catalogItem';
import { parseLiveChannelTitle, parseMediaDisplayTitle } from './titleParser';

/**
 * Everything a movie's catalogue item holds except its stream URL, which
 * needs the account's credentials. Pure, so the catalogue index's facet
 * worker derives its sort and filter values from exactly the same item the
 * catalogue shows.
 */
export function xtreamVodFields(
  sourceId: string,
  sourceName: string,
  stream: XtreamVodStream,
  index: number,
): CatalogItem {
  const title = stream.name || 'Unknown Movie';
  const metadata = parseMediaDisplayTitle(title);
  const providerId = (stream.stream_id ?? stream.num ?? `movie-${index}`).toString();
  const rating = parseProviderRating(stream.rating, stream.rating_5based);
  return {
    id: xtreamItemId(sourceId, 'vod', providerId),
    sourceItemId: providerId,
    title,
    posterUrl: stream.stream_icon || '',
    type: 'vod',
    rating,
    year: metadata.releaseYear || undefined,
    added: stream.added,
    categoryId: xtreamCategoryId(sourceId, stream.category_id),
    tags: metadata.tags,
    country: metadata.country,
    sourceId,
    subtitle: sourceName,
  };
}

/** A series' catalogue item; series need no credentials. */
export function xtreamSeriesItem(
  sourceId: string,
  sourceName: string,
  stream: XtreamSeries,
  index: number,
): CatalogItem {
  let year: string | undefined;
  if (stream.releaseDate) {
    const parsed = new Date(stream.releaseDate).getFullYear();
    if (!Number.isNaN(parsed)) year = parsed.toString();
  }
  const title = stream.name || 'Unknown Series';
  const metadata = parseMediaDisplayTitle(title, year);
  const providerId = (stream.series_id ?? stream.num ?? `series-${index}`).toString();
  const rating = parseProviderRating(stream.rating, stream.rating_5based);
  return {
    id: xtreamItemId(sourceId, 'series', providerId),
    sourceItemId: providerId,
    title,
    posterUrl: stream.cover || '',
    type: 'series',
    rating,
    year: year ?? metadata.releaseYear ?? undefined,
    added: stream.last_modified,
    categoryId: xtreamCategoryId(sourceId, stream.category_id),
    tags: metadata.tags,
    country: metadata.country,
    genre: stream.genre,
    sourceId,
    subtitle: sourceName,
    description: stream.plot,
  };
}

/** A channel's catalogue item except its stream URL and fallbacks, which need credentials. */
export function xtreamLiveFields(
  sourceId: string,
  sourceName: string,
  stream: XtreamLiveStream,
  index: number,
): CatalogItem & { sourceItemId: string } {
  const title = stream.name || 'Unknown Channel';
  const metadata = parseLiveChannelTitle(title);
  const providerId = (
    stream.stream_id ??
    stream.epg_channel_id ??
    stream.num ??
    `live-${index}`
  ).toString();
  const radio =
    stream.stream_type?.toLowerCase() === 'audio' || stream.stream_type?.toLowerCase() === 'radio';
  return {
    id: xtreamItemId(sourceId, 'live', providerId),
    sourceItemId: providerId,
    title,
    posterUrl: stream.stream_icon || '',
    type: 'live',
    channelNum: stream.num ?? index + 1,
    added: stream.added,
    categoryId: xtreamCategoryId(sourceId, stream.category_id),
    epgChannelId: stream.epg_channel_id || undefined,
    tags: metadata.qualityBadges,
    country: metadata.country,
    catchup: stream.tv_archive === 1 ? 'xtream' : undefined,
    catchupDays: stream.tv_archive_duration,
    sourceId,
    subtitle: sourceName,
    radio,
    radioMetadata: radio ? { title } : undefined,
  };
}
