import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useSettingsStore } from '@/modules/settings/public/store/useSettingsStore';
import { IconButton } from '@/shared/ui/Button';
import { useI18n } from '@/shared/i18n/i18n';

/** Folds the category sidebar of the catalogue pages away, or back. */
export function CategorySidebarToggle() {
  const { t } = useI18n();
  const hidden = useSettingsStore((state) => state.categorySidebarHidden);
  const updateSetting = useSettingsStore((state) => state.updateSetting);
  const label = t(hidden ? 'Show categories' : 'Hide categories');
  return (
    <IconButton
      size="sm"
      onClick={() => updateSetting('categorySidebarHidden', !hidden)}
      aria-label={label}
      aria-expanded={!hidden}
      title={label}
    >
      {hidden ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
    </IconButton>
  );
}
