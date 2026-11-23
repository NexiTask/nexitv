// @vitest-environment happy-dom

import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { LiveTvViewToggle } from '@/modules/catalog/components/LiveTvViewToggle';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sidebar } from '@/app/shell/Sidebar';
import { useLibraryStore } from '@/modules/library/store/useLibraryStore';
import { useSettingsStore } from '@/modules/settings/store/useSettingsStore';
import { trackDataActivity, type ReportDataProgress } from '@/shared/lib/dataActivity';

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
    });
  });

  it('shows ongoing data tasks above Settings and clears them as they finish', async () => {
    useSettingsStore.setState({ sidebarCollapsed: false });
    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );

    const settings = screen.getByRole('link', { name: 'Settings' });
    const status = screen.getByRole('status');
    let finishCatalog!: () => void;
    let failIndex!: (error: Error) => void;
    let reportIndex!: ReportDataProgress;

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
          (reportProgress) =>
            new Promise<void>((_, reject) => {
              failIndex = reject;
              reportIndex = reportProgress;
            }),
        );
      });
      expect(status.textContent).toBe('');

      act(() => vi.advanceTimersByTime(400));
      const activeLabel = 'Loading the provider catalog… Preparing the library index…';
      expect(status.textContent).toBe(activeLabel);
      expect(status.nextElementSibling?.contains(settings)).toBe(true);

      act(() => useSettingsStore.setState({ sidebarCollapsed: true }));
      expect(screen.getByTitle(activeLabel).textContent).toBe(activeLabel);

      act(() => reportIndex(25));
      expect(status.textContent).toBe('Loading the provider catalog… Indexing titles… 25%');

      await act(async () => {
        finishCatalog();
        await catalog;
      });
      expect(status.textContent).toBe('Indexing titles… 25%');
      act(() => reportIndex(null));
      expect(status.textContent).toBe('Preparing the library index…');

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

    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );

    const link = screen.getByRole('link', { name: 'Continue Watching, 1 item' });
    expect(link.getAttribute('title')).toBe('Continue Watching (1)');
    expect(link.querySelector('[class*="collapsedBadge"]')?.textContent).toBe('1');
  });

  it('can hide collapsed library counts without changing their accessible labels', () => {
    useSettingsStore.setState({ sidebarCollapsed: true, showCollapsedSidebarBadges: false });

    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );

    const link = screen.getByRole('link', { name: 'Continue Watching, 1 item' });
    expect(link.getAttribute('title')).toBe('Continue Watching (1)');
    expect(document.querySelector('aside')?.className).not.toContain('showCollapsedBadges');
  });

  it('shows the restrained inline count when the sidebar is expanded', () => {
    useSettingsStore.setState({ sidebarCollapsed: false });

    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: /Continue Watching/ }).textContent).toContain('1');
    // Seasonal decorations only rest on the full-width footer.
    expect(document.querySelector('[data-seasonal-decor="sidebar-footer"]')).toBeTruthy();
  });

  it('keeps collapsed navigation links accessible after their labels leave the rail', () => {
    useSettingsStore.setState({ sidebarCollapsed: true });

    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: 'Home' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Settings' })).toBeTruthy();
  });

  it('uses one explicit sidebar toggle and keeps the wordmark decorative', () => {
    useSettingsStore.setState({ sidebarCollapsed: false });

    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );

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

  it('hides the Coming Up workspace when its master preference is disabled', () => {
    useSettingsStore.setState({ upcomingEnabled: false, sidebarCollapsed: false });

    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );

    expect(screen.queryByRole('link', { name: 'Coming Up' })).toBeNull();
  });

  it('uses the compact rail without changing the saved normal-width preference', () => {
    setCompactViewport(true);
    useSettingsStore.setState({ sidebarCollapsed: false });

    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );

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
    render(
      <MemoryRouter initialEntries={['/epg']}>
        <Sidebar />
      </MemoryRouter>,
    );
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
