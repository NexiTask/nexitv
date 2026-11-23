import { useEffect } from 'react';
import { desktopApi } from '@/platform/desktop';
import { tauriApi, type ImdbRefreshEvent } from '@/platform/tauri';
import { notify } from '@/shared/notifications/useNotificationStore';
import { useDataActivities } from '@/shared/lib/dataActivity';

function showImport({ stage, dataset, percent }: ImdbRefreshEvent) {
  if (stage === 'downloading' && dataset) {
    useDataActivities.setState({
      imdbImport: { phase: dataset, ...(percent == null ? {} : { percent }) },
    });
  } else if (
    stage === 'checking' ||
    stage === 'downloading' ||
    stage === 'parsing' ||
    stage === 'matching'
  ) {
    useDataActivities.setState({
      imdbImport: { phase: stage === 'matching' || stage === 'checking' ? stage : 'importing' },
    });
  }
}

/** Follows the import in the sidebar, including runs started by the schedule. */
export function useImdbRefreshEvents() {
  useEffect(() => {
    if (!desktopApi.isDesktop()) return;
    let disposed = false;
    let receivedEvent = false;
    let stop: (() => void) | undefined;
    desktopApi
      .onImdbRefreshed((stage, event) => {
        if (disposed) return;
        receivedEvent = true;
        if (stage !== 'done' && stage !== 'failed') {
          showImport(event);
          return;
        }
        const completedImport = stage === 'done' && useDataActivities.getState().imdbImport;
        useDataActivities.setState({ imdbImport: null });
        if (!completedImport) return;
        void tauriApi
          .imdbRefreshStatus()
          .then((status) => {
            if (disposed) return;
            notify.success(
              'IMDb Data Updated',
              `${status.matched.toLocaleString()} of ${status.total.toLocaleString()} titles have an IMDb rating.`,
            );
          })
          .catch(() => undefined);
      })
      .then(async (unlisten) => {
        if (disposed) {
          unlisten();
          return;
        }
        stop = unlisten;
        if (receivedEvent) return;
        const status = await tauriApi.imdbRefreshStatus();
        if (!disposed && !receivedEvent && status.importProgress) showImport(status.importProgress);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      stop?.();
      useDataActivities.setState({ imdbImport: null });
    };
  }, []);
}
