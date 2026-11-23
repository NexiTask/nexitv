import { lazy } from 'react';

const loaders = {
  '/': () => import('@/modules/catalog/pages/HomePage'),
  '/live': () => import('@/modules/catalog/pages/LiveTVPage'),
  '/epg': () => import('@/modules/guide/pages/EpgPage'),
  '/movies': () => import('@/modules/catalog/pages/MoviesPage'),
  '/series': () => import('@/modules/catalog/pages/SeriesPage'),
  '/search': () => import('@/modules/search/pages/SearchPage'),
  '/library': () => import('@/modules/library/pages/LibraryPage'),
  '/downloads': () => import('@/modules/downloads/pages/DownloadsPage'),
  '/settings': () => import('@/modules/settings/pages/SettingsPage'),
  '/m3u-editor': () => import('@/modules/m3u-editor/pages/M3uEditorPage'),
} as const;

type PreloadableRoute = keyof typeof loaders;

export function preloadRouteModule(path: string): Promise<unknown> | undefined {
  const route = path.startsWith('/m3u-editor')
    ? '/m3u-editor'
    : path.startsWith('/library/')
      ? '/library'
      : path;
  return loaders[route as PreloadableRoute]?.();
}

export const HomePage = lazy(() => loaders['/']().then((module) => ({ default: module.HomePage })));
export const LiveTvPage = lazy(() =>
  loaders['/live']().then((module) => ({ default: module.LiveTvPage })),
);
export const EpgPage = lazy(() =>
  loaders['/epg']().then((module) => ({ default: module.EpgPage })),
);
export const MoviesPage = lazy(() =>
  loaders['/movies']().then((module) => ({ default: module.MoviesPage })),
);
export const SeriesPage = lazy(() =>
  loaders['/series']().then((module) => ({ default: module.SeriesPage })),
);
export const SearchPage = lazy(() =>
  loaders['/search']().then((module) => ({ default: module.SearchPage })),
);
export const LibraryPage = lazy(() =>
  loaders['/library']().then((module) => ({ default: module.LibraryPage })),
);
export const DownloadsPage = lazy(() =>
  loaders['/downloads']().then((module) => ({ default: module.DownloadsPage })),
);
export const SettingsPage = lazy(() =>
  loaders['/settings']().then((module) => ({ default: module.SettingsPage })),
);
export const M3uEditorPage = lazy(() =>
  loaders['/m3u-editor']().then((module) => ({ default: module.M3uEditorPage })),
);
