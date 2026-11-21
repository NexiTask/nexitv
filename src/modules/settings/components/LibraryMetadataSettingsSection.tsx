import { useSettingsStore } from '../store/useSettingsStore';
import { UI_LANGUAGE_DEFINITIONS } from '@/shared/i18n/config';
import { Select } from '@/shared/ui/Select';
import {
  SettingsButton,
  SettingsGroup,
  SettingsInput,
  SettingsPageContent,
  SettingsRow,
  SettingsToggle,
} from './SettingsControls';
import { storeTmdbApiKey } from '@/modules/metadata/public/services/tmdbCredentialVault';
import { useImdbRefresh } from '@/modules/metadata/public/hooks/useImdbRefresh';
import { notify } from '@/shared/notifications/useNotificationStore';
import { getErrorMessage } from '@/shared/lib/error';

export function LibraryMetadataSettingsSection() {
  const settings = useSettingsStore();
  const imdb = useImdbRefresh();

  return (
    <SettingsPageContent>
      {/* Stream Quality & Badges */}
      <SettingsGroup
        title="Stream Quality & Badges"
        description="Control quality indicators and smart stream organization across your library."
      >
        <SettingsRow
          title="Smart Stream Folding"
          description="Consolidate duplicate quality streams (4K, FHD, HD, RAW) of the same live channel into a single entry with automatic quality failover."
        >
          <SettingsToggle
            label="Enable live stream folding"
            checked={settings.streamFoldingEnabled}
            onChange={(checked) => settings.updateSetting('streamFoldingEnabled', checked)}
          />
        </SettingsRow>
        <SettingsRow
          title="Quality & Format Badges"
          description="Display resolution, frame rate, audio format, and edition pills on posters and channel rows."
        >
          <SettingsToggle
            label="Show quality and format badges"
            checked={settings.badgeVisibility.resolution}
            onChange={(checked) => {
              settings.setBadgeVisibility('resolution', checked);
              settings.setBadgeVisibility('fps', checked);
              settings.setBadgeVisibility('audio', checked);
              settings.setBadgeVisibility('edition', checked);
            }}
          />
        </SettingsRow>
        <SettingsRow
          title="Verified Stream Specs"
          description="Display real resolution & FPS measured directly from native video playback."
          disabled={!settings.badgeVisibility.resolution}
        >
          <SettingsToggle
            label="Show verified stream specs"
            checked={settings.badgeVisibility.verified}
            disabled={!settings.badgeVisibility.resolution}
            onChange={(checked) => settings.setBadgeVisibility('verified', checked)}
          />
        </SettingsRow>
        <SettingsRow
          title="Smart Channel Logo Aspect"
          description="Automatically detect and correct squished 16:9 or 4:3 channel logos forced into square provider files."
        >
          <Select
            ariaLabel="Smart channel logo aspect ratio"
            variant="settings"
            width={180}
            value={settings.smartLogoAspectMode}
            onChange={(value) =>
              settings.setSmartLogoAspectMode(value as typeof settings.smartLogoAspectMode)
            }
            options={[
              { value: 'auto', label: 'Smart Auto-Detect' },
              { value: 'force-16:9', label: 'Always 16:9' },
              { value: 'off', label: 'Original (Off)' },
            ]}
          />
        </SettingsRow>
      </SettingsGroup>

      {/* Metadata Enrichment (TMDB) */}
      <SettingsGroup
        title="Metadata Enrichment"
        description="Optional TMDB lookup for richer movie and series details. Your API key stays local and is never included in settings exports."
      >
        <SettingsRow
          title="Enable TMDB Enrichment"
          description="Allow Movena to look up localized posters, backdrops, and descriptions when opening a title."
        >
          <SettingsToggle
            label="Enable TMDB enrichment"
            checked={settings.tmdbEnabled}
            onChange={(checked) => settings.updateSetting('tmdbEnabled', checked)}
          />
        </SettingsRow>
        <SettingsRow
          title="TMDB API Key"
          description="Stored locally and sent only to api.themoviedb.org. Create a free key at themoviedb.org."
          wideControl
        >
          <SettingsInput
            type="password"
            aria-label="TMDB API key"
            autoComplete="off"
            disabled={!settings.tmdbEnabled}
            value={settings.tmdbApiKey}
            onChange={(event) => settings.updateSetting('tmdbApiKey', event.target.value)}
            onBlur={() => {
              void storeTmdbApiKey(settings.tmdbApiKey).catch((error: unknown) => {
                notify.error(
                  'TMDB Key Not Saved',
                  getErrorMessage(error, 'Credential storage failed without an error message.'),
                );
              });
            }}
            style={{ width: '220px' }}
          />
        </SettingsRow>
        <SettingsRow
          title="Metadata Language"
          description="Language requested from TMDB. Auto follows Movena's interface language."
          disabled={!settings.tmdbEnabled}
        >
          <Select
            ariaLabel="TMDB metadata language"
            variant="settings"
            width={180}
            disabled={!settings.tmdbEnabled}
            value={settings.tmdbLanguage}
            onChange={(value) => settings.updateSetting('tmdbLanguage', value)}
            options={[
              { value: 'auto', label: 'Automatic' },
              ...UI_LANGUAGE_DEFINITIONS.map(({ locale, label }) => ({
                value: locale,
                label,
                localize: false,
              })),
            ]}
          />
        </SettingsRow>
        <SettingsRow
          title="Poster Quality"
          description="Higher quality uses more bandwidth and storage in the image cache."
          disabled={!settings.tmdbEnabled}
        >
          <Select
            ariaLabel="TMDB poster quality"
            variant="settings"
            width={180}
            disabled={!settings.tmdbEnabled}
            value={settings.tmdbImageSize}
            onChange={(value) => settings.updateSetting('tmdbImageSize', value)}
            options={[
              { value: 'w342', label: 'Standard' },
              { value: 'w500', label: 'High' },
              { value: 'w780', label: 'Maximum' },
            ]}
          />
        </SettingsRow>
        <SettingsRow
          title="Include Adult Results"
          description="Allow TMDB searches to return adult-rated results. Disabled by default."
          disabled={!settings.tmdbEnabled}
        >
          <SettingsToggle
            label="Include adult TMDB results"
            checked={settings.tmdbIncludeAdult}
            disabled={!settings.tmdbEnabled}
            onChange={(checked) => settings.updateSetting('tmdbIncludeAdult', checked)}
          />
        </SettingsRow>
      </SettingsGroup>

      {/* IMDb Ratings (the bulk pipeline; see metadata/imdb.rs) */}
      {imdb.status && (
        <SettingsGroup
          title="IMDb Ratings"
          description="Ratings for the whole catalogue from IMDb's daily public datasets, matched by title and year. They power the quality filter and the IMDb sort on Movies and Series."
        >
          <SettingsRow
            title="Automatic Refresh"
            description="Check weekly for fresh ratings and match newly added titles daily. Runs in the background, never at startup."
          >
            <SettingsToggle
              label="Refresh IMDb ratings automatically"
              checked={imdb.status.enabled}
              onChange={(checked) => imdb.setEnabled(checked)}
            />
          </SettingsRow>
          <SettingsRow
            title="Coverage"
            description={
              imdb.status.lastRefresh
                ? `Last updated ${new Date(imdb.status.lastRefresh * 1000).toLocaleString()}.`
                : 'Not updated yet; the first pass runs shortly after startup.'
            }
          >
            <span style={{ whiteSpace: 'nowrap' }}>
              {imdb.status.matched.toLocaleString()} of {imdb.status.total.toLocaleString()} titles
              rated
            </span>
          </SettingsRow>
          <SettingsRow
            title="Update Now"
            description="Download the current IMDb datasets and re-match the catalogue. The first run downloads about 210 MB; afterwards only changed ratings are applied."
          >
            <SettingsButton onClick={imdb.start} disabled={imdb.status.running || imdb.isStarting}>
              {imdb.status.running || imdb.isStarting ? 'Updating…' : 'Update now'}
            </SettingsButton>
          </SettingsRow>
        </SettingsGroup>
      )}
    </SettingsPageContent>
  );
}
