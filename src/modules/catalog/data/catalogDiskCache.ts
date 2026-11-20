import { tauriApi, type CatalogCacheKind } from '@/platform/tauri';
import { desktopApi } from '@/platform/desktop';
import { debugLog } from '@/modules/diagnostics/public/store/useDebugStore';
import { getErrorMessage } from '@/shared/lib/error';
import { perfAsync, perfSync } from '@/shared/lib/perf';

/**
 * Serialising a large list blocks the UI thread for a few dozen
 * milliseconds; it waits until the catalogue that list fed has rendered.
 */
const STORE_DELAY_MS = 2_000;

/** Keep a provider's list on disk for the next start. Best effort: a failure only costs that head start. */
export function rememberProviderList(
  sourceId: string,
  kind: CatalogCacheKind,
  scope: string,
  list: unknown[],
): void {
  // An empty answer is more often a provider hiccup than an empty catalogue,
  // and showing it at the next start would read as "nothing here".
  if (!desktopApi.isDesktop() || list.length === 0) return;
  setTimeout(() => {
    const content = perfSync(
      `store:stringify:${kind}`,
      () => JSON.stringify(list),
      (s) => `chars=${s.length}`,
    );
    void perfAsync(`store:ipc:${kind}`, () =>
      tauriApi.catalogCacheStore(sourceId, kind, scope, content),
    ).catch((error: unknown) => {
      debugLog.warn('api', 'Catalogue could not be saved for the next start', {
        kind,
        error: getErrorMessage(error, 'Saving the catalogue failed.'),
      });
    });
  }, STORE_DELAY_MS);
}

/** The list saved for this account, or null when there is none worth showing. */
export async function loadProviderList(
  sourceId: string,
  kind: CatalogCacheKind,
  scope: string,
): Promise<{ list: unknown[]; savedAt: number } | null> {
  const entry = await perfAsync(
    `cache:load_ipc:${kind}`,
    () => tauriApi.catalogCacheLoad(sourceId, kind, scope),
    (e) => (e ? `chars=${e.content.length}` : 'miss'),
  );
  if (!entry) return null;
  const list: unknown = perfSync(`cache:json_parse:${kind}`, () => JSON.parse(entry.content));
  return Array.isArray(list) ? { list, savedAt: entry.savedAt } : null;
}
