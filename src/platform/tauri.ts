import { invoke } from '@tauri-apps/api/core';

/** The IMDb pipeline's state (metadata/imdb.rs). Unix seconds where set. */
export interface ImdbRefreshStatus {
  running: boolean;
  /** The automatic refresh (weekly dumps, daily backfill) is on. */
  enabled: boolean;
  lastRefresh: number | null;
  /** Titles the current dumps hold. */
  titles: number | null;
  /** Catalogue movies/series with a matched IMDb title, and their total. */
  matched: number;
  total: number;
}

export interface MpvStartOptions {
  /** Frontend-owned identity echoed by every native event for this session. */
  sessionId?: string | undefined;
  url: string;
  hwdec: string;
  hdr: boolean;
  /** Drives how verbose mpv's own log messages are; see settingsTypes.debugLogLevel. */
  debugLogLevel: string;
  toneMapping?: string | undefined;
  cacheSecs: number;
  demuxerMaxBytes: string;
  initialVolume: number;
  initialSpeed: number;
  subtitlesVisible: boolean;
  initialAudioDelayMs?: number | undefined;
  subtitleFontSize?: number | undefined;
  subtitleFontFamily?: string | undefined;
  subtitleOpacity?: number | undefined;
  subtitleBorderSize?: number | undefined;
  subtitleShadowOffset?: number | undefined;
  startPosition?: number | undefined;
  httpHeaders?: Record<string, string> | undefined;
}

export interface M3uFetchOptions {
  url: string;
  headers?: Record<string, string> | undefined;
  /** Opaque source id used by native conditional-request caching. */
  cacheKey?: string | undefined;
}

export interface M3uDocument {
  content: string;
  baseUrl: string;
  fileName?: string | undefined;
}

/** The provider lists an Xtream catalogue is built from. */
export type CatalogCacheKind = 'live' | 'vod' | 'series';

export type CatalogIndexOrder = 'added' | 'rating' | 'provider';

export interface CatalogIndexSource {
  sourceId: string;
  scope: string;
  /** The provider's own category ids, not Movena's source-prefixed ones. */
  hiddenCategoryIds: string[];
}

export interface CatalogIndexRows {
  /** False when some source has neither an index nor a saved copy yet. */
  ready: boolean;
  rows: { sourceId: string; raw: unknown }[];
}

/** The catalogue kinds the Movies, Series and Live TV pages are served for. */
export type CatalogPageKind = 'live' | 'vod' | 'series';

export interface CatalogPageSource {
  sourceId: string;
  scope: string;
}

export interface CatalogPageStatus {
  /** `building` while facets or name ranks are still being derived. */
  state: 'ready' | 'building' | 'unavailable';
  pending: number;
  total: number;
}

/** What a catalogue page shows, in the frontend's own terms (see catalog_query.rs). */
export interface CatalogPageQuery {
  hiddenCategoryIds: string[];
  category: string | null;
  targetCategoryIds: string[] | null;
  favoriteIds: string[];
  ultraHd: Record<string, boolean>;
  ratings: Record<string, { value: number | null; votes: number }>;
  tmdbGenres: Record<string, number>;
  categoryGenres: Record<string, number>;
  genre: number | null;
  sort: string;
  /** Live TV: fold each channel's variants into one (the stream folding setting). */
  fold: boolean;
  /** Instead of a category: exactly these titles, in this order. */
  orderedIds?: string[] | null | undefined;
  /** Keep titles whose normalized title contains this text. */
  titleFilter?: string | null | undefined;
  /** The quality view: an IMDb rating floor and its minimum vote count. */
  imdbMinRating?: number | null | undefined;
  imdbMinVotes?: number | null | undefined;
  /** Leave out the titles the provider flags as adult. */
  excludeAdult?: boolean | undefined;
}

export interface CatalogSearchResult {
  ready: boolean;
  generation: string;
  total: number;
  head: CatalogKeyRow[];
  /** Matches, best first. */
  keys: Uint32Array;
  /** `smartSearch` score of each match. */
  scores: Uint32Array;
}

/** Decodes a search answer: the page layout with keys followed by scores. */
export function decodeCatalogSearch(buffer: ArrayBuffer): CatalogSearchResult {
  const page = decodeCatalogPage(buffer) as unknown as Omit<
    CatalogSearchResult,
    'keys' | 'scores'
  > & {
    keys: Uint32Array;
  };
  const total = page.ready ? page.total : 0;
  return {
    ...page,
    keys: page.keys.subarray(0, total),
    scores: page.keys.subarray(total, total * 2),
  };
}

export interface CatalogKeyRow {
  key: number;
  raw: unknown;
  /** A folded channel's variants (itself included), in provider order. */
  group?: CatalogKeyRow[] | undefined;
}

