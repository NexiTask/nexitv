import { describe, expect, it } from 'vitest';
import { pickWatchNext, regularEpisodeCount } from '@/modules/catalog/lib/watchNext';

const episode = (id: number, num: number) => ({
  id: String(id),
  episode_num: num,
  title: `Episode ${num}`,
  container_extension: 'mkv',
  info: {},
});
const episodes = {
  '0': [episode(900, 1)],
  '1': [episode(102, 2), episode(101, 1)],
  '2': [episode(201, 1), episode(202, 2)],
};
const watching =
  (...ids: number[]) =>
  (e: { id: string | number }) =>
    ids.includes(Number(e.id));

describe('pickWatchNext', () => {
  it('offers the first episode after the furthest one watched', () => {
    const pick = pickWatchNext(episodes, watching(101, 102));
    expect(pick?.season).toBe('2');
    expect(pick?.episode.id).toBe('201');
  });

  it('moves on within a season', () => {
    expect(pickWatchNext(episodes, watching(101))?.episode.id).toBe('102');
  });

  it('leaves earlier gaps alone', () => {
    // 101 was skipped; 102 was the furthest watched, so 201 comes next.
    expect(pickWatchNext(episodes, watching(102))?.episode.id).toBe('201');
  });

  it('has nothing to offer when caught up or not started', () => {
    expect(pickWatchNext(episodes, watching(101, 102, 201, 202))).toBeNull();
    expect(pickWatchNext(episodes, watching())).toBeNull();
  });

  it('ignores specials', () => {
    expect(pickWatchNext({ '0': [episode(900, 1)] }, watching(900))).toBeNull();
    expect(regularEpisodeCount(episodes)).toBe(4);
  });
});
