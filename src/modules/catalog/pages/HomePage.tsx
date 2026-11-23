import { perfLog, perfSync } from '@/platform/perf';
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { PageTransition } from '@/app/shell/PageTransition';
import { HorizontalCarousel } from '@/modules/catalog/components/HorizontalCarousel';
import { isQueuedEpisode, useLibraryStore } from '@/modules/library/public/store/useLibraryStore';
import {
  useSettingsStore,
  type HomeSectionId,
} from '@/modules/settings/public/store/useSettingsStore';
import { historyCardSubtitle } from '@/shared/lib/time';
import type { MediaItem } from '../model/media';
import { MediaDetailsDialogs } from '../details/MediaDetailsDialogs';
import { useMediaDetailState } from '../hooks/useMediaDetailsState';
import { CarouselSkeleton } from '@/shared/ui/Skeleton';
import { Tv } from 'lucide-react';
import { useWatchNext } from '../data/useWatchNext';
import { EmptyState } from '@/shared/ui/EmptyState';
import { useNavigate } from 'react-router-dom';
import { HeaderSearch } from '@/modules/search/public/components/HeaderSearch';
import styles from '@/app/shell/AppLayout.module.css';
import { useVisibleCatalog } from '../data/useCategories';
import { useIndexPool } from '../data/useHomeRows';
import { selectFoldedLiveCatalog, type CatalogItem } from '../data/useCatalog';
import { useTmdbRatingChecks } from '../data/useTmdbRatingChecks';
import { sortCatalogItems } from '../lib/smartCatalogFilter';
import { ErrorState } from '@/shared/ui/ErrorState';
import { getCombinedErrorMessage, getErrorPresentation } from '@/shared/lib/error';
import { useEnabledSources } from '@/modules/sources/public/hooks/useEnabledSources';
import { useI18n } from '@/shared/i18n/i18n';
import { UpcomingReleaseCard } from '@/modules/guide/public/components/UpcomingReleaseCard';

const RECENT_POOL = 400;
const POPULAR_POOL = 1000;
const LIVE_POOL = 400;
const NO_ITEMS: CatalogItem[] = [];

function newestFirst(items: CatalogItem[]): CatalogItem[] {
  return [...items]
    .sort((a, b) => Number.parseInt(b.added || '0', 10) - Number.parseInt(a.added || '0', 10))
    .slice(0, 20);
}

