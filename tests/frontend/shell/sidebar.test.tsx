// @vitest-environment happy-dom

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { LiveTvViewToggle } from '@/modules/catalog/components/LiveTvViewToggle';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sidebar } from '@/app/shell/Sidebar';
import { useLibraryStore } from '@/modules/library/store/useLibraryStore';
import { useSettingsStore } from '@/modules/settings/store/useSettingsStore';
import {
  trackDataActivity,
  type ReportDataProgress,
  type ReportActivityDetail,
} from '@/shared/lib/dataActivity';

function renderSidebar(path = '/') {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Sidebar />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Sidebar', () => {
  const originalMatchMedia = window.matchMedia;

  beforeEach(() => {
    useLibraryStore.setState({
      history: [
        {
          id: 'history-1',
          title: 'Movie',
          type: 'vod',
          posterUrl: '',
          progressPercentage: 42,
          lastWatchedAt: 1,
        },
      ],
      favorites: [],
      collections: [],
      trackedSeries: {},
      watched: [],
    });
  });

  it('shows ongoing data tasks above Settings and clears them as they finish', async () => {
    useSettingsStore.setState({ sidebarCollapsed: false });
    renderSidebar();

    const settings = screen.getByRole('link', { name: 'Settings' });
    const status = screen.getByRole('status');
    let finishCatalog!: () => void;
    let failIndex!: (error: Error) => void;
    let reportIndex!: ReportDataProgress;
    let reportIndexDetail!: ReportActivityDetail;

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      act(() => {
        void trackDataActivity(
          'guide',
          () => new Promise<void>((resolve) => window.setTimeout(resolve, 100)),
        );
      });
      await act(() => vi.advanceTimersByTimeAsync(100));
      act(() => vi.advanceTimersByTime(400));
      expect(status.textContent).toBe('');

      let catalog!: Promise<void>;
      let index!: Promise<void>;
      act(() => {
        catalog = trackDataActivity(
          'catalog',
          () =>
            new Promise<void>((resolve) => {
              finishCatalog = resolve;
            }),
        );
        index = trackDataActivity(
          'index',
          (reportProgress, reportDetail) =>
            new Promise<void>((_, reject) => {
              failIndex = reject;
              reportIndex = reportProgress;
              reportIndexDetail = reportDetail;
            }),
        );
      });
      expect(status.textContent).toBe('');

      act(() => vi.advanceTimersByTime(400));
      expect(screen.getByText('Loading the provider catalog…')).toBeTruthy();
      expect(screen.getByText('Preparing the library index…')).toBeTruthy();
      expect(screen.queryByRole('progressbar')).toBeNull();
      expect(status.nextElementSibling?.contains(settings)).toBe(true);

      act(() => useSettingsStore.setState({ sidebarCollapsed: true }));
      expect(screen.getByTitle('Loading the provider catalog…')).toBeTruthy();

      act(() => {
        reportIndex(25);
        reportIndexDetail({ phase: 'index-titles', kind: 'vod', completed: 1000, total: 4000 });
      });
      const progress = screen.getByRole('progressbar', { name: 'Indexing titles…' });
      expect(progress.getAttribute('aria-valuenow')).toBe('25');
      expect(
        screen
          .getByTitle('Indexing titles… · 25% · Movies · 1,000 of 4,000 titles indexed')
          .contains(progress),
      ).toBe(true);
      expect(screen.getByText('25%')).toBeTruthy();

      await act(async () => {
        finishCatalog();
        await catalog;
      });
      expect(screen.queryByText('Loading the provider catalog…')).toBeNull();
      expect(screen.getByRole('progressbar', { name: 'Indexing titles…' })).toBe(progress);
      act(() => {
        reportIndex(null);
        reportIndexDetail({ phase: 'sort-titles', kind: 'vod' });
      });
      expect(screen.getByText('Preparing the library index…')).toBeTruthy();
      expect(screen.getByText('Movies · Sorting titles by name')).toBeTruthy();
      expect(screen.queryByRole('progressbar')).toBeNull();

      await act(async () => {
        const error = new Error('Index unavailable');
        failIndex(error);
        await expect(index).rejects.toBe(error);
      });
      expect(status.textContent).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows a collapsed library count while announcing its full label', () => {
    useSettingsStore.setState({ sidebarCollapsed: true, showCollapsedSidebarBadges: true });

    renderSidebar();

    const link = screen.getByRole('link', { name: 'Continue Watching, 1 item' });
    expect(link.getAttribute('title')).toBe('Continue Watching (1)');
    expect(link.querySelector('[class*="collapsedBadge"]')?.textContent).toBe('1');
  });

  it('counts the Watch Next queue separately and updates after dismissal', () => {
    useSettingsStore.setState({ sidebarCollapsed: false });
    const episode = {
      id: 'queued-show',
      title: 'Queued show',
      type: 'series' as const,
      posterUrl: '',
      episodeId: 'next-episode',
      seasonNum: 2,
      episodeNum: 8,
      progressPercentage: 0,
      lastWatchedAt: 2,
    };
    useLibraryStore.setState(({ history }) => ({
      history: [episode, { ...episode, id: 'paused-show', currentTime: 120 }, ...history],
    }));
    renderSidebar('/watch-next');

    const watchNext = screen.getByRole('link', { name: 'Watch Next' });
    expect(watchNext.getAttribute('href')).toBe('/watch-next');
    expect(watchNext.getAttribute('aria-current')).toBe('page');
    expect(watchNext.querySelector('[class*="badge"]')?.textContent).toBe('1');
    const resume = screen.getByRole('link', { name: 'Continue Watching' });
    expect(resume.getAttribute('href')).toBe('/continue');
    expect(resume.querySelector('[class*="badge"]')?.textContent).toBe('2');

    act(() =>
      useSettingsStore.setState({ sidebarCollapsed: true, showCollapsedSidebarBadges: true }),
    );
    expect(screen.getByRole('link', { name: 'Watch Next, 1 item' })).toBe(watchNext);
    expect(watchNext.querySelector('[class*="collapsedBadge"]')?.textContent).toBe('1');

    act(() => useLibraryStore.getState().dismissWatchNext(episode.id));
    expect(screen.getByRole('link', { name: 'Watch Next' })).toBe(watchNext);
    expect(watchNext.querySelector('[class*="collapsedBadge"]')).toBeNull();
  });

  it('can hide collapsed library counts without changing their accessible labels', () => {
    useSettingsStore.setState({ sidebarCollapsed: true, showCollapsedSidebarBadges: false });

    renderSidebar();

    const link = screen.getByRole('link', { name: 'Continue Watching, 1 item' });
    expect(link.getAttribute('title')).toBe('Continue Watching (1)');
    expect(document.querySelector('aside')?.className).not.toContain('showCollapsedBadges');
  });

  it('shows the restrained inline count when the sidebar is expanded', () => {
    useSettingsStore.setState({ sidebarCollapsed: false });

    renderSidebar();

    expect(screen.getByRole('link', { name: /Continue Watching/ }).textContent).toContain('1');
    // Seasonal decorations only rest on the full-width footer.
    expect(document.querySelector('[data-seasonal-decor="sidebar-footer"]')).toBeTruthy();
  });

  it('keeps collapsed navigation links accessible after their labels leave the rail', () => {
    useSettingsStore.setState({ sidebarCollapsed: true });

    renderSidebar();

    expect(screen.getByRole('link', { name: 'Home' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Settings' })).toBeTruthy();
  });

  it('uses one explicit sidebar toggle and keeps the wordmark decorative', () => {
    useSettingsStore.setState({ sidebarCollapsed: false });

    renderSidebar();

    expect(screen.getByRole('complementary', { name: 'Primary navigation' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Collapse sidebar' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Expand sidebar' })).toBeNull();
  });

  afterEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: originalMatchMedia,
    });
  });

  function setCompactViewport(matches: boolean) {
    const mediaQuery = {
      matches,
      media: '(max-width: 640px)',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } satisfies MediaQueryList;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn(() => mediaQuery),
    });
    return mediaQuery;
  }

  it('puts Continue Watching and Watch Next first in the Library', () => {
    useSettingsStore.setState({ upcomingEnabled: true, sidebarCollapsed: false });

    renderSidebar();

    const library = within(screen.getByRole('navigation', { name: 'Library' }));
    expect(library.getAllByRole('link').slice(0, 3)).toEqual([
      library.getByRole('link', { name: 'Continue Watching' }),
      library.getByRole('link', { name: 'Watch Next' }),
      library.getByRole('link', { name: 'Coming Up' }),
    ]);
  });

  it('hides the Coming Up workspace when its master preference is disabled', () => {
    useSettingsStore.setState({ upcomingEnabled: false, sidebarCollapsed: false });

    renderSidebar();

    expect(screen.queryByRole('link', { name: 'Coming Up' })).toBeNull();
  });

  it('uses the compact rail without changing the saved normal-width preference', () => {
    setCompactViewport(true);
    useSettingsStore.setState({ sidebarCollapsed: false });

    renderSidebar();

    expect(document.querySelector('aside')?.className).toContain('collapsed');
    expect(document.querySelector('[data-seasonal-decor]')).toBeNull();
    expect(screen.getByRole('link', { name: 'Home' }).getAttribute('title')).toBe('Home');
    expect(
      (
        screen.getByRole('button', {
          name: 'Sidebar stays compact in narrow layouts',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(useSettingsStore.getState().sidebarCollapsed).toBe(false);
  });
});

describe('Live TV holds the guide', () => {
  beforeEach(() => {
    useSettingsStore.setState({ sidebarCollapsed: false, liveTvView: 'channels' });
  });

  it('has no separate TV Guide entry and stays highlighted on the guide', () => {
    useSettingsStore.setState({ liveTvView: 'guide' });
    renderSidebar('/epg');
    expect(screen.queryByRole('link', { name: 'TV Guide' })).toBeNull();
    const live = screen.getByRole('link', { name: 'Live TV' });
    expect(live.getAttribute('href')).toBe('/epg');
    expect(live.className).toContain('active');
  });

  it('switches views with the toggle and remembers the choice', () => {
    function Where() {
      return <span data-testid="where">{useLocation().pathname}</span>;
    }
    render(
      <MemoryRouter initialEntries={['/live']}>
        <LiveTvViewToggle view="channels" />
        <Where />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('radio', { name: 'Guide' }));
    expect(screen.getByTestId('where').textContent).toBe('/epg');
    expect(useSettingsStore.getState().liveTvView).toBe('channels');
  });
});
