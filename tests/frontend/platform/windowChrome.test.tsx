// @vitest-environment happy-dom

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { WindowChrome } from '@/app/shell/WindowChrome';
import { useSettingsStore } from '@/modules/settings/store/useSettingsStore';

beforeEach(() => {
  localStorage.clear();
  useSettingsStore.getState().resetSettings();
});

describe('window buttons', () => {
  it('shows the window buttons by default', () => {
    render(<WindowChrome />);
    expect(screen.getByRole('button', { name: /close window/i })).toBeTruthy();
  });

  it('hides them when the setting is off', () => {
    useSettingsStore.getState().updateSetting('showWindowControls', false);
    render(<WindowChrome />);
    expect(screen.queryByRole('button', { name: /close window/i })).toBeNull();
  });
});
