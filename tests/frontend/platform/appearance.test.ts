// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from 'vitest';
import {
  activeSeason,
  applyAppearanceTheme,
  COLOR_THEMES,
  paletteName,
  themeHasLightVariant,
  easterSunday,
  msUntilNextLocalMidnight,
} from '@/shared/design/appearance';
import { contrastRatio, DEFAULT_ACCENT_COLOR } from '@/shared/design/color';

beforeEach(() => {
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('style');
});

describe('appearance synchronization', () => {
  it('applies the requested root theme and raw accent tokens', () => {
    applyAppearanceTheme('light', '#ffcc00');

    const root = document.documentElement;
    expect(root.dataset.theme).toBe('light');
    expect(root.style.colorScheme).toBe('light');
    expect(root.style.getPropertyValue('--accent-color')).toBe('#ffcc00');
    expect(root.style.getPropertyValue('--accent-color-rgb')).toBe('255, 204, 0');
    expect(root.style.getPropertyValue('--text-on-accent')).toBe('#0f1014');
    expect(
      contrastRatio(root.style.getPropertyValue('--accent-foreground'), '#ffffff'),
    ).toBeGreaterThanOrEqual(5.5);
  });

  it('falls back safely when an invalid accent reaches the DOM boundary', () => {
    applyAppearanceTheme('dark', 'invalid');

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.style.getPropertyValue('--accent-color')).toBe('#0672e5');
  });

  it('layers the Christmas season over the dark theme with its own accent', () => {
    applyAppearanceTheme('dark', '#ffcc00', 'christmas');

    const root = document.documentElement;
    expect(root.dataset.theme).toBe('dark');
    expect(root.dataset.season).toBe('christmas');
    expect(root.style.getPropertyValue('--accent-color')).toBe('#d93a49');
    expect(root.style.getPropertyValue('--accent-color-rgb')).toBe('217, 58, 73');
    expect(root.style.getPropertyValue('--text-on-accent')).toBe('#ffffff');
  });

  it('keeps the light theme and saved accent untouched during a season', () => {
    applyAppearanceTheme('light', '#ffcc00', 'christmas');

    const root = document.documentElement;
    expect(root.dataset.season).toBeUndefined();
    expect(root.style.getPropertyValue('--accent-color')).toBe('#ffcc00');
  });

  it('restores the saved accent when a season ends', () => {
    applyAppearanceTheme('dark', '#af52de', 'christmas');
    applyAppearanceTheme('dark', '#af52de', null);

    const root = document.documentElement;
    expect(root.dataset.season).toBeUndefined();
    expect(root.style.getPropertyValue('--accent-color')).toBe('#af52de');
  });
});