export interface CatalogPageResult {
  ready: boolean;
  status: CatalogPageStatus | null;
  /** Identifies the index state the keys belong to; rows are asked for under it. */
  generation: string;
  total: number;
  categoryTotal: number;
  genreCounts: number[];
  head: CatalogKeyRow[];
  /** `source position << 23 | provider list position`, in page order. */
  keys: Uint32Array;
}

export interface CatalogPageStats {
  categoryCounts: Record<string, number>;
  visibleTotal: number;
  favorites: number;
  recent: number;
  topRated: number;
  fourK: number;
}

/** Decodes `[u32 header length][header JSON][padding][u32 keys]` (little endian). */
export function decodeCatalogPage(buffer: ArrayBuffer): CatalogPageResult {
  const headerLength = new DataView(buffer).getUint32(0, true);
  const header = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buffer, 4, headerLength)),
  ) as Omit<CatalogPageResult, 'keys'>;
  const offset = Math.ceil((4 + headerLength) / 4) * 4;
  const keys = new Uint32Array(buffer, offset, Math.max(0, (buffer.byteLength - offset) / 4));
  return { ...header, keys };
}

export interface CatalogCacheEntry {
  /** The provider's JSON list, exactly as it was received. */
  content: string;
  /** Milliseconds since the Unix epoch. */
  savedAt: number;
}

export type M3uProbeStatus = 'online' | 'offline' | 'unauthorized' | 'timeout';

export interface M3uProbeOptions {
  url: string;
  headers?: Record<string, string> | undefined;
  timeoutMs?: number | undefined;
}

export interface M3uProbeResult {
  status: M3uProbeStatus;
  httpStatus?: number | undefined;
  errorMessage?: string | undefined;
  latencyMs: number;
}

interface XmltvChannelDto {
  id: string;
  names: string[];
}

interface XmltvProgrammeDto {
  title: string;
  description: string;
  start: number;
  end: number;
}

interface XmltvProgrammeGroupDto {
  channelId: string;
  programmes: XmltvProgrammeDto[];
}

export interface XmltvGuidePayload {
  channels: XmltvChannelDto[];
  programmeGroups: XmltvProgrammeGroupDto[];
}

export interface DownloadMediaOptions {
  id?: string | undefined;
  url: string;
  fileName: string;
  headers?: Record<string, string> | undefined;
  directory?: string | undefined;
}

export interface DeleteDownloadOptions {
  path: string;
  directory?: string | undefined;
}

export type MpvPropertyUpdate =
  | { property: 'video-aspect-override'; value: '-2' | '16:9' | '4:3' | '1:1' | '5:4' }
  | { property: 'keepaspect' | 'video-unscaled'; value: 'yes' | 'no' }
  | { property: 'panscan'; value: '0' | '1' }
  | { property: 'video-crop'; value: '' | '50%x100%+0+0' }
  | { property: 'brightness' | 'contrast' | 'saturation' | 'hue' | 'gamma'; value: number }
  | { property: 'scale-blur' | 'cscale-blur'; value: number }
  | { property: 'audio-delay'; value: number }
  | { property: 'sub-font-size' | 'sub-border-size' | 'sub-shadow-offset'; value: number }
  | { property: 'sub-font' | 'sub-color'; value: string };

/**
 * Strongly-typed wrapper for all Tauri IPC commands in Movena.
 */
