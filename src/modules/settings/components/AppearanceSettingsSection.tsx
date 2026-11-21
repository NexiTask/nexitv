import {
  RiLayoutGridFill,
  RiLayoutGridLine,
  RiLayoutRowFill,
  RiLayoutRowLine,
  RiMoonFill,
  RiMoonLine,
  RiSunFill,
  RiSunLine,
} from '@/shared/ui/icons';
import { useSettingsStore, type ThemePreference } from '../store/useSettingsStore';
import { DEFAULT_ACCENT_COLOR } from '@/shared/design/color';
import { AccentColorPicker } from '@/shared/ui/AccentColorPicker';
import { SegmentedControl } from '@/shared/ui/SegmentedControl';
import {
  SettingsGroup,
  SettingsPageContent,
  SettingsRow,
  SettingsToggle,
} from './SettingsControls';
export function AppearanceSettingsSection() {
  const settings = useSettingsStore();
  const accentColor = settings.accentColor || DEFAULT_ACCENT_COLOR;

  return (
    <SettingsPageContent>
      <SettingsGroup
        title="Catalogue & Theme"
        description="Choose how browsing surfaces look by default."
      >
        <SettingsRow
          title="Theme"
          description="Use light or dark colors across the Movena interface."
        >
          <SegmentedControl<ThemePreference>
            value={settings.themePreference}
            onChange={(value) => settings.updateSetting('themePreference', value)}
            ariaLabel="Interface theme"
            options={[
              { value: 'dark', label: 'Dark', icon: RiMoonLine, activeIcon: RiMoonFill },
              { value: 'light', label: 'Light', icon: RiSunLine, activeIcon: RiSunFill },
            ]}
          />
        </SettingsRow>

        <SettingsRow
          title="Accent Color"
          description="Highlight color used for selected items, active controls, and focus states."
        >
          <AccentColorPicker
            value={accentColor}
            onChange={(value) => settings.updateSetting('accentColor', value)}
          />
        </SettingsRow>

        <SettingsRow
          title="Default Catalogue View"
          description="Layout a section starts with. Each section remembers the view you pick there."
        >
          <SegmentedControl<'grid' | 'list'>
            value={settings.viewMode}
            onChange={(value) => settings.updateSetting('viewMode', value)}
            options={[
              {
                value: 'grid',
                label: 'Grid',
                icon: RiLayoutGridLine,
                activeIcon: RiLayoutGridFill,
              },
              { value: 'list', label: 'List', icon: RiLayoutRowLine, activeIcon: RiLayoutRowFill },
            ]}
          />
        </SettingsRow>

        <SettingsRow
          title="Window Buttons"
          description="Show the minimize, maximize and close buttons in the top corner. Turn off when your window manager handles windows, e.g. a tiling desktop."
        >
          <SettingsToggle
            label="Show window buttons"
            checked={settings.showWindowControls}
            onChange={(checked) => settings.updateSetting('showWindowControls', checked)}
          />
        </SettingsRow>
      </SettingsGroup>
    </SettingsPageContent>
  );
}
