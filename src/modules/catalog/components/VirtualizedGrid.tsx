import { useCallback, useEffect, useRef, useLayoutEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { MediaCard } from './MediaCard';
import type { MediaItem } from '../model/media';
import { useViewMode } from '../hooks/useViewMode';
import { calculateGridLayout } from '../lib/gridLayout';
import styles from './VirtualizedGrid.module.css';

type GridCssProperties = CSSProperties & {
  '--grid-card-width': string;
  '--grid-row-height': string;
  '--grid-gap': string;
};

const TRANSFORM_ORIGIN_STYLES: Record<string, CSSProperties> = {
  'left top': { transformOrigin: 'left top' },
  'center top': { transformOrigin: 'center top' },
  'right top': { transformOrigin: 'right top' },
  'left center': { transformOrigin: 'left center' },
  'center center': { transformOrigin: 'center center' },
  'right center': { transformOrigin: 'right center' },
  'left bottom': { transformOrigin: 'left bottom' },
  'center bottom': { transformOrigin: 'center bottom' },
  'right bottom': { transformOrigin: 'right bottom' },
};

interface VirtualizedGridProps {
  /** Every item, in order. Or, for a list held elsewhere, `count` and `getItem`. */
  items?: MediaItem[] | undefined;
  count?: number | undefined;
  /** The item at a position, or undefined while it is still loading. */
  getItem?: ((index: number) => MediaItem | undefined) | undefined;
  /** Positions `[start, end)` the grid currently renders. */
  onRangeChange?: ((start: number, end: number) => void) | undefined;
  onItemClick?: ((item: MediaItem) => void) | undefined;
  onViewDetails?: ((item: MediaItem) => void) | undefined;
  currentCollectionId?: string | undefined;
  gap?: number | undefined;
  isLiveTv?: boolean | undefined;
  showTypeInList?: boolean | undefined;
  /** A quick-remove X on each card (Continue Watching), with its label. */
  onRemoveItem?: ((item: MediaItem) => void) | undefined;
  removeLabel?: string | undefined;
}

export function VirtualizedGrid({
  items,
  count,
  getItem,
  onRangeChange,
  onItemClick,
  onViewDetails,
  currentCollectionId,
  gap = 16,
  isLiveTv = false,
  showTypeInList = true,
  onRemoveItem,
  removeLabel,
}: VirtualizedGridProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState<number>(0);
  const [viewMode] = useViewMode();

  const isListMode = viewMode === 'list';
  const effectiveGap = isListMode ? 0 : gap;

  // Responsive calculation of columns and fluid card dimensions
  useLayoutEffect(() => {
    const parentEl = parentRef.current;
    if (!parentEl) return;

    let frameId: number | null = null;
    let hasMeasured = false;

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (!entry) return;
      // ResizeObserver reports the element's content box, so its inline size
      // already excludes this scroll container's padding.
      const width = Math.max(0, Math.round(entry.contentRect.width));

      // The very first measurement (mount, or a page switch) has to land
      // immediately or the grid renders at the wrong column count for a
      // frame. After that, resize can fire many times within a single
      // frame (dragging the category sidebar's resize handle is the worst
      // case) — recomputing the virtualizer's full column layout and
      // re-rendering every visible card on each of those overwhelms the
      // main thread. Collapsing bursts to one commit per animation frame,
      // always using the latest measured width, keeps it tracking live
      // (imperceptibly ~16ms behind) instead of either flooding the main
      // thread or visibly lagging behind an actual window resize.
      if (!hasMeasured) {
        hasMeasured = true;
        setContainerWidth((current) => (current === width ? current : width));
        return;
      }

      if (frameId !== null) cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(() => {
        frameId = null;
        setContainerWidth((current) => (current === width ? current : width));
      });
    });

    resizeObserver.observe(parentEl);
    return () => {
      if (frameId !== null) cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
    };
  }, []);

  const gridLayout = calculateGridLayout(containerWidth, effectiveGap, isLiveTv);
  const columns = isListMode ? 1 : gridLayout.columns;
  const actualCardWidth = isListMode ? containerWidth : gridLayout.cardWidth;
  const actualRowHeight = isListMode ? 64 : gridLayout.rowHeight;

  const total = items ? items.length : (count ?? 0);
  const itemAt = (index: number) => (items ? items[index] : getItem?.(index));
  const rowCount = Math.ceil(total / columns);
  const layoutSignature = `${isListMode ? 'list' : isLiveTv ? 'live' : 'standard'}:${columns}:${actualRowHeight}:${effectiveGap}`;
  const getRowKey = useCallback(
    (index: number) => `${layoutSignature}:${index}`,
    [layoutSignature],
  );

  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    getItemKey: getRowKey,
    estimateSize: () => actualRowHeight,
    gap: effectiveGap,
    // Poster rows are visually tall and expensive to composite; one buffered
    // row is enough. Compact Live TV and list rows keep a little more runway.
    overscan: isListMode ? 4 : isLiveTv ? 2 : 1,
  });

  const virtualRows = rowVirtualizer.getVirtualItems();
  const firstIndex = virtualRows.length > 0 ? virtualRows[0]!.index * columns : 0;
  const lastIndex =
    virtualRows.length > 0
      ? Math.min(total, (virtualRows[virtualRows.length - 1]!.index + 1) * columns)
      : 0;
  useEffect(() => {
    if (onRangeChange && lastIndex > firstIndex) onRangeChange(firstIndex, lastIndex);
  }, [firstIndex, lastIndex, onRangeChange]);

  // A geometry-aware row key invalidates cached estimates during the current
  // render. This avoids the expensive measure() + notification + second
  // render cycle that made continuous sidebar/window resizing stutter.
  const gridStyle: GridCssProperties = {
    '--grid-card-width': isListMode ? '100%' : `${actualCardWidth}px`,
    '--grid-row-height': `${actualRowHeight}px`,
    '--grid-gap': `${effectiveGap}px`,
  };

  return (
    <div
      ref={parentRef}
      className={`${styles.gridContainer} ${isListMode ? styles.listContainer : ''} subtle-scrollbar`}
      style={gridStyle}
    >
      <div
        className={isListMode ? styles.listSurface : undefined}
        style={{
          height: `${rowVirtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualRows.map((virtualRow) => {
          const startIndex = virtualRow.index * columns;
          const rowItems = Array.from(
            { length: Math.max(0, Math.min(columns, total - startIndex)) },
            (_, offset) => itemAt(startIndex + offset),
          );

          return (
            <div
              // The virtualizer's key deliberately changes when row geometry
              // changes so its size cache is rebuilt. It must not also be the
              // React key: doing that remounts every visible card on each
              // resize frame, making images re-decode and placeholders flash.
              key={virtualRow.index}
              className={`${styles.rowWrapper} ${isListMode ? styles.listRow : ''} ${isListMode && virtualRow.index === rowCount - 1 ? styles.listRowLast : ''}`}
              style={{
                transform: `translateY(${virtualRow.start}px)`,
                zIndex: rowCount - virtualRow.index,
              }}
            >
              {rowItems.map((item, colIndex) => {
                // A row still loading keeps its place, so nothing shifts when it arrives.
                if (!item) {
                  return (
                    <div
                      key={`pending-${startIndex + colIndex}`}
                      className={styles.itemWrapper}
                      aria-hidden="true"
                    />
                  );
                }
                const isFirstCol = colIndex === 0;
                const isLastCol = colIndex === columns - 1;
                const isFirstRow = virtualRow.index === 0;
                const isLastRow = virtualRow.index === rowCount - 1;

                let originX = 'center';
                if (isFirstCol) originX = 'left';
                else if (isLastCol) originX = 'right';

                let originY = 'center';
                if (isFirstRow) originY = 'top';
                else if (isLastRow) originY = 'bottom';

                const transformOrigin = `${originX} ${originY}`;

                return (
                  <div key={item.id} className={styles.itemWrapper}>
                    <MediaCard
                      item={item}
                      onClick={onItemClick}
                      onViewDetails={onViewDetails}
                      currentCollectionId={currentCollectionId}
                      viewMode={viewMode}
                      isLiveTv={isLiveTv}
                      showTypeInList={showTypeInList}
                      onRemove={onRemoveItem}
                      removeLabel={removeLabel}
                      style={TRANSFORM_ORIGIN_STYLES[transformOrigin]}
                    />
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
