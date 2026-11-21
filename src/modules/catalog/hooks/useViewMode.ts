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
