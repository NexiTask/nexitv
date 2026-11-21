/**
 * One freshness rule for provider catalogues and their categories, shared by
 * the saved copies and the in-memory queries: a copy younger than this is used
 * as is, an older one is shown at once and replaced in the background.
 */
export const CATALOG_FRESH_MS = 12 * 60 * 60 * 1000;
