import { parseMediaDisplayTitle } from '@/modules/catalog/public/lib/titleParser';
import type { MediaItem } from '@/modules/catalog/public/model/media';

function titleKeys(item: MediaItem) {
  if (item.type !== 'vod' && item.type !== 'series') return {};
  const { cleanTitle, releaseYear } = parseMediaDisplayTitle(item.title, item.year);
  return {
    imdb: item.imdbId ? JSON.stringify([item.type, 'imdb', item.imdbId]) : undefined,
    name:
      cleanTitle && releaseYear
        ? JSON.stringify([item.type, releaseYear, cleanTitle.normalize('NFKC').toLowerCase()])
        : undefined,
  };
}

function buildIndex(items: MediaItem[]) {
  const rows = items.map((item) => ({ item, ...titleKeys(item) }));
  const imdbByName = new Map<string, string | null>();
  for (const { name, imdb } of rows) {
    if (!name || !imdb) continue;
    const prior = imdbByName.get(name);
    // An older snapshot may lack IMDb metadata. Only attach it when the
    // title and year point to one identity.
    imdbByName.set(name, prior === undefined || prior === imdb ? imdb : null);
  }

  const groups = new Map<string, MediaItem[]>();
  const keyById = new Map<string, string>();
  for (const { item, imdb, name } of rows) {
    const key =
      imdb ?? (name ? imdbByName.get(name) : undefined) ?? JSON.stringify(['item', item.id]);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
    keyById.set(item.id, key);
  }
  return { groups, keyById, imdbByName };
}

const indexes = new WeakMap<MediaItem[], ReturnType<typeof buildIndex>>();

function savedTitleIndex(items: MediaItem[]) {
  const cached = indexes.get(items);
  if (cached) return cached;
  const index = buildIndex(items);
  indexes.set(items, index);
  return index;
}

export function groupSavedTitles(items: MediaItem[]): MediaItem[] {
  return Array.from(savedTitleIndex(items).groups.values(), (group) => {
    return (
      group.find((item) => item.imdbId && item.imdbRating != null) ??
      group.find((item) => item.imdbId) ??
      group[0]!
    );
  });
}

export function savedTitleVersions(items: MediaItem[], item: MediaItem): readonly MediaItem[] {
  if (!items.length) return [];
  const { groups, keyById, imdbByName } = savedTitleIndex(items);
  const key = keyById.get(item.id);
  if (key) return groups.get(key) ?? [];

  const { imdb, name } = titleKeys(item);
  const identity = imdb ?? (name ? imdbByName.get(name) : undefined);
  return identity ? (groups.get(identity) ?? []) : [];
}
