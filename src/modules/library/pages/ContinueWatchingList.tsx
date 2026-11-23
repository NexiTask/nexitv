import { useState } from 'react';
import type { MediaItem } from '@/modules/catalog/public/model/media';
import { VirtualizedGrid } from '@/modules/catalog/public/components/VirtualizedGrid';
import { type HistoryItem, useLibraryStore } from '../store/useLibraryStore';
import { historyCardSubtitle } from '@/shared/lib/time';
import { CatalogViewToggle } from '@/modules/catalog/public/components/CatalogViewToggle';
import { History, Trash2 } from 'lucide-react';
import { EmptyState } from '@/shared/ui/EmptyState';
import { HeaderSearch } from '@/modules/search/public/components/HeaderSearch';
import styles from '@/app/shell/AppLayout.module.css';
import pageStyles from './ContinueWatchingList.module.css';
import { ConfirmDialog } from '@/shared/ui/ConfirmDialog';
import { CatalogPageHeader } from '@/modules/catalog/public/components/CatalogPageHeader';
import { useI18n } from '@/shared/i18n/i18n';

export function ContinueWatchingList({
  items,
  onItemClick,
}: {
  items: HistoryItem[];
  onItemClick: (item: MediaItem) => void;
}) {
  const { t, tn, number, language } = useI18n();
  const clearHistory = useLibraryStore((state) => state.clearHistory);
  const removeFromHistory = useLibraryStore((state) => state.removeFromHistory);

  const [isClearDialogOpen, setIsClearDialogOpen] = useState(false);

  const sortedHistory = [...items].sort((a, b) => b.lastWatchedAt - a.lastWatchedAt);

  return (
    <>
      <CatalogPageHeader
        title="Continue Watching"
        meta={tn('{count} item to resume', '{count} items to resume', sortedHistory.length, {
          count: number(sortedHistory.length),
        })}
        actions={
          <>
            <HeaderSearch onItemClick={onItemClick} />
            {sortedHistory.length > 0 && (
              <button
                type="button"
                onClick={() => setIsClearDialogOpen(true)}
                className={pageStyles.clearButton}
                aria-label={t('Clear all watch history')}
              >
                <Trash2 size={14} />
                <span>{t('Clear History')}</span>
              </button>
            )}
            <CatalogViewToggle />
          </>
        }
      />

      {sortedHistory.length === 0 ? (
        <EmptyState
          icon={History}
          title="No Watch History"
          description="Streams you start watching will automatically show up here so you can pick up right where you left off."
        />
      ) : (
        <div className={styles.catalogContent}>
          <VirtualizedGrid
            items={sortedHistory.map((h) => ({
              ...h,
              progress: h.progressPercentage ? h.progressPercentage / 100 : undefined,
              // Time left rather than a percentage: it answers the question
              // you actually have before pressing play.
              subtitle: historyCardSubtitle(h, language),
            }))}
            showTypeInList={false}
            onItemClick={onItemClick}
            onRemoveItem={(item) => removeFromHistory(item.id)}
            removeLabel="Remove from Continue Watching"
          />
        </div>
      )}

      {isClearDialogOpen && (
        <ConfirmDialog
          title="Clear Watch History?"
          description="This removes every Continue Watching entry. Favorites and collections are not affected."
          confirmLabel="Clear History"
          danger
          onCancel={() => setIsClearDialogOpen(false)}
          onConfirm={() => {
            clearHistory();
            setIsClearDialogOpen(false);
          }}
        />
      )}
    </>
  );
}
