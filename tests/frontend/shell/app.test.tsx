// @vitest-environment happy-dom

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/app/shell/Sidebar', () => ({
  Sidebar: () => <nav aria-label="Mock sidebar">Mock sidebar</nav>,
}));
vi.mock('@/modules/playback/components/PlayerShell', () => ({
  PlayerShell: () => null,
}));
vi.mock('@/shared/ui/ToastContainer', () => ({
  ToastContainer: () => null,
}));
vi.mock('@/app/components/ConnectionStatus', () => ({
  ConnectionStatus: () => null,
}));
vi.mock('@/shared/ui/ContextMenu', () => ({
  ContextMenu: () => null,
}));
vi.mock('@/modules/onboarding/components/OnboardingFlow', () => ({
  OnboardingFlow: () => <div>Mock onboarding</div>,
}));
vi.mock('@/app/components/ShortcutHelperDialog', () => ({
  ShortcutHelperDialog: ({ onClose }: { onClose: () => void }) => (
    <button onClick={onClose}>Mock shortcuts</button>
  ),
}));
vi.mock('@/modules/playback/hooks/usePlayerContextMenus', () => ({
  usePlayerContextMenus: () => ({ handleAppBackdropContextMenu: vi.fn() }),
}));
vi.mock('@/modules/downloads/hooks/useDownloadEvents', () => ({
  useDownloadEvents: vi.fn(),
}));
vi.mock('@/modules/guide/data/useUpcomingReleases', () => ({
  useUpcomingReleases: () => ({ data: [], dataUpdatedAt: 0, isLoading: false, refetch: vi.fn() }),
}));
vi.mock('@/modules/catalog/pages/HomePage', () => ({
  HomePage: () => <div>Mock home</div>,
}));
vi.mock('@/modules/search/pages/SearchPage', () => ({
  SearchPage: () => <div>Mock search</div>,
}));

import App from '@/app/App';
import { preloadRouteModule } from '@/app/router/routeModules';
import { useDownloadStore } from '@/modules/downloads/store/useDownloadStore';
import { useLibraryStore } from '@/modules/library/store/useLibraryStore';
import { useAuthStore } from '@/modules/sources/store/useAuthStore';
import { useSettingsStore } from '@/modules/settings/store/useSettingsStore';
import { useSourceStore } from '@/modules/sources/store/useSourceStore';

beforeEach(() => {
  Object.defineProperty(window, 'requestIdleCallback', {
    configurable: true,
    value: vi.fn(() => 1),
  });
  Object.defineProperty(window, 'cancelIdleCallback', {
    configurable: true,
    value: vi.fn(),
  });
  window.history.replaceState({}, '', '/');
  useDownloadStore.setState({ jobs: [], downloadedByLibraryId: {} });
  useLibraryStore.setState({
    savedItems: [],
    favorites: [],
    collections: [],
    history: [],
    trackedSeries: {},
    watched: [],
  });
  useSettingsStore.getState().resetSettings();
  useSettingsStore.setState({ onboardingDismissed: true });
  useAuthStore.setState({
    isInitializing: false,
    initializationError: null,
    initialize: vi.fn().mockResolvedValue(undefined),
  });
  useSourceStore.setState({
    isInitializing: false,
    initializationError: null,
    initialize: vi.fn().mockResolvedValue(undefined),
    refreshStaleSources: vi.fn().mockResolvedValue(undefined),
  });
});

