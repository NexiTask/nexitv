import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import {
  EMPTY_CATALOG_FILTERS,
  type CatalogFilterKind,
  type CatalogFilters,
  type CatalogWatchFilter,
} from '@/modules/settings/public/store/useSettingsStore';
import { useI18n } from '@/shared/i18n/i18n';
import { Select } from '@/shared/ui/Select';
import { CATALOG_GENRES } from '../lib/smartCatalogFilter';
import chipStyles from './GenreFilterBar.module.css';
import styles from './CatalogFilterPanel.module.css';

interface CatalogFilterPanelProps {
  type: CatalogFilterKind;
  filters: CatalogFilters;
  onChange: (filters: CatalogFilters) => void;
}

/** Runtime buckets: films by feature length, series by episode length. */
const RUNTIMES: Record<
  CatalogFilterKind,
  { label: string; min: number | null; max: number | null }[]
> = {
  vod: [
    { label: 'Under 90 min', min: null, max: 89 },
    { label: '90–120 min', min: 90, max: 120 },
    { label: '2–2½ hours', min: 121, max: 150 },
    { label: 'Over 2½ hours', min: 151, max: null },
  ],
  series: [
    { label: 'Under 30 min', min: null, max: 29 },
    { label: '30–60 min', min: 30, max: 60 },
    { label: 'Over 60 min', min: 61, max: null },
  ],
};
const RATINGS = [5, 6, 6.5, 7, 7.5, 8, 8.5];
const VOTES = [1_000, 10_000, 50_000, 100_000, 500_000];
const ADDED = [7, 30, 90, 365];

const ANY = 'any';
const runtimeKey = (min: number | null, max: number | null) => `${min ?? ''}-${max ?? ''}`;

/** Year bound typed by the reader: kept as text until it is a sane year. */
function YearInput({
  value,
  onCommit,
  label,
  placeholder,
}: {
  value: number | null;
  onCommit: (year: number | null) => void;
  label: string;
  placeholder: string;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(value == null ? '' : String(value));
  const [lastValue, setLastValue] = useState(value);
  if (value !== lastValue) {
    setLastValue(value);
    setDraft(value == null ? '' : String(value));
  }
  const commit = () => {
    const year = Number.parseInt(draft, 10);
    const valid = Number.isInteger(year) && year >= 1880 && year <= 2100;
    if (!draft.trim()) onCommit(null);
    else if (valid) onCommit(year);
    else setDraft(value == null ? '' : String(value));
  };
  return (
    <input
      className={`uiField ${styles.yearInput}`}
      inputMode="numeric"
      maxLength={4}
      aria-label={t(label)}
      placeholder={t(placeholder)}
      value={draft}
      onChange={(event) => setDraft(event.target.value.replace(/\D/g, ''))}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit();
      }}
    />
  );
}

/**
 * The Movies/Series filter panel: everything the catalogue index knows about
 * a title. Genres cycle through include → exclude → off.
 */
