import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/shared/design/index.css';
import App from './App';
import { perfLog } from '@/platform/perf';
import { isWebKitGtk } from '@/platform/runtime';
import { ensureUiMessages } from '@/shared/i18n/i18n';
import { useSettingsStore } from '@/modules/settings/store/useSettingsStore';
import { initializeTmdbApiKey } from '@/modules/metadata/services/tmdbCredentialVault';
import { activeSeason, applyAppearanceTheme } from '@/shared/design/appearance';

perfLog('boot:main_module');
// Scoped CSS fixes for the Linux webview (see .subtle-scrollbar in index.css).
if (isWebKitGtk()) document.documentElement.dataset.engine = 'webkitgtk';
const initialSettings = useSettingsStore.getState();
applyAppearanceTheme(
  initialSettings.themePreference,
  initialSettings.accentColor,
  activeSeason(new Date()),
  document.documentElement,
  { theme: initialSettings.colorTheme, flavor: initialSettings.catppuccinFlavor },
);
const root = createRoot(document.getElementById('root')!);

async function renderApp() {
  // Loaded only by the feature-gated desktop E2E build. Production bundles do
  // not include the WebDriver bridge or expose its invoke interception.
  if (import.meta.env.MODE === 'desktop-e2e') {
    await import('@wdio/tauri-plugin');
  }
  // Load the optional TMDB API key from the OS keyring in parallel so the
  // initial UI render never waits on a Secret Service / Keychain IPC call.
  void initializeTmdbApiKey().catch((error) => {
    console.warn('Could not initialize the TMDB credential vault', error);
  });
  const language = useSettingsStore.getState().language;
  if (language !== 'en') {
    await ensureUiMessages(language).catch((error) => {
      console.warn(`Could not preload the ${language} interface catalog`, error);
    });
  }
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void renderApp();
