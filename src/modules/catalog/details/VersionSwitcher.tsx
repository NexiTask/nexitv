import { useI18n } from '@/shared/i18n/i18n';
import { countryName } from '@/shared/lib/categoryName';
import { Select } from '@/shared/ui/Select';
import { parseMediaDisplayTitle } from '../lib/titleParser';
import type { TitleVariant } from '../data/useTitleVariants';
import styles from './VersionSwitcher.module.css';

export interface VersionSwitcherProps {
  variants: readonly TitleVariant[];
  activeId: string;
  onSelect: (item: TitleVariant['item']) => void;
}

/** The "N versions" row on a detail sheet: the provider variants behind one
 * grouped card, the open one included. Hidden when there is only one. */
export function VersionSwitcher({ variants, activeId, onSelect }: VersionSwitcherProps) {
  const { t, tn, number, language } = useI18n();
  if (variants.length < 2) return null;

  // Labels say what sets the copies apart: the title's own tags ("4K", "FHD")
  // plus the country its title or category declares. "4K" and "EN" repeat
  // across providers, so a repeated label gets its position appended.
  const seen = new Set<string>();
  const options = variants.map((variant, index) => {
    const tags = parseMediaDisplayTitle(variant.item.title).tags;
    const parts = [...tags];
    if (
      variant.country &&
      !parts.some((tag) => tag.toLowerCase() === variant.country?.toLowerCase())
    ) {
      parts.push(countryName(variant.country, language));
    }
    const base = parts.length > 0 ? parts.join(' · ') : t('Standard');
    const label = seen.has(base) ? `${base} (${number(index + 1)})` : base;
    seen.add(base);
    return { value: variant.item.id, label };
  });

  return (
    <div className={styles.versionRow}>
      <span className={styles.versionLabel}>
        {tn('{count} version', '{count} versions', variants.length, {
          count: number(variants.length),
        })}
      </span>
      <Select
        ariaLabel={t('Version')}
        width={220}
        value={activeId}
        onChange={(id) => {
          const variant = variants.find((candidate) => candidate.item.id === id);
          if (variant) onSelect(variant.item);
        }}
        options={options}
      />
    </div>
  );
}
