import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ensureUiMessages } from '@/shared/i18n/i18n';
import { isUiLanguage } from '@/shared/i18n/config';
import { useSettingsStore } from '@/modules/settings/store/useSettingsStore';
import { applyAppearanceTheme, COLOR_THEMES, type ColorTheme } from '@/shared/design/appearance';
import '@/shared/design/index.css';
import { ComponentHarness } from './ComponentHarness';
import { ReadmeHarness } from './ReadmeHarness';
import {
  README_FEATURE_SURFACES,
  README_SURFACES,
  type ReadmeFeatureSurface,
  type ReadmeSurface,
} from '../readmeSurfaces';

async function renderHarness() {
  const searchParams = new URLSearchParams(window.location.search);
  const requestedLocale = searchParams.get('locale');
  const language = isUiLanguage(requestedLocale) ? requestedLocale : 'en';
  const theme =
    searchParams.get('theme') === 'light' || searchParams.get('readme') === 'light-theme'
      ? 'light'
      : 'dark';
  // A colour theme (?palette=nord, ?palette=catppuccin&flavor=mocha).
  const requestedPalette = searchParams.get('palette');
  const colorTheme = COLOR_THEMES.some((entry) => entry.value === requestedPalette)
    ? (requestedPalette as ColorTheme)
    : 'default';
  const requestedFlavor = searchParams.get('flavor');
  const catppuccinFlavor =
    requestedFlavor === 'macchiato' || requestedFlavor === 'frappe' ? requestedFlavor : 'mocha';
  await ensureUiMessages(language);
  useSettingsStore.setState({
    language,
    themePreference: theme,
    colorTheme,
    catppuccinFlavor,
  });
  applyAppearanceTheme(
    theme,
    useSettingsStore.getState().accentColor,
    null,
    document.documentElement,
    { theme: colorTheme, flavor: catppuccinFlavor },
  );
  document.documentElement.lang = language;
  document.documentElement.dataset.motion = 'reduced';

  const readmeSurface = searchParams.get('readme');
  const isReadmeSurface =
    README_SURFACES.includes(readmeSurface as ReadmeSurface) ||
    README_FEATURE_SURFACES.includes(readmeSurface as ReadmeFeatureSurface);
  const settingsSection = searchParams.get('settingsSection');

  createRoot(document.getElementById('root')!).render(
    isReadmeSurface ? (
      <ReadmeHarness
        surface={readmeSurface as ReadmeSurface | ReadmeFeatureSurface}
        settingsSection={settingsSection}
      />
    ) : (
      <BrowserRouter>
        <ComponentHarness language={language} />
      </BrowserRouter>
    ),
  );
}

void renderHarness();
