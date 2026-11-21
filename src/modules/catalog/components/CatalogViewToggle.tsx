import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { EllipsisVertical, Minus, Plus } from 'lucide-react';
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

/**
 * The page's view options behind a "⋯" button: grid or list, and (in grid
 * view) the card size. Both are remembered per section, so they stay out of
 * the header until they are wanted.
 */
export function CatalogViewToggle() {
  const { t, number } = useI18n();
  const menuId = useId();
  const buttonRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; right: number } | null>(null);
  const [viewMode, setViewMode] = useViewMode();
  const [cardScale, setCardScale] = useCardScale();
  const index = stepIndex(cardScale);

  const place = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      setPosition({
        top: rect.bottom + 6,
        right: Math.max(12, window.innerWidth - rect.right),
      });
    }
  };

  useEffect(() => {
    if (!open) return;
    place();
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
    };
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [open]);

  return (
    <>
      <span ref={buttonRef} className={styles.anchor}>
        <IconButton
          size="sm"
          aria-label={t('View options')}
          title={t('View options')}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={() => setOpen((current) => !current)}
        >
          <EllipsisVertical size={22} strokeWidth={2.75} />
        </IconButton>
      </span>
      {open &&
        position &&
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            role="dialog"
            aria-label={t('View options')}
            className={styles.menu}
            style={{ top: position.top, right: position.right }}
          >
            <div className={styles.menuRow}>
              <span className={styles.menuLabel}>{t('Layout')}</span>
              <SegmentedControl
                ariaLabel="Catalog layout"
                value={viewMode}
                onChange={(val) => setViewMode(val as 'grid' | 'list')}
                options={[
                  {
                    value: 'grid',
                    label: 'Grid',
                    icon: RiLayoutGridLine,
                    activeIcon: RiLayoutGridFill,
                  },
                  {
                    value: 'list',
                    label: 'List',
                    icon: RiLayoutRowLine,
                    activeIcon: RiLayoutRowFill,
                  },
                ]}
              />
            </div>
            {viewMode === 'grid' && (
              <div className={styles.menuRow}>
                <span className={styles.menuLabel}>{t('Card size')}</span>
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
                    onClick={() =>
                      setCardScale(CARD_SCALES[Math.min(CARD_SCALES.length - 1, index + 1)]!)
                    }
                    disabled={index === CARD_SCALES.length - 1}
                    aria-label={t('Larger cards')}
                    title={t('Larger cards')}
                  >
                    <Plus size={14} />
                  </IconButton>
                </div>
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