export function HomePage() {
  const { t, language } = useI18n();
  const sources = useEnabledSources();
  const history = useLibraryStore((state) => state.history);
  const removeFromHistoryById = useLibraryStore((state) => state.removeFromHistory);
  const removeFromHistory = useCallback(
    (item: MediaItem) => removeFromHistoryById(item.id),
    [removeFromHistoryById],
  );
  const upcomingEnabled = useSettingsStore((state) => state.upcomingEnabled);
  const upcomingHomeEnabled = useSettingsStore((state) => state.upcomingHomeEnabled);
  const homeSections = useSettingsStore((state) => state.homeSections);
  const navigate = useNavigate();
  const hasSource = sources.isAvailable;
  const showUpcomingOnHome = upcomingEnabled && upcomingHomeEnabled;

  const { selectedMovie, selectedSeries, handleCloseMovie, handleCloseSeries, handleItemClick } =
    useMediaDetailState();

  const { items: watchNext } = useWatchNext();
  const dismissWatchNextById = useLibraryStore((state) => state.dismissWatchNext);
  const watchNextItems = useMemo(
    () =>
      watchNext.slice(0, 20).map((h) => ({
        ...h,
        progress: undefined,
        subtitle: historyCardSubtitle(h, language),
      })),
    [watchNext, language],
  );
  // Dismissed until the provider lists more episodes of that show.
  const dismissWatchNext = useCallback(
    (item: MediaItem) => dismissWatchNextById(item.id),
    [dismissWatchNextById],
  );

  const continueWatchingItems = useMemo(() => {
    if (!history || history.length === 0) return [];
    return history
      .filter((item) => !isQueuedEpisode(item))
      .sort((a, b) => b.lastWatchedAt - a.lastWatchedAt)
      .slice(0, 20)
      .map((h) => ({
        ...h,
        progress: h.progressPercentage ? h.progressPercentage / 100 : undefined,
        subtitle: historyCardSubtitle(h, language),
      }));
  }, [history, language]);

  // Home rows come from small candidate pools served by the catalogue index,
  // ranked below with the same rules as the full catalogue. Hidden categories
  // are left out by the index. Without an index (first start before anything
  // is saved, or outside the desktop app) Home loads the full catalogue.
  const recentMoviePool = useIndexPool('vod', 'added', RECENT_POOL);
  const popularMoviePool = useIndexPool('vod', 'rating', POPULAR_POOL);
  const recentSeriesPool = useIndexPool('series', 'added', RECENT_POOL);
  const popularSeriesPool = useIndexPool('series', 'rating', POPULAR_POOL);
  const livePool = useIndexPool('live', 'provider', LIVE_POOL);
  const pools = [recentMoviePool, popularMoviePool, recentSeriesPool, popularSeriesPool, livePool];
  const poolsSettled = pools.every((pool) => pool.settled);
  const useFullCatalog = poolsSettled && pools.some((pool) => pool.items === null);
  const streamFoldingEnabled = useSettingsStore((state) => state.streamFoldingEnabled);

  const moviesQuery = useVisibleCatalog('vod', { enabled: useFullCatalog });
  const seriesQuery = useVisibleCatalog('series', { enabled: useFullCatalog });
  const liveQuery = useVisibleCatalog('live', { enabled: useFullCatalog });
  const movies = useFullCatalog ? moviesQuery.data : NO_ITEMS;
  const series = useFullCatalog ? seriesQuery.data : NO_ITEMS;

  const recentMovies = useMemo(
    () => newestFirst(useFullCatalog ? movies : (recentMoviePool.items ?? NO_ITEMS)),
    [useFullCatalog, movies, recentMoviePool.items],
  );
  const recentSeries = useMemo(
    () => newestFirst(useFullCatalog ? series : (recentSeriesPool.items ?? NO_ITEMS)),
    [useFullCatalog, series, recentSeriesPool.items],
  );

  const movieRatingPool = useFullCatalog ? movies : (popularMoviePool.items ?? NO_ITEMS);
  const seriesRatingPool = useFullCatalog ? series : (popularSeriesPool.items ?? NO_ITEMS);
  const movieRatingChecks = useTmdbRatingChecks(movieRatingPool, 'movie');
  const seriesRatingChecks = useTmdbRatingChecks(seriesRatingPool, 'tv');

  const popularMovies = useMemo(() => {
    return perfSync('home:popular_sort:vod', () =>
      sortCatalogItems(movieRatingPool, 'rating', movieRatingChecks).slice(0, 20),
    );
  }, [movieRatingPool, movieRatingChecks]);

  const popularSeries = useMemo(() => {
    return sortCatalogItems(seriesRatingPool, 'rating', seriesRatingChecks).slice(0, 20);
  }, [seriesRatingPool, seriesRatingChecks]);

  const liveChannels = useMemo(() => {
    if (useFullCatalog) return liveQuery.data.slice(0, 20);
    const pool = livePool.items ?? NO_ITEMS;
    return (streamFoldingEnabled ? selectFoldedLiveCatalog(pool) : pool).slice(0, 20);
  }, [useFullCatalog, liveQuery.data, livePool.items, streamFoldingEnabled]);

  const isLoading = useFullCatalog
    ? moviesQuery.isLoading || seriesQuery.isLoading || liveQuery.isLoading
    : !poolsSettled;
  const firstRowsLogged = useRef(false);
  useEffect(() => {
    if (firstRowsLogged.current || isLoading || !(recentMovies.length || recentSeries.length))
      return;
    firstRowsLogged.current = true;
    perfLog(
      'home:rows_rendered',
      undefined,
      `index=${!useFullCatalog} movies=${recentMovies.length} series=${recentSeries.length} live=${liveChannels.length}`,
    );
  }, [isLoading, recentMovies.length, recentSeries.length, liveChannels.length, useFullCatalog]);
  const fullQueries = useFullCatalog ? [moviesQuery, seriesQuery, liveQuery] : [];
  const catalogError = getCombinedErrorMessage(
    fullQueries.map((query) => query.error),
    '',
  );
  const hasCatalogData =
    recentMovies.length > 0 ||
    recentSeries.length > 0 ||
    popularMovies.length > 0 ||
    liveChannels.length > 0;
  const showLoadError = Boolean(catalogError) && !hasCatalogData;
  const errorPresentation = getErrorPresentation(catalogError, 'Home');
  const failedCatalogQueries = fullQueries.filter((query) => query.isError);
  const isRetrying = failedCatalogQueries.some((query) => query.isFetching);
  const retryCatalogs = () => {
    void Promise.all(failedCatalogQueries.map((query) => query.refetch()));
  };

  // Sections beyond Continue Watching and Coming Up always render once
  // enabled — they never had an item-count gate before this became
  // reorderable/toggleable, and users who bother to disable a row expect it
  // to actually be gone, not conditionally back the moment it has content.
  const sectionVisible: Record<HomeSectionId, boolean> = {
    upcoming: showUpcomingOnHome,
    continueWatching: continueWatchingItems.length > 0,
    watchNext: watchNextItems.length > 0,
    recentMovies: true,
    recentSeries: true,
    popularMovies: true,
    popularSeries: true,
    liveChannels: true,
  };
  const activeSectionIds = homeSections
    .filter((section) => section.enabled && sectionVisible[section.id])
    .map((section) => section.id);

  const renderSection = (id: HomeSectionId, loading: boolean): ReactNode => {
    switch (id) {
      case 'upcoming':
        return (
          <UpcomingReleaseCard
            key={id}
            onOpen={handleItemClick}
            onViewAll={() => navigate('/upcoming')}
            showEmpty
          />
        );
      case 'continueWatching':
        return loading ? (
          <CarouselSkeleton key={id} title="Continue Watching" />
        ) : (
          <HorizontalCarousel
            key={id}
            title="Continue Watching"
            items={continueWatchingItems}
            onItemClick={handleItemClick}
            onSeeAll={() => navigate('/continue')}
            onRemoveItem={removeFromHistory}
            removeLabel="Remove from Continue Watching"
          />
        );
      case 'watchNext':
        return loading ? (
          <CarouselSkeleton key={id} title="Watch Next" />
        ) : (
          <HorizontalCarousel
            key={id}
            title="Watch Next"
            items={watchNextItems}
            onItemClick={handleItemClick}
            onSeeAll={() => navigate('/watch-next')}
            onRemoveItem={dismissWatchNext}
            removeLabel="Remove from Watch Next"
          />
        );
      case 'recentMovies':
        return loading ? (
          <CarouselSkeleton key={id} title="Recently Added Movies" />
        ) : (
          <HorizontalCarousel
            key={id}
            title="Recently Added Movies"
            items={recentMovies}
            onItemClick={handleItemClick}
            onSeeAll={() => navigate('/movies')}
          />
        );
      case 'recentSeries':
        return loading ? (
          <CarouselSkeleton key={id} title="Recently Added Series" />
        ) : (
          <HorizontalCarousel
            key={id}
            title="Recently Added Series"
            items={recentSeries}
            onItemClick={handleItemClick}
            onSeeAll={() => navigate('/series')}
          />
        );
      case 'popularMovies':
        return loading ? (
          <CarouselSkeleton key={id} title="Popular Movies" />
        ) : (
          <HorizontalCarousel
            key={id}
            title="Popular Movies"
            items={popularMovies}
            onItemClick={handleItemClick}
            onSeeAll={() => navigate('/movies')}
          />
        );
      case 'popularSeries':
        return loading ? (
          <CarouselSkeleton key={id} title="Popular Series" />
        ) : (
          <HorizontalCarousel
            key={id}
            title="Popular Series"
            items={popularSeries}
            onItemClick={handleItemClick}
            onSeeAll={() => navigate('/series')}
          />
        );
      case 'liveChannels':
        return loading ? (
          <CarouselSkeleton key={id} title="Live TV Channels" isLiveTv />
        ) : (
          <HorizontalCarousel
            key={id}
            title="Live TV Channels"
            items={liveChannels}
            onItemClick={handleItemClick}
            onSeeAll={() => navigate('/live')}
            isLiveTv
          />
        );
      default:
        return null;
    }
  };

  return (
    <PageTransition>
      <div className={styles.page}>
        <div className={`${styles.pageHeader} ${styles.homeHeader}`}>
          <div className={styles.homeTitleGroup}>
            <h1 className={styles.pageTitle}>{t('Home')}</h1>
            <p className={styles.pageSubtitle}>
              {t("Pick up where you left off and discover what's new")}
            </p>
          </div>
          <div className={styles.homeSearch}>
            <HeaderSearch onItemClick={handleItemClick} placeholder="Search your library" />
          </div>
        </div>

        {!hasSource ? (
          <EmptyState
            icon={Tv}
            title="No Source Available"
            description="Connect an Xtream account or add an M3U playlist to fill Home with available media."
            actionLabel="Manage Sources"
            onAction={() => navigate('/settings?section=sources')}
          />
        ) : isLoading ? (
          <div className={`${styles.homeScrollContainer} subtle-scrollbar`}>
            {activeSectionIds.map((id) => renderSection(id, true))}
          </div>
        ) : showLoadError ? (
          <ErrorState
            title={errorPresentation.title}
            description={errorPresentation.description}
            detail={errorPresentation.detail}
            actionLabel="Try Again"
            onAction={retryCatalogs}
            isRetrying={isRetrying}
          />
        ) : (
          <div className={`${styles.homeScrollContainer} subtle-scrollbar`}>
            {activeSectionIds.map((id) => renderSection(id, false))}
          </div>
        )}
      </div>

      <MediaDetailsDialogs
        selectedMovie={selectedMovie}
        selectedSeries={selectedSeries}
        onCloseMovie={handleCloseMovie}
        onCloseSeries={handleCloseSeries}
      />
    </PageTransition>
  );
}
