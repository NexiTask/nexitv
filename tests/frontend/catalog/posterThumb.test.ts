import { describe, expect, it } from 'vitest';
import { canThumbPoster, posterThumbUrl } from '@/platform/posterThumb';

describe('poster thumbnails', () => {
  it('only proxies http(s) posters', () => {
    expect(canThumbPoster('https://cdn.test/a.jpg')).toBe(true);
    expect(canThumbPoster('http://cdn.test/a.jpg')).toBe(true);
    expect(canThumbPoster('data:image/png;base64,AAAA')).toBe(false);
    expect(canThumbPoster('')).toBe(false);
    expect(canThumbPoster(undefined)).toBe(false);
  });

  it('falls back to the original URL outside the desktop shell', () => {
    expect(posterThumbUrl('https://cdn.test/a.jpg')).toBe('https://cdn.test/a.jpg');
  });

  it('asks the poster scheme for a hex-encoded URL inside the desktop shell', () => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      convertFileSrc: (path: string, protocol: string) => `${protocol}://localhost/${path}`,
    };
    try {
      expect(posterThumbUrl('https://a.b')).toBe('poster://localhost/68747470733a2f2f612e62?w=400');
    } finally {
      delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    }
  });
});
