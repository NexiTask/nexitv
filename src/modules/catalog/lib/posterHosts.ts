/**
 * Provider poster hosts that stopped answering. A dead host does not refuse
 * the connection, it hangs, so the image never fires `error` and the card
 * would stay blank; a load that outlasts `POSTER_LOAD_TIMEOUT_MS` marks its
 * host dead for the session, and every other poster on that host goes
 * straight to the fallback instead of waiting out its own timeout.
 *
 * A host that has delivered any poster this session is never timed out: a
 * lazy image just outside the viewport may not have started loading, and a
 * slow card must not condemn a working CDN.
 */
export const POSTER_LOAD_TIMEOUT_MS = 8_000;

const deadHosts = new Set<string>();
const liveHosts = new Set<string>();

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

export function isPosterHostDead(url: string | undefined): boolean {
  if (!url) return false;
  const host = hostOf(url);
  return host !== null && deadHosts.has(host);
}

/** Whether a slow load from this URL's host should count as a dead host. */
export function canTimeOutPosterHost(url: string): boolean {
  const host = hostOf(url);
  return host !== null && !liveHosts.has(host);
}

export function markPosterHostDead(url: string): void {
  const host = hostOf(url);
  if (host && !liveHosts.has(host)) deadHosts.add(host);
}

export function markPosterHostLive(url: string): void {
  const host = hostOf(url);
  if (!host) return;
  liveHosts.add(host);
  deadHosts.delete(host);
}

/** Tests only: forget the session's dead hosts. */
export function resetPosterHosts(): void {
  deadHosts.clear();
  liveHosts.clear();
}

/** A loaded movie/series cover that is no real poster: a small thumbnail, or
 * landscape (a screenshot or still where a 2:3 poster belongs). */
export function isWeakPoster(image: { naturalWidth: number; naturalHeight: number }): boolean {
  const { naturalWidth: width, naturalHeight: height } = image;
  if (!width || !height) return false;
  return width < 150 || width > height;
}
