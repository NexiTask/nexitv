import { LibraryBig, PanelLeftClose, PanelLeft } from 'lucide-react';
import {
  RiHome5Fill,
  RiHome5Line,
  RiMovie2Fill,
  RiMovie2Line,
  RiSearchFill,
  RiSearchLine,
  RiSettings3Fill,
  RiSettings3Line,
  RiSlideshow3Fill,
  RiSlideshow3Line,
  RiTv2Fill,
  RiTv2Line,
} from '@/shared/ui/icons';
import { NavLink, useLocation } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import { useDownloadStore } from '@/modules/downloads/store/useDownloadStore';
import { useSettingsStore } from '@/modules/settings/store/useSettingsStore';
import { StateIcon } from '@/shared/ui/StateIcon';
import { useEnabledSources } from '@/modules/sources/hooks/useEnabledSources';
import { prefetchNavigationData } from '../bootstrap/prefetch';
import { DataActivityStatus } from '../components/DataActivityStatus';
import styles from './Sidebar.module.css';
import { useI18n } from '@/shared/i18n/i18n';
import { useMediaQuery } from '@/modules/catalog/hooks/useMediaQuery';

const COMPACT_NAVIGATION_QUERY = '(max-width: 640px)';

export function Sidebar() {
  const { t, number, tn } = useI18n();
  const storedCollapsed = useSettingsStore((state) => state.sidebarCollapsed);
  const isCompactViewport = useMediaQuery(COMPACT_NAVIGATION_QUERY);
  const isCollapsed = storedCollapsed || isCompactViewport;
  const showCollapsedSidebarBadges = useSettingsStore((state) => state.showCollapsedSidebarBadges);
  const updateSetting = useSettingsStore((state) => state.updateSetting);
  const setIsCollapsed = (collapsed: boolean) => updateSetting('sidebarCollapsed', collapsed);

  const downloadCount = useDownloadStore((state) => state.jobs.length);
  const sources = useEnabledSources();
  const prefetch = (path: string) => void prefetchNavigationData(path, sources);

  const liveTvView = useSettingsStore((state) => state.liveTvView);
  const { pathname } = useLocation();
  const isAlsoActive = (item: { alsoActiveOn?: readonly string[] }) =>
    item.alsoActiveOn?.includes(pathname) ?? false;

  const navItems: {
    icons: { line: LucideIcon; fill: LucideIcon };
    label: string;
    path: string;
    badge?: number;
    alsoActiveOn?: readonly string[];
  }[] = [
    { icons: { line: RiHome5Line, fill: RiHome5Fill }, label: 'Home', path: '/' },
    // Live TV holds the channel grid and the guide; it reopens the last one.
    {
      icons: { line: RiTv2Line, fill: RiTv2Fill },
      label: 'Live TV',
      path: liveTvView === 'guide' ? '/epg' : '/live',
      alsoActiveOn: ['/live', '/epg'],
    },
    { icons: { line: RiMovie2Line, fill: RiMovie2Fill }, label: 'Movies', path: '/movies' },
    { icons: { line: RiSlideshow3Line, fill: RiSlideshow3Fill }, label: 'Series', path: '/series' },
    { icons: { line: RiSearchLine, fill: RiSearchFill }, label: 'Search', path: '/search' },
    {
      icons: { line: LibraryBig, fill: LibraryBig },
      label: 'Library',
      path: '/library',
      badge: downloadCount,
    },
  ];

  return (
    <aside
      className={`${styles.sidebar} ${isCollapsed ? styles.collapsed : ''} ${showCollapsedSidebarBadges ? styles.showCollapsedBadges : ''}`}
      aria-label={t('Primary navigation')}
    >
      {/* Top drag region for macOS frameless window */}
      <div className={styles.dragArea} data-tauri-drag-region />

      <div className={`${styles.content} subtle-scrollbar`}>
        <div className={styles.logoHeader} data-tauri-drag-region>
          <div className={styles.logoVisual} aria-hidden="true">
            <span className={styles.logoWordmark}>
              <span className={styles.logoInitial}>N</span>
              <span className={styles.logoRemainder}>EXITV</span>
            </span>
          </div>
        </div>

        {/* BROWSE */}
        <nav className={styles.navGroup} aria-label={t('Browse')}>
          {navItems.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              title={
                isCollapsed
                  ? `${t(item.label)}${item.badge ? ` (${number(item.badge)})` : ''}`
                  : undefined
              }
              aria-label={
                isCollapsed
                  ? `${t(item.label)}${item.badge ? `, ${tn('{count} download', '{count} downloads', item.badge, { count: number(item.badge) })}` : ''}`
                  : undefined
              }
              onMouseEnter={() => prefetch(item.path)}
              onFocus={() => prefetch(item.path)}
              className={({ isActive }) =>
                isActive || isAlsoActive(item)
                  ? `${styles.navItem} ${styles.active}`
                  : styles.navItem
              }
            >
              {({ isActive }) => (
                <>
                  <StateIcon
                    icons={item.icons}
                    active={isActive || isAlsoActive(item)}
                    className={styles.icon}
                    size={20}
                  />
                  <span className={styles.labelSlot}>
                    <span className={styles.label}>{t(item.label)}</span>
                    {item.badge ? (
                      <span className={styles.badge} aria-hidden="true">
                        {item.badge}
                      </span>
                    ) : null}
                  </span>
                  {item.badge ? (
                    <span className={styles.collapsedBadge} aria-hidden="true">
                      {item.badge}
                    </span>
                  ) : null}
                </>
              )}
            </NavLink>
          ))}
        </nav>
      </div>

      <div
        className={styles.footer}
        data-seasonal-decor={isCollapsed ? undefined : 'sidebar-footer'}
      >
        <DataActivityStatus compact={isCollapsed} />
        <div className={styles.bottomBar}>
          <NavLink
            to="/settings"
            title={isCollapsed ? t('Settings') : undefined}
            aria-label={isCollapsed ? t('Settings') : undefined}
            className={({ isActive }) =>
              isActive
                ? `${styles.navItem} ${styles.settingsLink} ${styles.active}`
                : `${styles.navItem} ${styles.settingsLink}`
            }
          >
            {({ isActive }) => (
              <>
                <StateIcon
                  icons={{ line: RiSettings3Line, fill: RiSettings3Fill }}
                  active={isActive}
                  className={styles.icon}
                  size={20}
                />
                <span className={styles.labelSlot}>
                  <span className={styles.label}>{t('Settings')}</span>
                </span>
              </>
            )}
          </NavLink>

          <button
            type="button"
            className={styles.bottomToggleBtn}
            onClick={() => setIsCollapsed(!storedCollapsed)}
            title={t(
              isCompactViewport
                ? 'Sidebar stays compact in narrow layouts'
                : storedCollapsed
                  ? 'Expand sidebar'
                  : 'Collapse sidebar',
            )}
            aria-label={t(
              isCompactViewport
                ? 'Sidebar stays compact in narrow layouts'
                : storedCollapsed
                  ? 'Expand sidebar'
                  : 'Collapse sidebar',
            )}
            disabled={isCompactViewport}
          >
            <span className={styles.toggleIcon} aria-hidden="true">
              <PanelLeftClose
                className={`${styles.toggleIconLayer} ${storedCollapsed ? styles.toggleIconHidden : styles.toggleIconVisible}`}
                size={20}
              />
              <PanelLeft
                className={`${styles.toggleIconLayer} ${storedCollapsed ? styles.toggleIconVisible : styles.toggleIconHidden}`}
                size={20}
              />
            </span>
          </button>
        </div>
      </div>
    </aside>
  );
}
