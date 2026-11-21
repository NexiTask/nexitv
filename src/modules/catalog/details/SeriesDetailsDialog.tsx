import { useEffect, useId, useState, useMemo, useRef } from 'react';
import {
  CheckCircle2,
  CircleOff,
  Clock,
  Download,
  Heart,
  HardDriveDownload,
  Clapperboard,
  Play,
  Settings,
} from 'lucide-react';
import {
  getXtreamCredentials,
  resolveXtreamSourceId,
  useAuthStore,
} from '@/modules/sources/public/store/useAuthStore';
import type { XtreamEpisode } from '@/modules/sources/public/data/xtreamClient';
import type { MediaItem } from '../model/media';
import type { TitleVariant } from '../data/useTitleVariants';
import { VersionSwitcher } from './VersionSwitcher';
import { DetailsHero } from './DetailsHero';
import heroStyles from './DetailsHero.module.css';
import { useImdbFacts } from '../data/useImdbFacts';
import { useSeriesInfo } from '../data/useDetails';
import { usePlayerStore } from '@/modules/playback/public/store/usePlayerStore';
import { useLibraryStore } from '@/modules/library/public/store/useLibraryStore';
import { useDownloadStore } from '@/modules/downloads/public/store/useDownloadStore';
import {
  downloadSeriesSeason,
  type DownloadableMediaItem,
} from '@/modules/downloads/public/services/mediaDownload';
import { formatDurationLabel, formatRemaining } from '@/shared/lib/time';
import {
  formatEpisodePlaybackTitle,
  parseEpisodeTitle,
  parseMediaDisplayTitle,
} from '../lib/titleParser';
import { getPrimaryMediaTags, mergeMediaTags } from '@/shared/lib/mediaTags';
import { countryName } from '@/shared/lib/categoryName';
import { SeriesDetailSkeleton } from '@/shared/ui/Skeleton';
import { useMediaContextMenus } from '../hooks/useMediaContextMenus';
import { DetailsDialogShell } from '../components/DetailsDialogShell';
import { ErrorState } from '@/shared/ui/ErrorState';
import { Select } from '@/shared/ui/Select';
import { getErrorPresentation } from '@/shared/lib/error';
import styles from './SeriesDetailsDialog.module.css';
import {
  playableFromDownloadedItem,
  resolveEpisodePlayback,
} from '@/modules/playback/public/lib/playback';
import { xtreamItemId } from '@/modules/sources/public/lib/sourceIdentity';
import { M3uSeriesDetailsDialog } from './M3uSeriesDetailsDialog';
import { useI18n } from '@/shared/i18n/i18n';
import { useNavigate } from 'react-router-dom';
import { SeriesUpcomingEpisodes } from '@/modules/guide/public/components/SeriesUpcomingEpisodes';
import { episodeScheduleKey } from '@/modules/guide/public/lib/upcoming';
import { useTmdbDetailEnrichment } from '@/modules/metadata/public/hooks/useTmdbDetailsEnrichment';
import { normalizeTmdbId } from '@/modules/metadata/public/model/tmdb';
import { parseProviderRating, resolveMediaRating } from '@/shared/lib/rating';
import { MediaRatingFact } from '../components/MediaRatingFact';
import { buildDetailPresentation, tmdbLookupFor } from './detailPresentation';

interface SeriesDetailsDialogProps {
  seriesId: string;
  seriesTitle: string;
  seriesPoster: string;
  sourceId?: string | undefined;
  sourceItemId?: string | undefined;
  initialSeasonNumber?: number | undefined;
  initialEpisodeNumber?: number | undefined;
  /** The other provider variants behind the grouped card, when grouped. */
  versions?: readonly TitleVariant[] | undefined;
  onSelectVersion?: ((item: MediaItem) => void) | undefined;
  /** Reports that this variant's details failed, so the caller can try the
   * next one without making the reader close and reopen the card. */
  onLoadFailed?: (() => void) | undefined;
  onClose: () => void;
}

export function SeriesDetailsDialog(props: SeriesDetailsDialogProps) {
  if (props.sourceId?.startsWith('m3u-')) {
    return <M3uSeriesDetailsDialog {...props} sourceId={props.sourceId} />;
  }
  return <XtreamSeriesDetailsDialog {...props} />;
}

