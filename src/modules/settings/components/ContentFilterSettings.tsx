import { useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { useCategories } from '@/modules/catalog/public/data/useCategories';
import { useI18n } from '@/shared/i18n/i18n';
import { countryName, parseProviderCategoryName } from '@/shared/lib/categoryName';
import { CountryFlag } from '@/shared/ui/CountryFlag';
import { Select } from '@/shared/ui/Select';
import { useSettingsStore } from '../store/useSettingsStore';
import { SettingsButton, SettingsGroup, SettingsInput, SettingsRow } from './SettingsControls';
import styles from './ContentFilterSettings.module.css';

/** The catalogue types the content filter covers. */
const FILTERED_TYPES = ['vod', 'series'] as const;

/**
 * Settings → Content Filter: what Movies and Series leave out by default.
 * Countries share the category sidebar's hidden-country list (hiding India
 * here hides its group there, and the other way round); keywords catch
 * categories filed under another country ("|DE| BOLLYWOOD").
 */
export function ContentFilterSettings() {
  const { t, language } = useI18n();
  const categoryPrefs = useSettingsStore((s) => s.categoryPrefs);
  const setHiddenCountries = useSettingsStore((s) => s.setHiddenCountries);
  const keywords = useSettingsStore((s) => s.catalogHiddenKeywords);
  const updateSetting = useSettingsStore((s) => s.updateSetting);
  const [draft, setDraft] = useState('');

  const movies = useCategories('vod');
  const series = useCategories('series');

  // A country counts as hidden when either page hides it; the filter edits
  // both together.
  const hidden = useMemo(() => {
    const keys = new Set<string>();
    for (const type of FILTERED_TYPES) {
      for (const key of categoryPrefs?.hiddenCountries?.[type] ?? []) keys.add(key);
    }
    return [...keys];
  }, [categoryPrefs]);

  // The countries the provider's Movies/Series categories actually declare,
  // with how many categories each one has.
  const available = useMemo(() => {
    const counts = new Map<string, number>();
    for (const category of [...(movies.data ?? []), ...(series.data ?? [])]) {
      const { country } = parseProviderCategoryName(category.category_name || '');
      if (!country) continue;
      counts.set(country, (counts.get(country) ?? 0) + 1);
    }
    return [...counts.entries()]
      .filter(([country]) => !hidden.includes(country))
      .map(([country, count]) => ({
        value: country,
        label: `${countryName(country, language)} (${count})`,
        localize: false,
      }))
      .sort((a, b) => a.label.localeCompare(b.label, language));
  }, [hidden, language, movies.data, series.data]);

  const setCountries = (keys: string[]) => {
    for (const type of FILTERED_TYPES) setHiddenCountries(type, keys);
  };

  const addKeyword = () => {
    const keyword = draft.trim();
    if (!keyword) return;
    if (!keywords.some((existing) => existing.toLowerCase() === keyword.toLowerCase())) {
      updateSetting('catalogHiddenKeywords', [...keywords, keyword].slice(0, 50));
    }
    setDraft('');
  };

  return (
    <SettingsGroup
      title="Content Filter"
      description="Leave content out of Movies and Series by default. A title with a copy that is not filtered still shows that copy."
    >
      <SettingsRow
        title="Hidden Countries"
        description="Hides every Movies and Series category of these countries. The category sidebar shares this list."
        alignStart
        wideControl
      >
        <div className={styles.filterControl}>
          {hidden.length > 0 && (
            <div className={styles.chips}>
              {hidden.map((key) => (
                <span key={key} className={styles.chip}>
                  <CountryFlag code={key} className={styles.flag} />
                  {countryName(key === 'other' ? null : key, language)}
                  <button
                    type="button"
                    className={styles.chipRemove}
                    aria-label={t('Show {name} again', {
                      name: countryName(key === 'other' ? null : key, language),
                    })}
                    onClick={() => setCountries(hidden.filter((other) => other !== key))}
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <Select
            ariaLabel="Hide a country"
            variant="settings"
            width={240}
            value=""
            onChange={(country) => {
              if (country) setCountries([...hidden, country]);
            }}
            options={[{ value: '', label: 'Hide a country…' }, ...available]}
          />
        </div>
      </SettingsRow>
      <SettingsRow
        title="Hidden Keywords"
        description='Hides Movies and Series categories whose name contains one of these words, e.g. "Bollywood".'
        alignStart
        wideControl
      >
        <div className={styles.filterControl}>
          {keywords.length > 0 && (
            <div className={styles.chips}>
              {keywords.map((keyword) => (
                <span key={keyword} className={styles.chip}>
                  {keyword}
                  <button
                    type="button"
                    className={styles.chipRemove}
                    aria-label={t('Remove {name}', { name: keyword })}
                    onClick={() =>
                      updateSetting(
                        'catalogHiddenKeywords',
                        keywords.filter((other) => other !== keyword),
                      )
                    }
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className={styles.keywordEntry}>
            <SettingsInput
              aria-label="Keyword to hide"
              placeholder="Add a keyword"
              maxLength={64}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') addKeyword();
              }}
              style={{ width: '180px' }}
            />
            <SettingsButton onClick={addKeyword} disabled={!draft.trim()}>
              {t('Add')}
            </SettingsButton>
          </div>
        </div>
      </SettingsRow>
    </SettingsGroup>
  );
}