describe('application shell', () => {
  it('opens the unified list from the former Library route with Smart Recommendations disabled', async () => {
    await preloadRouteModule('/library');
    const show = { id: 'saved-show', title: 'Saved Show', posterUrl: '', type: 'series' as const };
    useLibraryStore.setState({ savedItems: [show] });
    useSettingsStore.setState({
      recommendationsEnabled: false,
      lastCollectionId: 'recommendations',
    });
    window.history.replaceState({}, '', '/library/automated-recommendations');
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Recommendations', level: 1 })).toBeTruthy();
    expect(window.location.pathname).toBe('/library/recommendations');
    expect(screen.queryByRole('button', { name: 'Get recommendations' })).toBeNull();
    expect(
      screen.getByRole('group', {
        name: 'Open Saved Show',
        description: 'Recommended from your Library',
      }),
    ).toBeTruthy();
    act(() => useLibraryStore.getState().setSeriesStarted(show.id, true, show));
    expect(screen.getByRole('heading', { name: 'No recommendations to show' })).toBeTruthy();
  });

  it('moves the existing Favorites page into Library and keeps the list permanent', async () => {
    await preloadRouteModule('/library');
    const movie = {
      id: 'favorite-film',
      title: 'Favorite film',
      posterUrl: '',
      type: 'vod' as const,
    };
    const collection = { id: 'weekend', name: 'Weekend', items: [movie] };
    useLibraryStore.setState({ favorites: [movie], collections: [collection] });
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
    useSettingsStore.setState({ lastCollectionId: collection.id });
    window.history.replaceState({}, '', '/favorites');
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Favorites', level: 1 })).toBeTruthy();
    expect(window.location.pathname).toBe('/library/favorites');
    const library = within(screen.getByRole('complementary', { name: 'Library' }));
    const favorites = library.getByRole('link', { name: 'Favorites' });
    const weekend = library.getByRole('link', { name: 'Weekend' });
    const saved = library.getByRole('link', { name: 'Saved' });
    expect(library.getAllByRole('link')).toEqual([
      library.getByRole('link', { name: 'Continue Watching' }),
      library.getByRole('link', { name: 'Watch Next' }),
      library.getByRole('link', { name: 'Recommendations' }),
      saved,
      favorites,
      library.getByRole('link', { name: 'Downloads' }),
      weekend,
    ]);
    expect(favorites.getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('group', { name: 'Open Favorite film' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Rename Collection' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete Collection' })).toBeNull();

    await user.click(weekend);
    expect(await screen.findByRole('heading', { name: 'Weekend', level: 1 })).toBeTruthy();
    const card = screen.getByRole('group', { name: 'Open Favorite film' });
    await user.hover(card);
    await user.click(within(card).getByRole('button', { name: 'Remove from Favorites' }));
    expect(useLibraryStore.getState().favorites).toEqual([]);
    expect(useLibraryStore.getState().savedItems).toEqual([movie]);
    expect(useLibraryStore.getState().collections[0]?.items).toEqual([movie]);
    await user.click(within(card).getByRole('button', { name: 'Add to Favorites' }));
    expect(useLibraryStore.getState().savedItems).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Delete Collection' }));
    const confirmation = within(screen.getByRole('alertdialog', { name: 'Delete Collection?' }));
    await user.click(confirmation.getByRole('button', { name: 'Delete Collection' }));

    expect(await screen.findByRole('heading', { name: 'Saved', level: 1 })).toBeTruthy();
    expect(window.location.pathname).toBe('/library/saved');
    const activeLibrary = within(screen.getByRole('complementary', { name: 'Library' }));
    const activeSaved = activeLibrary.getByRole('link', { name: 'Saved' });
    const activeFavorites = activeLibrary.getByRole('link', { name: 'Favorites' });
    expect(activeLibrary.queryByRole('link', { name: 'Weekend' })).toBeNull();
    expect(activeSaved.getAttribute('aria-current')).toBe('page');
    expect(useLibraryStore.getState().favorites).toEqual([movie]);
    expect(screen.queryByRole('button', { name: 'Delete Collection' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'No saved items' })).toBeTruthy();

    await user.click(activeFavorites);
    expect(await screen.findByRole('heading', { name: 'Favorites', level: 1 })).toBeTruthy();
    const favoriteCard = screen.getByRole('group', { name: 'Open Favorite film' });
    await user.hover(favoriteCard);
    await user.click(within(favoriteCard).getByRole('button', { name: 'Remove from Favorites' }));
    expect(screen.getByRole('heading', { name: 'Your Favorites Are Empty' })).toBeTruthy();

    await user.click(activeSaved);
    expect(await screen.findByRole('heading', { name: 'Saved', level: 1 })).toBeTruthy();
    const savedCard = screen.getByRole('group', { name: 'Open Favorite film' });
    await user.hover(savedCard);
    await user.click(within(savedCard).getByRole('button', { name: 'Add to Favorites' }));
    expect(screen.getByRole('heading', { name: 'No saved items' })).toBeTruthy();
    expect(useLibraryStore.getState().favorites).toEqual([movie]);
  });

  it('opens Saved by default when Library has no last selected list', async () => {
    await preloadRouteModule('/library');
    window.history.replaceState({}, '', '/library');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Saved', level: 1 })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'No saved items' })).toBeTruthy();
    expect(window.location.pathname).toBe('/library/saved');
  });

  it('opens the saved custom list from the old Collections route and selects a new list by ID', async () => {
    await preloadRouteModule('/library');
    const collection = { id: 'weekend', name: 'Weekend', items: [] };
    useLibraryStore.setState({ collections: [collection] });
    useSettingsStore.setState({ lastCollectionId: collection.id });
    window.history.replaceState({}, '', '/collections');
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Weekend', level: 1 })).toBeTruthy();
    expect(window.location.pathname).toBe('/library/weekend');
    await user.click(screen.getByRole('button', { name: 'Create Collection' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Create new collection' }));
    await user.type(dialog.getByRole('textbox', { name: 'Collection name' }), collection.name);
    await user.click(dialog.getByRole('button', { name: 'Create Collection' }));

    const [first, created] = useLibraryStore.getState().collections;
    expect(first).toEqual(collection);
    expect(created?.name).toBe(collection.name);
    expect(window.location.pathname).toBe(`/library/${created?.id}`);
    expect(useSettingsStore.getState().lastCollectionId).toBe(created?.id);
  });

  it('opens the legacy Watch Next route in Library and keeps playback counts and actions separate', async () => {
    await preloadRouteModule('/library/watch-next');
    const queued = {
      id: 'queued',
      title: 'Queued show',
      type: 'series' as const,
      posterUrl: '',
      lastWatchedAt: 2,
      seasonNum: 2,
      episodeNum: 8,
      progressPercentage: 0,
    };
    useLibraryStore.setState({
      history: [queued, { ...queued, id: 'resuming', progressPercentage: 20 }],
    });
    window.history.replaceState({}, '', '/watch-next');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Watch Next' })).toBeTruthy();
    expect(window.location.pathname).toBe('/library/watch-next');
    const library = within(screen.getByRole('complementary', { name: 'Library' }));
    const watchNext = library.getByRole('link', { name: 'Watch Next' });
    const continueWatching = library.getByRole('link', { name: 'Continue Watching' });
    expect(watchNext.getAttribute('aria-current')).toBe('page');
    expect(within(watchNext).getByText('1')).toBeTruthy();
    expect(within(continueWatching).getByText('1')).toBeTruthy();
    expect(screen.getByText('1 episode')).toBeTruthy();
    act(() => useLibraryStore.getState().dismissWatchNext(queued.id));
    expect(screen.getByRole('heading', { name: 'No Next Episodes' })).toBeTruthy();
    expect(within(watchNext).getByText('0')).toBeTruthy();
    expect(within(continueWatching).getByText('1')).toBeTruthy();

    const user = userEvent.setup();
    await user.click(continueWatching);
    expect(await screen.findByRole('heading', { name: 'Continue Watching' })).toBeTruthy();
    expect(window.location.pathname).toBe('/library/continue');
    expect(screen.getByText('1 item to resume')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Clear all watch history' }));
    const confirmation = within(screen.getByRole('alertdialog', { name: 'Clear Watch History?' }));
    await user.click(confirmation.getByRole('button', { name: 'Clear History' }));
    expect(screen.getByRole('heading', { name: 'No Watch History' })).toBeTruthy();
  });

  it('redirects the old Continue Watching route into Library', async () => {
    await preloadRouteModule('/library/continue');
    window.history.replaceState({}, '', '/continue');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Continue Watching' })).toBeTruthy();
    expect(window.location.pathname).toBe('/library/continue');
  });

  it('opens the Coming Up calendar in Library and hides its link when disabled', async () => {
    await preloadRouteModule('/library/upcoming');
    window.history.replaceState({}, '', '/upcoming');
    useLibraryStore.setState({
      favorites: [{ id: 'show', title: 'Example Show', posterUrl: '', type: 'series' }],
    });
    useSettingsStore.setState({
      upcomingEnabled: true,
      upcomingCalendarEnabled: true,
      tmdbEnabled: true,
      tmdbApiKey: 'fixture',
    });
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Coming Up', level: 1 })).toBeTruthy();
    expect(window.location.pathname).toBe('/library/upcoming');
    const library = within(screen.getByRole('complementary', { name: 'Library' }));
    expect(library.getAllByRole('link').map((link) => link.getAttribute('aria-label'))).toEqual([
      'Continue Watching',
      'Watch Next',
      'Coming Up',
      'Recommendations',
      'Saved',
      'Favorites',
      'Downloads',
    ]);
    expect(library.getByRole('link', { name: 'Coming Up' }).getAttribute('aria-current')).toBe(
      'page',
    );

    await user.click(screen.getByRole('radio', { name: 'Calendar' }));
    expect(screen.getByRole('region', { name: 'Release calendar' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Next month' }));

    act(() => useSettingsStore.setState({ upcomingCalendarEnabled: false }));
    expect(screen.queryByRole('radio', { name: 'Calendar' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Release calendar' })).toBeNull();

    act(() => useSettingsStore.setState({ upcomingEnabled: false }));
    expect(library.queryByRole('link', { name: 'Coming Up' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Coming Up is disabled' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Open Settings' }));
    await waitFor(() => expect(window.location.search).toBe('?section=coming-up'));
  });

  it('opens the previous Downloads route inside Library with the current queue', async () => {
    await preloadRouteModule('/library/downloads');
    useDownloadStore.getState().enqueue({
      id: 'download-1',
      fileName: 'Saved film.mp4',
      sourceUrl: 'https://media.test/video.mp4',
    });
    window.history.replaceState({}, '', '/downloads');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Downloads', level: 1 })).toBeTruthy();
    expect(window.location.pathname).toBe('/library/downloads');
    const library = within(screen.getByRole('complementary', { name: 'Library' }));
    const downloads = library.getByRole('link', { name: 'Downloads' });
    expect(downloads.getAttribute('aria-current')).toBe('page');
    expect(within(downloads).getByText('1')).toBeTruthy();
    expect(screen.getByText('Saved film.mp4')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Downloading' })).toBeTruthy();
  });

  it('restores M3U and Xtream sources in parallel', async () => {
    let resolveSources!: () => void;
    let resolveAuth!: () => void;
    const initializeSources = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSources = resolve;
        }),
    );
    const initializeAuth = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveAuth = resolve;
        }),
    );
    useSourceStore.setState({ initialize: initializeSources });
    useAuthStore.setState({ initialize: initializeAuth });

    render(<App />);

    await waitFor(() => {
      expect(initializeSources).toHaveBeenCalledOnce();
      expect(initializeAuth).toHaveBeenCalledOnce();
    });
    resolveSources();
    resolveAuth();
  });

  it('renders the workspace while saved sources are restored in the background', async () => {
    useSourceStore.setState({ isInitializing: true });

    render(<App />);

    expect(await screen.findByText('Mock home')).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Mock sidebar' })).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('synchronizes theme changes to the document immediately', async () => {
    render(<App />);
    await screen.findByText('Mock home');

    expect(document.documentElement.dataset.theme).toBe('dark');

    act(() => useSettingsStore.getState().updateSetting('themePreference', 'light'));

    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe('light');
      expect(document.documentElement.style.colorScheme).toBe('light');
    });
  });

  it('switches the seasonal look on at local midnight and keeps it off the light theme', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
      vi.setSystemTime(new Date(2026, 10, 30, 23, 59, 50));
      render(<App />);
      await screen.findByText('Mock home');
      expect(document.documentElement.dataset.season).toBeUndefined();

      act(() => vi.advanceTimersByTime(10_000));
      await waitFor(() => expect(document.documentElement.dataset.season).toBe('christmas'));
      expect(document.documentElement.style.getPropertyValue('--accent-color')).toBe('#d93a49');

      act(() => useSettingsStore.getState().updateSetting('themePreference', 'light'));
      await waitFor(() => expect(document.documentElement.dataset.season).toBeUndefined());
      expect(document.documentElement.style.getPropertyValue('--accent-color')).toBe(
        useSettingsStore.getState().accentColor,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores the main workspace and routes global keyboard shortcuts', async () => {
    render(<App />);

    expect(await screen.findByText('Mock home')).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Mock sidebar' })).toBeTruthy();

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(await screen.findByText('Mock search')).toBeTruthy();
  });

  it('toggles the shortcut helper without reacting inside editable controls', async () => {
    render(<App />);
    await screen.findByText('Mock home');

    fireEvent.keyDown(window, { key: '?' });
    expect(await screen.findByRole('button', { name: 'Mock shortcuts' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Mock shortcuts' }));
    expect(screen.queryByRole('button', { name: 'Mock shortcuts' })).toBeNull();

    const input = document.createElement('input');
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: '?' });
    expect(screen.queryByRole('button', { name: 'Mock shortcuts' })).toBeNull();
    input.remove();
  });
});