export const tauriApi = {
  /** Spawn or re-initialize native mpv player instance */
  mpvStart: (options: MpvStartOptions) => invoke<void>('mpv_start', { options }),

  /** Terminate active mpv player instance */
  mpvStop: () => invoke<void>('mpv_stop'),

  /** Toggle playback pause state */
  mpvPlayPause: () => invoke<void>('mpv_play_pause'),

  /** Seek to absolute time position in seconds */
  mpvSeek: (position: number) => invoke<void>('mpv_seek', { position }),

  /** Relative seek forward or backward in seconds */
  mpvSeekRelative: (seconds: number) => invoke<void>('mpv_seek_relative', { seconds }),

  /** Set playback audio volume level (0-100) */
  mpvSetVolume: (volume: number) => invoke<void>('mpv_set_volume', { volume }),

  /** Set playback speed multiplier (e.g. 0.5 to 2.0) */
  mpvSetSpeed: (speed: number) => invoke<void>('mpv_set_speed', { speed }),

  /** Switch active audio track ID */
  mpvSetAudioTrack: (trackId: number) => invoke<void>('mpv_set_audio_track', { trackId }),

  /** Switch active subtitle track ID (or 0 for disabled) */
  mpvSetSubTrack: (trackId: number) => invoke<void>('mpv_set_sub_track', { trackId }),

  /** Start or stop stream recording dump to file path */
  mpvSetRecording: (path: string) => invoke<void>('mpv_set_recording', { path }),

  /** Set one validated mpv property from Movena's finite public allowlist. */
  mpvSetProperty: (update: MpvPropertyUpdate) => invoke<void>('mpv_set_property', { update }),

  /** Toggle native/borderless window fullscreen */
  playerSetFullscreen: (on: boolean) => invoke<boolean>('player_set_fullscreen', { on }),

  /** Hide or show native cursor over video viewport */
  playerSetCursorHidden: (hidden: boolean) =>
    invoke<boolean>('player_set_cursor_hidden', { hidden }),

  /** Store the active provider password in the operating-system credential vault. */
  credentialStore: (password: string) => invoke<void>('credential_store', { password }),

  /** Restore the active provider password from the operating-system credential vault. */
  credentialLoad: () => invoke<string | null>('credential_load'),

  /** Remove the active provider password from the operating-system credential vault. */
  credentialDelete: () => invoke<void>('credential_delete'),

  /** Store one playlist connection secret by its non-secret source id. */
  sourceSecretStore: (sourceId: string, value: string) =>
    invoke<void>('source_secret_store', { sourceId, value }),

  /** Restore one playlist connection secret. */
  sourceSecretLoad: (sourceId: string) => invoke<string | null>('source_secret_load', { sourceId }),

  /** Remove one playlist connection secret. */
  sourceSecretDelete: (sourceId: string) => invoke<void>('source_secret_delete', { sourceId }),

  /** Download a remote M3U outside the webview's CORS boundary. */
  m3uFetch: (options: M3uFetchOptions) => invoke<M3uDocument>('m3u_fetch', { options }),

  /** Probe a stream outside the webview CORS boundary with its source headers. */
  m3uProbeStream: (options: M3uProbeOptions) =>
    invoke<M3uProbeResult>('m3u_probe_stream', { options }),

  /** Download, decompress, and parse XMLTV outside the webview. */
  xmltvFetch: (options: M3uFetchOptions) => invoke<XmltvGuidePayload>('xmltv_fetch', { options }),

  /**
   * Fetch IntroDB's intro/recap/outro timestamps outside the webview's CORS
   * boundary. IntroDB always answers with a hardcoded
   * `Access-Control-Allow-Origin: https://introdb.app`, so a direct
   * `fetch()` from the app is silently blocked by the browser for every
   * request regardless of network connectivity or data availability.
   */
  introDbFetchSegments: (imdbId: string, season: number, episode: number) =>
    invoke<unknown>('introdb_fetch_segments', { imdbId, season, episode }),

  /** The IMDb pipeline's state: refresh schedule, coverage, last refresh. */
  imdbRefreshStatus: () => invoke<ImdbRefreshStatus>('imdb_refresh_status'),

  /** Update the IMDb data now, regardless of the weekly schedule. */
  imdbRefreshStart: () => invoke<ImdbRefreshStatus>('imdb_refresh_start'),

  /** Turn the automatic refresh (weekly dumps, daily backfill) off or on. */
  imdbRefreshSetEnabled: (enabled: boolean) =>
    invoke<void>('imdb_refresh_set_enabled', { enabled }),

  /** Start a managed media download; progress and lifecycle arrive on download-event. */
  downloadMediaStart: (options: DownloadMediaOptions & { id: string }) =>
    invoke<void>('download_media_start', { options }),
  downloadMediaPause: (id: string) => invoke<void>('download_media_pause', { id }),
  downloadMediaResume: (id: string) => invoke<void>('download_media_resume', { id }),
  downloadMediaCancel: (id: string) => invoke<void>('download_media_cancel', { id }),
  /** Permanently deletes a completed download's file from disk. */
  downloadMediaDelete: (options: DeleteDownloadOptions) =>
    invoke<void>('download_media_delete', { options }),

  /** Read a user-selected local M3U and report its base directory URL. */
  m3uReadFile: (path: string) => invoke<M3uDocument>('m3u_read_file', { path }),

  /** Write a validated M3U playlist file to a user-selected path. */
  m3uWriteFile: (path: string, content: string) =>
    invoke<void>('m3u_write_file', { path, content }),

  /** Persist the latest valid playlist body in application data. */
  m3uCacheStore: (sourceId: string, document: M3uDocument) =>
    invoke<void>('m3u_cache_store', { sourceId, document }),

  /** Load a previously validated playlist body. */
  m3uCacheLoad: (sourceId: string) => invoke<M3uDocument | null>('m3u_cache_load', { sourceId }),

  /** Remove a playlist's application-data cache. */
  m3uCacheDelete: (sourceId: string) => invoke<void>('m3u_cache_delete', { sourceId }),

  /** Keep a provider's catalogue list on disk under the account scope it belongs to. */
  catalogCacheStore: (sourceId: string, kind: CatalogCacheKind, scope: string, content: string) =>
    invoke<void>('catalog_cache_store', { sourceId, kind, scope, content }),

  /** A stored catalogue list, or null when there is none for this account or it is too old. */
  catalogCacheLoad: (sourceId: string, kind: CatalogCacheKind, scope: string) =>
    invoke<CatalogCacheEntry | null>('catalog_cache_load', { sourceId, kind, scope }),

  /** A pre-ordered candidate pool from the catalogue index (hidden categories left out). */
  catalogIndexRows: (
    kind: CatalogCacheKind,
    sources: CatalogIndexSource[],
    order: CatalogIndexOrder,
    limit: number,
  ) => invoke<CatalogIndexRows>('catalog_index_rows', { kind, sources, order, limit }),

  /** Whether the Movies or Series page can be served from the catalogue index. */
  catalogIndexPageStatus: (kind: CatalogPageKind, sources: CatalogPageSource[]) =>
    invoke<CatalogPageStatus>('catalog_index_page_status', { kind, sources }),

  /** One catalogue page's ordered keys, genre counts and first rows. */
  catalogIndexPage: async (
    kind: CatalogPageKind,
    sources: CatalogPageSource[],
    query: CatalogPageQuery,
  ) => decodeCatalogPage(await invoke<ArrayBuffer>('catalog_index_page', { kind, sources, query })),

  /** Raw provider rows for page keys; `stale` when the index changed since `generation`. */
  catalogIndexPageRows: (
    kind: CatalogPageKind,
    sources: CatalogPageSource[],
    generation: string,
    keys: number[],
    fold: boolean,
  ) =>
    invoke<{ stale: boolean; rows: CatalogKeyRow[] }>('catalog_index_page_rows', {
      kind,
      sources,
      generation,
      keys,
      fold,
    }),

  /** The category sidebar's counts, or null while the index cannot serve the page. */
  catalogIndexPageStats: (
    kind: CatalogPageKind,
    sources: CatalogPageSource[],
    query: CatalogPageQuery,
  ) => invoke<CatalogPageStats | null>('catalog_index_page_stats', { kind, sources, query }),

  /** The next head of a rating ranking for the TMDB checks. */
  catalogIndexRatingHead: (
    kind: CatalogPageKind,
    sources: CatalogPageSource[],
    query: CatalogPageQuery,
    checkedIds: string[],
    limit: number,
  ) =>
    invoke<{ ready: boolean; rows: CatalogKeyRow[] }>('catalog_index_rating_head', {
      kind,
      sources,
      query,
      checkedIds,
      limit,
    }),

  /** `smartSearch` over one catalogue in the index: matches best first, with scores. */
  catalogIndexSearch: async (
    kind: CatalogPageKind,
    sources: CatalogPageSource[],
    query: CatalogPageQuery,
    text: string,
    head: number,
  ) =>
    decodeCatalogSearch(
      await invoke<ArrayBuffer>('catalog_index_search', { kind, sources, query, text, head }),
    ),

  /** Rows still waiting for facets, as JSON bytes for the facet worker. */
  catalogIndexFacetBatch: (sourceId: string, kind: CatalogPageKind, scope: string, limit: number) =>
    invoke<ArrayBuffer>('catalog_index_facet_batch', { sourceId, kind, scope, limit }),

  /** Store worker-derived facet rows; false when the list changed meanwhile. */
  catalogIndexStoreFacets: (
    sourceId: string,
    kind: CatalogPageKind,
    generation: number,
    facets: unknown[],
  ) => invoke<boolean>('catalog_index_store_facets', { sourceId, kind, generation, facets }),

  /** Every faceted title of a kind when some lack a name rank, as JSON bytes. */
  catalogIndexTitles: (kind: CatalogPageKind) =>
    invoke<ArrayBuffer>('catalog_index_titles', { kind }),

  /** Store name ranks in `catalogIndexTitles` order; false when anything changed meanwhile. */
  catalogIndexStoreRanks: (kind: CatalogPageKind, token: string, ranks: number[]) =>
    invoke<boolean>('catalog_index_store_ranks', { kind, token, ranks }),

  /** Remove every stored catalogue list of one source. */
  catalogCacheDelete: (sourceId: string) => invoke<void>('catalog_cache_delete', { sourceId }),

  /** Remove all Movena-managed caches and the supplied source credentials. */
  appDataClear: (sourceIds: string[]) => invoke<void>('app_data_clear', { sourceIds }),

  /** Read a user-selected, size-limited Movena settings backup. */
  settingsConfigRead: (path: string) => invoke<string>('settings_config_read', { path }),

  /** Write a validated Movena settings backup to a user-selected path. */
  settingsConfigWrite: (path: string, content: string) =>
    invoke<void>('settings_config_write', { path, content }),
};
