import {
  accessibleAccentForeground,
  accentHoverColor,
  contrastingTextColor,
  DEFAULT_ACCENT_COLOR,
  parseHex,
} from './color';

export type ThemePreference = 'dark' | 'light';

/** A colour theme over the dark/light canvas. */
export type ColorTheme =
  | 'default'
  | 'catppuccin'
  | 'dracula'
  | 'nord'
  | 'gruvbox'
  | 'tokyo-night'
  | 'rose-pine'
  | 'solarized';
/** Catppuccin's dark flavours; the light canvas always uses Latte. */
export type CatppuccinFlavor = 'mocha' | 'macchiato' | 'frappe';

export interface AppearancePalette {
  theme: ColorTheme;
  flavor: CatppuccinFlavor;
}

export const DEFAULT_PALETTE: AppearancePalette = { theme: 'default', flavor: 'mocha' };

/** The themes Settings offers, in its order, with their display names. */
export const COLOR_THEMES: readonly { value: ColorTheme; label: string }[] = [
  { value: 'default', label: 'Default' },
  { value: 'catppuccin', label: 'Catppuccin' },
  { value: 'dracula', label: 'Dracula' },
  { value: 'nord', label: 'Nord' },
  { value: 'gruvbox', label: 'Gruvbox' },
  { value: 'tokyo-night', label: 'Tokyo Night' },
  { value: 'rose-pine', label: 'Rosé Pine' },
  { value: 'solarized', label: 'Solarized' },
];

/** Each theme's variant per canvas (index.css `data-palette`); null: the
 * theme has none for that canvas and the default colours apply. */
const THEME_VARIANTS: Record<
  Exclude<ColorTheme, 'default' | 'catppuccin'>,
  { dark: string | null; light: string | null }
> = {
  dracula: { dark: 'dracula', light: null },
  nord: { dark: 'nord', light: 'nord-light' },
  gruvbox: { dark: 'gruvbox-dark', light: 'gruvbox-light' },
  'tokyo-night': { dark: 'tokyo-night', light: 'tokyo-night-day' },
  'rose-pine': { dark: 'rose-pine', light: 'rose-pine-dawn' },
  solarized: { dark: 'solarized-dark', light: 'solarized-light' },
};

/** Each palette's usual accent. */
const PALETTE_ACCENTS: Record<string, string> = {
  'catppuccin-mocha': '#cba6f7',
  'catppuccin-macchiato': '#c6a0f6',
  'catppuccin-frappe': '#ca9ee6',
  'catppuccin-latte': '#8839ef',
  dracula: '#bd93f9',
  nord: '#88c0d0',
  'nord-light': '#5e81ac',
  'gruvbox-dark': '#fe8019',
  'gruvbox-light': '#af3a03',
  'tokyo-night': '#7aa2f7',
  'tokyo-night-day': '#2e7de9',
  'rose-pine': '#ebbcba',
  'rose-pine-dawn': '#d7827e',
  'solarized-dark': '#268bd2',
  'solarized-light': '#268bd2',
};

/** Whether a theme has a variant for the light canvas. */
export function themeHasLightVariant(theme: ColorTheme): boolean {
  if (theme === 'default' || theme === 'catppuccin') return true;
  return THEME_VARIANTS[theme].light !== null;
}

/** The `data-palette` value for a palette on a canvas, or null for the default. */
export function paletteName(theme: ThemePreference, palette: AppearancePalette): string | null {
  if (palette.theme === 'default') return null;
  if (palette.theme === 'catppuccin') {
    return `catppuccin-${theme === 'light' ? 'latte' : palette.flavor}`;
  }
  return THEME_VARIANTS[palette.theme][theme];
}
export type Season = 'christmas' | 'easter';

/** Seasons bring their own accent; the saved accent returns once they end. */
const SEASON_ACCENT_COLORS: Record<Season, string> = {
  christmas: '#d93a49',
  easter: '#8f6fe0',
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Western (Gregorian) Easter Sunday for a year, as a local date. */
export function easterSunday(year: number): Date {
  // Anonymous Gregorian algorithm (Meeus/Jones/Butcher).
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

/**
 * Season active on the user's local calendar date, so seasons ship with the
 * app instead of needing a release timed to the holidays. Christmas runs from
 * December 1 through Epiphany on January 6; Easter from Palm Sunday through
 * Easter Monday.
 */
export function activeSeason(now: Date): Season | null {
  const month = now.getMonth();
  if (month === 11 || (month === 0 && now.getDate() <= 6)) return 'christmas';

  const year = now.getFullYear();
  if (Number.isNaN(year)) return null;
  const today = new Date(year, month, now.getDate()).getTime();
  const easter = easterSunday(year).getTime();
  // Rounded: a daylight-saving change inside the window makes one day 23 or 25 hours.
  const daysFromEaster = Math.round((today - easter) / DAY_MS);
  if (daysFromEaster >= -7 && daysFromEaster <= 1) return 'easter';
  return null;
}

/** Milliseconds until the next local midnight, when the season may change. */
export function msUntilNextLocalMidnight(now: Date): number {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return midnight.getTime() - now.getTime();
}

/**
 * Applies the complete appearance contract to the root element. Keeping this
 * outside React lets startup restore a saved light theme before the first
 * frame while App can reuse the same path for live setting changes.
 */
export function applyAppearanceTheme(
  theme: ThemePreference,
  accentValue: string,
  season: Season | null = null,
  root: HTMLElement = document.documentElement,
  palette: AppearancePalette = DEFAULT_PALETTE,
): void {
  const named = paletteName(theme, palette);
  // Seasonal palettes are drawn for the default dark canvas only.
  const appliedSeason = theme === 'dark' && !named ? season : null;
  // A colour theme brings its own accent, unless the viewer picked one.
  const themeAccent =
    named && accentValue.toLowerCase() === DEFAULT_ACCENT_COLOR.toLowerCase()
      ? (PALETTE_ACCENTS[named] ?? accentValue)
      : accentValue;
  const requestedAccent = appliedSeason ? SEASON_ACCENT_COLORS[appliedSeason] : themeAccent;
  const accent = parseHex(requestedAccent) ? requestedAccent : DEFAULT_ACCENT_COLOR;
  const rgb = parseHex(accent);

  root.dataset.theme = theme;
  if (named) root.dataset.palette = named;
  else delete root.dataset.palette;
  if (appliedSeason) root.dataset.season = appliedSeason;
  else delete root.dataset.season;
  root.style.colorScheme = theme;
  root.style.setProperty('--accent-color', accent);
  root.style.setProperty('--accent-foreground', accessibleAccentForeground(accent, theme));
  root.style.setProperty('--accent-hover', accentHoverColor(accent, theme));
  root.style.setProperty('--text-on-accent', contrastingTextColor(accent));

  if (rgb) {
    root.style.setProperty('--accent-color-rgb', `${rgb.r}, ${rgb.g}, ${rgb.b}`);
  }
}
