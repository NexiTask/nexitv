# Asset provenance and licenses

## Project artwork

The NexiTV application icon (a white "N" with a play triangle on a dark rounded
square) replaced Movena's icon on 21 November 2026. It is original artwork for
this project, drawn from the outline of the "N" in the bundled Unbounded font
(SIL Open Font License 1.1, see `public/fonts/OFL-Unbounded.txt`), and is
distributed under GPL-3.0-or-later like the rest of this artwork. It does not use
Movena's logo. The favicon, desktop application icons, required Windows tiles, and DMG
background stored in `public/` and `src-tauri/` are project artwork from this
repository's contributors. They are distributed under GPL-3.0-or-later with
the application source. The branding rules in `TRADEMARK.md` prevent
misrepresentation but do not withdraw the copyright license. Android and iOS
icon trees are intentionally not shipped because Movena supports desktop
bundles only.

Files covered include:

- `public/favicon.png` and `public/favicon.svg`
- `src-tauri/icons/32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.png`,
  `icon.icns`, and `icon.ico`
- `src-tauri/icons/StoreLogo.png`, `Square44x44Logo.png`, and
  `Square150x150Logo.png` for the desktop MSIX manifest
- `src-tauri/dmg/background.png` and `src-tauri/dmg/background.svg`

## README showcase artwork

The images in `.github/assets/readme/` are:

- `app-movies.webp`, `app-movie-details.webp`, `app-series.webp`, and
  `app-series-details.webp`: screenshots of the NexiTV desktop app taken on
  21 November 2026 on a real catalogue, in the Catppuccin Mocha theme with 125%
  cards. They show TMDB poster artwork and provider titles, which are
  third-party content, and no account, source name, or credential.
- `social-preview.png`: a 1280×640 branded composition made from the Movies
  screenshot and the checked-in Unbounded wordmark font. Regenerate it with
  `npm run readme:social-preview`.

NexiTV's UI and the original portions of the captures are project work
distributed under GPL-3.0-or-later. TMDB metadata and artwork embedded in the
screenshots are third-party content and are not offered under the project's GPL
license.

The README no longer ships browser captures of the fixture-based UI harness
(`tests/ui/harness/ReadmeHarness.tsx`); `npm run readme:screenshots` can still
generate them for design review, but its output is not part of the README.

## Unbounded font

`public/fonts/unbounded-latin-800.woff2` (the in-app sidebar wordmark) is
Unbounded ExtraBold by The Unbounded Project Authors, the Latin subset served by
Google Fonts, obtained on 21 November 2026. It is licensed under the SIL Open
Font License 1.1; the complete license is in `public/fonts/OFL-Unbounded.txt`.
The checked-in WOFF2 SHA-256 is
`fe6d4ea7ed9647abf1e100a703786338d7898d56d0bedcdfdbc325e8fb02c834`.

## Righteous font

`public/fonts/righteous-latin-400.woff2` is Righteous by Astigmatic (Brian J.
Bonislawsky), obtained from the
[Google Fonts Righteous source](https://github.com/google/fonts/tree/main/ofl/righteous)
on 23 August 2026. It is licensed under the SIL Open Font License 1.1. The
Reserved Font Name is "Righteous". The complete license is in
`public/fonts/OFL.txt`. The checked-in WOFF2 SHA-256 is
`17bb3e21ead29ad20cb4e9ffbfa6eac5dbed184836ae13e5c14cbd6e85ddcce6`.

## External service branding

`public/tmdb-logo.svg` is TMDB's approved "Primary short (blue)" logo,
downloaded from TMDB's official
[Logos & Attribution page](https://www.themoviedb.org/about/logos-attribution)
on 23 August 2026. Its checked-in SHA-256 is
`ea66f5cb3bf6ecf099ddcce41b374103d11ecad1b27615019359e06e20a8f767`.
It is included only to satisfy TMDB attribution and is not offered under the
project's GPL license. TMDB, TVmaze, and IntroDB names, logos, and data are not project
artwork. Their use is subject to the applicable service terms and attribution
requirements.
