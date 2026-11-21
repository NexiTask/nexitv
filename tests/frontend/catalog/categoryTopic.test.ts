import { describe, expect, it } from 'vitest';
import { categoryTopicCountry } from '@/shared/lib/categoryName';

describe('category topic country', () => {
  it('reads an origin list filed under another market', () => {
    expect(categoryTopicCountry('|AR| أفلام هندية', 'AR')).toBe('IN');
    expect(categoryTopicCountry('|DE| BOLLYWOOD', 'DE')).toBe('IN');
    expect(categoryTopicCountry('|AR| أفلام تركية', 'AR')).toBe('TR');
  });

  it('leaves dub/sub lists and a country’s own categories alone', () => {
    expect(categoryTopicCountry('|EN| HINDI DUBBED', 'EN')).toBeNull();
    expect(categoryTopicCountry('|IN| HINDI ENGLISH SUBS', 'IN')).toBeNull();
    expect(categoryTopicCountry('|IN| TAMIL MOVIES', 'IN')).toBeNull();
    expect(categoryTopicCountry('|EN| ACTION/THRILLER', 'EN')).toBeNull();
  });
});
