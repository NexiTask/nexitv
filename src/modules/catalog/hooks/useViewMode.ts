import { useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import { useSettingsStore } from '@/modules/settings/public/store/useSettingsStore';

type ViewMode = 'grid' | 'list';

/** The section a path belongs to: its first segment ("movies", "favorites"),
 * "home" for the root. */
export function viewSection(pathname: string): string {
  return pathname.split('/').filter(Boolean)[0] ?? 'home';
}

/**
 * The grid/list view of the section on screen: what the viewer last chose
 * there, else the default from Settings → Appearance.
 */
export function useViewMode(): [ViewMode, (mode: ViewMode) => void] {
  const section = viewSection(useLocation().pathname);
  const mode = useSettingsStore((state) => state.viewModes[section] ?? state.viewMode);
  const setMode = useCallback(
    (next: ViewMode) => {
      const { viewModes, updateSetting } = useSettingsStore.getState();
      updateSetting('viewModes', { ...viewModes, [section]: next });
    },
    [section],
  );
  return [mode, setMode];
}

/** The card sizes the − / + buttons step through. */
export const CARD_SCALES = [0.8, 1, 1.25, 1.5, 1.75, 2] as const;

/** The grid card size of the section on screen (1 = standard). */
export function useCardScale(): [number, (scale: number) => void] {
  const section = viewSection(useLocation().pathname);
  const scale = useSettingsStore((state) => state.cardScales[section] ?? 1);
  const setScale = useCallback(
    (next: number) => {
      const { cardScales, updateSetting } = useSettingsStore.getState();
      updateSetting('cardScales', { ...cardScales, [section]: next });
    },
    [section],
  );
  return [scale, setScale];
}
