/**
 * Device-aware organic SERP scanning for one keyword.
 *
 * Desktop and mobile are requested independently and concurrently; each device
 * reports its own outcome, so one device failing never changes the other's
 * result. Failures are carried as `scan_error` — they are never converted into
 * a "no ranking" result (see rankingHistoryService.buildKeywordUpdate).
 */

import { DataForSeoService } from './DataForSeoService.js';
import { RankingParserService } from './RankingParserService.js';
import { isMobileRankingEnabled } from './serpDevices.js';

/**
 * Request one device's organic SERP. Never throws: a provider failure is
 * returned as { serpData: null, serpError }.
 */
export async function scanDeviceSerp({ keyword, locationCode, languageCode, device, serpFetcher }) {
  const fetcher = serpFetcher || ((kw, loc, lang, opts) => DataForSeoService.getSerpOrganic(kw, loc, lang, opts));
  try {
    const serpData = await fetcher(keyword, locationCode, languageCode, { device });
    return { device, serpData, serpError: null, scanned_at: new Date() };
  } catch (err) {
    console.error(`[SERP] Failed | device=${device} | keyword="${keyword}" | ${err.message}`);
    return { device, serpData: null, serpError: err.message || 'unknown error', scanned_at: new Date() };
  }
}

/**
 * Turn one device's raw scan into the normalised per-device result.
 *   scan_error set   -> the check failed (rank unknown)
 *   scan_error null  -> the check succeeded; empty ranking_urls means "not found
 *                       within tracked_depth" (tracked_depth null if the
 *                       response carried no organic items to prove a range)
 */
export function buildDeviceResult(scan, cleanDomain) {
  if (!scan) return null;
  if (scan.serpError || !scan.serpData) {
    return {
      ranking_urls:  [],
      best_rank:     null,
      tracked_depth: null,
      scan_error:    scan.serpError || 'no response',
      scanned_at:    scan.scanned_at,
    };
  }
  const parsed = RankingParserService.parseOrganic(scan.serpData, cleanDomain);
  const depth  = RankingParserService.observedOrganicDepth(scan.serpData);
  // Counts and the verdict only — no SERP content. Without this line only the
  // desktop scan was ever visible in logs.
  console.log(
    `[DEVICE_SCAN_RESULT] device=${scan.device} | target="${cleanDomain}" | organicDepth=${depth ?? 'null'} | ` +
    `matched=${parsed.best_rank !== null} | rank=${parsed.best_rank ?? 'null'} | matchedUrls=${parsed.ranking_urls.length}`
  );
  return {
    ranking_urls:  parsed.ranking_urls,
    best_rank:     parsed.best_rank,
    maps_rank:     parsed.maps_rank,
    tracked_depth: RankingParserService.observedOrganicDepth(scan.serpData),
    scan_error:    null,
    scanned_at:    scan.scanned_at,
  };
}

/**
 * Scan desktop (always) and mobile (unless disabled) concurrently.
 * @returns {Promise<{ desktop: object, mobile: object|null }>} raw scans
 */
export async function scanKeywordDevices({
  keyword, locationCode, languageCode, serpFetcher, mobileEnabled = isMobileRankingEnabled(),
}) {
  const base = { keyword, locationCode, languageCode, serpFetcher };
  const [desktop, mobile] = await Promise.all([
    scanDeviceSerp({ ...base, device: 'desktop' }),
    mobileEnabled ? scanDeviceSerp({ ...base, device: 'mobile' }) : Promise.resolve(null),
  ]);
  return { desktop, mobile };
}
