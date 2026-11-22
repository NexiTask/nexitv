import { useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { useI18n } from '@/shared/i18n/i18n';
import { useDataActivities } from '@/shared/lib/dataActivity';
import styles from './DataActivityStatus.module.css';

const ACTIVITIES = ['catalog', 'index', 'playlist', 'guide'] as const;
const SHOW_DELAY_MS = 400;

function ActivityLabels({
  active,
  compact,
}: {
  active: (typeof ACTIVITIES)[number][];
  compact: boolean;
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
    index: t('Preparing the library index…'),
    playlist: t('Loading playlists…'),
    guide: t('Loading the TV guide…'),
  };
  const label = active.map((activity) => labels[activity]).join(' ');

  return (
    <div
      className={compact ? `${styles.row} ${styles.compact}` : styles.row}
      title={compact ? label : undefined}
    >
      <LoaderCircle size={20} aria-hidden="true" className={styles.spinner} />
      <span className={styles.label}>{label}</span>
    </div>
  );
}

export function DataActivityStatus({ compact }: { compact: boolean }) {
  const counts = useDataActivities();
  const active = ACTIVITIES.filter((activity) => counts[activity] > 0);

  return (
    <div role="status">
      {active.length > 0 && <ActivityLabels active={active} compact={compact} />}
    </div>
  );
}
