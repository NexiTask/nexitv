import { Play, Heart, Check, Film, Clapperboard, Radio, HardDriveDownload, X } from 'lucide-react';
import styles from './MediaCard.module.css';
import { memo, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { useLibraryStore } from '@/modules/library/public/store/useLibraryStore';
import { useDownloadStore } from '@/modules/downloads/public/store/useDownloadStore';
import { useMediaContextMenus } from '../hooks/useMediaContextMenus';
import { parseLiveChannelTitle, parseMediaDisplayTitle } from '../lib/titleParser';
import {
  filterMediaTagsByVisibility,
  getPrimaryMediaTags,
  getTagColorType,
  mergeMediaTags,
  withVerifiedResolution,
} from '@/shared/lib/mediaTags';
import { countryName, normalizeCountryCode } from '@/shared/lib/categoryName';
import { MediaCardMenu } from './MediaCardMenu';
import { CountryFlag } from '@/shared/ui/CountryFlag';
import { useI18n } from '@/shared/i18n/i18n';
import { useSettingsStore } from '@/modules/settings/public/store/useSettingsStore';
import {
  formatVerifiedResolution,
  useStreamVerificationStore,
} from '@/modules/sources/public/store/useStreamVerificationStore';
import { useLogoAspect } from '../hooks/useLogoAspect';
import { getCachedLogoAspect, type LogoAspect } from '../lib/logoAspectDetector';
import { useTmdbPosterFallback } from '../data/useTmdbPosterFallback';
import { quickPlay } from '../lib/quickPlay';
import { canThumbPoster, posterThumbUrl } from '@/platform/posterThumb';
import { useQueryClient } from '@tanstack/react-query';
import {
  canTimeOutPosterHost,
  isPosterHostDead,
  markPosterHostDead,
  isWeakPoster,
  markPosterHostLive,
  POSTER_LOAD_TIMEOUT_MS,
} from '../lib/posterHosts';
import {
  streamProviderBrand,
  type StreamProviderBrand,
} from '@/modules/sources/public/lib/streamProvider';
import type { MediaItem } from '../model/media';

interface MediaCardProps {
  item: MediaItem;
  onClick?: ((item: MediaItem) => void) | undefined;
  onViewDetails?: ((item: MediaItem) => void) | undefined;
  currentCollectionId?: string | undefined;
  style?: React.CSSProperties | undefined; // For virtualization
  viewMode?: 'grid' | 'list' | undefined;
  isLiveTv?: boolean | undefined;
  /** Show Movie/Series in mixed list contexts such as Favorites and Search. */
  showTypeInList?: boolean | undefined;
  /** A quick X in the card's corner (Continue Watching), with its label. */
  onRemove?: ((item: MediaItem) => void) | undefined;
  removeLabel?: string | undefined;
  /** Context to show over a poster on hover or focus. */
  posterDetails?: { description: ReactNode; action?: ReactNode } | undefined;
}

function formatChannelNumber(value: string | number | undefined): string {
  if (value === undefined || value === null || value === '') return '—';
  const text = String(value).replace(/^#/, '');
  return /^\d+$/.test(text) ? text.padStart(2, '0') : text;
}

function ProviderFallbackLogo({ provider }: { provider: StreamProviderBrand }) {
  if (provider === 'youtube') {
    return (
      <svg
        viewBox="0 0 28 20"
        className={`${styles.providerLogo} ${styles.providerLogoYoutube}`}
        role="img"
        aria-label="YouTube"
      >
        <rect width="28" height="20" rx="5" fill="currentColor" />
        <path d="M11 5.5 19 10l-8 4.5v-9Z" fill="var(--text-on-accent)" />
      </svg>
    );
  }

  return (
    <svg
      viewBox="0 0 24 24"
      className={`${styles.providerLogo} ${styles.providerLogoTwitch}`}
      role="img"
      aria-label="Twitch"
    >
      <path d="M3 1h20v14l-6 6h-5l-4 3v-3H1V5l2-4Z" fill="currentColor" />
      <path
        d="M5 4v14h4v3l4-3h4l3-3V4H5Zm5 4h2v6h-2V8Zm5 0h2v6h-2V8Z"
        fill="var(--text-on-accent)"
      />
    </svg>
  );
}

/** Looks up TMDB's poster for a card whose own cover is missing or broken. Only
 * those cards mount it, so ordinary cards carry no query observer or settings
 * subscriptions. */
function TmdbPosterProbe({
  mediaType,
  lookup,
  onPoster,
}: {
  mediaType: 'movie' | 'tv';
  lookup: { title: string; year?: string | undefined };
  onPoster: (url: string | null) => void;
}) {
  const poster = useTmdbPosterFallback(mediaType, lookup);
  useEffect(() => {
    onPoster(poster);
  }, [poster, onPoster]);
  return null;
}

/** Corrects the aspect of a live channel logo; only live cards mount it. */
function LogoAspectProbe({
  posterUrl,
  channelKey,
  sourceId,
  onAspect,
}: {
  posterUrl: string | undefined;
  channelKey: string;
  sourceId: string | undefined;
  onAspect: (aspect: LogoAspect) => void;
}) {
  const aspect = useLogoAspect(posterUrl, channelKey, sourceId);
  useEffect(() => {
    onAspect(aspect);
  }, [aspect, onAspect]);
  return null;
}

function MediaCardComponent({
  item,
  onClick,
  onViewDetails,
  currentCollectionId,
  style,
  viewMode = 'grid',
  isLiveTv = false,
  showTypeInList = true,
  onRemove,
  removeLabel = 'Remove',
  posterDetails,
}: MediaCardProps) {
  const { t, tn, language, number } = useI18n();
  const { handleMediaCardContextMenu } = useMediaContextMenus();
  const queryClient = useQueryClient();
  const descriptionId = useId();
  const details = viewMode === 'grid' ? posterDetails : undefined;
  const [imgError, setImgError] = useState(() => isPosterHostDead(item.posterUrl));
  const [imgLoaded, setImgLoaded] = useState(false);
  // The hover overlay (play, favourite, menu, badges) is built on first hover or
  // focus. Mounting it on every card made each new grid row cost tens of ms.
  const [hot, setHot] = useState(false);
  // The provider's cover loaded but is no poster: a thumbnail or a landscape
  // screenshot ("stalker_portal/screenshots/..."). TMDB's poster replaces it.
  const [weakPoster, setWeakPoster] = useState(false);
  // Reported by TmdbPosterProbe / LogoAspectProbe, which only the cards that need
  // them mount.
  const [tmdbPoster, setTmdbPoster] = useState<string | null>(null);
  // The backend's thumbnail could not be made (or is not wanted): load the original.
  const [thumbFailed, setThumbFailed] = useState(false);
  const [logoAspect, setLogoAspect] = useState<LogoAspect>(() =>
    item.type === 'live' ? (getCachedLogoAspect(item.posterUrl) ?? 'original') : 'original',
  );

  // Fine-grained primitive selectors prevent card re-renders when unrelated store data changes
  const isFav =
    useLibraryStore((s) => s.favorites.some((f) => f.id === item.id)) || Boolean(item.isFavorite);
  const isW =
    useLibraryStore((s) => (s.watched || []).includes(item.id)) || Boolean(item.isWatched);
  const isDownloaded = useDownloadStore((s) => Boolean(s.downloadedByLibraryId[item.id]));

  // Reset imgError state when virtualized grid item changes
  useEffect(() => {
    setImgError(isPosterHostDead(item.posterUrl));
    setImgLoaded(false);
    setWeakPoster(false);
    setTmdbPoster(null);
    setThumbFailed(false);
  }, [item.id, item.posterUrl]);

  // A provider poster on a host that hangs never errors; give it a deadline
  // (cards mount as they scroll into view, so the clock starts when visible).
  const providerPoster = item.type !== 'live' ? item.posterUrl : undefined;
  useEffect(() => {
    if (!providerPoster || imgError || imgLoaded || !canTimeOutPosterHost(providerPoster)) return;
    const timer = setTimeout(() => {
      if (!canTimeOutPosterHost(providerPoster)) return;
      markPosterHostDead(providerPoster);
      setImgError(true);
    }, POSTER_LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [providerPoster, imgError, imgLoaded]);

  const providerBrand = item.type === 'live' ? streamProviderBrand(item.streamUrl) : null;

  const handleFavoriteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    const { addFavorite, removeFavorite } = useLibraryStore.getState();
    if (isFav) {
      removeFavorite(item.id);
    } else {
      addFavorite(item);
    }
  };

  // Movies and series start straight away (resuming where they were left);
  // anything quick play cannot start opens as before.
  const play = () => {
    if (item.type !== 'vod' && item.type !== 'series') {
      onClick?.(item);
      return;
    }
    void quickPlay(queryClient, item).then((started) => {
      if (!started) onClick?.(item);
    });
  };

  const handlePlayClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    play();
  };

  const renderPlaceholderIcon = () => {
    if (item.type === 'live') {
      return providerBrand ? (
        <ProviderFallbackLogo provider={providerBrand} />
      ) : (
        <Radio size={36} className={styles.placeholderIcon} />
      );
    }
    if (item.type === 'series')
      return <Clapperboard size={36} className={styles.placeholderIcon} />;
    return <Film size={36} className={styles.placeholderIcon} />;
  };

  const isLive = item.type === 'live';
  // Providers dump the same "DE - ", "3D-DE - " clutter in front of movie and
  // series titles as they do live channel names — just dash- instead of
  // pipe-separated. Pulled apart the same way, so it shows as a flag + tag
  const customRules = useSettingsStore((s) => s.customTitleRules);
  const badgeVisibility = useSettingsStore((s) => s.badgeVisibility);
  const verifiedMeta = useStreamVerificationStore((s) => s.verifiedStreams[item.id]);

  const parsedTitle = useMemo(
    () => (isLive ? parseLiveChannelTitle(item.title, customRules) : null),
    [isLive, item.title, customRules],
  );
  const parsedMediaTitle = useMemo(
    () => (!isLive ? parseMediaDisplayTitle(item.title, item.year, customRules) : null),
    [isLive, item.title, item.year, customRules],
  );
  const displayTitle = parsedTitle?.cleanTitle ?? parsedMediaTitle?.cleanTitle ?? item.title;
  const displayYear = parsedMediaTitle?.releaseYear ?? null;

  // A provider copy with no cover, or one whose link no longer loads, shows
  // TMDB's poster instead of a grey card.
  const needsPosterFallback = !isLive && (!item.posterUrl || imgError || weakPoster);
  // A weak cover stays until TMDB has a better one (and stays if it has none).
  const posterSrc =
    weakPoster && tmdbPoster
      ? tmdbPoster
      : !imgError && item.posterUrl
        ? item.posterUrl
        : tmdbPoster;
  const useThumb = !isLive && !thumbFailed && canThumbPoster(posterSrc ?? undefined);
  const showPlaceholder = !posterSrc;
  const verifiedResolutionBadge =
    badgeVisibility?.verified && verifiedMeta
      ? formatVerifiedResolution(verifiedMeta.width, verifiedMeta.height, verifiedMeta.fps)
      : null;
  const providerQualityBadges = mergeMediaTags(
    ...(parsedTitle?.qualityBadges ?? parsedMediaTitle?.tags ?? []),
    ...(item.tags ?? []),
    item.quality,
  );
  const qualityBadges = withVerifiedResolution(providerQualityBadges, verifiedResolutionBadge);
  const filteredBadges = filterMediaTagsByVisibility(qualityBadges, badgeVisibility);
  const visibleQualityBadges = getPrimaryMediaTags(filteredBadges);
  const titleCountry = item.country ?? parsedTitle?.country ?? parsedMediaTitle?.country ?? null;
  const countryCode = normalizeCountryCode(titleCountry)?.toUpperCase() ?? null;
  // Catalog items use `subtitle` for their source name. That is useful for
  // routing and debugging, but it is not viewer-facing card metadata. History
  // items are the exception: their subtitle answers what will resume.
  const isResumeItem =
    item.progress !== undefined || item.seasonNum !== undefined || item.episodeNum !== undefined;
  const cardSubtitle = isResumeItem ? item.subtitle : undefined;
  const cardContext = cardSubtitle || t('Continue watching');
  const showListSecondary = Boolean(
    countryCode ||
    (isLive && parsedTitle?.categoryPrefix) ||
    cardSubtitle ||
    (!isLive && showTypeInList),
  );

  const isLiveTvGrid = isLiveTv && viewMode === 'grid';
  const showPosterFooter = viewMode === 'grid';
  const imdbRating =
    !isLive && item.imdbRating !== undefined && item.imdbRating > 0
      ? number(item.imdbRating, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
      : null;
  const numericRating =
    viewMode === 'list' &&
    item.rating !== undefined &&
    !isNaN(Number(item.rating)) &&
    Number(item.rating) > 0
      ? number(Number(item.rating), { minimumFractionDigits: 1, maximumFractionDigits: 1 })
      : null;

  const channelKey = item.sourceItemId || item.id;
  const logoAspectClass = isLive
    ? logoAspect === '16:9'
      ? styles.posterUnsquish169
      : logoAspect === '4:3'
        ? styles.posterUnsquish43
        : ''
    : '';

  const handleCardKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!onClick || event.target !== event.currentTarget) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onClick(item);
  };

  return (
    <div
      className={`${styles.cardContainer} ${viewMode === 'list' ? styles.listView : ''} ${isLiveTvGrid ? styles.cardContainerLiveTvGrid : ''}`}
      style={style}
      role="group"
      aria-label={onClick ? t('Open {title}', { title: displayTitle }) : displayTitle}
      aria-describedby={details ? descriptionId : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={() => onClick?.(item)}
      onKeyDown={handleCardKeyDown}
      onPointerEnter={hot ? undefined : () => setHot(true)}
      onFocus={hot ? undefined : () => setHot(true)}
      onContextMenu={(e) =>
        handleMediaCardContextMenu(e, item, {
          onPlay: isLive ? (i) => onClick?.(i) : undefined,
          onViewDetails: onViewDetails || ((i) => onClick?.(i)),
          currentCollectionId,
        })
      }
    >
      {needsPosterFallback && !isLive && (
        <TmdbPosterProbe
          mediaType={item.type === 'series' ? 'tv' : 'movie'}
          lookup={{
            title: parsedMediaTitle?.cleanTitle ?? item.title,
            year: parsedMediaTitle?.releaseYear ?? item.year,
          }}
          onPoster={setTmdbPoster}
        />
      )}
      {isLive && (
        <LogoAspectProbe
          posterUrl={item.posterUrl}
          channelKey={channelKey}
          sourceId={item.sourceId}
          onAspect={setLogoAspect}
        />
      )}
      {viewMode === 'list' && isLive && (
        <span className={styles.listChannelNumber}>{formatChannelNumber(item.channelNum)}</span>
      )}

      <div
        className={`${styles.posterWrapper} ${isLive ? styles.posterWrapperLive : ''} ${isLiveTvGrid ? styles.posterWrapperLiveTvGrid : ''}`}
      >
        {!showPlaceholder ? (
          <img
            src={useThumb && posterSrc ? posterThumbUrl(posterSrc) : posterSrc}
            alt={displayTitle}
            className={`${styles.poster} ${isLive ? styles.posterLive : ''} ${logoAspectClass}`}
            loading="lazy"
            decoding="async"
            onLoad={(event) => {
              setImgLoaded(true);
              // posterSrc is the provider URL even when a thumbnail was shown.
              if (posterSrc) markPosterHostLive(posterSrc);
              const image = event.currentTarget;
              if (!isLive && posterSrc === item.posterUrl && isWeakPoster(image)) {
                setWeakPoster(true);
              }
            }}
            onError={() => (useThumb ? setThumbFailed(true) : setImgError(true))}
          />
        ) : (
          <div className={styles.placeholder}>
            {renderPlaceholderIcon()}
            {!isLive && <span className={styles.placeholderTitle}>{displayTitle}</span>}
          </div>
        )}

        {viewMode !== 'list' && isLive && item.channelNum !== undefined && (
          <div className={styles.channelBadge}>{item.channelNum}</div>
        )}

        {viewMode !== 'list' && visibleQualityBadges.length > 0 && (
          <div className={styles.posterBadgesRight}>
            {visibleQualityBadges.map((badge) => (
              <span
                key={badge}
                className={styles.posterBadgeRight}
                data-tag-type={getTagColorType(badge)}
              >
                {badge}
              </span>
            ))}
          </div>
        )}

        {isW && viewMode !== 'list' && (
          <div
            className={`${styles.watchedBadge} ${isLive && item.channelNum !== undefined ? styles.watchedBadgeBelowChannel : ''}`}
            title={t('Watched')}
          >
            <Check size={14} />
          </div>
        )}

        {isDownloaded && viewMode !== 'list' && (
          <div
            className={`${styles.downloadedBadge} ${isW ? styles.downloadedBadgeNextToWatched : ''}`}
            title={t('Downloaded')}
          >
            <HardDriveDownload size={13} />
          </div>
        )}

        {showPosterFooter && (
          <div className={styles.posterFooter}>
            <div className={styles.posterTitleRow}>
              <h3 className={styles.posterTitle} title={displayTitle}>
                {displayTitle}
              </h3>
            </div>

            {isResumeItem && !isLive ? (
              <div className={styles.posterMeta}>
                <span className={styles.posterContext}>{cardContext}</span>
              </div>
            ) : (
              imdbRating && (
                <div
                  className={styles.posterMeta}
                  title={tn(
                    'IMDb rating {rating} out of 10 from {count} vote',
                    'IMDb rating {rating} out of 10 from {count} votes',
                    item.imdbVotes ?? 0,
                    { rating: imdbRating, count: number(item.imdbVotes ?? 0) },
                  )}
                >
                  <span className={styles.imdbBadge}>IMDb</span>
                  <span className={styles.imdbRating}>{imdbRating}</span>
                  {item.imdbVotes ? (
                    <span className={styles.imdbVotes}>
                      {number(item.imdbVotes, { notation: 'compact' })}
                    </span>
                  ) : null}
                </div>
              )
            )}
          </div>
        )}

        {details && (
          <div className={`${styles.overlay} ${styles.posterDetails}`}>
            <div id={descriptionId} className={styles.posterDescription}>
              {details.description}
            </div>
            {hot && details.action}
          </div>
        )}

        {viewMode !== 'list' && !details && (
          <div className={styles.overlay}>
            {hot && (
              <>
                <button
                  type="button"
                  className={styles.actionBtn}
                  onClick={handlePlayClick}
                  title={t('Play Content')}
                  aria-label={t('Play {title}', { title: displayTitle })}
                >
                  <Play size={20} fill="currentColor" />
                </button>

                <div className={styles.topActions}>
                  {onRemove && (
                    <button
                      type="button"
                      className={`${styles.iconBtn} ${styles.removeBtn}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onRemove(item);
                      }}
                      title={t(removeLabel)}
                      aria-label={t(removeLabel)}
                    >
                      <X size={16} />
                    </button>
                  )}
                  <button
                    type="button"
                    className={styles.iconBtn}
                    onClick={handleFavoriteClick}
                    title={t(isFav ? 'Remove from Favorites' : 'Add to Favorites')}
                    aria-label={t(isFav ? 'Remove from Favorites' : 'Add to Favorites')}
                  >
                    <Heart
                      size={16}
                      fill={isFav ? 'var(--color-favorite)' : 'transparent'}
                      color={isFav ? 'var(--color-favorite)' : 'currentColor'}
                    />
                  </button>

                  <MediaCardMenu
                    item={item}
                    currentCollectionId={currentCollectionId}
                    onPlay={play}
                    onViewDetails={() => (onViewDetails ? onViewDetails(item) : onClick?.(item))}
                  />
                </div>

                <div className={styles.overlayMeta}>
                  {visibleQualityBadges.length > 0 && (
                    <div className={styles.overlayBadges}>
                      {visibleQualityBadges.map((badge) => (
                        <span
                          key={badge}
                          className={styles.overlayBadge}
                          data-tag-type={getTagColorType(badge)}
                        >
                          {badge}
                        </span>
                      ))}
                    </div>
                  )}
                  {item.progress !== undefined && item.progress > 0 && (
                    <span className={styles.overlayProgressText}>
                      {t('{percent}% watched', {
                        percent: number(Math.round(item.progress * 100)),
                      })}
                    </span>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {viewMode !== 'list' && item.progress !== undefined && item.progress > 0 && (
          <div className={styles.progressBar}>
            <div className={styles.progressFill} style={{ width: `${item.progress * 100}%` }} />
          </div>
        )}
      </div>

      {viewMode === 'list' && (
        <div className={styles.listContent}>
          <div className={styles.listCopy}>
            <div className={styles.listTitleRow}>
              <h3 className={styles.listTitle} title={displayTitle}>
                {displayTitle}
              </h3>
              {displayYear && <span className={styles.listYear}>{displayYear}</span>}
            </div>

            {showListSecondary && (
              <div className={styles.listSecondary}>
                {countryCode ? (
                  <span
                    className={`${styles.listSecondaryItem} ${styles.countryMeta}`}
                    aria-label={countryName(titleCountry, language)}
                    title={countryName(titleCountry, language)}
                  >
                    <CountryFlag code={countryCode} className={styles.countryFlag} />
                    <span className={styles.countryName}>
                      {countryName(titleCountry, language)}
                    </span>
                  </span>
                ) : isLive && parsedTitle?.categoryPrefix ? (
                  <span className={`${styles.listSecondaryItem} ${styles.categoryPrefix}`}>
                    {parsedTitle.categoryPrefix}
                  </span>
                ) : null}

                {cardSubtitle ? (
                  <span className={styles.listSecondaryItem}>{cardSubtitle}</span>
                ) : isLive || !showTypeInList ? null : (
                  <>
                    <span className={styles.listSecondaryItem}>
                      {t(item.type === 'series' ? 'Series' : 'Movie')}
                    </span>
                    {imdbRating ? (
                      <span className={styles.listSecondaryItem}>IMDb {imdbRating}</span>
                    ) : (
                      numericRating && (
                        <span className={styles.listSecondaryItem}>
                          {t('Rating {rating}', { rating: numericRating })}
                        </span>
                      )
                    )}
                  </>
                )}
              </div>
            )}

            {item.progress !== undefined && item.progress > 0 && (
              <div className={styles.listProgress}>
                <div className={styles.progressFill} style={{ width: `${item.progress * 100}%` }} />
              </div>
            )}
          </div>

          <div className={styles.listTrailing}>
            {visibleQualityBadges.length > 0 && (
              <div className={styles.badgeRow}>
                {visibleQualityBadges.map((badge) => (
                  <span
                    key={badge}
                    className={styles.badgeQualityInline}
                    data-tag-type={getTagColorType(badge)}
                  >
                    {badge}
                  </span>
                ))}
              </div>
            )}

            {isW && (
              <span className={styles.listWatched} title={t('Watched')}>
                <Check size={14} />
              </span>
            )}

            {isDownloaded && (
              <span className={styles.listDownloaded} title={t('Downloaded')}>
                <HardDriveDownload size={14} />
              </span>
            )}

            <div className={styles.listActions}>
              <button
                type="button"
                className={styles.listPlayBtn}
                onClick={handlePlayClick}
                aria-label={t('Play {title}', { title: displayTitle })}
              >
                <Play size={15} fill="currentColor" />
              </button>
              <MediaCardMenu
                item={item}
                currentCollectionId={currentCollectionId}
                onPlay={play}
                onViewDetails={() => (onViewDetails ? onViewDetails(item) : onClick?.(item))}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Memoize to prevent unnecessary rerenders in virtualized grids
export const MediaCard = memo(MediaCardComponent);
