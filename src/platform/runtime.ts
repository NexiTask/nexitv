/**
 * Whether the app is currently running on macOS.
 *
 * Used by PlayerShell to gate the bottom corner-sliver overlay that hides
 * the mpv video surface's square bottom corners poking past the (OS-rounded)
 * main window — see `src-tauri/src/macos_embed.rs`'s module doc. Every other
 * platform embeds mpv directly into this window via `--wid`, inheriting its
 * corner rounding for free, so the overlay would only cover real picture
 * there.
 */
export function isMacOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac/.test(navigator.userAgent);
}

/**
 * Whether the app runs in WebKitGTK (the Linux webview). Its user agent says
 * Linux and AppleWebKit without Chrome; Chromium-based webviews always say Chrome.
 */
export function isWebKitGtk(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /Linux/.test(ua) && /AppleWebKit/.test(ua) && !/Chrome|Chromium/.test(ua);
}
