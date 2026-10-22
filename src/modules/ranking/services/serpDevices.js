/**
 * SERP device configuration for DataForSEO Google organic rankings.
 *
 * Values verified against the DataForSEO docs for
 * POST /v3/serp/google/organic/live/advanced (device/os/depth behave the same as on live/regular):
 *   device: "desktop" | "mobile"  (default "desktop")
 *   os:     desktop -> "windows" | "macos" (default "windows")
 *           mobile  -> "android" | "ios"   (default "android")
 * DataForSEO's pricing page states device is part of the base price, so a
 * mobile request costs the same as a desktop request (one extra request per
 * keyword scan, not a different rate).
 *
 * Desktop keeps the exact configuration Odito has always sent
 * (device=desktop, os=windows) so existing desktop behaviour is unchanged.
 */

export const SERP_DEVICES = Object.freeze({
  desktop: Object.freeze({ device: 'desktop', os: 'windows' }),
  mobile:  Object.freeze({ device: 'mobile',  os: 'android' }),
});

export const DEFAULT_SERP_DEVICE = 'desktop';

/** Requested result depth — unchanged from the original desktop request. */
export const SERP_DEPTH = 100;

export function resolveSerpDevice(device = DEFAULT_SERP_DEVICE) {
  const config = typeof device === 'string' ? SERP_DEVICES[device] : undefined;
  if (!config) {
    throw Object.assign(
      new Error(`Unsupported SERP device "${String(device)}". Supported: ${Object.keys(SERP_DEVICES).join(', ')}`),
      { code: 'UNSUPPORTED_SERP_DEVICE' }
    );
  }
  return config;
}

/**
 * Rollout kill-switch for the extra mobile request per keyword scan.
 * ON by default. Any common "off" spelling (false / 0 / off / no / disabled,
 * case- and whitespace-insensitive) turns it off, so a mistyped disable never
 * silently keeps paid mobile requests running. Existing mobile data is kept;
 * it just stops being refreshed.
 */
const MOBILE_OFF_VALUES = new Set(['false', '0', 'off', 'no', 'disabled']);

export function isMobileRankingEnabled(env = process.env) {
  const raw = String(env.KEYWORD_MOBILE_RANKING_ENABLED ?? '').trim().toLowerCase();
  return !MOBILE_OFF_VALUES.has(raw);
}

/** Small FIFO concurrency limiter (no external dependency). */
export function createLimiter(max) {
  const limit = Math.max(1, Number.isFinite(max) ? Math.floor(max) : 1);
  let active = 0;
  const queue = [];

  const next = () => {
    if (active >= limit || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => { active--; next(); });
  };

  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    next();
  });
}
