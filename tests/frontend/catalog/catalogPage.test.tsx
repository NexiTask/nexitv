import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Film } from 'lucide-react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CatalogPage } from '@/modules/catalog/components/CatalogPage';
import { useAuthStore } from '@/modules/sources/store/useAuthStore';
import { useSourceStore } from '@/modules/sources/store/useSourceStore';
import * as catalogApi from '@/modules/catalog/data/useCatalog';
import * as categoriesApi from '@/modules/catalog/data/useCategories';
import * as enabledSourcesHook from '@/modules/sources/hooks/useEnabledSources';
import { useSettingsStore } from '@/modules/settings/store/useSettingsStore';
import type { MediaItem } from '@/modules/catalog/model/media';
import { desktopApi } from '@/platform/desktop';
import { decodeCatalogPage, tauriApi } from '@/platform/tauri';

const tmdb = vi.hoisted(() => ({
  searchTmdbTitles: vi.fn(),
  getTmdbMovie: vi.fn(),
  getTmdbTv: vi.fn(),
}));
vi.mock('@/modules/metadata/data/tmdbClient', () => tmdb);

vi.mock('@/modules/catalog/components/VirtualizedGrid', () => ({
  VirtualizedGrid: ({
    items,
    count,
    getItem,
    onItemClick,
  }: {
    items?: Array<{ id: string; title: string }>;
    count?: number;
    getItem?: (index: number) => { id: string; title: string } | undefined;
    onItemClick?: (item: { id: string; title: string }) => void;
  }) => (
    <div data-testid="virtualized-grid">
      {(
        items ??
        Array.from({ length: count ?? 0 }, (_, index) => getItem?.(index)).filter(
          (item): item is { id: string; title: string } => Boolean(item),
        )
      ).map((item) => (
        <button key={item.id} onClick={() => onItemClick?.(item)}>
          {item.title}
        </button>
      ))}
    </div>
  ),
}));

