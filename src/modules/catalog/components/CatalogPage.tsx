import { useMemo, useState, useEffect } from 'react';
import type { LucideIcon } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { VirtualizedGrid } from './VirtualizedGrid';
import type { MediaItem } from '../model/media';
import { CategorySidebar } from './CategorySidebar';
import { GridSkeleton } from '@/shared/ui/Skeleton';
import { CatalogViewToggle } from './CatalogViewToggle';
import { CatalogSortSelect } from './CatalogSortSelect';
import { GenreFilterBar } from './GenreFilterBar';
import filterBarStyles from './GenreFilterBar.module.css';
import { EmptyState } from '@/shared/ui/EmptyState';
import { HeaderSearch } from '@/modules/search/public/components/HeaderSearch';
import { ErrorState } from '@/shared/ui/ErrorState';
import { CatalogPageHeader } from './CatalogPageHeader';
import { useSettingsStore } from '@/modules/settings/public/store/useSettingsStore';
import {
  IMDB_QUALITY_PRESETS,
  type ImdbQualityPreset,
} from '@/modules/settings/public/store/useSettingsStore';
import { Select } from '@/shared/ui/Select';
import { useLibraryStore } from '@/modules/library/public/store/useLibraryStore';
import { useEnabledSources } from '@/modules/sources/public/hooks/useEnabledSources';
import { useVerifiedResolutionMap } from '@/modules/sources/public/store/useStreamVerificationStore';
import { useCatalogCategorySelection } from '../hooks/useCatalogCategorySelection';
import { useCatalogByType, type CatalogItem } from '../data/useCatalog';
import { useTmdbRatingChecks, useTmdbRatingChecksFrom } from '../data/useTmdbRatingChecks';
import { useCategories, useHiddenCategoryIds } from '../data/useCategories';
import {
  useCatalogPageMode,
  useIndexedCatalogPage,
  useIndexedCatalogStats,
  useIndexedRatingHead,
  type IndexedPageParams,
} from '../data/useIndexedCatalog';
import {
  CATALOG_GENRES,
  filterItemsBySmartCategory,
  filterItemsByGenre,
  sortCatalogItems,
  type RatingLookups,
} from '../lib/smartCatalogFilter';
import { categoryGenreMasks, ultraHdOverrides } from '../lib/catalogPageQuery';
import type { GenreCounts } from './GenreFilterBar';
import { getCombinedErrorMessage, getErrorPresentation } from '@/shared/lib/error';
import { useI18n } from '@/shared/i18n/i18n';
import styles from '@/app/shell/AppLayout.module.css';

const NO_ITEMS: CatalogItem[] = [];
const NO_OVERRIDES: Record<string, never> = {};
const NO_LOOKUPS: RatingLookups = new Map();

export interface CatalogPageProps {
  type: 'vod' | 'series' | 'live';
  title: string;
  icon: LucideIcon;
  emptyTitle: string;
  emptyDescription: string;
  noSourceDescription: string;
  onItemClick: (item: MediaItem) => void;
  onViewDetails?: ((item: MediaItem) => void) | undefined;
  isLiveTv?: boolean | undefined;
}

