import { useI18n } from '@/shared/i18n/i18n';
import { Select } from '@/shared/ui/Select';
import { parseMediaDisplayTitle } from '../lib/titleParser';
import type { MediaItem } from '../model/media';
import styles from './VersionSwitcher.module.css';

export interface VersionSwitcherProps {
  variants: readonly MediaItem[];
  activeId: string;
  onSelect: (item: MediaItem) => void;
}

/** The "N versions" row on a detail sheet: the provider variants behind one
 * grouped card. Hidden when the title has no other variants. */
export function VersionSwitcher({ variants, activeId, onSelect }: VersionSwitcherProps) {
  const { t, tn, number } = useI18n();
  if (variants.length === 0) return null;

  // "4K", "FHD", "EN" repeat across providers; a repeated label gets its
  // position appended so every option stays distinguishable.
  const seen = new Set<string>();
  const options = variants.map((item, index) => {
    const tags = parseMediaDisplayTitle(item.title).tags;
    const base = tags.length > 0 ? tags.join(' · ') : t('Standard');
    const label = seen.has(base) ? `${base} (${number(index + 1)})` : base;
    seen.add(base);
    return { value: item.id, label };
  });

  return (
    <div className={styles.versionRow}>
      <span className={styles.versionLabel}>
        {tn('{count} version', '{count} versions', variants.length + 1, {
          count: number(variants.length + 1),
        })}
      </span>
      <Select
        ariaLabel={t('Version')}
        width={220}
        value={activeId}
        onChange={(id) => {
          const item = variants.find((candidate) => candidate.id === id);
          if (item) onSelect(item);
        }}
        options={options}
      />
    </div>
  );
}
