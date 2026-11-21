import { Minus, Plus } from 'lucide-react';
import {
  RiLayoutGridFill,
  RiLayoutGridLine,
  RiLayoutRowFill,
  RiLayoutRowLine,
} from '@/shared/ui/icons';
import { CARD_SCALES, useCardScale, useViewMode } from '../hooks/useViewMode';
import { SegmentedControl } from '@/shared/ui/SegmentedControl';
import { IconButton } from '@/shared/ui/Button';
import { useI18n } from '@/shared/i18n/i18n';
import styles from './CatalogViewToggle.module.css';

/** The nearest step to a stored scale, so the buttons always move by one step. */
function stepIndex(scale: number): number {
  let best = 0;
  CARD_SCALES.forEach((step, index) => {
    if (Math.abs(step - scale) < Math.abs(CARD_SCALES[best]! - scale)) best = index;
  });
  return best;
}

export function CatalogViewToggle() {
  const { t, number } = useI18n();
  const [viewMode, setViewMode] = useViewMode();
  const [cardScale, setCardScale] = useCardScale();
  const index = stepIndex(cardScale);

  return (
    <div className={styles.viewControls}>
      {viewMode === 'grid' && (
        <div className={styles.sizeControl} role="group" aria-label={t('Card size')}>
          <IconButton
            size="sm"
            onClick={() => setCardScale(CARD_SCALES[Math.max(0, index - 1)]!)}
            disabled={index === 0}
            aria-label={t('Smaller cards')}
            title={t('Smaller cards')}
          >
            <Minus size={14} />
          </IconButton>
          <span className={styles.sizeValue} aria-live="polite">
            {number(CARD_SCALES[index]!, { style: 'percent' })}
          </span>
          <IconButton
            size="sm"
            onClick={() => setCardScale(CARD_SCALES[Math.min(CARD_SCALES.length - 1, index + 1)]!)}
            disabled={index === CARD_SCALES.length - 1}
            aria-label={t('Larger cards')}
            title={t('Larger cards')}
          >
            <Plus size={14} />
          </IconButton>
        </div>
      )}
      <SegmentedControl
        ariaLabel="Catalog layout"
        value={viewMode}
        onChange={(val) => setViewMode(val as 'grid' | 'list')}
        options={[
          { value: 'grid', label: 'Grid', icon: RiLayoutGridLine, activeIcon: RiLayoutGridFill },
          { value: 'list', label: 'List', icon: RiLayoutRowLine, activeIcon: RiLayoutRowFill },
        ]}
      />
    </div>
  );
}
