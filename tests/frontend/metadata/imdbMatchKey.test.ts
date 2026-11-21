import { describe, expect, it } from 'vitest';
import { imdbMatchKey } from '@/modules/metadata/public/model/imdbMatchKey';

describe('IMDb match keys', () => {
  it('normalize the clean display title like the TMDB match does', () => {
    expect(imdbMatchKey("The Handmaid's Tale")).toBe('thehandmaidstale');
    expect(imdbMatchKey('Fish & Chips')).toBe('fishandchips');
    expect(imdbMatchKey('EN - Water For Elephants (2011)', 2011)).toBe('waterforelephants');
  });

  it('scrub edition noise the title parser keeps', () => {
    expect(imdbMatchKey('Friends - UNCUT')).toBe('friends');
    expect(imdbMatchKey('Boruto: Naruto Next Generations (ENG-SUB)')).toBe(
      'borutonarutonextgenerations',
    );
    expect(imdbMatchKey('MAGIA NAGOŚCI - POLSKA (18+)')).toBe('magianagoscipolska');
    expect(imdbMatchKey('The New Adventures Of Huckleberry Finn (1968-1969)')).toBe(
      'thenewadventuresofhuckleberryfinn',
    );
    expect(imdbMatchKey('Dark Hearts S01E05')).toBe('darkhearts');
  });

  it('keep real title parts', () => {
    expect(imdbMatchKey('It (Chinese Drama)')).toBe('itchinesedrama');
    expect(imdbMatchKey('Blade (Director)')).toBe('bladedirector');
    expect(imdbMatchKey('Movie: Part 2')).toBe('moviepart2');
    expect(imdbMatchKey('Cleopatra', '1963')).toBe('cleopatra');
  });

  it('let the facet builder decide channels carry no key', () => {
    // The key itself never depends on the kind; country prefixes and quality
    // tags fold away exactly as a TMDB lookup would see them.
    expect(imdbMatchKey('DE: Sport One FHD')).toBe('sportone');
  });
});
