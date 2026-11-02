/**
 * Local Competitors limits, all overridable by environment variable (read when asked). Every Google Places request is billed, so the
 * limits are cost controls: a search is explicit (a button, never a page load), a few requests at most, and capped per project per day.
 */
const int = (name, fallback, min = 1) => { const n = Number.parseInt(process.env[name], 10); return Number.isFinite(n) && n >= min ? n : fallback; };
const flag = (name, fallback) => { const v = String(process.env[name] ?? '').trim().toLowerCase(); return ['false', '0', 'off', 'no'].includes(v) ? false : ['true', '1', 'on', 'yes'].includes(v) ? true : fallback; };

/** The radii a user may pick (km). The default is 5. Google's own limit is 50 km. */
export const RADII_KM = Object.freeze([1, 3, 5, 10, 15, 25]);
export const DEFAULT_RADIUS_KM = 5;

export function getLocalConfig() {
  return Object.freeze({
    /** Kill switch. COMPETITOR_LOCAL_ENABLED=false */
    enabled: flag('COMPETITOR_LOCAL_ENABLED', true),
    /** Google Places requests one project may make per UTC day. A search makes 1-4 (one Nearby + up to three Text Searches). */
    projectDailyPlacesCalls: int('COMPETITOR_LOCAL_DAILY_CALLS', 40),
    /** Results returned per search, after the distance filter. */
    maxResults: int('COMPETITOR_LOCAL_MAX_RESULTS', 100),
  });
}
