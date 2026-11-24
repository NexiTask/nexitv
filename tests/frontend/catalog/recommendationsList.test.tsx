// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import { RecommendationsList } from '@/modules/library/pages/RecommendationsList';
import { useSeriesRecommendations } from '@/modules/library/public/data/useSeriesRecommendations';
import { tauriApi } from '@/platform/tauri';

vi.mock('@/platform/desktop', () => ({ desktopApi: { isDesktop: () => true } }));
vi.mock('@/modules/catalog/public/data/useCategories', () => ({
  useVisibleCatalog: () => ({
    data: [
      { id: 'test-series', title: 'The Fixture', type: 'series', posterUrl: '', genres: ['Crime'] },
    ],
    isLoading: false,
  }),
  useCategories: () => ({ data: [] }),
}));
vi.mock('@/modules/guide/public/data/useUpcomingReleases', () => ({
  useUpcomingReleases: () => ({ data: [] }),
}));

it('reopens saved picks locally and keeps them when a manual refresh fails', async () => {
  const status = vi.spyOn(tauriApi, 'chatGptStatus').mockResolvedValue({
    activeClient: 'client',
    accounts: [{ clientId: 'client', label: 'Test', planPermission: true }],
  });
  const read = vi.spyOn(tauriApi, 'recommendationsCached').mockResolvedValue({
    generatedAt: 1780000000,
    picks: [{ key: JSON.stringify(['series', 'test-series']), genreMatch: false }],
  });
  const rank = vi
    .spyOn(tauriApi, 'recommendationsGenerate')
    .mockRejectedValue('Test refresh failed.');
  const imdb = vi
    .spyOn(tauriApi, 'catalogIndexImdb')
    .mockResolvedValue({ id: 'tt1234567', rating: 8.5, votes: 12500 });
  const openSeries = vi.fn();
  const open = () =>
    render(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient()}>
          <RecommendationsList next={[]} onOpen={openSeries} />
        </QueryClientProvider>
      </MemoryRouter>,
    );
  try {
    const first = open();
    expect(await screen.findByRole('group', { name: 'Open The Fixture' })).toBeTruthy();
    expect(await screen.findByText('IMDb')).toBeTruthy();
    expect(screen.getByText('8.5')).toBeTruthy();
    expect(screen.getByTitle('IMDb rating 8.5 out of 10 from 12,500 votes')).toBeTruthy();
    expect(imdb).toHaveBeenCalledWith('series', 'test-series');
    first.unmount();
    open();
    const poster = await screen.findByRole('group', {
      name: 'Open The Fixture',
      description: 'Discover a series',
    });
    fireEvent.keyDown(poster, { key: 'Enter' });
    expect(openSeries).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'test-series' }),
      undefined,
    );
    expect(read).toHaveBeenCalledTimes(2);
    expect(rank).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh recommendations' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Test refresh failed.');
    await waitFor(() => expect(rank).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('group', { name: 'Open The Fixture' })).toBeTruthy();
  } finally {
    status.mockRestore();
    read.mockRestore();
    rank.mockRestore();
    imdb.mockRestore();
  }
});

it('loads saved Home cards only when the row is enabled', async () => {
  const status = vi.spyOn(tauriApi, 'chatGptStatus').mockResolvedValue({
    activeClient: 'client',
    accounts: [{ clientId: 'client', label: 'Test', planPermission: true }],
  });
  const read = vi.spyOn(tauriApi, 'recommendationsCached').mockResolvedValue({
    generatedAt: 1780000000,
    picks: [{ key: JSON.stringify(['series', 'test-series']), genreMatch: false }],
  });
  const generate = vi.spyOn(tauriApi, 'recommendationsGenerate');
  const imdb = vi
    .spyOn(tauriApi, 'catalogIndexImdb')
    .mockResolvedValue({ id: 'tt1234567', rating: 8.5, votes: 12500 });
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  try {
    const { result, rerender } = renderHook(
      ({ enabled }) => useSeriesRecommendations([], enabled),
      { initialProps: { enabled: false }, wrapper },
    );
    expect(status).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(imdb).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await waitFor(() =>
      expect(result.current.cards[0]?.item).toMatchObject({
        id: 'test-series',
        imdbRating: 8.5,
        imdbVotes: 12500,
      }),
    );
    expect(read).toHaveBeenCalledOnce();
    expect(generate).not.toHaveBeenCalled();
    rerender({ enabled: false });
    expect(result.current.cards).toEqual([]);
  } finally {
    status.mockRestore();
    read.mockRestore();
    generate.mockRestore();
    imdb.mockRestore();
  }
});
