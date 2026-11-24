import { Bookmark } from 'lucide-react';
import { useLibraryStore } from '@/modules/library/public/store/useLibraryStore';
import { useI18n } from '@/shared/i18n/i18n';
import type { MediaItem } from '../model/media';

export function SaveToLibraryButton({
  item,
  className,
  activeClassName,
}: {
  item: MediaItem;
  className?: string | undefined;
  activeClassName?: string | undefined;
}) {
  const { t } = useI18n();
  const isSaved = useLibraryStore((state) =>
    state.savedItems.some((entry) => entry.id === item.id),
  );
  const toggleSavedItem = useLibraryStore((state) => state.toggleSavedItem);
  const isFavorite = useLibraryStore((state) => state.isFavorite(item.id));
  const label = t(
    isFavorite ? 'Move to Saved' : isSaved ? 'Remove from Library' : 'Add to Library',
  );

  return (
    <button
      type="button"
      className={isSaved && activeClassName ? `${className ?? ''} ${activeClassName}` : className}
      onClick={() => toggleSavedItem(item)}
      aria-label={label}
      aria-pressed={isSaved}
      title={label}
    >
      <Bookmark size={18} fill={isSaved ? 'currentColor' : 'none'} />
    </button>
  );
}