export function CatalogFilterPanel({ type, filters, onChange }: CatalogFilterPanelProps) {
  const { t, number } = useI18n();
  const set = (patch: Partial<CatalogFilters>) => onChange({ ...filters, ...patch });

  const runtimeOptions = [
    { value: ANY, label: t('Any length') },
    ...RUNTIMES[type].map((bucket) => ({
      value: runtimeKey(bucket.min, bucket.max),
      label: t(bucket.label),
    })),
  ];
  const runtimeValue =
    filters.runtimeMin == null && filters.runtimeMax == null
      ? ANY
      : runtimeKey(filters.runtimeMin, filters.runtimeMax);

  const watchOptions: { value: CatalogWatchFilter; label: string }[] =
    type === 'vod'
      ? [
          { value: 'all', label: t('Watched or not') },
          { value: 'unwatched', label: t('Not watched') },
          { value: 'in-progress', label: t('In progress') },
          { value: 'watched', label: t('Watched') },
        ]
      : [
          { value: 'all', label: t('Started or not') },
          { value: 'unwatched', label: t('Not started') },
          { value: 'in-progress', label: t('In progress') },
        ];

  const cycleGenre = (genre: string) => {
    if (filters.genres.includes(genre)) {
      set({
        genres: filters.genres.filter((g) => g !== genre),
        excludeGenres: [...filters.excludeGenres, genre],
      });
    } else if (filters.excludeGenres.includes(genre)) {
      set({ excludeGenres: filters.excludeGenres.filter((g) => g !== genre) });
    } else {
      set({ genres: [...filters.genres, genre] });
    }
  };

  return (
    <section className={styles.panel} aria-label={t('Filters')}>
      <div className={styles.fields}>
        <div className={styles.field}>
          <span className={styles.label}>{t('Year')}</span>
          <div className={styles.yearRange}>
            <YearInput
              value={filters.yearMin}
              onCommit={(yearMin) => set({ yearMin })}
              label="From year"
              placeholder="From"
            />
            <span className={styles.rangeDash}>–</span>
            <YearInput
              value={filters.yearMax}
              onCommit={(yearMax) => set({ yearMax })}
              label="To year"
              placeholder="To"
            />
          </div>
        </div>

        <div className={styles.field}>
          <span className={styles.label}>{t(type === 'vod' ? 'Runtime' : 'Episode length')}</span>
          <Select
            ariaLabel={t(type === 'vod' ? 'Runtime' : 'Episode length')}
            value={runtimeValue}
            width={170}
            options={runtimeOptions}
            onChange={(value) => {
              const bucket = RUNTIMES[type].find(
                (candidate) => runtimeKey(candidate.min, candidate.max) === value,
              );
              set({ runtimeMin: bucket?.min ?? null, runtimeMax: bucket?.max ?? null });
            }}
          />
        </div>

        <div className={styles.field}>
          <span className={styles.label}>{t('IMDb rating')}</span>
          <Select
            ariaLabel={t('Minimum IMDb rating')}
            value={filters.minRating == null ? ANY : String(filters.minRating)}
            width={120}
            options={[
              { value: ANY, label: t('Any') },
              ...RATINGS.map((rating) => ({
                value: String(rating),
                label: `${number(rating, { minimumFractionDigits: 1 })}+`,
                localize: false,
              })),
            ]}
            onChange={(value) => set({ minRating: value === ANY ? null : Number(value) })}
          />
        </div>

        <div className={styles.field}>
          <span className={styles.label}>{t('IMDb votes')}</span>
          <Select
            ariaLabel={t('Minimum IMDb votes')}
            value={filters.minVotes == null ? ANY : String(filters.minVotes)}
            width={120}
            options={[
              { value: ANY, label: t('Any') },
              ...VOTES.map((votes) => ({
                value: String(votes),
                label: `${number(votes, { notation: 'compact' })}+`,
                localize: false,
              })),
            ]}
            onChange={(value) => set({ minVotes: value === ANY ? null : Number(value) })}
          />
        </div>

        <div className={styles.field}>
          <span className={styles.label}>{t('Added')}</span>
          <Select
            ariaLabel={t('Added within')}
            value={filters.addedWithinDays == null ? ANY : String(filters.addedWithinDays)}
            width={150}
            options={[
              { value: ANY, label: t('Any time') },
              ...ADDED.map((days) => ({
                value: String(days),
                label: t('Last {count} days', { count: number(days) }),
              })),
            ]}
            onChange={(value) => set({ addedWithinDays: value === ANY ? null : Number(value) })}
          />
        </div>

        <div className={styles.field}>
          <span className={styles.label}>{t('Watch state')}</span>
          <Select
            ariaLabel={t('Watch state')}
            value={filters.watch}
            width={150}
            options={watchOptions}
            onChange={(watch) => set({ watch })}
          />
        </div>
      </div>

      <div className={styles.field}>
        <span className={styles.label}>
          {t('Genres')}
          <span className={styles.hint}>{t('Click to include, again to exclude')}</span>
        </span>
        <div className={styles.chips}>
          {CATALOG_GENRES.map((genre) => {
            const included = filters.genres.includes(genre);
            const excluded = filters.excludeGenres.includes(genre);
            return (
              <button
                key={genre}
                type="button"
                className={`${chipStyles.chip} ${styles.genreChip} ${
                  included ? chipStyles.activeChip : ''
                } ${excluded ? styles.excludedChip : ''}`}
                aria-pressed={included ? 'true' : excluded ? 'mixed' : 'false'}
                onClick={() => cycleGenre(genre)}
              >
                {excluded ? '−' : included ? '+' : ''}
                {t(genre)}
              </button>
            );
          })}
        </div>
      </div>

      <div className={styles.footer}>
        <div className={styles.chips}>
          <button
            type="button"
            className={`${chipStyles.chip} ${styles.genreChip} ${
              filters.ultraHdOnly ? chipStyles.activeChip : ''
            }`}
            aria-pressed={filters.ultraHdOnly}
            onClick={() => set({ ultraHdOnly: !filters.ultraHdOnly })}
          >
            {t('4K only')}
          </button>
          <button
            type="button"
            className={`${chipStyles.chip} ${styles.genreChip} ${
              filters.ratedOnly ? chipStyles.activeChip : ''
            }`}
            aria-pressed={filters.ratedOnly}
            onClick={() => set({ ratedOnly: !filters.ratedOnly })}
          >
            {t('IMDb-rated only')}
          </button>
        </div>
        <button
          type="button"
          className={styles.clear}
          onClick={() => onChange(EMPTY_CATALOG_FILTERS)}
        >
          <RotateCcw size={14} />
          {t('Clear filters')}
        </button>
      </div>
    </section>
  );
}
