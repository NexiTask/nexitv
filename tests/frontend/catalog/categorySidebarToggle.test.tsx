// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { CategorySidebarToggle } from '@/modules/catalog/components/CategorySidebarToggle';
import { useSettingsStore } from '@/modules/settings/store/useSettingsStore';

beforeEach(() => {
  localStorage.clear();
  useSettingsStore.getState().resetSettings();
});

describe('category sidebar toggle', () => {
  it('hides the sidebar and brings it back, remembering the choice', () => {
    render(<CategorySidebarToggle />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide categories' }));
    expect(useSettingsStore.getState().categorySidebarHidden).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Show categories' }));
    expect(useSettingsStore.getState().categorySidebarHidden).toBe(false);
  });
});