export function CatalogPage({
  type,
  title,
  icon: EmptyIcon,
  emptyTitle,
  emptyDescription,
  noSourceDescription,
  onItemClick,
  onViewDetails,
  isLiveTv = false,
}: CatalogPageProps) {
  const { t, tn, number } = useI18n();
  const sources = useEnabledSources();
  const viewMode = useSettingsStore((state) => state.viewMode);
  const catalogSortModes = useSettingsStore((state) => state.catalogSortModes);
  const setCatalogSort = useSettingsStore((state) => state.setCatalogSort);
  const badgeVisibility = useSettingsStore((state) => state.badgeVisibility);
  const streamFoldingEnabled = useSettingsStore((state) => state.streamFoldingEnabled);
  const catalogImdbQuality = useSettingsStore((state) => state.catalogImdbQuality);
  const setCatalogImdbQuality = useSettingsStore((state) => state.updateSetting);
  const catalogHideAdult = useSettingsStore((state) => state.catalogHideAdult);
  const setCatalogHideAdult = useSettingsStore((state) => state.updateSetting);
  const catalogGroupTitles = useSettingsStore((state) => state.catalogGroupTitles);
  const verifiedResolutions = useVerifiedResolutionMap(badgeVisibility?.verified ?? true);
  const navigate = useNavigate();
  const [activeCategoryId, setActiveCategoryId] = useCatalogCategorySelection(type);
  // Top Rated is a ranking: whatever order the catalogue is set to, the best
  // rating comes first there.
  const isTopRated = activeCategoryId === 'smart:top-rated';
  // Movies and Series come from the catalogue index when it can serve them;
  // otherwise, and for Live TV, from the full catalogue in memory.
  const { mode, fallBack } = useCatalogPageMode(type);
  const isLegacy = mode === 'legacy';
  const isIndexed = mode === 'index';
  const settingsSortMode = catalogSortModes?.[type] ?? 'default';
  // Top Rated ranks on IMDb once the index serves the page — the backend
  // enforces the rule (real votes only), so the TMDB rating checks stay out
  // of it. The legacy full-catalogue path keeps the provider ranking.
  const isImdbRanked = isTopRated && isIndexed && type !== 'live';
  // The index sorts by IMDb; the legacy full-catalogue path cannot, so it
  // keeps the default order there.
  const currentSortMode = isImdbRanked
    ? 'imdb'
    : isTopRated
      ? 'rating'
      : isLegacy && settingsSortMode === 'imdb'
        ? 'default'
        : settingsSortMode;
  const [selectedGenre, setSelectedGenre] = useState<string | null>(null);

  // Reset genre when category changes
  useEffect(() => {
    setSelectedGenre(null);
  }, [activeCategoryId]);

  const {
    data: legacyItems,
    isLoading: isLegacyLoading,
    isError,
    error,
    isFetching,
    refetch,
  } = useCatalogByType(type, { enabled: isLegacy });
  // A cached full catalogue is ignored while the index serves the page.
  const allItems = isLegacy ? (legacyItems ?? NO_ITEMS) : NO_ITEMS;

  const {
    data: categories = [],
    isError: isCategoriesError,
    error: categoriesError,
    isFetching: areCategoriesFetching,
    refetch: refetchCategories,
  } = useCategories(type);

  const hiddenCategoryIds = useHiddenCategoryIds(type);
  const favorites = useLibraryStore((s) => s.favorites);
  const recentChannelIds = useLibraryStore((s) => s.recentChannels);

  const categoryNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const cat of categories) {
      map.set(String(cat.category_id), cat.category_name);
    }
    return map;
  }, [categories]);

  const isRatingRanked = type !== 'live' && currentSortMode === 'rating';

  // The titles a rating ranking is built from, judged on provider data alone.
  // TMDB checks the head of this list; it must not depend on their results,
  // or every answer would reshape the list and start the checks over. The
  // genre is applied inside the checks, which learn the genres as they go.
  const ratingCandidates = useMemo(() => {
    if (!isRatingRanked) return [];
    return filterItemsBySmartCategory(
      allItems,
      activeCategoryId,
      hiddenCategoryIds,
      favorites,
      categories,
      verifiedResolutions,
    );
  }, [
    isRatingRanked,
    allItems,
    activeCategoryId,
    hiddenCategoryIds,
    favorites,
    categories,
    verifiedResolutions,
  ]);
  const mediaType = type === 'series' ? 'tv' : 'movie';
  const legacyLookups = useTmdbRatingChecks(ratingCandidates, mediaType, {
    enabled: isRatingRanked && isLegacy,
    genre: selectedGenre,
    categoryNameMap,
  });

  const ultraHd = useMemo(
    () => (isIndexed ? ultraHdOverrides(verifiedResolutions) : NO_OVERRIDES),
    [isIndexed, verifiedResolutions],
  );
  // The quality view is an index query: the legacy full-catalogue path has no
  // IMDb data to filter by (its control stays disabled until the index serves
  // the page).
  const imdbQuality: ImdbQualityPreset = isIndexed && type !== 'live' ? catalogImdbQuality : 'all';
  const imdbQualityParams = useMemo(() => {
    if (imdbQuality === 'all') return {};
    const preset = IMDB_QUALITY_PRESETS[imdbQuality];
    return { imdbMinRating: preset.minRating, imdbMinVotes: preset.minVotes };
  }, [imdbQuality]);
  const excludeAdult = isIndexed && type !== 'live' && catalogHideAdult;
  // Variant grouping is an index rule too: the legacy full-catalogue path
  // has no IMDb identities to group by.
  const groupTitles = isIndexed && type !== 'live' && catalogGroupTitles;
  const categoryGenres = useMemo(
    () => (isIndexed ? categoryGenreMasks(categories, categoryNameMap) : NO_OVERRIDES),
    [isIndexed, categories, categoryNameMap],
  );
  const baseIndexParams = useMemo<Omit<IndexedPageParams, 'ratingLookups'>>(
    () => ({
      activeCategoryId,
      hiddenCategoryIds,
      favorites,
      categories,
      categoryGenres,
      ultraHd,
      genre: selectedGenre,
      sort: currentSortMode,
      fold: type === 'live' && streamFoldingEnabled,
      recentChannelIds,
      ...imdbQualityParams,
      excludeAdult,
      groupTitles,
    }),
    [
      activeCategoryId,
      hiddenCategoryIds,
      favorites,
      categories,
      categoryGenres,
      ultraHd,
      selectedGenre,
      currentSortMode,
      type,
      streamFoldingEnabled,
      recentChannelIds,
      imdbQualityParams,
      excludeAdult,
      groupTitles,
    ],
  );
  const headParams = useMemo<IndexedPageParams>(
    () => ({ ...baseIndexParams, ratingLookups: NO_LOOKUPS }),
    [baseIndexParams],
  );
  const [indexGeneration, setIndexGeneration] = useState('');
  const indexHead = useIndexedRatingHead(type, headParams, indexGeneration);
  const indexLookups = useTmdbRatingChecksFrom(indexHead, mediaType, {
    enabled: isRatingRanked && isIndexed,
    genre: selectedGenre,
  });
  const ratingLookups = isIndexed ? indexLookups : legacyLookups;

  const indexParams = useMemo<IndexedPageParams>(
    () => ({ ...baseIndexParams, ratingLookups: isRatingRanked ? indexLookups : NO_LOOKUPS }),
    [baseIndexParams, indexLookups, isRatingRanked],
  );
  const indexed = useIndexedCatalogPage(type, indexParams, isIndexed);
  const indexStats = useIndexedCatalogStats(
    type,
    { hiddenCategoryIds, favorites, ultraHd, fold: baseIndexParams.fold, groupTitles },
    isIndexed,
  );
  const pageGeneration = indexed.result?.generation ?? '';
  useEffect(() => {
    if (pageGeneration) setIndexGeneration(pageGeneration);
  }, [pageGeneration]);
  useEffect(() => {
    // An index that cannot answer leaves the page to the full catalogue.
    if (isIndexed && indexed.isError) fallBack();
  }, [fallBack, indexed.isError, isIndexed]);

  const categoryItems = useMemo(() => {
    return filterItemsBySmartCategory(
      allItems,
      activeCategoryId,
      hiddenCategoryIds,
      favorites,
      categories,
      verifiedResolutions,
      ratingLookups,
      recentChannelIds,
    );
  }, [
    recentChannelIds,
    allItems,
    activeCategoryId,
    hiddenCategoryIds,
    favorites,
    categories,
    verifiedResolutions,
    ratingLookups,
  ]);

  const items = useMemo(() => {
    const genreFiltered = filterItemsByGenre(
      categoryItems,
      selectedGenre,
      categoryNameMap,
      ratingLookups,
    );
    return sortCatalogItems(genreFiltered, currentSortMode, ratingLookups);
  }, [categoryItems, selectedGenre, categoryNameMap, currentSortMode, ratingLookups]);

  const indexResult = isIndexed ? indexed.result : undefined;
  const itemCount = indexResult ? indexResult.total : items.length;
  const categoryItemCount = indexResult ? indexResult.categoryTotal : categoryItems.length;
  const indexGenreCounts = useMemo<GenreCounts | undefined>(() => {
    if (!indexResult) return undefined;
    return {
      total: indexResult.categoryTotal,
      genres: CATALOG_GENRES.flatMap((genre, bit) => {
        const count = indexResult.genreCounts[bit] ?? 0;
        return count > 0 ? [{ genre, count }] : [];
      }),
    };
  }, [indexResult]);
  const isLoading = isLegacy
    ? isLegacyLoading
    : mode === 'pending' || indexed.isLoading || (isIndexed && !indexResult);

  const pageError = getCombinedErrorMessage([error, categoriesError], '');
  const errorPresentation = getErrorPresentation(pageError, title);
  const showLoadError =
    ((isLegacy && isError) || isCategoriesError) &&
    (isIndexed ? !indexResult : allItems.length === 0);

  const retryPage = () => {
    const retries = [
      ...(isError ? [refetch()] : []),
      ...(isCategoriesError ? [refetchCategories()] : []),
    ];
    void Promise.all(retries);
  };

  const getCountMeta = () => {
    if (isLoading) {
      if (type === 'vod') return t('Loading movies');
      if (type === 'series') return t('Loading series');
      return t('Loading channels');
    }
    if (type === 'vod') {
      return tn('{count} movie', '{count} movies', itemCount, {
        count: number(itemCount),
      });
    }
    if (type === 'series') {
      return tn('{count} series', '{count} series', itemCount, {
        count: number(itemCount),
      });
    }
    return tn('{count} channel', '{count} channels', itemCount, {
      count: number(itemCount),
    });
  };

  return (
    <div className={`${styles.page} ${styles.catalogLayout}`}>
      <CategorySidebar
        type={type}
        activeCategoryId={activeCategoryId}
        onSelectCategory={setActiveCategoryId}
        indexStats={isLegacy ? undefined : (indexStats ?? null)}
      />

      <div className={styles.catalogMain}>
        <CatalogPageHeader
          title={title}
          meta={getCountMeta()}
          actions={
            <>
              <HeaderSearch onItemClick={onItemClick} />
              {type !== 'live' && (
                <Select
                  value={imdbQuality}
                  onChange={(value) => setCatalogImdbQuality('catalogImdbQuality', value)}
                  disabled={isLegacy}
                  width={175}
                  ariaLabel={t('IMDb quality')}
                  options={[
                    { value: 'all', label: t('Quality: All') },
                    { value: 'imdb-7-1k', label: t('IMDb ≥ 7.0 · 1k+ votes') },
                    { value: 'imdb-65-5k', label: t('IMDb ≥ 6.5 · 5k+ votes') },
                    { value: 'imdb-6-10k', label: t('IMDb ≥ 6.0 · 10k+ votes') },
                  ]}
                />
              )}
              {type !== 'live' && (
                <button
                  type="button"
                  className={`${filterBarStyles.chip} ${
                    catalogHideAdult ? filterBarStyles.activeChip : ''
                  }`}
                  aria-pressed={catalogHideAdult}
                  disabled={isLegacy}
                  onClick={() => setCatalogHideAdult('catalogHideAdult', !catalogHideAdult)}
                >
                  {catalogHideAdult ? t('Adult hidden') : t('Adult shown')}
                </button>
              )}
              <CatalogSortSelect
                value={currentSortMode}
                onChange={(sort) => setCatalogSort(type, sort)}
                isLiveTv={isLiveTv}
                disabled={isTopRated}
              />
              <CatalogViewToggle />
            </>
          }
        />

        {isLoading ? (
          <div className={styles.catalogContent}>
            <GridSkeleton
              viewMode={viewMode}
              count={viewMode === 'list' ? 10 : 18}
              isLiveTv={isLiveTv}
            />
          </div>
        ) : showLoadError ? (
          <ErrorState
            title={errorPresentation.title}
            description={errorPresentation.description}
            detail={errorPresentation.detail}
            actionLabel="Try Again"
            onAction={retryPage}
            isRetrying={(isError && isFetching) || (isCategoriesError && areCategoriesFetching)}
          />
        ) : !sources.isAvailable ? (
          <EmptyState
            icon={EmptyIcon}
            title="No Source Available"
            description={noSourceDescription}
            actionLabel="Manage Sources"
            onAction={() => navigate('/settings?section=sources')}
          />
        ) : itemCount === 0 ? (
          <div className={styles.catalogContent}>
            {type !== 'live' && categoryItemCount > 0 && (
              <GenreFilterBar
                items={indexGenreCounts ? undefined : categoryItems}
                counts={indexGenreCounts}
                selectedGenre={selectedGenre}
                onSelectGenre={setSelectedGenre}
                categoryNameMap={categoryNameMap}
                ratingLookups={ratingLookups}
              />
            )}
            <EmptyState icon={EmptyIcon} title={emptyTitle} description={emptyDescription} />
          </div>
        ) : (
          <div className={styles.catalogContent}>
            {type !== 'live' && (
              <GenreFilterBar
                items={indexGenreCounts ? undefined : categoryItems}
                counts={indexGenreCounts}
                selectedGenre={selectedGenre}
                onSelectGenre={setSelectedGenre}
                categoryNameMap={categoryNameMap}
                ratingLookups={ratingLookups}
              />
            )}
            <VirtualizedGrid
              {...(indexResult
                ? {
                    count: indexResult.total,
                    getItem: indexed.getItem,
                    onRangeChange: indexed.requestRange,
                  }
                : { items })}
              isLiveTv={isLiveTv}
              showTypeInList={false}
              onItemClick={onItemClick}
              onViewDetails={onViewDetails}
            />
          </div>
        )}
      </div>
    </div>
  );
}
