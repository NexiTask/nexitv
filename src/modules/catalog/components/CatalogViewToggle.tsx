import {
  RiLayoutGridFill,
  RiLayoutGridLine,
  RiLayoutRowFill,
  RiLayoutRowLine,
} from '@/shared/ui/icons';
import { useViewMode } from '../hooks/useViewMode';
import { SegmentedControl } from '@/shared/ui/SegmentedControl';

export function CatalogViewToggle() {
  const [viewMode, setViewMode] = useViewMode();

  return (
    <SegmentedControl
      ariaLabel="Catalog layout"
      value={viewMode}
      onChange={(val) => setViewMode(val as 'grid' | 'list')}
      options={[
        { value: 'grid', label: 'Grid', icon: RiLayoutGridLine, activeIcon: RiLayoutGridFill },
        { value: 'list', label: 'List', icon: RiLayoutRowLine, activeIcon: RiLayoutRowFill },
      ]}
    />
  );
}
