export interface GridLayoutMetrics {
  columns: number;
  cardWidth: number;
  rowHeight: number;
}

const STANDARD_TARGET_WIDTH = 180;
const STANDARD_MIN_WIDTH = 150;
const LIVE_TARGET_WIDTH = 120;
const LIVE_MIN_WIDTH = 96;

/**
 * Chooses the closest comfortable column count, then derives card and row
 * dimensions from the exact available content width. The resulting columns
 * plus their gaps always consume the full row without overflowing it.
 */
export function calculateGridLayout(
  containerWidth: number,
  gap: number,
  isLiveTv: boolean,
  /** The viewer's card size: 1 is the standard, 2 twice as wide. */
  scale = 1,
): GridLayoutMetrics {
  const safeWidth = Math.max(0, containerWidth);
  const safeGap = Math.max(0, gap);
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const targetWidth = (isLiveTv ? LIVE_TARGET_WIDTH : STANDARD_TARGET_WIDTH) * safeScale;
  const minWidth = (isLiveTv ? LIVE_MIN_WIDTH : STANDARD_MIN_WIDTH) * safeScale;

  if (safeWidth === 0) {
    return {
      columns: 4,
      cardWidth: targetWidth,
      rowHeight: isLiveTv ? targetWidth : targetWidth * 1.5,
    };
  }

  const closestColumnCount = Math.max(
    1,
    Math.round((safeWidth + safeGap) / (targetWidth + safeGap)),
  );
  const maximumComfortableColumns = Math.max(
    1,
    Math.floor((safeWidth + safeGap) / (minWidth + safeGap)),
  );
  const columns = Math.min(closestColumnCount, maximumComfortableColumns);
  const cardWidth = Math.max(0, (safeWidth - safeGap * (columns - 1)) / columns);

  return {
    columns,
    cardWidth,
    rowHeight: isLiveTv ? cardWidth : cardWidth * 1.5,
  };
}
