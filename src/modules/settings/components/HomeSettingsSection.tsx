import { ChevronDown, ChevronUp, RotateCcw } from 'lucide-react';
import { useSettingsStore, type HomeSectionId } from '../store/useSettingsStore';
import {
  DEFAULT_HOME_SECTIONS,
  HOME_SECTION_LABELS,
  moveHomeSection,
} from '@/modules/catalog/public/lib/homeSections';
import {
  SettingsButton,
  SettingsGroup,
  SettingsPageContent,
  SettingsRow,
  SettingsToggle,
} from './SettingsControls';
import { useI18n } from '@/shared/i18n/i18n';
import { Select } from '@/shared/ui/Select';

const rowControlsStyle = { display: 'flex', alignItems: 'center', gap: 'var(--space-2)' } as const;

export function HomeSettingsSection() {
  const { t, number } = useI18n();
  const homeSections = useSettingsStore((state) => state.homeSections);
  const recommendationsEnabled = useSettingsStore((state) => state.recommendationsEnabled);
  const recommendationsHomeLimit = useSettingsStore((state) => state.recommendationsHomeLimit);
  const updateSetting = useSettingsStore((state) => state.updateSetting);

  const toggleSection = (id: HomeSectionId) => {
    updateSetting(
      'homeSections',
      homeSections.map((section) =>
        section.id === id ? { ...section, enabled: !section.enabled } : section,
      ),
    );
  };

  const move = (index: number, direction: -1 | 1) => {
    updateSetting('homeSections', moveHomeSection(homeSections, index, direction));
  };

  return (
    <SettingsPageContent>
      <SettingsGroup
        title="Home Layout"
        description="Choose which rows appear on the Home page, and reorder them with the arrows."
      >
        {homeSections.map((section, index) => {
          const label = HOME_SECTION_LABELS[section.id];
          const isUpcoming = section.id === 'upcoming';
          return (
            <SettingsRow
              key={section.id}
              title={label}
              description={
                isUpcoming
                  ? 'Shown or hidden by the "Show on Home" setting under Coming Up.'
                  : undefined
              }
            >
              <div style={rowControlsStyle}>
                <SettingsButton
                  iconOnly
                  onClick={() => move(index, -1)}
                  disabled={index === 0}
                  aria-label={t('Move {section} up', { section: t(label) })}
                  title={t('Move up')}
                >
                  <ChevronUp size={15} />
                </SettingsButton>
                <SettingsButton
                  iconOnly
                  onClick={() => move(index, 1)}
                  disabled={index === homeSections.length - 1}
                  aria-label={t('Move {section} down', { section: t(label) })}
                  title={t('Move down')}
                >
                  <ChevronDown size={15} />
                </SettingsButton>
                {!isUpcoming && (
                  <SettingsToggle
                    label={t('Show {section}', { section: t(label) })}
                    checked={section.enabled}
                    onChange={() => toggleSection(section.id)}
                  />
                )}
              </div>
            </SettingsRow>
          );
        })}

        <SettingsRow
          title="Reset Layout"
          description="Restore the default row order and visibility."
        >
          <SettingsButton onClick={() => updateSetting('homeSections', DEFAULT_HOME_SECTIONS)}>
            <RotateCcw size={15} /> {t('Reset to Default')}
          </SettingsButton>
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title="Recommendations">
        <SettingsRow
          title="Enable recommendations"
          description="Show TV series recommendations in Library and allow access to their Home row."
        >
          <SettingsToggle
            label="Enable recommendations"
            checked={recommendationsEnabled}
            onChange={(checked) => updateSetting('recommendationsEnabled', checked)}
          />
        </SettingsRow>
        <SettingsRow
          title="Recommendations on Home"
          description="Maximum number of saved recommendations shown on Home."
          disabled={!recommendationsEnabled}
        >
          <Select
            value={recommendationsHomeLimit}
            options={([6, 8, 12] as const).map((value) => ({
              value,
              label: number(value),
              localize: false,
            }))}
            onChange={(value) => updateSetting('recommendationsHomeLimit', value)}
            disabled={!recommendationsEnabled}
            variant="settings"
            ariaLabel="Maximum recommendations on Home"
          />
        </SettingsRow>
      </SettingsGroup>
    </SettingsPageContent>
  );
}
