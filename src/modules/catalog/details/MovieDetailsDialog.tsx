import { useEffect, useId, useRef, useState } from 'react';
import { Clock, Download, Film, Heart, Play, RotateCcw, Settings } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { getXtreamCredentials, useAuthStore } from '@/modules/sources/public/store/useAuthStore';
import { getStreamUrl } from '@/modules/sources/public/data/xtreamClient';
import { useVodInfo } from '../data/useDetails';
import { usePlayerStore } from '@/modules/playback/public/store/usePlayerStore';
import { useLibraryStore } from '@/modules/library/public/store/useLibraryStore';
import { formatRemaining } from '@/shared/lib/time';
import { parseMediaDisplayTitle } from '../lib/titleParser';
import { getPrimaryMediaTags } from '@/shared/lib/mediaTags';
import { countryName } from '@/shared/lib/categoryName';
import { MovieDetailSkeleton } from '@/shared/ui/Skeleton';
import { DetailsDialogShell } from '../components/DetailsDialogShell';
import { ErrorState } from '@/shared/ui/ErrorState';
import { getErrorPresentation } from '@/shared/lib/error';
import type { MediaItem } from '../model/media';
import type { TitleVariant } from '../data/useTitleVariants';
import { VersionSwitcher } from './VersionSwitcher';
import { DetailsHero } from './DetailsHero';
import heroStyles from './DetailsHero.module.css';
import { useImdbFacts } from '../data/useImdbFacts';
import styles from './MovieDetailsDialog.module.css';
import { downloadMediaItem } from '@/modules/downloads/public/services/mediaDownload';
import { M3uMovieDetailsDialog } from './M3uMovieDetailsDialog';
import { useI18n } from '@/shared/i18n/i18n';
import { useTmdbDetailEnrichment } from '@/modules/metadata/public/hooks/useTmdbDetailsEnrichment';
import { normalizeTmdbId } from '@/modules/metadata/public/model/tmdb';
import { parseProviderRating, resolveMediaRating } from '@/shared/lib/rating';
import { MediaRatingFact } from '../components/MediaRatingFact';
import { buildDetailPresentation, tmdbLookupFor } from './detailPresentation';

interface MovieDetailsDialogProps {
  movieId: string;
  movieTitle: string;
  moviePoster: string;
  sourceId?: string | undefined;
  sourceItemId?: string | undefined;
  /** The other provider variants behind the grouped card, when grouped. */
  versions?: readonly TitleVariant[] | undefined;
  onSelectVersion?: ((item: MediaItem) => void) | undefined;
  /** Reports that this variant's details failed, so the caller can try the
   * next one without making the reader close and reopen the card. */
  onLoadFailed?: (() => void) | undefined;
  onClose: () => void;
}

export function MovieDetailsDialog(props: MovieDetailsDialogProps) {
  if (props.sourceId?.startsWith('m3u-')) {
    return <M3uMovieDetailsDialog {...props} sourceId={props.sourceId} />;
  }
  return <XtreamMovieDetailsDialog {...props} />;
}

