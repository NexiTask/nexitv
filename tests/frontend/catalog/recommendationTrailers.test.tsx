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
  const frame = () => document.querySelector('iframe');
  const open = vi.fn();
  render(
    <RecommendationTrailers items={items} onOpen={open}>
      {(preview, selectedId, select) => (
        <>
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
        </>
      )}
    </RecommendationTrailers>,
  );

  setVisible(0.5);
  expect(frame()).toBeNull();
  expect(endpoint).not.toHaveBeenCalled();
  setVisible(0.75);
  await waitFor(() => expect(frame()?.getAttribute('src')).toContain(ids.Dark));

  fireEvent.click(screen.getByRole('button', { name: 'Fargo' }));
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
  fireEvent.click(screen.getByRole('button', { name: 'Close trailer' }));
  expect(frame()).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'No Trailer' }));
  setVisible(0.75);
  expect(screen.getByText('No official trailer available')).toBeTruthy();
  expect(frame()).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Series details' }));
  expect(open).toHaveBeenCalledWith(items[2]);
});
