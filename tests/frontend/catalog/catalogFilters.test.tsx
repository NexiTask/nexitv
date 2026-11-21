// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CatalogFilterPanel } from '@/modules/catalog/components/CatalogFilterPanel';
import { activeFilterCount, filterQueryFields } from '@/modules/catalog/lib/catalogPageQuery';
import {
  EMPTY_CATALOG_FILTERS,
  normalizeCatalogFilters,
  type CatalogFilters,
} from '@/modules/settings/store/useSettingsStore';

const filters = (patch: Partial<CatalogFilters>): CatalogFilters => ({
  ...EMPTY_CATALOG_FILTERS,
  ...patch,
});

describe('catalogue filter query', () => {
  it('sends nothing while no filter is on', () => {
    expect(filterQueryFields(EMPTY_CATALOG_FILTERS)).toEqual({});
    expect(activeFilterCount(EMPTY_CATALOG_FILTERS)).toBe(0);
  });

  it('maps the panel onto the index query', () => {
    const fields = filterQueryFields(
      filters({
        yearMin: 1990,
        runtimeMax: 120,
        genres: ['Action', 'Drama'],
        excludeGenres: ['Horror'],
        addedWithinDays: 7,
        ultraHdOnly: true,
        watch: 'unwatched',
      }),
      ['b', 'a'],
      ['c'],
      10 * 86_400 + 500,
    );
    expect(fields).toEqual({
      yearMin: 1990,
      runtimeMax: 120,
      genresAny: 0b101,
      genresExclude: 1 << 5,
      // Whole days: ten days in, minus seven.
      addedSince: 3 * 86_400,
      ultraHdOnly: true,
      watch: 'unwatched',
      watchedIds: ['a', 'b'],
      inProgressIds: ['c'],
    });
  });

  it('counts each active filter once', () => {
    expect(
      activeFilterCount(
        filters({ yearMin: 1990, yearMax: 2000, genres: ['Action'], ratedOnly: true }),
      ),
    ).toBe(3);
  });

  it('keeps only sane stored values', () => {
    expect(
      normalizeCatalogFilters({
        yearMin: 'x',
        minRating: 42,
        watch: 'nope',
        genres: ['A', 'A', 3],
      }),
    ).toEqual(filters({ genres: ['A'] }));
  });
});

describe('catalogue filter panel', () => {
  it('cycles a genre through include, exclude and off', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <CatalogFilterPanel type="vod" filters={EMPTY_CATALOG_FILTERS} onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Comedy' }));
    expect(onChange).toHaveBeenLastCalledWith(filters({ genres: ['Comedy'] }));

    rerender(
      <CatalogFilterPanel
        type="vod"
        filters={filters({ genres: ['Comedy'] })}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '+Comedy' }));
    expect(onChange).toHaveBeenLastCalledWith(filters({ excludeGenres: ['Comedy'] }));

    rerender(
      <CatalogFilterPanel
        type="vod"
        filters={filters({ excludeGenres: ['Comedy'] })}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '−Comedy' }));
    expect(onChange).toHaveBeenLastCalledWith(EMPTY_CATALOG_FILTERS);
  });

  it('takes a typed year when it is a real one', () => {
    const onChange = vi.fn();
    render(<CatalogFilterPanel type="vod" filters={EMPTY_CATALOG_FILTERS} onChange={onChange} />);
    const from = screen.getByRole('combobox', { name: 'From year' });
    fireEvent.change(from, { target: { value: '1994' } });
    fireEvent.blur(from);
    expect(onChange).toHaveBeenLastCalledWith(filters({ yearMin: 1994 }));
  });

  it('offers a dropdown of years to pick from', () => {
    const onChange = vi.fn();
    render(<CatalogFilterPanel type="vod" filters={EMPTY_CATALOG_FILTERS} onChange={onChange} />);
    const to = screen.getByRole('combobox', { name: 'To year' });
    fireEvent.focus(to);
    // Newest first, and narrowed by what is typed.
    const newest = new Date().getFullYear() + 1;
    expect(screen.getAllByRole('option')[0]?.textContent).toBe(String(newest));
    fireEvent.change(to, { target: { value: '199' } });
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      '1999',
      '1998',
      '1997',
      '1996',
      '1995',
      '1994',
      '1993',
      '1992',
      '1991',
      '1990',
    ]);
    fireEvent.click(screen.getByRole('option', { name: '1995' }));
    expect(onChange).toHaveBeenLastCalledWith(filters({ yearMax: 1995 }));
  });

  it('picks with the keyboard, clears when emptied, and ignores nonsense', () => {
    const onChange = vi.fn();
    render(
      <CatalogFilterPanel type="vod" filters={filters({ yearMin: 2001 })} onChange={onChange} />,
    );
    const from = screen.getByRole('combobox', { name: 'From year' });
    fireEvent.focus(from);
    fireEvent.change(from, { target: { value: '20' } });
    fireEvent.keyDown(from, { key: 'ArrowDown' });
    fireEvent.keyDown(from, { key: 'Enter' });
    const picked = onChange.mock.calls.at(-1)?.[0] as { yearMin: number };
    expect(String(picked.yearMin).startsWith('20')).toBe(true);

    fireEvent.change(from, { target: { value: '' } });
    fireEvent.blur(from);
    expect(onChange).toHaveBeenLastCalledWith(filters({ yearMin: null }));

    onChange.mockClear();
    fireEvent.change(from, { target: { value: '12' } });
    fireEvent.blur(from);
    expect(onChange).not.toHaveBeenCalled();
  });
});
