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
import {
  INTERFACE_ZOOM_STEPS,
  normalizeInterfaceZoom,
  useSettingsStore,
  type ThemePreference,
} from '../store/useSettingsStore';
import { Select } from '@/shared/ui/Select';
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
          title="Color Theme"
          description="A color palette over the dark or light canvas. Catppuccin brings its own soft pastel colors and Mauve accent."
        >
          <Select
            ariaLabel="Color theme"
            variant="settings"
            width={170}
            value={settings.colorTheme}
            onChange={(value) => settings.updateSetting('colorTheme', value)}
            options={[
              { value: 'default', label: 'Default' },
              { value: 'catppuccin', label: 'Catppuccin', localize: false },
            ]}
          />
        </SettingsRow>

        {settings.colorTheme === 'catppuccin' && (
          <SettingsRow
            title="Catppuccin Flavor"
            description="The dark flavor. The light theme always uses Latte."
            disabled={settings.themePreference === 'light'}
          >
            <Select
              ariaLabel="Catppuccin flavor"
              variant="settings"
              width={170}
              value={settings.catppuccinFlavor}
              disabled={settings.themePreference === 'light'}
              onChange={(value) => settings.updateSetting('catppuccinFlavor', value)}
              options={[
                { value: 'mocha', label: 'Mocha', localize: false },
                { value: 'macchiato', label: 'Macchiato', localize: false },
                { value: 'frappe', label: 'Frappé', localize: false },
              ]}
            />
          </SettingsRow>
        )}

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
          title="Interface Zoom"
          description="Scales the whole interface: text, cards and controls. Ctrl + and Ctrl − change it too, Ctrl 0 resets it."
        >
          <Select
            ariaLabel="Interface zoom"
            variant="settings"
            width={120}
            value={String(normalizeInterfaceZoom(settings.interfaceZoom))}
            onChange={(value) => settings.updateSetting('interfaceZoom', Number(value))}
            options={INTERFACE_ZOOM_STEPS.map((step) => ({
              value: String(step),
              label: `${Math.round(step * 100)}%`,
              localize: false,
            }))}
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
