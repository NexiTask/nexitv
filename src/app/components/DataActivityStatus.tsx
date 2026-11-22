import { useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { useI18n } from '@/shared/i18n/i18n';
import { useDataActivities } from '@/shared/lib/dataActivity';
import styles from './DataActivityStatus.module.css';

const ACTIVITIES = ['catalog', 'index', 'playlist', 'guide'] as const;
const SHOW_DELAY_MS = 400;

function ActivityLabels({ active }: { active: (typeof ACTIVITIES)[number][] }) {
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

  return (
    <>
      <LoaderCircle size={16} aria-hidden="true" className={styles.spinner} />
      <span>{active.map((activity) => labels[activity]).join(' ')}</span>
    </>
  );
}

export function DataActivityStatus() {
  const counts = useDataActivities();
  const active = ACTIVITIES.filter((activity) => counts[activity] > 0);

  return (
    <div className={styles.status} role="status">
      {active.length > 0 && <ActivityLabels active={active} />}
    </div>
  );
}