function XtreamSeriesDetailsDialog({
  seriesId,
  seriesTitle,
  seriesPoster,
  sourceId,
  sourceItemId,
  initialSeasonNumber,
  initialEpisodeNumber,
  versions,
  onSelectVersion,
  onLoadFailed,
  onClose,
}: SeriesDetailsDialogProps) {
  const { t, tn, number, language } = useI18n();
  const navigate = useNavigate();
  const { handleMediaCardContextMenu } = useMediaContextMenus();
  const credentials = useAuthStore((state) => {
    const resolvedSourceId = sourceId === 'xtream' ? state.profiles[0]?.id : sourceId;
    return resolvedSourceId
      ? (state.runtimes[resolvedSourceId]?.credentials ?? null)
      : getXtreamCredentials();
  });
  const providerSeriesId = sourceItemId || seriesId;
  const resolvedSourceId = resolveXtreamSourceId(sourceId);
  const playStream = usePlayerStore((state) => state.playStream);
  const [detailsExpanded, setDetailsExpanded] = useState(false);

  const titleId = useId();

  const isFav = useLibraryStore((state) => state.favorites.some((f) => f.id === seriesId));
  const addFavorite = useLibraryStore((state) => state.addFavorite);
  const removeFavorite = useLibraryStore((state) => state.removeFavorite);

  const historyItem = useLibraryStore((state) => state.history.find((h) => h.id === seriesId));
  const watchedIds = useLibraryStore((state) => state.watched);
  const remainingLabel = formatRemaining(historyItem?.currentTime, historyItem?.duration, language);
  const downloadedByLibraryId = useDownloadStore((state) => state.downloadedByLibraryId);

  const [selectedSeason, setSelectedSeason] = useState<string>('');
  const initialEpisodeRef = useRef<HTMLButtonElement>(null);
  const positionedEpisodeRef = useRef(false);

  const { data, isLoading, error, isFetching, refetch } = useSeriesInfo(providerSeriesId, sourceId);
  const imdb = useImdbFacts('series', seriesId);
  const tmdb = useTmdbDetailEnrichment('tv', {
    ...tmdbLookupFor(data?.info?.name || seriesTitle, data?.info?.releaseDate),
    tmdbId: normalizeTmdbId(data?.info?.tmdb ?? data?.info?.tmdb_id),
    ready: !isLoading,
  });
  const enriched = tmdb.details;

  const toggleFavorite = () => {
    if (isFav) removeFavorite(seriesId);
    else
      addFavorite({
        id: seriesId,
        title: seriesTitle,
        posterUrl: seriesPoster,
        type: 'series',
        sourceItemId: providerSeriesId,
        sourceId: Object.values(data?.episodes ?? {})[0]?.[0]?.source_id || sourceId,
        description: data?.info?.plot,
      });
  };

  const [isRetryingDetails, setIsRetryingDetails] = useState(false);
  const prerequisiteError = !credentials
    ? `No credentials are loaded for Xtream source "${sourceId ?? 'default'}".`
    : !String(providerSeriesId).trim()
      ? 'Series details cannot be loaded because the provider item id is empty.'
      : null;
  const effectiveError = error ?? prerequisiteError;
  const errorPresentation = getErrorPresentation(effectiveError, 'Series details');
  const [retryPresentation, setRetryPresentation] = useState<typeof errorPresentation | null>(null);
  const visibleErrorPresentation = retryPresentation ?? errorPresentation;
  const showErrorState = !data && (!!effectiveError || isRetryingDetails);

  const retryDetails = async () => {
    setRetryPresentation(errorPresentation);
    setIsRetryingDetails(true);
    try {
      await refetch();
    } finally {
      setIsRetryingDetails(false);
      setRetryPresentation(null);
    }
  };

  // A grouped card may represent a variant whose provider call fails; report
  // it once so the caller can fall back to the next variant on its own.
  const reportedFailure = useRef<string | null>(null);
  useEffect(() => {
    if (data || !error || !credentials) {
      reportedFailure.current = null;
      return;
    }
    if (reportedFailure.current !== String(providerSeriesId)) {
      reportedFailure.current = String(providerSeriesId);
      onLoadFailed?.();
    }
  }, [credentials, data, error, onLoadFailed, providerSeriesId]);

  const detailPresentation = buildDetailPresentation({
    enriched,
    providerReleaseDate: data?.info?.releaseDate,
    providerCast: data?.info?.cast,
    providerDirector: data?.info?.director,
    providerGenres: data?.info?.genre,
  });
  const { releaseYear, castList, director, genres } = detailPresentation;
  const parsedTitle = parseMediaDisplayTitle(
    data?.info?.name || seriesTitle,
    Number.isFinite(releaseYear) ? String(releaseYear) : undefined,
  );
  const cleanSeriesTitle = parsedTitle.cleanTitle;
  const displayCountry = parsedTitle.country ? countryName(parsedTitle.country, language) : null;
  const plot = enriched?.overview || data?.info?.plot || t('No description available.');
  const rating = resolveMediaRating(
    tmdb.rating,
    parseProviderRating(data?.info?.rating, data?.info?.rating_5based),
    imdb,
  );
  const hasMoreDetails = plot.length > 280 || castList.length > 3;
  const resumeHint = [historyItem?.episodeTitle, remainingLabel].filter(Boolean).join(' · ');
  // Real (landscape) backdrop art only — cover/seriesPoster are 2:3 posters,
  // and background-size: cover on this ~4:1 strip would crop one down to a
  // near-arbitrary sliver of itself rather than gracefully letterbox it.
  const backdropUrl = enriched?.backdropUrl || data?.info?.backdrop_path?.[0];
  const resumeProgress = Math.min(100, Math.max(0, historyItem?.progressPercentage || 0));

  const seasons = useMemo(() => {
    return data?.episodes
      ? Object.keys(data.episodes).sort((left, right) => Number(left) - Number(right))
      : [];
  }, [data?.episodes]);

  const seasonSelectOptions = useMemo(() => {
    return seasons.map((s) => ({
      value: s,
      label: t('Season {number}', { number: s }),
    }));
  }, [seasons, t]);

  const displayedSeasonCount = enriched?.numberOfSeasons ?? seasons.length;
  const displayedEpisodeCount =
    enriched?.numberOfEpisodes ??
    Object.values(data?.episodes ?? {}).reduce((count, episodes) => count + episodes.length, 0);

  useEffect(() => {
    setSelectedSeason('');
    positionedEpisodeRef.current = false;
  }, [initialEpisodeNumber, initialSeasonNumber, providerSeriesId]);

  useEffect(() => {
    if (data?.episodes) {
      const availableSeasons = Object.keys(data.episodes);
      if (availableSeasons.length > 0 && !selectedSeason) {
        const requestedSeason = initialSeasonNumber?.toString();
        const savedSeasonStr = historyItem?.seasonNum?.toString();
        if (requestedSeason && availableSeasons.includes(requestedSeason)) {
          setSelectedSeason(requestedSeason);
        } else if (savedSeasonStr && availableSeasons.includes(savedSeasonStr)) {
          setSelectedSeason(savedSeasonStr);
        } else {
          setSelectedSeason(
            [...availableSeasons].sort((left, right) => Number(left) - Number(right))[0] ?? '',
          );
        }
      }
    }
  }, [data, selectedSeason, historyItem?.seasonNum, initialSeasonNumber]);

  const currentEpisodes = useMemo(() => {
    return selectedSeason && data?.episodes ? data.episodes[selectedSeason] || [] : [];
  }, [selectedSeason, data?.episodes]);

  // Episode thumbnails only when the provider has real stills: many lists
  // repeat the series cover on every episode, which is just noise.
  const showEpisodeStills = useMemo(() => {
    const stills = new Set(
      currentEpisodes
        .map((episode) => episode.info?.movie_image)
        .filter((image): image is string => Boolean(image) && image !== data?.info?.cover),
    );
    return stills.size > 1 && stills.size * 2 >= currentEpisodes.length;
  }, [currentEpisodes, data?.info?.cover]);
  const availableEpisodeKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const [seasonNumber, episodes] of Object.entries(data?.episodes ?? {})) {
      for (const episode of episodes)
        keys.add(episodeScheduleKey(seasonNumber, episode.episode_num));
    }
    return keys;
  }, [data?.episodes]);

  useEffect(() => {
    if (
      positionedEpisodeRef.current ||
      !initialEpisodeNumber ||
      (initialSeasonNumber && selectedSeason !== String(initialSeasonNumber)) ||
      !initialEpisodeRef.current
    )
      return;
    positionedEpisodeRef.current = true;
    initialEpisodeRef.current.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [currentEpisodes, initialEpisodeNumber, initialSeasonNumber, selectedSeason]);

  const handlePlayEpisode = (
    episode: XtreamEpisode,
    customStartPos?: number,
    seasonOverride = selectedSeason,
  ) => {
    const episodeLibraryId = resolvedSourceId
      ? xtreamItemId(resolvedSourceId, 'episode', episode.id)
      : episode.id.toString();

    let startPosition = customStartPos;
    if (startPosition === undefined) {
      const isSavedEp = historyItem && historyItem.episodeId?.toString() === episode.id.toString();
      startPosition = isSavedEp ? historyItem.currentTime || 0 : 0;
    }

    // A downloaded episode plays straight from disk — instantly, online or
    // offline — skipping the provider stream entirely.
    const downloaded = downloadedByLibraryId[episodeLibraryId];
    if (downloaded) {
      playStream(playableFromDownloadedItem(downloaded, startPosition));
      return;
    }

    const playback = resolveEpisodePlayback(episode, credentials);
    if (!playback) return;

    const parsedEpisode = parseEpisodeTitle(episode.title, {
      seriesTitle: cleanSeriesTitle,
      seasonNum: seasonOverride,
      episodeNum: episode.episode_num,
    });

    playStream({
      id: resolvedSourceId ? xtreamItemId(resolvedSourceId, 'episode', episode.id) : episode.id,
      sourceItemId: episode.id.toString(),
      title: formatEpisodePlaybackTitle(
        cleanSeriesTitle,
        seasonOverride,
        episode.episode_num,
        episode.title,
      ),
      type: 'series',
      ...playback,
      posterUrl: episode.info?.movie_image || seriesPoster,
      seriesPosterUrl: data?.info?.cover || seriesPoster,
      seriesId: seriesId,
      seriesSourceItemId: providerSeriesId,
      seriesTitle: cleanSeriesTitle,
      seasonNum: seasonOverride,
      episodeNum: episode.episode_num,
      episodeTitle: parsedEpisode.cleanTitle,
      startPosition,
      knownDuration: historyItem?.duration,
      tags: mergeMediaTags(...parsedTitle.tags, ...parsedEpisode.tags),
      country: parsedTitle.country ?? parsedEpisode.country,
    });
  };

  const handleDownloadSeason = () => {
    const episodesToDownload: DownloadableMediaItem[] = currentEpisodes.map((episode) => {
      const episodeLibraryId = resolvedSourceId
        ? xtreamItemId(resolvedSourceId, 'episode', episode.id)
        : episode.id.toString();
      const playback = resolveEpisodePlayback(episode, credentials);
      const parsedEpisode = parseEpisodeTitle(episode.title, {
        seriesTitle: cleanSeriesTitle,
        seasonNum: selectedSeason,
        episodeNum: episode.episode_num,
      });
      return {
        id: episodeLibraryId,
        title: formatEpisodePlaybackTitle(
          cleanSeriesTitle,
          selectedSeason,
          episode.episode_num,
          episode.title,
        ),
        type: 'series',
        streamUrl: playback?.streamUrl,
        httpHeaders: playback?.httpHeaders,
        containerExtension: episode.container_extension,
        posterUrl: episode.info?.movie_image || data?.info?.cover || seriesPoster,
        description: episode.info?.plot,
        seriesId,
        seriesSourceItemId: providerSeriesId,
        seriesTitle: cleanSeriesTitle,
        seriesPosterUrl: data?.info?.cover || seriesPoster,
        seasonNum: selectedSeason,
        episodeNum: episode.episode_num,
        episodeTitle: parsedEpisode.cleanTitle,
      };
    });
    downloadSeriesSeason(`Season ${selectedSeason}`, episodesToDownload);
  };

  // The selected season's episodes as the library knows them (watched ids).
  const seasonEpisodeIds = useMemo(
    () =>
      currentEpisodes.map((episode) =>
        resolvedSourceId
          ? xtreamItemId(resolvedSourceId, 'episode', episode.id)
          : episode.id.toString(),
      ),
    [currentEpisodes, resolvedSourceId],
  );
  const seasonWatched =
    seasonEpisodeIds.length > 0 && seasonEpisodeIds.every((id) => watchedIds.includes(id));

  // Keep the library's "started series" list true to the episodes: the Not
  // started filter reads it, and it also repairs shows marked before it existed.
  const setSeriesStarted = useLibraryStore((state) => state.setSeriesStarted);
  useEffect(() => {
    if (!data?.episodes) return;
    const watchedSet = new Set(watchedIds);
    const anyWatched =
      watchedSet.has(seriesId) ||
      Object.values(data.episodes).some((episodes) =>
        episodes.some((episode) =>
          watchedSet.has(
            resolvedSourceId
              ? xtreamItemId(resolvedSourceId, 'episode', episode.id)
              : episode.id.toString(),
          ),
        ),
      );
    setSeriesStarted(seriesId, anyWatched, {
      id: seriesId,
      title: seriesTitle,
      posterUrl: seriesPoster,
      type: 'series',
      sourceId,
      sourceItemId: providerSeriesId,
      seriesSourceItemId: providerSeriesId,
    });
  }, [
    data?.episodes,
    watchedIds,
    resolvedSourceId,
    seriesId,
    seriesTitle,
    seriesPoster,
    sourceId,
    providerSeriesId,
    setSeriesStarted,
  ]);

  const handleToggleSeasonWatched = () => {
    const library = useLibraryStore.getState();
    library.setWatched(seasonEpisodeIds, !seasonWatched);
    if (seasonWatched || !historyItem || !data?.episodes) return;
    // Continue Watching pointed into this season: move it on to the first
    // episode of the next season, or let the show go when this was the last.
    if (historyItem.seasonNum?.toString() !== selectedSeason) return;
    const nextSeason = seasons.find(
      (season) =>
        Number(season) > Number(selectedSeason) && (data.episodes[season]?.length ?? 0) > 0,
    );
    const nextEpisode = nextSeason
      ? [...(data.episodes[nextSeason] ?? [])].sort(
          (left, right) => Number(left.episode_num) - Number(right.episode_num),
        )[0]
      : undefined;
    library.advanceSeriesHistory(
      seriesId,
      nextSeason && nextEpisode
        ? {
            id: nextEpisode.id.toString(),
            seasonNum: nextSeason,
            episodeNum: nextEpisode.episode_num,
            episodeTitle: parseEpisodeTitle(nextEpisode.title, {
              seriesTitle: cleanSeriesTitle,
              seasonNum: nextSeason,
              episodeNum: nextEpisode.episode_num,
            }).cleanTitle,
          }
        : null,
    );
  };

  const handleResumeClick = () => {
    if (!data?.episodes || !historyItem) return;
    const seasonKey = historyItem.seasonNum?.toString() || selectedSeason;
    const eps = data.episodes[seasonKey] || [];
    const targetEp =
      eps.find((episode) => episode.id.toString() === historyItem.episodeId?.toString()) || eps[0];
    if (targetEp) {
      if (seasonKey !== selectedSeason) {
        setSelectedSeason(seasonKey);
      }
      handlePlayEpisode(targetEp, historyItem.currentTime || 0, seasonKey);
    }
  };

  return (
    <DetailsDialogShell
      onClose={onClose}
      labelledBy={data ? titleId : undefined}
      ariaLabel="Series details"
      stateLayout={showErrorState}
    >
      {showErrorState ? (
        <div className={styles.errorColumn}>
          {versions && onSelectVersion && versions.length > 1 && (
            <VersionSwitcher variants={versions} activeId={seriesId} onSelect={onSelectVersion} />
          )}
          <ErrorState
            modal
            title={visibleErrorPresentation.title}
            description={visibleErrorPresentation.description}
            detail={visibleErrorPresentation.detail}
            actionIcon={!error && !credentials ? Settings : undefined}
            actionLabel={error ? 'Try Again' : !credentials ? 'Open Settings' : 'Close'}
            onAction={
              error
                ? () => void retryDetails()
                : !credentials
                  ? () => {
                      onClose();
                      navigate('/settings?section=sources');
                    }
                  : onClose
            }
            isRetrying={isRetryingDetails || isFetching}
          />
        </div>
      ) : isLoading ? (
        <SeriesDetailSkeleton />
      ) : data ? (
        <>
          <div className={`${heroStyles.page} subtle-scrollbar`}>
            <DetailsHero
              titleId={titleId}
              title={cleanSeriesTitle}
              posterUrl={enriched?.posterUrl || data.info?.cover || seriesPoster}
              posterIcon={<Clapperboard size={40} />}
              backdropUrl={backdropUrl}
              facts={[
                Number.isFinite(releaseYear) && (
                  <span key="year" className={heroStyles.fact}>
                    {releaseYear}
                  </span>
                ),
                enriched?.runtimeMinutes && (
                  <span key="runtime" className={heroStyles.fact}>
                    <Clock size={14} />{' '}
                    {language === 'en'
                      ? `${number(enriched.runtimeMinutes)}m`
                      : t('{count} min', { count: number(enriched.runtimeMinutes) })}
                  </span>
                ),
                rating && (
                  <MediaRatingFact
                    key="rating"
                    rating={rating}
                    className={heroStyles.fact}
                    iconClassName={heroStyles.star}
                  />
                ),
                displayedSeasonCount > 0 && (
                  <span key="seasons" className={heroStyles.fact}>
                    {tn('{count} season', '{count} seasons', displayedSeasonCount, {
                      count: number(displayedSeasonCount),
                    })}
                  </span>
                ),
                displayedEpisodeCount > 0 && (
                  <span key="episodes" className={heroStyles.fact}>
                    {tn('{count} episode', '{count} episodes', displayedEpisodeCount, {
                      count: number(displayedEpisodeCount),
                    })}
                  </span>
                ),
                displayCountry && (
                  <span key="country" className={heroStyles.fact}>
                    {displayCountry}
                  </span>
                ),
              ]}
              genres={genres}
              tags={getPrimaryMediaTags(parsedTitle.tags)}
              plot={plot}
              expanded={detailsExpanded}
              onToggleExpanded={
                hasMoreDetails ? () => setDetailsExpanded((expanded) => !expanded) : undefined
              }
              actions={
                <>
                  {historyItem && historyItem.episodeNum ? (
                    <button
                      type="button"
                      className={heroStyles.primaryBtn}
                      onClick={handleResumeClick}
                      data-modal-primary
                    >
                      <Play size={20} fill="currentColor" />
                      <span className={heroStyles.primaryLabel}>
                        <span>
                          {t(historyItem.currentTime ? 'Resume' : 'Play')} S{historyItem.seasonNum}
                          :E
                          {historyItem.episodeNum}
                        </span>
                        {resumeHint && <span className={heroStyles.primaryHint}>{resumeHint}</span>}
                      </span>
                      {resumeProgress > 0 && (
                        <span className={heroStyles.progress} aria-hidden="true">
                          <span
                            className={heroStyles.progressFill}
                            style={{ width: `${resumeProgress}%` }}
                          />
                        </span>
                      )}
                    </button>
                  ) : currentEpisodes.length > 0 ? (
                    <button
                      type="button"
                      className={heroStyles.primaryBtn}
                      onClick={() => {
                        const firstEpisode = currentEpisodes[0];
                        if (firstEpisode) handlePlayEpisode(firstEpisode);
                      }}
                      data-modal-primary
                    >
                      <Play size={20} fill="currentColor" />
                      <span>{t('Start Watching')}</span>
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={`${heroStyles.iconBtn} ${isFav ? heroStyles.iconBtnActive : ''}`}
                    onClick={toggleFavorite}
                    aria-label={t(isFav ? 'Remove from favorites' : 'Add to favorites')}
                    title={t(isFav ? 'In Favorites' : 'Add to Favorites')}
                    aria-pressed={isFav}
                  >
                    <Heart size={18} fill={isFav ? 'currentColor' : 'none'} />
                  </button>
                </>
              }
              versions={
                versions &&
                onSelectVersion && (
                  <VersionSwitcher
                    variants={versions}
                    activeId={seriesId}
                    onSelect={onSelectVersion}
                  />
                )
              }
            />

            <div className={heroStyles.body}>
              {/* Episodes Section */}
              <section className={styles.episodeSection} aria-label={t('Episodes')}>
                <div className={styles.episodeBrowserHeader}>
                  {seasons.length > 0 ? (
                    <Select
                      value={selectedSeason}
                      options={seasonSelectOptions}
                      onChange={setSelectedSeason}
                      width={180}
                    />
                  ) : null}

                  {currentEpisodes.length > 0 && (
                    <div className={styles.seasonActions}>
                      <button
                        type="button"
                        className={styles.downloadSeasonBtn}
                        onClick={handleToggleSeasonWatched}
                        aria-pressed={seasonWatched}
                      >
                        {seasonWatched ? <CircleOff size={14} /> : <CheckCircle2 size={14} />}
                        <span>
                          {t(seasonWatched ? 'Mark season unwatched' : 'Mark season watched')}
                        </span>
                      </button>
                      <button
                        type="button"
                        className={styles.downloadSeasonBtn}
                        onClick={handleDownloadSeason}
                      >
                        <Download size={14} />
                        <span>{t('Download Season')}</span>
                      </button>
                    </div>
                  )}
                </div>

                <div className={`${styles.episodesList} ${styles.episodeRows}`}>
                  {currentEpisodes.map((episode) => {
                    const episodeLibraryId = resolvedSourceId
                      ? xtreamItemId(resolvedSourceId, 'episode', episode.id)
                      : episode.id.toString();
                    const parsedEpisode = parseEpisodeTitle(episode.title, {
                      seriesTitle: cleanSeriesTitle,
                      seasonNum: selectedSeason,
                      episodeNum: episode.episode_num,
                    });
                    const epTitle = formatEpisodePlaybackTitle(
                      cleanSeriesTitle,
                      selectedSeason,
                      episode.episode_num,
                      episode.title,
                    );
                    const episodeItem = {
                      id: episodeLibraryId,
                      sourceItemId: episode.id.toString(),
                      title: epTitle,
                      posterUrl: episode.info?.movie_image || data.info?.cover || seriesPoster,
                      type: 'series' as const,
                      streamUrl: resolveEpisodePlayback(episode, credentials)?.streamUrl || '',
                      httpHeaders: episode.http_headers,
                      sourceId: episode.source_id,
                      description: episode.info?.plot,
                      seriesId,
                      seriesSourceItemId: providerSeriesId,
                      seriesTitle: cleanSeriesTitle,
                      seriesPosterUrl: data.info?.cover || seriesPoster,
                      seasonNum: selectedSeason,
                      episodeNum: episode.episode_num,
                      episodeTitle: parsedEpisode.cleanTitle,
                    };

                    const isSavedEp =
                      historyItem && historyItem.episodeId?.toString() === episode.id.toString();
                    const epProgress = isSavedEp
                      ? Math.min(100, Math.max(0, historyItem.progressPercentage))
                      : 0;
                    const isWatched = watchedIds.includes(episodeLibraryId);
                    const isDownloaded = Boolean(downloadedByLibraryId[episodeLibraryId]);
                    const durationLabel = formatDurationLabel(
                      episode.info?.duration,
                      episode.info?.duration_secs,
                    );
                    const episodeStatus =
                      isSavedEp && epProgress > 0
                        ? remainingLabel
                        : isWatched
                          ? t('Watched')
                          : null;
                    const episodeLabel = [
                      t('Season {season}, episode {episode}', {
                        season: selectedSeason,
                        episode: episode.episode_num,
                      }),
                      parsedEpisode.cleanTitle,
                      durationLabel,
                      episodeStatus,
                    ]
                      .filter(Boolean)
                      .join(', ');
                    const isRequestedEpisode =
                      initialEpisodeNumber === Number(episode.episode_num) &&
                      (!initialSeasonNumber || String(initialSeasonNumber) === selectedSeason);

                    return (
                      <button
                        type="button"
                        key={episode.id}
                        ref={isRequestedEpisode ? initialEpisodeRef : undefined}
                        className={`${styles.episodeRow} ${isSavedEp && epProgress > 0 ? styles.currentEpisodeRow : ''} ${isRequestedEpisode ? styles.requestedEpisodeRow : ''} ${isWatched && !isSavedEp ? styles.watchedEpisodeRow : ''}`}
                        onClick={() => handlePlayEpisode(episode)}
                        onContextMenu={(e) =>
                          handleMediaCardContextMenu(e, episodeItem, {
                            onPlay: () => handlePlayEpisode(episode),
                          })
                        }
                        aria-label={episodeLabel}
                        aria-current={isRequestedEpisode ? 'true' : undefined}
                      >
                        <span className={styles.episodeNumber} aria-hidden="true">
                          <span className={styles.episodeNumberText}>{episode.episode_num}</span>
                          <Play
                            size={16}
                            fill="currentColor"
                            className={styles.episodeNumberPlay}
                          />
                        </span>

                        {showEpisodeStills && (
                          <span className={styles.episodeThumb}>
                            <img
                              src={episode.info?.movie_image || data.info?.cover || seriesPoster}
                              alt=""
                              loading="lazy"
                            />
                          </span>
                        )}

                        <span className={styles.episodeMain}>
                          <span className={styles.episodeTitle}>{parsedEpisode.cleanTitle}</span>
                          {episode.info?.plot && (
                            <span className={styles.episodePlot}>{episode.info.plot}</span>
                          )}
                        </span>

                        <span className={styles.episodeSide}>
                          {isDownloaded && (
                            <span className={styles.episodeDownloaded} title={t('Downloaded')}>
                              <HardDriveDownload size={14} />
                            </span>
                          )}
                          {episodeStatus && (
                            <span
                              className={`${styles.episodeStatus} ${isWatched && !isSavedEp ? styles.watchedStatus : ''}`}
                            >
                              {isWatched && !isSavedEp && <CheckCircle2 size={13} />}
                              {episodeStatus}
                            </span>
                          )}
                          {durationLabel && (
                            <span className={styles.episodeDuration}>{durationLabel}</span>
                          )}
                        </span>

                        {epProgress > 0 && !isWatched && (
                          <span className={styles.episodeProgress} aria-hidden="true">
                            <span
                              className={styles.episodeProgressFill}
                              style={{ width: `${epProgress}%` }}
                            />
                          </span>
                        )}
                      </button>
                    );
                  })}
                  {currentEpisodes.length === 0 && (
                    <div className={styles.emptyEpisodes}>
                      {t('No episodes available for this season.')}
                    </div>
                  )}
                  <SeriesUpcomingEpisodes
                    seriesId={seriesId}
                    availableEpisodeKeys={availableEpisodeKeys}
                    onViewSchedule={() => {
                      onClose();
                      navigate('/upcoming');
                    }}
                  />
                </div>
              </section>

              {/* Director & Cast Credits */}
              {(director || castList.length > 0) && (
                <div className={heroStyles.credits}>
                  {director && (
                    <div className={heroStyles.creditBlock}>
                      <h2 className={heroStyles.sectionTitle}>{t('Director')}</h2>
                      <span className={heroStyles.creditValue}>{director}</span>
                    </div>
                  )}
                  {castList.length > 0 && (
                    <div className={heroStyles.creditBlock}>
                      <h2 className={heroStyles.sectionTitle}>{t('Cast')}</h2>
                      <div className={heroStyles.cast}>
                        {(detailsExpanded ? castList : castList.slice(0, 10)).map((actor, idx) => (
                          <span key={idx} className={heroStyles.castName}>
                            {actor}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </>
      ) : null}
    </DetailsDialogShell>
  );
}
