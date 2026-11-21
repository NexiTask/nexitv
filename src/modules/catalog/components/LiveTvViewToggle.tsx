import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSettingsStore } from '@/modules/settings/public/store/useSettingsStore';
import {
  RiCalendarScheduleFill,
  RiCalendarScheduleLine,
  RiTv2Fill,
  RiTv2Line,
} from '@/shared/ui/icons';
import { SegmentedControl } from '@/shared/ui/SegmentedControl';

type LiveTvView = 'channels' | 'guide';
const ROUTES: Record<LiveTvView, string> = { channels: '/live', guide: '/epg' };

/**
 * Live TV's Channels | Guide switch, in the header of both views. The view
 * last shown is remembered, so the sidebar's Live TV entry reopens it.
 */
export function LiveTvViewToggle({ view }: { view: LiveTvView }) {
  const navigate = useNavigate();
  const remembered = useSettingsStore((state) => state.liveTvView);
  const updateSetting = useSettingsStore((state) => state.updateSetting);

  useEffect(() => {
    if (remembered !== view) updateSetting('liveTvView', view);
  }, [remembered, updateSetting, view]);

  return (
    <SegmentedControl<LiveTvView>
      ariaLabel="Live TV view"
      size="sm"
      value={view}
      onChange={(next) => {
        if (next !== view) navigate(ROUTES[next]);
      }}
      options={[
        { value: 'channels', label: 'Channels', icon: RiTv2Line, activeIcon: RiTv2Fill },
        {
          value: 'guide',
          label: 'Guide',
          icon: RiCalendarScheduleLine,
          activeIcon: RiCalendarScheduleFill,
        },
      ]}
    />
  );
}
