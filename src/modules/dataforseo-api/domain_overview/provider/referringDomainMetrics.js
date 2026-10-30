import { DOMAIN_QUALITY } from '../config.js';

/**
 * The values computed from a referring domain's own numbers, in ONE place (the server): quality tier, dofollow share, sitewide flag, top
 * country and main placement. They are computed when the provider's answer is parsed, so they are cached with the row and sent with it:
 * the browser and the CSV export read these and never re-derive them. Pure; thresholds come from DOMAIN_QUALITY in config.js.
 * A missing input gives a missing result (null), never a guess.
 */

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Referring pages that carry at least one dofollow link ÷ referring pages, 0–100. null when either figure is unknown or there are no pages. */
export function dofollowPercent(referringPages, referringPagesNofollow) {
  const pages = num(referringPages);
  const nofollow = num(referringPagesNofollow);
  if (pages === null || nofollow === null || pages <= 0) return null;
  return Math.min(100, Math.max(0, ((pages - nofollow) / pages) * 100));
}

/**
 * "high" | "medium" | "toxic" | "low", or null when there is not enough data to say.
 *  toxic:  spam > 30, OR (rank < 50 and backlinks >= 100 and dofollow share < 10%)
 *  high:   rank >= 300 and spam <= 10        medium: rank >= 150 and spam <= 30        low: everything else
 * Spam above the limit is toxic whatever else is unknown; the low-rank rule needs all of its figures; high / medium / low need rank and spam.
 */
export function classifyDomainQuality({ rank, spamScore, backlinks, dofollowPct }, t = DOMAIN_QUALITY) {
  const r = num(rank);
  const s = num(spamScore);
  const b = num(backlinks);
  const d = num(dofollowPct);
  if (s !== null && s > t.toxic.spamAbove) return 'toxic';
  const lr = t.toxic.lowRank;
  if (r !== null && b !== null && d !== null && r < lr.rankBelow && b >= lr.minBacklinks && d < lr.dofollowPercentBelow) return 'toxic';
  if (r === null || s === null) return null;
  if (r >= t.high.minRank && s <= t.high.maxSpam) return 'high';
  if (r >= t.medium.minRank && s <= t.medium.maxSpam) return 'medium';
  return 'low';
}

/** The key with the highest count in a { key: count } breakdown (ties: the smaller key). null when there is no breakdown. "" is a real key (unknown). */
export function topKey(breakdown) {
  if (!breakdown || typeof breakdown !== 'object') return null;
  let best = null;
  for (const [key, count] of Object.entries(breakdown)) {
    if (num(count) === null) continue;
    if (best === null || count > best.count || (count === best.count && key < best.key)) best = { key, count };
  }
  return best ? best.key : null;
}

/**
 * Sitewide: the domain links from at least `pages` pages, OR footer links are at least `footerShare` of its referring pages.
 * @returns {boolean|null} null when the page count is unknown.
 */
export function isSitewide(referringPages, semanticLocations, t = DOMAIN_QUALITY) {
  const pages = num(referringPages);
  if (pages === null) return null;
  if (pages >= t.sitewide.pages) return true;
  const footer = num(semanticLocations?.footer);
  return pages > 0 && footer !== null && footer / pages >= t.sitewide.footerShare;
}
