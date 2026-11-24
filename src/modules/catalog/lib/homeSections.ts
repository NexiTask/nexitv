/** Pure domain rules for the user-customizable Discover/home page row layout. */

export const HOME_SECTION_IDS = [
  'upcoming',
  'continueWatching',
  'watchNext',
  'recommendations',
  'recentMovies',
  'recentSeries',
  'popularMovies',
  'popularSeries',
  'liveChannels',
] as const;

export type HomeSectionId = (typeof HOME_SECTION_IDS)[number];

export interface HomeSectionPref {
  id: HomeSectionId;
  enabled: boolean;
}

const DEFAULT_HOME_ORDER: readonly HomeSectionId[] = [
  'watchNext',
  'upcoming',
  'recommendations',
  'continueWatching',
  ...HOME_SECTION_IDS.slice(4),
];

export const DEFAULT_HOME_SECTIONS: HomeSectionPref[] = DEFAULT_HOME_ORDER.map((id) => ({
  id,
  enabled: true,
}));

/** User-facing label per section, used by both Discover and its settings section. */
export const HOME_SECTION_LABELS: Record<HomeSectionId, string> = {
  upcoming: 'Coming Up',
  continueWatching: 'Continue Watching',
  watchNext: 'Watch Next',
  recommendations: 'Recommendations',
  recentMovies: 'Recently Added Movies',
  recentSeries: 'Recently Added Series',
  popularMovies: 'Popular Movies',
  popularSeries: 'Popular Series',
  liveChannels: 'Live TV Channels',
};

function isHomeSectionId(value: unknown): value is HomeSectionId {
  return typeof value === 'string' && (HOME_SECTION_IDS as readonly string[]).includes(value);
}

/**
 * Validates and repairs a persisted section-order list. Unknown or duplicate
 * entries are dropped; any section missing from an older/corrupt save (for
 * example one written before a new row existed) is appended so it still
 * shows up rather than silently disappearing.
 */
export function sanitizeHomeSections(value: unknown): HomeSectionPref[] {
  const seen = new Set<HomeSectionId>();
  const result: HomeSectionPref[] = [];

  if (Array.isArray(value)) {
    const entries = value.filter(
      (entry): entry is { id?: unknown; enabled?: unknown } =>
        entry !== null && typeof entry === 'object',
    );
    const formerLibraryRow = entries.find(({ id }) => id === 'automatedRecommendations');
    const hasRecommendations = entries.some(({ id }) => id === 'recommendations');
    for (const entry of entries) {
      if (entry.id === 'automatedRecommendations' && hasRecommendations) continue;
      const id = entry.id === 'automatedRecommendations' ? 'recommendations' : entry.id;
      if (!isHomeSectionId(id) || seen.has(id)) continue;
      seen.add(id);
      result.push({
        id,
        enabled:
          entry.enabled !== false ||
          (id === 'recommendations' &&
            formerLibraryRow !== undefined &&
            formerLibraryRow.enabled !== false),
      });
    }
  }

  if (result.length === 0) return DEFAULT_HOME_SECTIONS.map((section) => ({ ...section }));

  // A section the save predates goes right after the one that precedes it in
  // the default layout (Watch Next lands under Continue Watching), else last.
  HOME_SECTION_IDS.forEach((id, index) => {
    if (seen.has(id)) return;
    const before = result.findIndex((section) => section.id === HOME_SECTION_IDS[index - 1]);
    result.splice(before >= 0 ? before + 1 : result.length, 0, { id, enabled: true });
  });

  return result;
}

export function migrateLegacyHomeOrder(sections: HomeSectionPref[]): HomeSectionPref[] {
  if (!HOME_SECTION_IDS.every((id, index) => sections[index]?.id === id)) return sections;
  const byId = new Map(sections.map((section) => [section.id, section]));
  return DEFAULT_HOME_ORDER.map((id) => byId.get(id) ?? { id, enabled: true });
}

export function moveHomeSection(
  sections: HomeSectionPref[],
  index: number,
  direction: -1 | 1,
): HomeSectionPref[] {
  const target = index + direction;
  if (target < 0 || target >= sections.length) return sections;
  const next = [...sections];
  const [moved] = next.splice(index, 1);
  if (!moved) return sections;
  next.splice(target, 0, moved);
  return next;
}
