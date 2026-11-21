import { parseMediaDisplayTitle } from '@/modules/catalog/public/lib/titleParser';
import { tmdbTitleKey } from './tmdbMatch';

/**
 * The catalogue's IMDb match key: the clean display title, normalized the way
 * the TMDB match normalizes, plus a scrub of edition noise the title parser
 * keeps. The key is only a join key for the IMDb pipeline (metadata/imdb.rs);
 * the display title keeps its edition labels.
 *
 * Step 0 (NTV-2) measured what the scrub buys: titles like "Friends - UNCUT"
 * and "Boruto: Naruto Next Generations (ENG-SUB)" otherwise miss "Friends"
 * and "Boruto: Naruto Next Generations", the largest recoverable share of the
 * 45.5% of titles with no IMDb row under their plain key.
 */

/**
 * Bracketed suffixes that are edition/marker noise, not part of a title:
 * caps, digits, `+`, `&`, dots, dashes, spaces — "(UNCUT)", "(18+)",
 * "(ENG-SUB)", "(KR)", "(1)", "(MULTI-SUB)", "(1968-1969)". Real title parts
 * are left alone: a lowercase word never matches this set.
 */
const MATCH_KEY_BRACKET_NOISE = /^[A-Z0-9+&.\- ]{1,30}$/;

/** Trailing edition words after a separator: "Movie - UNCUT". */
const MATCH_KEY_EDITION_WORDS = new Set([
  'UNCUT',
  'UNCENSORED',
  'CENSORED',
  'EXTENDED',
  'REMASTERED',
  'UNRATED',
  'SUBBED',
  'DUBBED',
]);

/** A trailing episode code a provider left in a series title: "S01E05". */
const MATCH_KEY_EPISODE_CODE = /\s+[Ss]\d{1,3}\s*[E:]\s*\d{1,4}$/;

export function imdbMatchKey(rawTitle: string, explicitYear?: string | number): string {
  const year = explicitYear === undefined ? undefined : String(explicitYear);
  let title = parseMediaDisplayTitle(rawTitle, year).cleanTitle;

  for (;;) {
    const bracketed = title.match(/^(.+?)\s+[([]([^()[\]]{1,30})[)\]]$/);
    if (bracketed && MATCH_KEY_BRACKET_NOISE.test(bracketed[2]!)) {
      title = bracketed[1]!;
      continue;
    }
    const edition = title.match(/^(.+?)\s+[-–—|]\s*([A-Za-z0-9+]{1,20})$/);
    if (edition && MATCH_KEY_EDITION_WORDS.has(edition[2]!.toUpperCase())) {
      title = edition[1]!;
      continue;
    }
    const episode = title.match(MATCH_KEY_EPISODE_CODE);
    if (episode) {
      title = title.replace(MATCH_KEY_EPISODE_CODE, '');
      continue;
    }
    break;
  }

  return tmdbTitleKey(title);
}
