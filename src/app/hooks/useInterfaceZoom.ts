import { useEffect } from 'react';
import { desktopApi } from '@/platform/desktop';
import { INTERFACE_ZOOM_STEPS, useSettingsStore } from '@/modules/settings/store/useSettingsStore';

/** The zoom step one notch up (+1) or down (−1) from `current`. */
export function stepInterfaceZoom(current: number, direction: 1 | -1): number {
  const index = INTERFACE_ZOOM_STEPS.findIndex((step) => step >= current - 0.001);
  const at = index < 0 ? INTERFACE_ZOOM_STEPS.length - 1 : index;
  const next = Math.min(INTERFACE_ZOOM_STEPS.length - 1, Math.max(0, at + direction));
  return INTERFACE_ZOOM_STEPS[next]!;
}

/**
 * Applies Settings → Appearance → Interface Zoom to the webview, at startup
 * and on every change, and lets Ctrl + / Ctrl − / Ctrl 0 change that same
 * setting (the webview's own zoom hotkeys are off, or the two would drift).
 */
export function useInterfaceZoom() {
  const zoom = useSettingsStore((state) => state.interfaceZoom);

  useEffect(() => {
    if (!desktopApi.isDesktop()) return;
    void desktopApi.setInterfaceZoom(zoom).catch(() => undefined);
  }, [zoom]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const { interfaceZoom, updateSetting } = useSettingsStore.getState();
      let next: number | null = null;
      if (event.key === '+' || event.key === '=') next = stepInterfaceZoom(interfaceZoom, 1);
      else if (event.key === '-' || event.key === '_') next = stepInterfaceZoom(interfaceZoom, -1);
      else if (event.key === '0') next = 1;
      if (next === null) return;
      event.preventDefault();
      if (next !== interfaceZoom) updateSetting('interfaceZoom', next);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);
}
