/** Pure domain rules for the user-customizable Discover/home page row layout. */

export const HOME_SECTION_IDS = [
  'upcoming',
  'continueWatching',
  'watchNext',
  'automatedRecommendations',
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

/** Display order matches NexiTV's original fixed Discover layout. */
export const DEFAULT_HOME_SECTIONS: HomeSectionPref[] = HOME_SECTION_IDS.map((id) => ({
  id,
  enabled: true,
}));

/** User-facing label per section, used by both Discover and its settings section. */
export const HOME_SECTION_LABELS: Record<HomeSectionId, string> = {
  upcoming: 'Coming Up',
  continueWatching: 'Continue Watching',
  watchNext: 'Watch Next',
  automatedRecommendations: 'Automated Recommendations',
  recommendations: 'Smart Recommendations',
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
    for (const entry of value) {
      if (!entry || typeof entry !== 'object') continue;
      const id = (entry as { id?: unknown }).id;
      if (!isHomeSectionId(id) || seen.has(id)) continue;
      seen.add(id);
      result.push({ id, enabled: (entry as { enabled?: unknown }).enabled !== false });
    }
  }

  // A section the save predates goes right after the one that precedes it in
  // the default layout (Watch Next lands under Continue Watching), else last.
  HOME_SECTION_IDS.forEach((id, index) => {
    if (seen.has(id)) return;
    const before = result.findIndex((section) => section.id === HOME_SECTION_IDS[index - 1]);
    result.splice(before >= 0 ? before + 1 : result.length, 0, { id, enabled: true });
  });

  return result;
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
