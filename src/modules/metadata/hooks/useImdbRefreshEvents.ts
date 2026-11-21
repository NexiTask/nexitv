import { useEffect, useRef } from 'react';
import { desktopApi } from '@/platform/desktop';
import { tauriApi } from '@/platform/tauri';
import { notify } from '@/shared/notifications/useNotificationStore';

/**
 * Toasts for the IMDb pipeline's runs, wherever they start (the schedule or
 * the Settings button): one notice when a run begins, the counts when it
 * finishes. Mounted once, beside the other app-level event hooks.
 */
export function useImdbRefreshEvents() {
  const announcedRun = useRef(false);

  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    desktopApi
      .onImdbRefreshed((stage) => {
        if (stage === 'failed') {
          announcedRun.current = false;
          return;
        }
        if (stage === 'done') {
          // The daily backfill finishes silently: only a run that was
          // announced reports its counts (a full refresh sends 'done' twice,
          // and only the first one toasts).
          if (!announcedRun.current) return;
          announcedRun.current = false;
          void tauriApi
            .imdbRefreshStatus()
            .then((status) => {
              notify.success(
                'IMDb Data Updated',
                `${status.matched.toLocaleString()} of ${status.total.toLocaleString()} titles have an IMDb rating.`,
              );
            })
            .catch(() => undefined);
          return;
        }
        // Checking/downloading/parsing: a run is active. Announce it once.
        if (announcedRun.current) return;
        announcedRun.current = true;
        notify.info(
          'Updating IMDb Ratings',
          'New ratings are being matched; coverage fills in as they land.',
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
  }, []);
}
