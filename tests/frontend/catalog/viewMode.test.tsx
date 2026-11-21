// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { useViewMode, viewSection } from '@/modules/catalog/hooks/useViewMode';
import { useSettingsStore } from '@/modules/settings/store/useSettingsStore';

const at =
  (path: string) =>
  ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
  );

beforeEach(() => {
  localStorage.clear();
  useSettingsStore.getState().resetSettings();
});

describe('grid/list view per section', () => {
  it('names a section by its first path segment', () => {
    expect(viewSection('/collections/abc')).toBe('collections');
    expect(viewSection('/')).toBe('home');
  });

  it('remembers each section on its own and starts others at the default', () => {
    const movies = renderHook(() => useViewMode(), { wrapper: at('/movies') });
    expect(movies.result.current[0]).toBe('grid');
    act(() => movies.result.current[1]('list'));
    expect(movies.result.current[0]).toBe('list');

    const series = renderHook(() => useViewMode(), { wrapper: at('/series') });
    expect(series.result.current[0]).toBe('grid');

    useSettingsStore.getState().updateSetting('viewMode', 'list');
    const favorites = renderHook(() => useViewMode(), { wrapper: at('/favorites') });
    expect(favorites.result.current[0]).toBe('list');
    expect(series.result.current[0]).toBe('list');
    act(() => series.result.current[1]('grid'));
    expect(series.result.current[0]).toBe('grid');
    expect(movies.result.current[0]).toBe('list');
  });
});
