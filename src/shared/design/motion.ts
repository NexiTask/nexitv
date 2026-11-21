/** Framer Motion uses seconds while CSS tokens use milliseconds. Keep their
 * values paired here so code-driven and stylesheet-driven motion stay aligned. */
export const MOTION_DURATION = {
  // UI motion is instant: WebKitGTK repaints fades and slides slowly enough
  // that they read as lag (NTV-1). Only timed feedback and loops keep a length.
  fast: 0,
  normal: 0,
  slow: 0,
  deliberate: 0,
  feedback: 0.8,
  loop: 1,
} as const;

export const MOTION_EASE = {
  standard: [0.16, 1, 0.3, 1] as const,
} as const;
