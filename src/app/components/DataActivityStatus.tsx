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
  state = 'working',
}: {
  label: string;
  compact: boolean;
  state?: 'working' | 'complete' | 'error';
}) {
  const Icon = state === 'working' ? LoaderCircle : state === 'complete' ? Check : CircleAlert;
  return (
    <div
      className={compact ? `${styles.row} ${styles.compact}` : styles.row}
      title={compact ? label : undefined}
    >
      <Icon
        size={16}
        aria-hidden="true"
        className={state === 'working' ? styles.spinner : undefined}
      />
      <span className={styles.label}>{label}</span>
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
  const { t, number } = useI18n();
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
  const label = active
    .map((activity) => {
      const percent = progress.get(activity);
      return percent === undefined
        ? labels[activity]
        : `${labels[activity]} ${number(percent / 100, { style: 'percent', maximumFractionDigits: 0 })}`;
    })
    .join(' ');

  return <ActivityRow label={label} compact={compact} />;
}

export function DataActivityStatus({ compact }: { compact: boolean }) {
  const { t, number } = useI18n();
  const counts = useDataActivities();
  const active = ACTIVITIES.filter((activity) => counts[activity] > 0);
  const progress = new Map<DataActivity, number>();
  for (const { activity, percent } of counts.progress.values()) {
    if (counts[activity] === 1) progress.set(activity, percent);
  }
  const refresh = counts.sourceRefresh?.phase;
  const refreshLabels = {
    refreshing: `${t('Refreshing sources…')} ${number((counts.sourceRefresh?.percent ?? 0) / 100, { style: 'percent', maximumFractionDigits: 0 })}`,
    complete: t('Sources Refreshed'),
    incomplete: t('Refresh Incomplete'),
    failed: t('Refresh Failed'),
  };

  return (
    <div role="status">
      {refresh ? (
        <ActivityRow
          label={refreshLabels[refresh]}
          compact={compact}
          state={
            refresh === 'refreshing' ? 'working' : refresh === 'complete' ? 'complete' : 'error'
          }
        />
      ) : (
        active.length > 0 && (
          <ActivityLabels active={active} compact={compact} progress={progress} />
        )
      )}
    </div>
  );
}
