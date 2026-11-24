// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { MediaItem } from '@/modules/catalog/public/model/media';
import { RecommendationTrailers } from '@/modules/library/public/components/RecommendationTrailers';
import { tauriApi } from '@/platform/tauri';

const ids: Record<string, string> = { Dark: 'ESEUoa-mz2c', Fargo: 'p2Jq3-Iotdc' };
const items: MediaItem[] = ['Dark', 'Fargo', 'No Trailer'].map((title) => ({
  id: title,
  title,
  type: 'series',
  posterUrl: '',
}));

vi.mock('@/platform/desktop', () => ({
  desktopApi: { isDesktop: () => true, openUrl: vi.fn() },
}));

vi.mock('@/modules/metadata/public/hooks/useTmdbDetailsEnrichment', () => ({
  useTmdbDetailEnrichment: (_mediaType: string, { title }: { title: string }) => ({
    details: {
      backdropUrl: `https://images.example.test/${encodeURIComponent(title)}.jpg`,
      videos: ids[title]
        ? [
            {
              type: 'Teaser',
              official: true,
              site: 'YouTube',
              url: `https://www.youtube.com/watch?v=${ids[title]}`,
            },
          ]
        : [],
    },
    rating: { status: 'matched' },
  }),
}));

let reportIntersection: (ratio: number) => void;
function setVisible(ratio: number) {
  act(() => reportIntersection(ratio));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('plays one muted trailer in view, switches series and stops outside the viewport', async () => {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(notify: IntersectionObserverCallback) {
        reportIntersection = (ratio) =>
          notify(
            [
              {
                isIntersecting: ratio > 0,
                intersectionRatio: ratio,
                boundingClientRect: { width: 560, height: 315 },
              } as IntersectionObserverEntry,
            ],
            this as unknown as IntersectionObserver,
          );
      }
      observe() {}
      disconnect() {}
    },
  );
  const endpoint = vi
    .spyOn(tauriApi, 'recommendationTrailerEndpoint')
    .mockResolvedValue('http://127.0.0.1:12345/trailers/fixture/');
  const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
  const frame = () => document.querySelector('iframe');
  const reportPlayerEvent = (data: string) => {
    Object.defineProperty(frame()!, 'contentWindow', { value: window });
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data,
          origin: 'http://127.0.0.1:12345',
          source: window,
        }),
      );
    });
  };
  const open = vi.fn();
  render(
    <RecommendationTrailers items={items} onOpen={open} fullWidth>
      {(preview, selectedId, select) => (
        <div data-testid="recommendations-page">
          {preview}
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={item.id === selectedId}
              onClick={() => select(item)}
            >
              {item.title}
            </button>
          ))}
        </div>
      )}
    </RecommendationTrailers>,
  );

  setVisible(0.5);
  expect(frame()).toBeNull();
  expect(document.querySelectorAll('img')).toHaveLength(1);
  expect(endpoint).not.toHaveBeenCalled();
  setVisible(0.75);
  await waitFor(() => expect(frame()?.getAttribute('src')).toContain(ids.Dark));

  const page = screen.getByTestId('recommendations-page');
  const poster = screen.getByRole('button', { name: 'Fargo' });
  page.scrollTop = 180;
  poster.focus();
  fireEvent.click(poster);
  expect(scrollIntoView).not.toHaveBeenCalled();
  expect(screen.getByTestId('recommendations-page')).toBe(page);
  expect(page.scrollTop).toBe(180);
  expect(document.activeElement).toBe(poster);
  expect(frame()).toBeNull();
  setVisible(0.75);
  await waitFor(() => expect(frame()?.getAttribute('src')).toContain(ids.Fargo));
  expect(document.querySelectorAll('iframe')).toHaveLength(1);

  setVisible(0);
  expect(frame()).toBeNull();
  setVisible(0.75);
  await waitFor(() => expect(frame()).not.toBeNull());
  fireEvent.click(screen.getByRole('checkbox', { name: 'Autoplay trailers' }));
  expect(frame()).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Watch teaser' }));
  expect(frame()).not.toBeNull();
  reportPlayerEvent('nexitv:trailer-ended');
  expect(frame()).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Watch teaser' }));
  fireEvent.click(screen.getByRole('button', { name: 'Close trailer' }));
  expect(frame()).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Watch teaser' }));
  reportPlayerEvent('nexitv:trailer-error');
  expect(frame()).toBeNull();
  expect(screen.getByRole('button', { name: 'Open trailer in browser' })).toBeTruthy();
  expect(document.querySelectorAll('img')).toHaveLength(1);

  fireEvent.click(screen.getByRole('button', { name: 'No Trailer' }));
  setVisible(0.75);
  expect(screen.getByText('No official trailer available')).toBeTruthy();
  expect(frame()).toBeNull();
  expect(document.querySelectorAll('img')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Series details' }));
  expect(open).toHaveBeenCalledWith(items[2]);
});