describe('CatalogPage component', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    useAuthStore.setState({ profiles: [], runtimes: {} });
    useSourceStore.setState({ profiles: [], enabledSourceIds: [], runtimes: {} });
    useSettingsStore.getState().resetSettings();
    vi.restoreAllMocks();

    vi.spyOn(enabledSourcesHook, 'useEnabledSources').mockReturnValue({
      enabledSourceIds: ['src-1'],
      xtreamEnabled: true,
      xtreamAvailable: true,
      xtreamSources: [],
      availableXtreamSources: [],
      m3uSources: [],
      availableM3uSources: [],
      isAvailable: true,
      isLoading: false,
      errors: [],
      queryScope: 'all',
    });
  });

  const renderWithProviders = (ui: React.ReactElement) => {
    return render(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>{ui}</BrowserRouter>
      </QueryClientProvider>,
    );
  };

  it('renders catalog page with items, header, and search', async () => {
    const mockItems: MediaItem[] = [
      { id: 'm1', title: 'The Matrix', posterUrl: '', type: 'vod', categoryId: 'cat-1' },
      { id: 'm2', title: 'The Matrix Reloaded', posterUrl: '', type: 'vod', categoryId: 'cat-1' },
    ];

    vi.spyOn(catalogApi, 'useCatalogByType').mockReturnValue({
      data: mockItems,
      isLoading: false,
      isError: false,
      error: null,
      isFetching: false,
      refetch: vi.fn(),
    } as any);

    vi.spyOn(categoriesApi, 'useCategories').mockReturnValue({
      data: [{ category_id: 'cat-1', category_name: 'Action' }],
      isLoading: false,
      isError: false,
      error: null,
      isFetching: false,
      refetch: vi.fn(),
    } as any);

    const onItemClick = vi.fn();

    renderWithProviders(
      <CatalogPage
        type="vod"
        title="Movies"
        icon={Film}
        emptyTitle="No Movies Found"
        emptyDescription="There are no movies in this category."
        noSourceDescription="Add a source to view movies."
        onItemClick={onItemClick}
      />,
    );

    expect(screen.getByRole('heading', { level: 1, name: 'Movies' })).toBeTruthy();
    expect(screen.getByText(/2 movies/i)).toBeTruthy();
    expect(screen.getByText('The Matrix')).toBeTruthy();
    expect(screen.getByText('The Matrix Reloaded')).toBeTruthy();
  });

  it('displays empty state when catalog is empty', async () => {
    vi.spyOn(catalogApi, 'useCatalogByType').mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null,
      isFetching: false,
      refetch: vi.fn(),
    } as any);

    vi.spyOn(categoriesApi, 'useCategories').mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null,
      isFetching: false,
      refetch: vi.fn(),
    } as any);

    renderWithProviders(
      <CatalogPage
        type="vod"
        title="Movies"
        icon={Film}
        emptyTitle="No Movies Found"
        emptyDescription="There are no movies in this category."
        noSourceDescription="Add a source to view movies."
        onItemClick={vi.fn()}
      />,
    );

    expect(screen.getByText('No Movies Found')).toBeTruthy();
    expect(screen.getByText('There are no movies in this category.')).toBeTruthy();
  });

  it('displays no source state when source is unavailable', async () => {
    vi.spyOn(enabledSourcesHook, 'useEnabledSources').mockReturnValue({
      enabledSourceIds: [],
      xtreamEnabled: false,
      xtreamAvailable: false,
      xtreamSources: [],
      availableXtreamSources: [],
      m3uSources: [],
      availableM3uSources: [],
      isAvailable: false,
      isLoading: false,
      errors: [],
      queryScope: 'none',
    });

    vi.spyOn(catalogApi, 'useCatalogByType').mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null,
      isFetching: false,
      refetch: vi.fn(),
    } as any);

    vi.spyOn(categoriesApi, 'useCategories').mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null,
      isFetching: false,
      refetch: vi.fn(),
    } as any);

    renderWithProviders(
      <CatalogPage
        type="vod"
        title="Movies"
        icon={Film}
        emptyTitle="No Movies Found"
        emptyDescription="There are no movies in this category."
        noSourceDescription="Add a source to view movies."
        onItemClick={vi.fn()}
      />,
    );

    expect(screen.getByText('No Source Available')).toBeTruthy();
    expect(screen.getByText('Add a source to view movies.')).toBeTruthy();
  });

  it('displays error state and retries on action click', async () => {
    const user = userEvent.setup();
    const refetchCatalog = vi.fn();

    vi.spyOn(catalogApi, 'useCatalogByType').mockReturnValue({
      data: [],
      isLoading: false,
      isError: true,
      error: new Error('Network failure'),
      isFetching: false,
      refetch: refetchCatalog,
    } as any);

    vi.spyOn(categoriesApi, 'useCategories').mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null,
      isFetching: false,
      refetch: vi.fn(),
    } as any);

    renderWithProviders(
      <CatalogPage
        type="vod"
        title="Movies"
        icon={Film}
        emptyTitle="No Movies Found"
        emptyDescription="There are no movies in this category."
        noSourceDescription="Add a source to view movies."
        onItemClick={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Try Again' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Try Again' }));
    expect(refetchCatalog).toHaveBeenCalledTimes(1);
  });

  it('filters catalog items using genre chips and applies sorting', async () => {
    const user = userEvent.setup();
    const mockItems: MediaItem[] = [
      {
        id: 'm1',
        title: 'Die Hard',
        genre: 'Action',
        added: '100',
        year: '1988',
        rating: 8.2,
        posterUrl: '',
        type: 'vod',
        categoryId: 'cat-1',
      },
      {
        id: 'm2',
        title: 'Airplane!',
        genre: 'Comedy',
        added: '200',
        year: '1980',
        rating: 7.7,
        posterUrl: '',
        type: 'vod',
        categoryId: 'cat-1',
      },
      {
        id: 'm3',
        title: 'The Matrix',
        genre: 'Action, Sci-Fi',
        added: '300',
        year: '1999',
        rating: 8.7,
        posterUrl: '',
        type: 'vod',
        categoryId: 'cat-1',
      },
    ];

    vi.spyOn(catalogApi, 'useCatalogByType').mockReturnValue({
      data: mockItems,
      isLoading: false,
      isError: false,
      error: null,
      isFetching: false,
      refetch: vi.fn(),
    } as any);

    vi.spyOn(categoriesApi, 'useCategories').mockReturnValue({
      data: [{ category_id: 'cat-1', category_name: 'All Movies' }],
      isLoading: false,
      isError: false,
      error: null,
      isFetching: false,
      refetch: vi.fn(),
    } as any);

    renderWithProviders(
      <CatalogPage
        type="vod"
        title="Movies"
        icon={Film}
        emptyTitle="No Movies Found"
        emptyDescription="There are no movies in this category."
        noSourceDescription="Add a source to view movies."
        onItemClick={vi.fn()}
      />,
    );

    // Initial state renders all 3 items
    expect(screen.getByText('Die Hard')).toBeTruthy();
    expect(screen.getByText('Airplane!')).toBeTruthy();
    expect(screen.getByText('The Matrix')).toBeTruthy();

    // Click 'Comedy' genre chip
    const comedyChip = screen.getByRole('button', { name: /Comedy/i });
    await user.click(comedyChip);

    // Only Comedy item remains
    expect(screen.getByText('Airplane!')).toBeTruthy();
    expect(screen.queryByText('Die Hard')).toBeNull();
    expect(screen.queryByText('The Matrix')).toBeNull();

    // Click 'All Genres' to reset
    const allGenresChip = screen.getByRole('button', { name: /All Genres/i });
    await user.click(allGenresChip);
    expect(screen.getByText('Die Hard')).toBeTruthy();
    expect(screen.getByText('Airplane!')).toBeTruthy();
    expect(screen.getByText('The Matrix')).toBeTruthy();
  });

  it('hides the quick genre bar when the setting is off', async () => {
    const mockItems: MediaItem[] = [
      {
        id: 'm1',
        title: 'Die Hard',
        genre: 'Action',
        added: '100',
        year: '1988',
        rating: 8.2,
        posterUrl: '',
        type: 'vod',
        categoryId: 'cat-1',
      },
    ];
    vi.spyOn(catalogApi, 'useCatalogByType').mockReturnValue({
      data: mockItems,
      isLoading: false,
      isError: false,
      error: null,
      isFetching: false,
      refetch: vi.fn(),
    } as any);
    vi.spyOn(categoriesApi, 'useCategories').mockReturnValue({
      data: [{ category_id: 'cat-1', category_name: 'All Movies' }],
      isLoading: false,
      isError: false,
      error: null,
      isFetching: false,
      refetch: vi.fn(),
    } as any);
    useSettingsStore.getState().updateSetting('catalogGenreBar', false);

    renderWithProviders(
      <CatalogPage
        type="vod"
        title="Movies"
        icon={Film}
        emptyTitle="No Movies Found"
        emptyDescription="There are no movies in this category."
        noSourceDescription="Connect a source."
        onItemClick={vi.fn()}
      />,
    );

    expect(await screen.findByText('Die Hard')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /All Genres/i })).toBeNull();
  });

  it('lists Top Rated best first whatever sort the catalogue is set to', () => {
    useSettingsStore.setState({
      tmdbEnabled: false,
      selectedCategoryIds: { live: null, vod: 'smart:top-rated', series: null },
      catalogSortModes: { live: 'default', vod: 'name-asc', series: 'default' },
    });
    const mockItems: MediaItem[] = [
      { id: 'a', title: 'Alpha', rating: 7.1, posterUrl: '', type: 'vod', categoryId: 'cat-1' },
      { id: 'b', title: 'Bravo', rating: 9.2, posterUrl: '', type: 'vod', categoryId: 'cat-1' },
      { id: 'c', title: 'Charlie', rating: 8.4, posterUrl: '', type: 'vod', categoryId: 'cat-1' },
      { id: 'd', title: 'Delta', rating: 6.2, posterUrl: '', type: 'vod', categoryId: 'cat-1' },
    ];
    vi.spyOn(catalogApi, 'useCatalogByType').mockReturnValue({
      data: mockItems,
      isLoading: false,
      isError: false,
      error: null,
      isFetching: false,
      refetch: vi.fn(),
    } as any);
    vi.spyOn(categoriesApi, 'useCategories').mockReturnValue({
      data: [{ category_id: 'cat-1', category_name: 'All Movies' }],
      isLoading: false,
      isError: false,
      error: null,
      isFetching: false,
      refetch: vi.fn(),
    } as any);

    renderWithProviders(
      <CatalogPage
        type="vod"
        title="Movies"
        icon={Film}
        emptyTitle="No Movies Found"
        emptyDescription="There are no movies in this category."
        noSourceDescription="Add a source to view movies."
        onItemClick={vi.fn()}
      />,
    );

    const grid = screen.getByTestId('virtualized-grid');
    expect([...grid.querySelectorAll('button')].map((button) => button.textContent)).toEqual([
      'Bravo',
      'Charlie',
      'Alpha',
    ]);
    const sort = screen.getByRole('button', { name: 'Sort catalog items' });
    expect(sort.textContent).toContain('Top Rated');
    expect((sort as HTMLButtonElement).disabled).toBe(true);
    // The catalogue's own sort choice is left alone for the other categories.
    expect(useSettingsStore.getState().catalogSortModes.vod).toBe('name-asc');
  });

  it('keeps TMDB corrections in Top Rated while switching genres', async () => {
    const user = userEvent.setup();
    const onTmdb: Record<string, { voteAverage: number; voteCount: number }> = {
      Bogus: { voteAverage: 4.8, voteCount: 212 },
      Laugh: { voteAverage: 8.1, voteCount: 500 },
      Boom: { voteAverage: 8.7, voteCount: 900 },
      Bang: { voteAverage: 7.6, voteCount: 300 },
    };
    tmdb.searchTmdbTitles.mockImplementation(async (_key, mediaType, title: string) => ({
      results: [
        {
          id: title.length,
          mediaType,
          title,
          originalTitle: null,
          releaseYear: null,
          genreIds: [],
          ...onTmdb[title],
        },
      ],
    }));
    useSettingsStore.setState({
      tmdbEnabled: true,
      tmdbApiKey: 'test-key',
      selectedCategoryIds: { live: null, vod: 'smart:top-rated', series: null },
    });
    const mockItems: MediaItem[] = [
      {
        id: 'bogus',
        title: 'Bogus',
        rating: 9.4,
        posterUrl: '',
        type: 'vod',
        categoryId: 'cat-comedy',
      },
      {
        id: 'laugh',
        title: 'Laugh',
        rating: 8,
        posterUrl: '',
        type: 'vod',
        categoryId: 'cat-comedy',
      },
      {
        id: 'boom',
        title: 'Boom',
        rating: 8.6,
        posterUrl: '',
        type: 'vod',
        categoryId: 'cat-action',
      },
      {
        id: 'bang',
        title: 'Bang',
        rating: 7.5,
        posterUrl: '',
        type: 'vod',
        categoryId: 'cat-action',
      },
    ];
    vi.spyOn(catalogApi, 'useCatalogByType').mockReturnValue({
      data: mockItems,
      isLoading: false,
      isError: false,
      error: null,
      isFetching: false,
      refetch: vi.fn(),
    } as any);
    vi.spyOn(categoriesApi, 'useCategories').mockReturnValue({
      data: [
        { category_id: 'cat-comedy', category_name: 'Comedy' },
        { category_id: 'cat-action', category_name: 'Action' },
      ],
      isLoading: false,
      isError: false,
      error: null,
      isFetching: false,
      refetch: vi.fn(),
    } as any);

    renderWithProviders(
      <CatalogPage
        type="vod"
        title="Movies"
        icon={Film}
        emptyTitle="No Movies Found"
        emptyDescription="There are no movies in this category."
        noSourceDescription="Add a source to view movies."
        onItemClick={vi.fn()}
      />,
    );

    const gridTitles = () =>
      within(screen.getByTestId('virtualized-grid'))
        .getAllByRole('button')
        .map((button) => button.textContent);
    const chip = (name: RegExp) =>
      within(screen.getByRole('group', { name: 'Filter by genre' })).getByRole('button', { name });

    await waitFor(() => expect(gridTitles()).toEqual(['Boom', 'Laugh', 'Bang']));
    expect(chip(/All Genres/).textContent).toBe('All Genres3');
    expect(chip(/Comedy/).textContent).toBe('Comedy1');

    await user.click(chip(/Action/));

    expect(gridTitles()).toEqual(['Boom', 'Bang']);
    // The corrected "Bogus" stays out of Top Rated in every other genre too.
    expect(chip(/All Genres/).textContent).toBe('All Genres3');
    expect(chip(/Comedy/).textContent).toBe('Comedy1');
    expect(tmdb.searchTmdbTitles).toHaveBeenCalledTimes(4);

    await user.click(chip(/Comedy/));
    expect(gridTitles()).toEqual(['Laugh']);
  });

  it('filters Top Rated films by the genres TMDB names when their categories name none', async () => {
    const user = userEvent.setup();
    const onTmdb: Record<string, { voteAverage: number; voteCount: number; genreIds: number[] }> = {
      Heist: { voteAverage: 8.2, voteCount: 900, genreIds: [28, 80] },
      Jokes: { voteAverage: 7.8, voteCount: 600, genreIds: [35] },
      Chase: { voteAverage: 7.4, voteCount: 300, genreIds: [28] },
    };
    tmdb.searchTmdbTitles.mockImplementation(async (_key, mediaType, title: string) => ({
      results: [
        {
          id: title.length,
          mediaType,
          title,
          originalTitle: null,
          releaseYear: null,
          ...onTmdb[title],
        },
      ],
    }));
    useSettingsStore.setState({
      tmdbEnabled: true,
      tmdbApiKey: 'test-key',
      selectedCategoryIds: { live: null, vod: 'smart:top-rated', series: null },
    });
    vi.spyOn(catalogApi, 'useCatalogByType').mockReturnValue({
      data: [
        { id: 'heist', title: 'Heist', rating: 8, posterUrl: '', type: 'vod', categoryId: 'new' },
        { id: 'jokes', title: 'Jokes', rating: 7.9, posterUrl: '', type: 'vod', categoryId: 'new' },
        {
          id: 'chase',
          title: 'Chase',
          rating: 7.2,
          posterUrl: '',
          type: 'vod',
          categoryId: 'cinema',
        },
      ] satisfies MediaItem[],
      isLoading: false,
      isError: false,
      error: null,
      isFetching: false,
      refetch: vi.fn(),
    } as any);
    vi.spyOn(categoriesApi, 'useCategories').mockReturnValue({
      data: [
        { category_id: 'new', category_name: 'DE | Neu' },
        { category_id: 'cinema', category_name: 'DE | Kino 2025' },
      ],
      isLoading: false,
      isError: false,
      error: null,
      isFetching: false,
      refetch: vi.fn(),
    } as any);

    renderWithProviders(
      <CatalogPage
        type="vod"
        title="Movies"
        icon={Film}
        emptyTitle="No Movies Found"
        emptyDescription="There are no movies in this category."
        noSourceDescription="Add a source to view movies."
        onItemClick={vi.fn()}
      />,
    );

    const genres = () => screen.getByRole('group', { name: 'Filter by genre' });
    await waitFor(() =>
      expect(within(genres()).getByRole('button', { name: /Action/ }).textContent).toBe('Action2'),
    );
    expect(within(genres()).getByRole('button', { name: /Comedy/ }).textContent).toBe('Comedy1');

    await user.click(within(genres()).getByRole('button', { name: /Action/ }));

    expect(
      within(screen.getByTestId('virtualized-grid'))
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Heist', 'Chase']);
  });
});

