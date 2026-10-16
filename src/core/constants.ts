/**
 * Timing and limit values the SDK uses directly, as plain constants so the
 * bundler inlines them (the shared LIMITS/TIMING objects of @3x/core would be
 * shipped whole). Every value equals @3x/core's (asserted in test/constants.test.ts).
 */
export const SESSION_TIMEOUT_MS = 30 * 60_000;
export const HEARTBEAT_MS = 120_000;
export const FLUSH_DEBOUNCE_MS = 10_000;
export const FIRST_FLUSH_DELAY_MS = 1_000;
export const RESUME_AFTER_HIDDEN_MS = 30 * 60_000;
export const IDLE_AFTER_MS = 30_000;
export const TICK_MS = 1_000;
export const DEDUPE_WINDOW_MS = 1_000;
export const LABEL_FORWARD_MS = 150;
export const POPSTATE_WINDOW_MS = 1_000;
export const CLICK_CONTEXT_MS = 1_000;
export const EXPIRE_MARGIN_MS = 10 * 60_000;
export const SECTION_VISIBLE_RATIO = 0.5;
export const SECTION_VIEWPORT_COVER = 0.5;
export const CONFIG_WAIT_MS = 5_000;

export const MAX_BODY_BYTES = 16_384;
export const MAX_PAGEVIEWS_PER_BATCH = 5;
export const MAX_EVENTS_PER_BATCH = 100;
export const MAX_EVENTS_PER_PAGEVIEW = 500;
export const MAX_VIDEO_PLAYS_PER_PAGEVIEW = 10;
export const MAX_SECTIONS_PER_PAGEVIEW = 40;
export const MAX_VIDEO_RANGES = 40;
export const SHRINK_VIDEO_RANGES = 20;
export const MAX_ID_LENGTH = 40;
export const MAX_AGE_MS = 86_400_000;
export const MAX_ENGAGED_MS = 4 * 3_600_000;
export const MAX_VIDEO_DURATION_S = 7_200;
export const MAX_CUSTOM_PROPS = 20;
export const MAX_CUSTOM_STRING_LENGTH = 200;
export const MAX_TRAITS = 20;
