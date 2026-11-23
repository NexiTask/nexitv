import { useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import { useSettingsStore } from '@/modules/settings/public/store/useSettingsStore';

type ViewMode = 'grid' | 'list';

/** Library lists retain the view settings from their previous pages. */
export function viewSection(pathname: string): string {
  const [section, listId] = pathname.split('/').filter(Boolean);
  if (section === 'library') return listId === 'favorites' ? 'favorites' : 'collections';
  return section ?? 'home';
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

/** What a section starts at until its card size is changed there. */
export const DEFAULT_CARD_SCALE = 1.25;

/** The grid card size of the section on screen (1 = the standard width). */
export function useCardScale(): [number, (scale: number) => void] {
  const section = viewSection(useLocation().pathname);
  const scale = useSettingsStore((state) => state.cardScales[section] ?? DEFAULT_CARD_SCALE);
  const setScale = useCallback(
    (next: number) => {
      const { cardScales, updateSetting } = useSettingsStore.getState();
      updateSetting('cardScales', { ...cardScales, [section]: next });
    },
    [section],
  );
  return [scale, setScale];
}
