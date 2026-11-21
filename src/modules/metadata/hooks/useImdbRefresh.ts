import { useCallback, useEffect, useState } from 'react';
import { tauriApi, type ImdbRefreshStatus } from '@/platform/tauri';
import { desktopApi } from '@/platform/desktop';
import { notify } from '@/shared/notifications/useNotificationStore';
import { getErrorMessage } from '@/shared/lib/error';

/**
 * The IMDb pipeline's state for Settings: load it, follow a running refresh,
 * and drive the toggle and the manual update. The pipeline itself runs on its
 * own schedule in the backend (metadata/imdb.rs); this only reports and
 * commands it.
 */
export function useImdbRefresh() {
  const [status, setStatus] = useState<ImdbRefreshStatus | null>(null);
  const [isStarting, setIsStarting] = useState(false);

  const reload = useCallback(() => {
    return tauriApi
      .imdbRefreshStatus()
      .then(setStatus)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // While a refresh runs, follow it; a few seconds of latency is fine here.
  const running = status?.running ?? false;
  useEffect(() => {
    if (!running) return;
    const interval = setInterval(() => void reload(), 3_000);
    return () => clearInterval(interval);
  }, [running, reload]);

  // A run can start anywhere (the schedule, the update button); the stage
  // events are how a follower that did not start it learns it is running.
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    desktopApi
      .onImdbRefreshed((stage) => {
        if (stage === 'done') {
          void reload();
          return;
        }
        setStatus((current) =>
          current && !current.running ? { ...current, running: true } : current,
        );
      })
      .then((unlisten) => {
        if (disposed) unlisten();
        else stop = unlisten;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      stop?.();
    };
  }, [reload]);

  const start = useCallback(() => {
    setIsStarting(true);
    tauriApi
      .imdbRefreshStart()
      .then((status) => {
        setStatus(status);
      })
      .catch((error: unknown) => {
        notify.error('IMDb Update Failed', getErrorMessage(error, 'The update could not run.'));
      })
      .finally(() => {
        setIsStarting(false);
        void reload();
      });
  }, [reload]);

  const setEnabled = useCallback((enabled: boolean) => {
    tauriApi
      .imdbRefreshSetEnabled(enabled)
      .then(() => setStatus((current) => (current ? { ...current, enabled } : current)))
      .catch((error: unknown) => {
        notify.error(
          'IMDb Setting Not Saved',
          getErrorMessage(error, 'The setting could not be saved.'),
        );
      });
  }, []);

  return { status, isStarting, start, setEnabled, reload };
}