function XtreamMovieDetailsDialog({
  movieId,
  movieTitle,
  moviePoster,
  sourceId,
  sourceItemId,
  versions,
  onSelectVersion,
  onLoadFailed,
  onClose,
}: MovieDetailsDialogProps) {
  const { t, language, number } = useI18n();
  const navigate = useNavigate();
  const credentials = useAuthStore((state) => {
    const resolvedSourceId = sourceId === 'xtream' ? state.profiles[0]?.id : sourceId;
    return resolvedSourceId
      ? (state.runtimes[resolvedSourceId]?.credentials ?? null)
      : getXtreamCredentials();
  });
  const providerMovieId = sourceItemId || movieId;
  const playStream = usePlayerStore((state) => state.playStream);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const titleId = useId();

  const isFav = useLibraryStore((state) => state.favorites.some((f) => f.id === movieId));
  const addFavorite = useLibraryStore((state) => state.addFavorite);
  const removeFavorite = useLibraryStore((state) => state.removeFavorite);

  const { data, isLoading, error, isFetching, refetch } = useVodInfo(providerMovieId, sourceId);
  const imdb = useImdbFacts('vod', movieId);
  const tmdb = useTmdbDetailEnrichment('movie', {
    ...tmdbLookupFor(data?.info.name || movieTitle, data?.info.releaseDate),
    tmdbId: normalizeTmdbId(data?.info.tmdb_id),
    ready: !isLoading,
  });
  const enriched = tmdb.details;
  const toggleFavorite = () => {
    if (isFav) removeFavorite(movieId);
    else
      addFavorite({
        id: movieId,
        title: movieTitle,
        posterUrl: moviePoster,
        type: 'vod',
        sourceItemId: providerMovieId,
        streamUrl: data?.movie_data.direct_stream_url,
        httpHeaders: data?.movie_data.http_headers,
        sourceId: data?.movie_data.source_id,
        containerExtension: data?.movie_data.container_extension,
        description: data?.info.description || data?.info.plot,
      });
  };
  const [isRetryingDetails, setIsRetryingDetails] = useState(false);
  const prerequisiteError = !credentials
    ? `No credentials are loaded for Xtream source "${sourceId ?? 'default'}".`
    : !String(providerMovieId).trim()
      ? 'Movie details cannot be loaded because the provider item id is empty.'
      : null;
  const effectiveError = error ?? prerequisiteError;
  const errorPresentation = getErrorPresentation(effectiveError, 'Movie details');
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
    if (reportedFailure.current !== String(providerMovieId)) {
      reportedFailure.current = String(providerMovieId);
      onLoadFailed?.();
    }
  }, [credentials, data, error, onLoadFailed, providerMovieId]);

  const historyItem = useLibraryStore((state) => state.history.find((h) => h.id === movieId));
  const remainingLabel = formatRemaining(historyItem?.currentTime, historyItem?.duration, language);

  const detailPresentation = buildDetailPresentation({
    enriched,
    providerReleaseDate: data?.info.releaseDate,
    providerCast: data?.info.cast,
    providerDirector: data?.info.director,
    providerGenres: data?.info.genre,
  });
  const { releaseYear, castList, director, genres } = detailPresentation;
  const parsedTitle = parseMediaDisplayTitle(
    data?.info.name || movieTitle,
    Number.isFinite(releaseYear) ? String(releaseYear) : undefined,
  );
  const plot =
    enriched?.overview ||
    data?.info.description ||
    data?.info.plot ||
    t('No description available.');
  const rating = resolveMediaRating(
    tmdb.rating,
    parseProviderRating(data?.info.rating, data?.info.rating_5based),
    imdb,
  );
  const duration = enriched?.runtimeMinutes
    ? t('{count} min', { count: number(enriched.runtimeMinutes) })
    : data?.info.duration;
  const displayCountry = parsedTitle.country ? countryName(parsedTitle.country, language) : null;
  const hasMoreDetails = plot.length > 280 || castList.length > 4;
  const progress = Math.min(100, Math.max(0, historyItem?.progressPercentage || 0));
  // Real (landscape) backdrop art only — movie_image/moviePoster are 2:3
  // posters, and background-size: cover on this ~4:1 strip would crop one
  // down to a near-arbitrary sliver of itself rather than gracefully
  // letterbox it, so those aren't acceptable fallbacks here.
  const backdropUrl = enriched?.backdropUrl || data?.info.backdrop_path?.[0];

  const handlePlay = (startFromBeginning = false) => {
    if (!data) return;
    const streamUrl =
      data.movie_data.direct_stream_url ||
      (credentials
        ? getStreamUrl(
            credentials,
            'vod',
            providerMovieId,
            data.movie_data.container_extension || 'mp4',
          )
        : '');
    if (!streamUrl) return;
    const startPos = startFromBeginning ? 0 : historyItem?.currentTime || 0;
    playStream({
      id: movieId,
      sourceItemId: providerMovieId,
      title: parsedTitle.cleanTitle,
      type: 'vod',
      streamUrl,
      httpHeaders: data.movie_data.http_headers,
      sourceId: data.movie_data.source_id || sourceId,
      posterUrl: data.info.movie_image || moviePoster,
      startPosition: startPos,
      knownDuration: historyItem?.duration,
      tags: parsedTitle.tags,
      country: parsedTitle.country,
    });
  };

  const handleDownload = () => {
    if (!data) return;
    const streamUrl =
      data.movie_data.direct_stream_url ||
      (credentials
        ? getStreamUrl(
            credentials,
            'vod',
            providerMovieId,
            data.movie_data.container_extension || 'mp4',
          )
        : '');
    void downloadMediaItem({
      id: movieId,
      title: parsedTitle.cleanTitle,
      type: 'vod',
      streamUrl,
      httpHeaders: data.movie_data.http_headers,
      containerExtension: data.movie_data.container_extension,
      posterUrl: data.info.movie_image || moviePoster,
      description: data.info.description || data.info.plot,
    });
  };

  return (
    <DetailsDialogShell
      onClose={onClose}
      labelledBy={data ? titleId : undefined}
      ariaLabel="Movie details"
      modalClassName={showErrorState ? undefined : styles.movieModal}
      stateLayout={showErrorState}
    >
      {showErrorState ? (
        <div className={styles.errorColumn}>
          {versions && onSelectVersion && versions.length > 1 && (
            <VersionSwitcher variants={versions} activeId={movieId} onSelect={onSelectVersion} />
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
        <MovieDetailSkeleton />
      ) : data ? (
        <>
          <div className={`${heroStyles.page} subtle-scrollbar`}>
            <DetailsHero
              titleId={titleId}
              title={parsedTitle.cleanTitle}
              posterUrl={enriched?.posterUrl || data.info.movie_image || moviePoster}
              posterIcon={<Film size={40} />}
              backdropUrl={backdropUrl}
              facts={[
                Number.isFinite(releaseYear) && (
                  <span key="year" className={heroStyles.fact}>
                    {releaseYear}
                  </span>
                ),
                duration && (
                  <span key="duration" className={heroStyles.fact}>
                    <Clock size={14} /> {duration}
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
                  {historyItem && historyItem.currentTime ? (
                    <>
                      <button
                        type="button"
                        className={heroStyles.primaryBtn}
                        onClick={() => handlePlay(false)}
                        data-modal-primary
                      >
                        <Play size={20} fill="currentColor" />
                        <span className={heroStyles.primaryLabel}>
                          <span>{t('Resume')}</span>
                          {remainingLabel && (
                            <span className={heroStyles.primaryHint}>{remainingLabel}</span>
                          )}
                        </span>
                        {progress > 0 && (
                          <span className={heroStyles.progress} aria-hidden="true">
                            <span
                              className={heroStyles.progressFill}
                              style={{ width: `${progress}%` }}
                            />
                          </span>
                        )}
                      </button>
                      <button
                        type="button"
                        className={heroStyles.secondaryBtn}
                        onClick={() => handlePlay(true)}
                      >
                        <RotateCcw size={16} />
                        <span>{t('Start Over')}</span>
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className={heroStyles.primaryBtn}
                      onClick={() => handlePlay(false)}
                      data-modal-primary
                    >
                      <Play size={20} fill="currentColor" />
                      <span>{t('Play Movie')}</span>
                    </button>
                  )}
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
                  <button
                    type="button"
                    className={heroStyles.iconBtn}
                    onClick={handleDownload}
                    aria-label={t('Download movie')}
                    title={t('Download movie')}
                  >
                    <Download size={18} />
                  </button>
                </>
              }
              versions={
                versions &&
                onSelectVersion && (
                  <VersionSwitcher
                    variants={versions}
                    activeId={movieId}
                    onSelect={onSelectVersion}
                  />
                )
              }
            />

            {(director || castList.length > 0) && (
              <div className={heroStyles.body}>
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
              </div>
            )}
          </div>
        </>
      ) : null}
    </DetailsDialogShell>
  );
}
