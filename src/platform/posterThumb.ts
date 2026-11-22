import { convertFileSrc } from '@tauri-apps/api/core';

/** Width (CSS px) a poster is shrunk to; enough for a card at 2x. */
const THUMB_WIDTH = 400;

function hex(text: string): string {
  return Array.from(new TextEncoder().encode(text), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

/** Whether a poster URL can be served as a small cached thumbnail. */
export function canThumbPoster(url: string | undefined): url is string {
  return Boolean(url && /^https?:\/\//i.test(url));
}

/**
 * The poster as a small JPEG from the backend's `poster://` scheme (fetched,
 * shrunk and cached on disk there). Decoding full-size provider posters while a
 * grid scrolls is what made it stutter.
 */
export function posterThumbUrl(url: string): string {
  try {
    return `${convertFileSrc(hex(url), 'poster')}?w=${THUMB_WIDTH}`;
  } catch {
    // Not running inside the desktop shell (tests, a plain browser).
    return url;
  }
}
