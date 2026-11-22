import { afterEach, describe, expect, it, vi } from 'vitest';
import { isWebKitGtk } from '@/platform/runtime';

function withUserAgent(userAgent: string) {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
}

describe('isWebKitGtk', () => {
  afterEach(() => vi.restoreAllMocks());

  it('detects the Linux WebKitGTK webview', () => {
    withUserAgent(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/60.5 Safari/605.1.15',
    );
    expect(isWebKitGtk()).toBe(true);
  });

  it('ignores Chromium on Linux and WebKit on macOS', () => {
    withUserAgent(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    );
    expect(isWebKitGtk()).toBe(false);
    withUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)',
    );
    expect(isWebKitGtk()).toBe(false);
  });
});
