// @vitest-environment happy-dom

import { fireEvent, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { stepInterfaceZoom, useInterfaceZoom } from '@/app/hooks/useInterfaceZoom';
import {
  normalizeInterfaceZoom,
  useSettingsStore,
} from '@/modules/settings/store/useSettingsStore';

beforeEach(() => {
  localStorage.clear();
  useSettingsStore.getState().resetSettings();
});

describe('interface zoom', () => {
  it('steps through the offered sizes and stops at the ends', () => {
    expect(stepInterfaceZoom(1, 1)).toBe(1.1);
    expect(stepInterfaceZoom(1, -1)).toBe(0.9);
    expect(stepInterfaceZoom(2, 1)).toBe(2);
    expect(stepInterfaceZoom(0.75, -1)).toBe(0.75);
  });

  it('keeps stored values on an offered step', () => {
    expect(normalizeInterfaceZoom(1.12)).toBe(1.1);
    expect(normalizeInterfaceZoom('big')).toBe(1);
    expect(normalizeInterfaceZoom(9)).toBe(2);
  });

  it('changes the setting with Ctrl + / − / 0', () => {
    renderHook(() => useInterfaceZoom());
    fireEvent.keyDown(window, { key: '=', ctrlKey: true });
    fireEvent.keyDown(window, { key: '+', ctrlKey: true });
    expect(useSettingsStore.getState().interfaceZoom).toBe(1.25);
    fireEvent.keyDown(window, { key: '-', ctrlKey: true });
    expect(useSettingsStore.getState().interfaceZoom).toBe(1.1);
    fireEvent.keyDown(window, { key: '0', ctrlKey: true });
    expect(useSettingsStore.getState().interfaceZoom).toBe(1);
  });
});
