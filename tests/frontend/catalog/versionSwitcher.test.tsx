// @vitest-environment happy-dom

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { VersionSwitcher } from '@/modules/catalog/details/VersionSwitcher';
import type { TitleVariant } from '@/modules/catalog/data/useTitleVariants';

const variant = (id: string, title: string, country: string | null = null): TitleVariant => ({
  item: { id, title, posterUrl: '', type: 'vod' },
  country,
});

describe('VersionSwitcher', () => {
  it('counts and offers the open copy alongside the others', () => {
    const variants = [variant('a', 'The Godfather', 'US'), variant('b', 'SE-4K - The Godfather')];
    render(<VersionSwitcher variants={variants} activeId="a" onSelect={vi.fn()} />);
    expect(screen.getByText('2 versions')).toBeTruthy();
  });

  it('hides itself when the open copy is the only one', () => {
    const { container } = render(
      <VersionSwitcher
        variants={[variant('a', 'The Godfather')]}
        activeId="a"
        onSelect={vi.fn()}
      />,
    );
    expect(container.innerHTML).toBe('');
  });
});