describe('seasonal calendar', () => {
  it('runs Christmas from December 1 through January 6 in local time', () => {
    expect(activeSeason(new Date(2026, 10, 30, 23, 59, 59))).toBeNull();
    expect(activeSeason(new Date(2026, 11, 1, 0, 0, 0))).toBe('christmas');
    expect(activeSeason(new Date(2026, 11, 31, 23, 59, 59))).toBe('christmas');
    expect(activeSeason(new Date(2027, 0, 1))).toBe('christmas');
    expect(activeSeason(new Date(2027, 0, 6, 23, 59, 59))).toBe('christmas');
    expect(activeSeason(new Date(2027, 0, 7, 0, 0, 0))).toBeNull();
    expect(activeSeason(new Date(2026, 6, 15))).toBeNull();
    expect(activeSeason(new Date(Number.NaN))).toBeNull();
  });

  it('finds Western Easter Sunday', () => {
    const iso = (date: Date) => `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
    expect(iso(easterSunday(2024))).toBe('2024-3-31');
    expect(iso(easterSunday(2025))).toBe('2025-4-20');
    expect(iso(easterSunday(2026))).toBe('2026-4-5');
    expect(iso(easterSunday(2027))).toBe('2027-3-28');
    expect(iso(easterSunday(2038))).toBe('2038-4-25');
    expect(iso(easterSunday(2285))).toBe('2285-3-22');
  });

  it('runs Easter from Palm Sunday through Easter Monday in local time', () => {
    expect(activeSeason(new Date(2027, 2, 20, 23, 59, 59))).toBeNull();
    expect(activeSeason(new Date(2027, 2, 21, 0, 0, 0))).toBe('easter');
    expect(activeSeason(new Date(2027, 2, 28, 12))).toBe('easter');
    expect(activeSeason(new Date(2027, 2, 29, 23, 59, 59))).toBe('easter');
    expect(activeSeason(new Date(2027, 2, 30, 0, 0, 0))).toBeNull();
    // A window that crosses the daylight-saving change (late March in Europe).
    expect(activeSeason(new Date(2026, 2, 29))).toBe('easter');
    expect(activeSeason(new Date(2026, 3, 6))).toBe('easter');
    expect(activeSeason(new Date(2026, 3, 7))).toBeNull();
  });

  it('layers the Easter season over the dark theme with a readable accent', () => {
    applyAppearanceTheme('dark', '#ffcc00', 'easter');

    const root = document.documentElement;
    expect(root.dataset.season).toBe('easter');
    expect(root.style.getPropertyValue('--accent-color')).toBe('#8f6fe0');
    const onAccent = root.style.getPropertyValue('--text-on-accent');
    expect(contrastRatio('#8f6fe0', onAccent)).toBeGreaterThanOrEqual(3);
  });

  it('measures the delay to the next local midnight', () => {
    expect(msUntilNextLocalMidnight(new Date(2026, 10, 30, 23, 59, 30))).toBe(30_000);
    expect(msUntilNextLocalMidnight(new Date(2026, 11, 31, 0, 0, 0))).toBe(
      new Date(2027, 0, 1).getTime() - new Date(2026, 11, 31).getTime(),
    );
  });
});

describe('colour themes', () => {
  const catppuccin = (flavor: 'mocha' | 'macchiato' | 'frappe' = 'mocha') => ({
    theme: 'catppuccin' as const,
    flavor,
  });

  it('marks the palette and brings Mauve when the accent is the default', () => {
    const root = document.createElement('html');
    applyAppearanceTheme('dark', DEFAULT_ACCENT_COLOR, null, root, catppuccin('macchiato'));
    expect(root.dataset.palette).toBe('catppuccin-macchiato');
    expect(root.style.getPropertyValue('--accent-color')).toBe('#c6a0f6');
  });

  it('uses Latte on the light canvas and keeps a picked accent', () => {
    const root = document.createElement('html');
    applyAppearanceTheme('light', '#ff8800', null, root, catppuccin());
    expect(root.dataset.palette).toBe('catppuccin-latte');
    expect(root.style.getPropertyValue('--accent-color')).toBe('#ff8800');
  });

  it('drops the palette and the seasons step aside while it is on', () => {
    const root = document.createElement('html');
    applyAppearanceTheme('dark', DEFAULT_ACCENT_COLOR, 'christmas', root, catppuccin());
    expect(root.dataset.season).toBeUndefined();
    applyAppearanceTheme('dark', DEFAULT_ACCENT_COLOR, 'christmas', root);
    expect(root.dataset.palette).toBeUndefined();
    expect(root.dataset.season).toBe('christmas');
  });
});

describe('famous themes', () => {
  const palette = (theme: 'dracula' | 'nord' | 'gruvbox' | 'rose-pine') => ({
    theme,
    flavor: 'mocha' as const,
  });

  it('picks the dark and light variant of a theme', () => {
    const root = document.createElement('html');
    applyAppearanceTheme('dark', DEFAULT_ACCENT_COLOR, null, root, palette('gruvbox'));
    expect(root.dataset.palette).toBe('gruvbox-dark');
    expect(root.style.getPropertyValue('--accent-color')).toBe('#fe8019');
    applyAppearanceTheme('light', DEFAULT_ACCENT_COLOR, null, root, palette('rose-pine'));
    expect(root.dataset.palette).toBe('rose-pine-dawn');
  });

  it('keeps the default light colours for a dark-only theme', () => {
    const root = document.createElement('html');
    applyAppearanceTheme('light', DEFAULT_ACCENT_COLOR, null, root, palette('dracula'));
    expect(root.dataset.palette).toBeUndefined();
    expect(themeHasLightVariant('dracula')).toBe(false);
    expect(themeHasLightVariant('nord')).toBe(true);
  });

  it('defines CSS for every palette the themes can name', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync('src/shared/design/index.css', 'utf8');
    for (const { value } of COLOR_THEMES) {
      for (const canvas of ['dark', 'light'] as const) {
        for (const flavor of ['mocha', 'macchiato', 'frappe'] as const) {
          const name = paletteName(canvas, { theme: value, flavor });
          if (name) expect(css).toContain(`html[data-palette='${name}']`);
        }
      }
    }
  });
});
