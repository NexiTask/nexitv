import { ListVideo } from 'lucide-react';
import { CatalogPageHeader } from '@/modules/catalog/public/components/CatalogPageHeader';
import { CatalogViewToggle } from '@/modules/catalog/public/components/CatalogViewToggle';
import { VirtualizedGrid } from '@/modules/catalog/public/components/VirtualizedGrid';
import { useWatchNext } from '@/modules/catalog/public/data/useWatchNext';
import { MediaDetailsDialogs } from '@/modules/catalog/public/details/MediaDetailsDialogs';
import { useMediaDetailState } from '@/modules/catalog/public/hooks/useMediaDetailsState';
import { useViewMode } from '@/modules/catalog/public/hooks/useViewMode';
import { HeaderSearch } from '@/modules/search/public/components/HeaderSearch';
import { EmptyState } from '@/shared/ui/EmptyState';
import { ErrorState } from '@/shared/ui/ErrorState';
import { GridSkeleton } from '@/shared/ui/Skeleton';
import { useI18n } from '@/shared/i18n/i18n';
import { historyCardSubtitle } from '@/shared/lib/time';
import styles from '@/app/shell/AppLayout.module.css';
import { useLibraryStore } from '../store/useLibraryStore';

export function WatchNextPage() {
  const { t, tn, number, language } = useI18n();
  const { items, isLoading, error, retry } = useWatchNext();
  const [viewMode] = useViewMode();
  const dismissWatchNext = useLibraryStore((state) => state.dismissWatchNext);
  const { selectedMovie, selectedSeries, handleCloseMovie, handleCloseSeries, handleItemClick } =
    useMediaDetailState({ enableSourceOnOpen: true });

  return (
    <>
      <div className={styles.page}>
        <CatalogPageHeader
          title="Watch Next"
          meta={
            isLoading && !items.length
              ? undefined
              : tn('{count} episode', '{count} episodes', items.length, {
                  count: number(items.length),
                })
          }
          actions={
            <>
              <HeaderSearch onItemClick={handleItemClick} />
              <CatalogViewToggle />
            </>
          }
        />

        {items.length > 0 ? (
          <div className={styles.catalogContent}>
            <VirtualizedGrid
              items={items.map((item) => ({
                ...item,
                subtitle: historyCardSubtitle(item, language),
              }))}
              showTypeInList={false}
              onItemClick={handleItemClick}
              onRemoveItem={(item) => dismissWatchNext(item.id)}
              removeLabel="Remove from Watch Next"
            />
          </div>
        ) : isLoading ? (
          <div
            className={styles.catalogContent}
            role="status"
            aria-label={t('Loading episodes...')}
          >
            <GridSkeleton viewMode={viewMode} />
          </div>
        ) : error ? (
          <ErrorState
            title="Could Not Load Next Episodes"
            description="Check your source connection and try again."
            onAction={retry}
            actionLabel="Try Again"
          />
        ) : (
          <EmptyState
            icon={ListVideo}
            title="No Next Episodes"
            description="Next episodes from series you’ve started will appear here."
          />
        )}
      </div>

      <MediaDetailsDialogs
        selectedMovie={selectedMovie}
        selectedSeries={selectedSeries}
        onCloseMovie={handleCloseMovie}
        onCloseSeries={handleCloseSeries}
      />
    </>
  );
}
