import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { startScreenshotHarness, waitForPageAssets } from './screenshot-harness.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const assetDir = path.join(projectRoot, '.github', 'assets', 'readme');
// A surface is captured as-is, or with extra harness query parameters
// (a colour theme, a canvas) under its own file name.
const surfaces = [
  'hero',
  'live-tv',
  'live-epg',
  'player-vod',
  'player-series',
  'library-details',
  'series-details',
  'movies-filters',
  'upcoming',
  'search',
  'm3u-editor',
  'm3u-raw-editor',
  'downloads',
  'settings',
  'playback-settings',
  'light-theme',
  { name: 'theme-catppuccin-mocha', surface: 'movies', query: 'palette=catppuccin&flavor=mocha' },
  { name: 'theme-tokyo-night', surface: 'movies', query: 'palette=tokyo-night' },
  { name: 'theme-nord', surface: 'movies', query: 'palette=nord' },
  { name: 'theme-gruvbox-light', surface: 'movies', query: 'palette=gruvbox&theme=light' },
];

await mkdir(assetDir, { recursive: true });

const harness = await startScreenshotHarness(projectRoot);

let browser;
try {
  // PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH lets a system Chromium stand in when
  // Playwright's own browser download is not installed.
  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
  });
  const context = await browser.newContext({
    colorScheme: 'dark',
    reducedMotion: 'reduce',
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);

  for (const entry of surfaces) {
    const { name, surface, query } =
      typeof entry === 'string' ? { name: entry, surface: entry, query: '' } : entry;
    await page.goto(
      `${harness.baseUrl}/?readme=${encodeURIComponent(surface)}${query ? `&${query}` : ''}`,
      { waitUntil: 'networkidle' },
    );
    await waitForPageAssets(page, 250);

    const capture = await cdp.send('Page.captureScreenshot', {
      format: 'webp',
      quality: 90,
      fromSurface: true,
      captureBeyondViewport: false,
    });
    const target = path.join(assetDir, `${name}.webp`);
    await writeFile(target, Buffer.from(capture.data, 'base64'));
    console.log(`Generated ${path.relative(projectRoot, target)} (1440x900).`);
  }
} catch (error) {
  harness.writeOutput();
  throw error;
} finally {
  if (browser) await browser.close();
  harness.stop();
}
