// @vitest-environment happy-dom

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const virtualState = vi.hoisted(() => ({ rowKey: 'live:4:120:16:0' }));

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({
    getTotalSize: () => 120,
    getVirtualItems: () => [{ index: 0, key: virtualState.rowKey, start: 0 }],
  }),
}));

import { VirtualizedGrid } from '@/modules/catalog/components/VirtualizedGrid';
import type { MediaItem } from '@/modules/catalog/model/media';

beforeAll(() => {
  class TestResizeObserver {
    observe() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, 'ResizeObserver', {
    value: TestResizeObserver,
    configurable: true,
  });
});

describe('virtualized grid resizing', () => {
  it('preserves mounted card artwork when the virtualizer invalidates row geometry', () => {
    const items: MediaItem[] = [
      {
        id: 'youtube-live',
        title: 'YouTube Live',
        posterUrl: '',
        type: 'live',
        streamUrl: 'https://www.youtube.com/@channel/live',
      },
    ];
    const view = render(
      <MemoryRouter>
        <VirtualizedGrid items={items} isLiveTv gap={16} />
      </MemoryRouter>,
    );
    const originalLogo = screen.getByRole('img', { name: 'YouTube' });

    virtualState.rowKey = 'live:4:121:16:0';
    view.rerender(
      <MemoryRouter>
        <VirtualizedGrid items={items} isLiveTv gap={17} />
      </MemoryRouter>,
    );

    expect(screen.getByRole('img', { name: 'YouTube' })).toBe(originalLogo);
  });
});

describe('virtualized grid over a list held elsewhere', () => {
  it('renders loaded items, keeps places for missing ones and reports its range', () => {
    virtualState.rowKey = 'standard:4:120:16:0';
    const items: Record<number, MediaItem> = {
      0: { id: 'a', title: 'Alpha', posterUrl: '', type: 'vod' },
      2: { id: 'c', title: 'Gamma', posterUrl: '', type: 'vod' },
    };
    const onRangeChange = vi.fn();
    const { container } = render(
      <MemoryRouter>
        <VirtualizedGrid
          count={3}
          getItem={(index) => items[index]}
          onRangeChange={onRangeChange}
        />
      </MemoryRouter>,
    );

    expect(screen.getAllByText('Alpha').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Gamma').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('[aria-hidden="true"][class*="itemWrapper"]')).toHaveLength(
      1,
    );
    // One rendered row holds all three positions.
    expect(onRangeChange).toHaveBeenCalledWith(0, 3);
  });
});
