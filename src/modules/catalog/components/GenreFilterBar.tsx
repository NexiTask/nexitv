import { useMemo } from 'react';
import type { RatingLookups, SmartCatalogItem } from '../lib/smartCatalogFilter';
import { getAvailableGenres, type KnownGenre } from '../lib/smartCatalogFilter';
import { useI18n } from '@/shared/i18n/i18n';
import styles from './GenreFilterBar.module.css';

export interface GenreCounts {
  total: number;
  genres: { genre: KnownGenre; count: number }[];
}

interface GenreFilterBarProps<T extends SmartCatalogItem> {
  /** The titles to count; or `counts`, when they were counted elsewhere. */
  items?: T[] | undefined;
  counts?: GenreCounts | undefined;
  selectedGenre: string | null;
  onSelectGenre: (genre: string | null) => void;
  categoryNameMap?: Map<string, string> | undefined;
  /** TMDB's verdicts, whose genres count for the titles they cover. */
  ratingLookups?: RatingLookups | undefined;
  className?: string | undefined;
}

export function GenreFilterBar<T extends SmartCatalogItem>({
  items,
  counts,
  selectedGenre,
  onSelectGenre,
  categoryNameMap,
  ratingLookups,
  className,
}: GenreFilterBarProps<T>) {
  const { t, number } = useI18n();

  const availableGenres = useMemo(() => {
    return counts?.genres ?? getAvailableGenres(items ?? [], categoryNameMap, ratingLookups);
  }, [counts, items, categoryNameMap, ratingLookups]);
  const total = counts?.total ?? items?.length ?? 0;

  if (availableGenres.length === 0) {
    return null;
  }

  const isAllSelected = selectedGenre === null || selectedGenre === 'All';

  return (
    <div
      className={`${styles.container} ${className || ''}`}
      role="group"
      aria-label={t('Filter by genre')}
    >
      <button
        type="button"
        className={`${styles.chip} ${isAllSelected ? styles.activeChip : ''}`}
        onClick={() => onSelectGenre(null)}
        aria-pressed={isAllSelected}
      >
        <span>{t('All Genres')}</span>
        <span className={styles.chipCount}>{number(total)}</span>
      </button>

      {availableGenres.map(({ genre, count }) => {
        const isSelected = selectedGenre === genre;
        return (
          <button
            key={genre}
            type="button"
            className={`${styles.chip} ${isSelected ? styles.activeChip : ''}`}
            onClick={() => onSelectGenre(isSelected ? null : genre)}
            aria-pressed={isSelected}
          >
            <span>{t(genre)}</span>
            <span className={styles.chipCount}>{number(count)}</span>
          </button>
        );
      })}
    </div>
  );
}
