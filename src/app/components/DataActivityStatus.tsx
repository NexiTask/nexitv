import { useEffect, useState } from 'react';
import { Check, CircleAlert, LoaderCircle } from 'lucide-react';
import { useI18n } from '@/shared/i18n/i18n';
import { useDataActivities, type DataActivity } from '@/shared/lib/dataActivity';
import styles from './DataActivityStatus.module.css';

const ACTIVITIES = ['catalog', 'index', 'playlist', 'guide'] as const;
const SHOW_DELAY_MS = 400;

function ActivityRow({
  label,
  compact,
  percent,
  state = 'working',
}: {
  label: string;
  compact: boolean;
  percent?: number | undefined;
  state?: 'working' | 'complete' | 'error';
}) {
  const { number } = useI18n();
  const Icon = state === 'working' ? LoaderCircle : state === 'complete' ? Check : CircleAlert;
  const value = percent === undefined ? undefined : number(percent / 100, { style: 'percent' });

  return (
    <div
      className={styles.row}
      title={compact ? [label, value].filter(Boolean).join(' ') : undefined}
    >
      <Icon size={16} aria-hidden="true" className={styles.icon} data-state={state} />
      <div className={styles.details}>
        <div className={styles.heading}>
          <span className={styles.label}>{label}</span>
          {value !== undefined && <span className={styles.value}>{value}</span>}
        </div>
        {percent !== undefined && (
          <div
            className={styles.track}
            role="progressbar"
            aria-label={label}
            aria-valuenow={percent}
          >
            <span className={styles.fill} style={{ transform: `scaleX(${percent / 100})` }} />
          </div>
        )}
      </div>
    </div>
  );
}

function ActivityLabels({
  active,
  compact,
  progress,
}: {
  active: (typeof ACTIVITIES)[number][];
  compact: boolean;
  progress: ReadonlyMap<DataActivity, number>;
}) {
  const { t } = useI18n();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(true), SHOW_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);

  if (!visible) return null;

  const labels = {
    catalog: t('Loading the provider catalog…'),
    index: progress.has('index') ? t('Indexing titles…') : t('Preparing the library index…'),
    playlist: t('Loading playlists…'),
    guide: t('Loading the TV guide…'),
  };
  return active.map((activity) => (
    <ActivityRow
      key={activity}
      label={labels[activity]}
      compact={compact}
      percent={progress.get(activity)}
    />
  ));
}

export function DataActivityStatus({ compact }: { compact: boolean }) {
  const { t } = useI18n();
  const counts = useDataActivities();
  const active = ACTIVITIES.filter((activity) => counts[activity] > 0);
  const progress = new Map<DataActivity, number>();
  for (const { activity, percent } of counts.progress.values()) {
    if (counts[activity] === 1) progress.set(activity, percent);
  }
  const refresh = counts.sourceRefresh?.phase;
  const imdbImport = counts.imdbImport;
  const imdbLabels = {
    importing: t('Importing IMDb data…'),
    ratings: t('Downloading IMDb ratings…'),
    titles: t('Downloading IMDb titles…'),
    matching: t('Matching IMDb ratings…'),
  };
  const refreshLabels = {
    refreshing: t('Refreshing sources…'),
    complete: t('Sources Refreshed'),
    incomplete: t('Refresh Incomplete'),
    failed: t('Refresh Failed'),
  };

  return (
    <div className={compact ? `${styles.card} ${styles.compact}` : styles.card} role="status">
      {refresh ? (
        <ActivityRow
          label={refreshLabels[refresh]}
          compact={compact}
          percent={refresh === 'refreshing' ? counts.sourceRefresh?.percent : undefined}
          state={
            refresh === 'refreshing' ? 'working' : refresh === 'complete' ? 'complete' : 'error'
          }
        />
      ) : (
        active.length > 0 && (
          <ActivityLabels active={active} compact={compact} progress={progress} />
        )
      )}
      {imdbImport && (
        <ActivityRow
          label={imdbLabels[imdbImport.phase]}
          compact={compact}
          percent={imdbImport.percent}
        />
      )}
    </div>
  );
}
