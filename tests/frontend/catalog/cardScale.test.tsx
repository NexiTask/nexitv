// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { CatalogViewToggle } from '@/modules/catalog/components/CatalogViewToggle';
import { calculateGridLayout } from '@/modules/catalog/lib/gridLayout';
import { useSettingsStore } from '@/modules/settings/store/useSettingsStore';

beforeEach(() => {
  localStorage.clear();
  useSettingsStore.getState().resetSettings();
});

describe('grid card size', () => {
  it('fits fewer, wider cards as the scale grows', () => {
    const standard = calculateGridLayout(1200, 16, false);
    const double = calculateGridLayout(1200, 16, false, 2);
    expect(double.columns).toBeLessThan(standard.columns);
    expect(double.cardWidth).toBeGreaterThan(standard.cardWidth * 1.6);
    expect(double.rowHeight).toBeCloseTo(double.cardWidth * 1.5);
  });

  it('steps the size per section and stops at the ends', () => {
    render(
      <MemoryRouter initialEntries={['/movies']}>
        <CatalogViewToggle />
      </MemoryRouter>,
    );
    const larger = screen.getByRole('button', { name: 'Larger cards' });
    // A section starts at 125%.
    expect(screen.getByText('125%')).toBeTruthy();
    fireEvent.click(larger);
    expect(useSettingsStore.getState().cardScales).toEqual({ movies: 1.5 });
    for (let i = 0; i < 10; i += 1) fireEvent.click(larger);
    expect(useSettingsStore.getState().cardScales.movies).toBe(2);
    expect(larger.hasAttribute('disabled')).toBe(true);
  });

  it('hides the size control in list view', () => {
    useSettingsStore.getState().updateSetting('viewModes', { movies: 'list' });
    render(
      <MemoryRouter initialEntries={['/movies']}>
        <CatalogViewToggle />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('button', { name: 'Larger cards' })).toBeNull();
  });
});
