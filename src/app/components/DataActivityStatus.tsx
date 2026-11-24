import { useEffect, useState } from 'react';
import { Check, CircleAlert, LoaderCircle } from 'lucide-react';
import { normalizeDownloadProgress } from '@/modules/downloads/public/lib/downloads';
import { useDownloadStore } from '@/modules/downloads/public/store/useDownloadStore';
import { useI18n, type I18nApi } from '@/shared/i18n/i18n';
import {
  useDataActivities,
  type ActivityDetail,
  type DataActivity,
} from '@/shared/lib/dataActivity';
import styles from './DataActivityStatus.module.css';

const ACTIVITIES = ['catalog', 'index', 'playlist', 'guide'] as const;
const SHOW_DELAY_MS = 400;

function catalogName(kind: 'live' | 'vod' | 'series', t: I18nApi['t']) {
  return kind === 'live' ? t('Live TV') : kind === 'vod' ? t('Movies') : t('Series');
}

function describeActivity(detail: ActivityDetail, { t, number }: I18nApi): string {
  switch (detail.phase) {
    case 'fetch-catalog':
      return `${catalogName(detail.kind, t)} · ${t('Downloading the latest catalog')}`;
    case 'check-index':
      return `${catalogName(detail.kind, t)} · ${t('Checking the saved index')}`;
    case 'save-index':
      return `${catalogName(detail.kind, t)} · ${t('Saving the catalog to the index')}`;
    case 'sort-titles':
      return `${catalogName(detail.kind, t)} · ${t('Sorting titles by name')}`;
    case 'index-titles':
      return `${catalogName(detail.kind, t)} · ${
        detail.completed === undefined || detail.total === undefined
          ? t('Preparing titles for search and filters')
          : t('{completed} of {total} titles indexed', {
              completed: number(detail.completed),
              total: number(detail.total),
            })
      }`;
    case 'download-playlist':
      return t('Downloading the playlist file');
    case 'read-playlist':
      return t('Reading a local playlist file');
    case 'restore-playlist':
      return t('Opening a saved playlist');
    case 'parse-playlist':
      return t('Reading channels and groups');
  }
}

function ActivityRow({
  label,
  compact,
  detail,
  percent,
  state = 'working',
}: {
  label: string;
  compact: boolean;
  detail?: string | undefined;
  percent?: number | undefined;
  state?: 'working' | 'complete' | 'error';
}) {
  const { number } = useI18n();
  const Icon = state === 'working' ? LoaderCircle : state === 'complete' ? Check : CircleAlert;
  const value = percent === undefined ? undefined : number(percent / 100, { style: 'percent' });

  return (
    <div
      className={styles.row}
      title={compact || detail ? [label, value, detail].filter(Boolean).join(' · ') : undefined}
    >
      <Icon size={16} aria-hidden="true" className={styles.icon} data-state={state} />
      <div className={styles.details}>
        <div className={styles.heading}>
          <span className={styles.label}>{label}</span>
          {value !== undefined && <span className={styles.value}>{value}</span>}
        </div>
        {detail && <div className={styles.detail}>{detail}</div>}
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
  details,
}: {
  active: (typeof ACTIVITIES)[number][];
  compact: boolean;
  progress: ReadonlyMap<DataActivity, number>;
  details: ReadonlyMap<DataActivity, ActivityDetail[]>;
}) {
  const i18n = useI18n();
  const { t, list } = i18n;
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
      detail={
        activity === 'guide'
          ? t('Loading channel listings from XMLTV')
          : list([
              ...new Set(details.get(activity)?.map((detail) => describeActivity(detail, i18n))),
            ])
      }
    />
  ));
}

function DownloadActivity({ compact }: { compact: boolean }) {
  const { t, tn, number } = useI18n();
  const jobs = useDownloadStore((state) => state.jobs);
  const active = jobs.filter((job) => job.state === 'downloading');
  if (!active.length) return null;

  const totalBytes = active.every((job) => job.totalBytes !== null)
    ? active.reduce((sum, job) => sum + (job.totalBytes ?? 0), 0)
    : null;
  const downloadedBytes = active.reduce((sum, job) => sum + job.downloadedBytes, 0);
  const { percent } = normalizeDownloadProgress(downloadedBytes, totalBytes);
  return (
    <ActivityRow
      label={t('Downloading…')}
      compact={compact}
      detail={
        active.length === 1
          ? active[0]?.fileName
          : tn('{count} download', '{count} downloads', active.length, {
              count: number(active.length),
            })
      }
      percent={percent ?? undefined}
    />
  );
}

export function DataActivityStatus({ compact }: { compact: boolean }) {
  const { t, number } = useI18n();
  const counts = useDataActivities();
  const active = ACTIVITIES.filter((activity) => counts[activity] > 0);
  const progress = new Map<DataActivity, number>();
  for (const { activity, percent } of counts.progress.values()) {
    if (counts[activity] === 1) progress.set(activity, percent);
  }
  const details = new Map<DataActivity, ActivityDetail[]>();
  for (const { activity, detail } of counts.details.values()) {
    const existing = details.get(activity);
    if (existing) existing.push(detail);
    else details.set(activity, [detail]);
  }
  const refresh = counts.sourceRefresh;
  const imdbImport = counts.imdbImport;
  const imdbLabels = {
    checking: t('Importing IMDb data…'),
    importing: t('Importing IMDb data…'),
    ratings: t('Downloading IMDb ratings…'),
    titles: t('Downloading IMDb titles…'),
    matching: t('Matching IMDb ratings…'),
  };
  const imdbDetails = {
    checking: t('Checking the library for titles to match'),
    importing: t('Reading downloaded IMDb files'),
    ratings: t('Getting scores and vote counts'),
    titles: t('Getting title names, years, and types'),
    matching: t('Applying IMDb ratings to library titles'),
  };
  const refreshLabels = {
    refreshing: t('Refreshing sources…'),
    complete: t('Sources Refreshed'),
    incomplete: t('Refresh Incomplete'),
    failed: t('Refresh Failed'),
  };
  let refreshDetail: string | undefined;
  if (refresh?.phase === 'refreshing') {
    const count = t('{completed} of {total} refresh tasks finished', {
      completed: number(refresh.settled),
      total: number(refresh.total),
    });
    refreshDetail = refresh.kind ? `${catalogName(refresh.kind, t)} · ${count}` : count;
  } else if (refresh?.summary) {
    refreshDetail = t('Updated {updated} · Failed {failed} · Kept edits on {kept}', {
      updated: number(refresh.summary.updated),
      failed: number(refresh.summary.failed),
      kept: number(refresh.summary.kept),
    });
  } else if (refresh) {
    refreshDetail = t('The refresh stopped before it could finish');
  }

  return (
    <div className={compact ? `${styles.card} ${styles.compact}` : styles.card} role="status">
      {refresh && (
        <ActivityRow
          label={refreshLabels[refresh.phase]}
          compact={compact}
          detail={refreshDetail}
          percent={refresh.phase === 'refreshing' ? refresh.percent : undefined}
          state={
            refresh.phase === 'refreshing'
              ? 'working'
              : refresh.phase === 'complete'
                ? 'complete'
                : 'error'
          }
        />
      )}
      {active.length > 0 && (
        <ActivityLabels active={active} compact={compact} progress={progress} details={details} />
      )}
      <DownloadActivity compact={compact} />
      {imdbImport && (
        <ActivityRow
          label={imdbLabels[imdbImport.phase]}
          compact={compact}
          detail={imdbDetails[imdbImport.phase]}
          percent={imdbImport.percent}
        />
      )}
    </div>
  );
}
