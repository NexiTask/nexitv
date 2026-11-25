// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaCard } from '@/modules/catalog/components/MediaCard';
import type { MediaItem } from '@/modules/catalog/model/media';
import { POSTER_LOAD_TIMEOUT_MS, resetPosterHosts } from '@/modules/catalog/lib/posterHosts';
import { useDownloadStore } from '@/modules/downloads/store/useDownloadStore';
import { useSettingsStore } from '@/modules/settings/store/useSettingsStore';
import { useStreamVerificationStore } from '@/modules/sources/store/useStreamVerificationStore';

const movieItem: MediaItem = { id: 'movie-1', title: 'Inception', posterUrl: '', type: 'vod' };

function renderCard(item: MediaItem, viewMode?: 'grid' | 'list') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <MediaCard item={item} viewMode={viewMode} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useDownloadStore.setState({ jobs: [], downloadedByLibraryId: {} });
  useSettingsStore.getState().resetSettings();
  useStreamVerificationStore.getState().clearVerifications();
});

describe('MediaCard downloaded indicator', () => {
  it('shows no downloaded badge for a title that has not been downloaded', () => {
    renderCard(movieItem);
    expect(screen.queryByTitle('Downloaded')).toBeNull();
  });

  it('shows a downloaded badge once the title is in the local download library', () => {
    useDownloadStore.getState().addDownloadedItem({
      id: 'movie-1',
      jobId: 'job-1',
      filePath: 'C:\\Downloads\\Inception.mp4',
      fileName: 'Inception.mp4',
      type: 'vod',
      title: 'Inception',
      sizeBytes: 100,
      downloadedAt: Date.now(),
    });
    renderCard(movieItem);
    expect(screen.getByTitle('Downloaded')).toBeTruthy();
  });

  it('only badges the specific downloaded title, not every card', () => {
    useDownloadStore.getState().addDownloadedItem({
      id: 'some-other-movie',
      jobId: 'job-1',
      filePath: 'C:\\Downloads\\Other.mp4',
      fileName: 'Other.mp4',
      type: 'vod',
      title: 'Other Movie',
      sizeBytes: 100,
      downloadedAt: Date.now(),
    });
    renderCard(movieItem);
    expect(screen.queryByTitle('Downloaded')).toBeNull();
  });

  it('renders the downloaded indicator in list view too', () => {
    useDownloadStore.getState().addDownloadedItem({
      id: 'movie-1',
      jobId: 'job-1',
      filePath: 'C:\\Downloads\\Inception.mp4',
      fileName: 'Inception.mp4',
      type: 'vod',
      title: 'Inception',
      sizeBytes: 100,
      downloadedAt: Date.now(),
    });
    renderCard(movieItem, 'list');
    expect(screen.getByTitle('Downloaded')).toBeTruthy();
  });
});

describe('MediaCard quality badge', () => {
  const channelItem: MediaItem = {
    id: 'channel-1',
    title: 'Sports 4K',
    posterUrl: '',
    type: 'live',
  };

  it('shows the provider-declared quality when nothing has been verified yet', () => {
    renderCard(channelItem);
    expect(screen.getAllByText('4K').length).toBeGreaterThan(0);
  });

  it('shows only the verified resolution once it disagrees with the channel name, not both', () => {
    useStreamVerificationStore.getState().recordVerification('channel-1', {
      width: 1920,
      height: 1080,
      fps: 30,
    });
    renderCard(channelItem);
    expect(screen.getAllByText('FHD').length).toBeGreaterThan(0);
    expect(screen.queryAllByText('4K')).toHaveLength(0);
  });
});

describe('MediaCard poster on a hanging host', () => {
  const hanging = (id: string): MediaItem => ({
    id,
    title: 'The Godfather',
    posterUrl: `http://203.0.113.7/images/${id}.jpg`,
    type: 'vod',
  });

  beforeEach(() => {
    resetPosterHosts();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives up on a poster that never loads and skips the dead host afterwards', () => {
    const { container, unmount } = renderCard(hanging('m1'));
    expect(container.querySelector('img')).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(POSTER_LOAD_TIMEOUT_MS);
    });
    expect(container.querySelector('img')).toBeNull();
    unmount();

    // Another poster on the same host goes straight to the fallback.
    const second = renderCard(hanging('m2'));
    expect(second.container.querySelector('img')).toBeNull();
  });

  it('never times out a host that has delivered a poster', () => {
    const { container } = renderCard(hanging('m1'));
    const image = container.querySelector('img');
    expect(image).not.toBeNull();
    fireEvent.load(image as HTMLImageElement);

    const slow = renderCard(hanging('m2'));
    act(() => {
      vi.advanceTimersByTime(POSTER_LOAD_TIMEOUT_MS * 2);
    });
    expect(slow.container.querySelector('img')).not.toBeNull();
  });
});

describe('MediaCard IMDb rating', () => {
  it('shows the IMDb rating and votes under a movie title', () => {
    renderCard({ ...movieItem, imdbRating: 8.8, imdbVotes: 2_600_000 });
    expect(screen.getByText('IMDb')).toBeTruthy();
    expect(screen.getByText('8.8')).toBeTruthy();
    expect(screen.getByText('2.6M')).toBeTruthy();
  });

  it('shows no IMDb line for an unmatched title', () => {
    renderCard(movieItem);
    expect(screen.queryByText('IMDb')).toBeNull();
  });

  it('shows a series rating alongside episode context', () => {
    renderCard({
      ...movieItem,
      type: 'series',
      seasonNum: 1,
      episodeNum: 2,
      subtitle: 'S1 E2',
      imdbRating: 8.8,
    });
    expect(screen.getByText('IMDb')).toBeTruthy();
    expect(screen.getByText('8.8')).toBeTruthy();
    expect(screen.getByText('S1 E2')).toBeTruthy();
  });
});

describe('MediaCard quick remove', () => {
  it('offers the X only when asked, and removing does not open the title', () => {
    const onRemove = vi.fn();
    const onClick = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <MediaCard
            item={{ ...movieItem, progress: 0.4 }}
            onClick={onClick}
            onRemove={onRemove}
            removeLabel="Remove from Continue Watching"
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    // The hover overlay is built on first hover.
    fireEvent.pointerEnter(screen.getByRole('group'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove from Continue Watching' }));
    expect(onRemove).toHaveBeenCalledWith(expect.objectContaining({ id: 'movie-1' }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('has no X on an ordinary card', () => {
    renderCard(movieItem);
    expect(screen.queryByRole('button', { name: 'Remove from Continue Watching' })).toBeNull();
  });
});

describe('weak provider covers', () => {
  it('treats thumbnails and landscape screenshots as no poster', async () => {
    const { isWeakPoster } = await import('@/modules/catalog/lib/posterHosts');
    expect(isWeakPoster({ naturalWidth: 120, naturalHeight: 90 })).toBe(true);
    expect(isWeakPoster({ naturalWidth: 640, naturalHeight: 360 })).toBe(true);
    expect(isWeakPoster({ naturalWidth: 600, naturalHeight: 900 })).toBe(false);
    expect(isWeakPoster({ naturalWidth: 0, naturalHeight: 0 })).toBe(false);
  });
});
