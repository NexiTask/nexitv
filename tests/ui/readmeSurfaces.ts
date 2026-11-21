export const README_SURFACES = [
  'hero',
  'movies',
  'series',
  'continue-watching',
  'favorites',
  'collections',
  'not-found',
  'live-tv',
  'live-epg',
  'player-vod',
  'player-series',
  'library-details',
  'series-details',
  'upcoming',
  'search',
  'm3u-editor',
  'm3u-raw-editor',
  'downloads',
  'settings',
  'playback-settings',
  'light-theme',
] as const;

export type ReadmeSurface = (typeof README_SURFACES)[number];

/** README-only views of newer features that the production UI QA scenarios
 * do not cover; the screenshot script captures them like any surface. */
export const README_FEATURE_SURFACES = ['movies-filters'] as const;

export type ReadmeFeatureSurface = (typeof README_FEATURE_SURFACES)[number];