describe('CatalogPage served from the catalogue index', () => {
  const source = {
    id: 'xtream-one',
    profile: { name: 'Provider' },
    runtime: null,
    credentials: { url: 'http://provider.test', username: 'u', password: 'p' },
    queryScope: 'xtream-scope',
    isAvailable: true,
  };

  function encodePage(header: object, keys: number[]): ArrayBuffer {
    const json = new TextEncoder().encode(JSON.stringify(header));
    const offset = Math.ceil((4 + json.length) / 4) * 4;
    const buffer = new ArrayBuffer(offset + keys.length * 4);
    new DataView(buffer).setUint32(0, json.length, true);
    new Uint8Array(buffer, 4, json.length).set(json);
    keys.forEach((key, index) => new DataView(buffer).setUint32(offset + index * 4, key, true));
    return buffer;
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    useSettingsStore.getState().resetSettings();
    vi.spyOn(desktopApi, 'isDesktop').mockReturnValue(true);
    // The hidden-category lookup asks the provider for categories; stay offline.
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    vi.spyOn(desktopApi, 'onCatalogIndexUpdated').mockResolvedValue(() => undefined);
    vi.spyOn(enabledSourcesHook, 'useEnabledSources').mockReturnValue({
      enabledSourceIds: ['xtream-one'],
      xtreamEnabled: true,
      xtreamAvailable: true,
      xtreamSources: [source],
      availableXtreamSources: [source],
      m3uSources: [],
      availableM3uSources: [],
      isAvailable: true,
      isLoading: false,
      errors: [],
      queryScope: 'all',
    } as any);
    vi.spyOn(categoriesApi, 'useCategories').mockReturnValue({
      data: [{ category_id: 'xtream-one:category:1', category_name: 'Action' }],
      isLoading: false,
      isError: false,
      error: null,
      isFetching: false,
      refetch: vi.fn(),
    } as any);
  });

  const renderPage = () =>
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <BrowserRouter>
          <CatalogPage
            type="vod"
            title="Movies"
            icon={Film}
            emptyTitle="No Movies Found"
            emptyDescription="None here."
            noSourceDescription="Add a source."
            onItemClick={vi.fn()}
          />
        </BrowserRouter>
      </QueryClientProvider>,
    );

  it('shows the index page without loading the full catalogue', async () => {
    const catalog = vi.spyOn(catalogApi, 'useCatalogByType');
    vi.spyOn(tauriApi, 'catalogIndexPageStatus').mockResolvedValue({
      state: 'ready',
      pending: 0,
      total: 2,
    });
    const page = vi.spyOn(tauriApi, 'catalogIndexPage').mockImplementation(async () =>
      decodeCatalogPage(
        encodePage(
          {
            ready: true,
            status: null,
            generation: '4',
            total: 2,
            categoryTotal: 2,
            genreCounts: [2],
            head: [
              { key: 1, raw: { stream_id: 8, name: 'Second Film', category_id: 1 } },
              { key: 0, raw: { stream_id: 7, name: 'First Film', category_id: 1 } },
            ],
          },
          [1, 0],
        ),
      ),
    );
    vi.spyOn(tauriApi, 'catalogIndexPageStats').mockResolvedValue({
      categoryCounts: { 'xtream-one:category:1': 2 },
      visibleTotal: 2,
      favorites: 0,
      recent: 0,
      topRated: 0,
      fourK: 0,
    });

    renderPage();

    expect(await screen.findByText('Second Film')).toBeTruthy();
    const grid = screen.getByTestId('virtualized-grid');
    expect(
      within(grid)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Second Film', 'First Film']);
    expect(screen.getByText(/2 movies/i)).toBeTruthy();
    const genres = screen.getByRole('group', { name: 'Filter by genre' });
    expect(within(genres).getByRole('button', { name: /Action/ }).textContent).toContain('2');
    expect(page).toHaveBeenCalledWith(
      'vod',
      [{ sourceId: 'xtream-one', scope: 'xtream-scope' }],
      expect.objectContaining({ category: null, sort: 'default', genre: null }),
    );
    for (const [type, options] of catalog.mock.calls) {
      expect(type).toBe('vod');
      expect(options?.enabled).toBe(false);
    }
  });

  it('falls back to the full catalogue when the index cannot serve the page', async () => {
    vi.spyOn(tauriApi, 'catalogIndexPageStatus').mockResolvedValue({
      state: 'unavailable',
      pending: 0,
      total: 0,
    });
    const page = vi.spyOn(tauriApi, 'catalogIndexPage');
    vi.spyOn(catalogApi, 'useCatalogByType').mockImplementation(
      (_type, options) =>
        ({
          data: options?.enabled
            ? [{ id: 'm1', title: 'Legacy Film', posterUrl: '', type: 'vod' }]
            : undefined,
          isLoading: false,
          isError: false,
          error: null,
          isFetching: false,
          refetch: vi.fn(),
        }) as any,
    );

    renderPage();

    expect(await screen.findByText('Legacy Film')).toBeTruthy();
    expect(page).not.toHaveBeenCalled();
  });
});
