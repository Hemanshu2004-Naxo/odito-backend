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
import { ORGANIC_OUTCOMES } from './serpResponseOutcome.js';

/**
 * Request one device's organic SERP. Never throws: a provider failure is
 * returned as { serpData: null, serpError }.
 */
export async function scanDeviceSerp({ keyword, locationCode, languageCode, device, serpFetcher }) {
  const fetcher = serpFetcher || ((kw, loc, lang, opts) => DataForSeoService.getSerpOrganic(kw, loc, lang, opts));
  try {
    const serpData = await fetcher(keyword, locationCode, languageCode, { device });
    return {
      device, serpData, serpError: null, attempts: serpData?.dfsAttempts ?? 1, serpMeta: serpData?.dfsSerpMeta ?? null,
      scanned_at: new Date(),
    };
  } catch (err) {
    console.error(`[SERP] Failed | device=${device} | keyword="${keyword}" | ${err.message}`);
    return {
      device, serpData: null, serpError: err.message || 'unknown error', attempts: err.attempts ?? 1,
      serpMeta: err.serpMeta ?? null, scanned_at: new Date(),
    };
  }
}

const PARTIAL_NOT_FOUND_ERROR =
  'DataForSEO returned partial results (code 40106) that did not include the site; ranking unknown for the missing pages';

/**
 * Turn one device's raw scan into the normalised per-device result.
 *   scan_error set   -> the check failed (rank unknown)
 *   scan_error null  -> the check succeeded; empty ranking_urls means "not found
 *                       within tracked_depth" (tracked_depth null if the
 *                       response carried no organic items to prove a range)
 *
 * Partial results (40106, `serp.outcome === 'partial'`):
 *   site found     -> a real observation: the rank is recorded (scan status partial_success downstream)
 *   site not found -> NOT "not ranked": the site may be on a page that was not returned, so it is a scan_error and the
 *                     previous rank is preserved. Missing positions are never invented.
 * `serp` ({ outcome, provider_code, requested_depth, returned_results }) is carried whenever the provider reported it.
 */
export function buildDeviceResult(scan, cleanDomain) {
  if (!scan) return null;
  const serp = scan.serpMeta ?? null;
  const failed = (scanError) => ({
    ranking_urls:  [],
    best_rank:     null,
    maps_rank:     null,
    tracked_depth: null,
    scan_error:    scanError,
    attempts:      scan.attempts ?? 1,
    scanned_at:    scan.scanned_at,
    ...(serp ? { serp } : {}),
  });
  if (scan.serpError || !scan.serpData) return failed(scan.serpError || 'no response');

  const parsed = RankingParserService.parseOrganic(scan.serpData, cleanDomain);
  const depth  = RankingParserService.observedOrganicDepth(scan.serpData);
  // Counts and the verdict only — no SERP content. Without this line only the
  // desktop scan was ever visible in logs.
  console.log(
    `[DEVICE_SCAN_RESULT] device=${scan.device} | target="${cleanDomain}" | organicDepth=${depth ?? 'null'} | ` +
    `outcome=${serp?.outcome ?? 'complete'} | returned=${serp?.returned_results ?? 'null'} | ` +
    `matched=${parsed.best_rank !== null} | rank=${parsed.best_rank ?? 'null'} | matchedUrls=${parsed.ranking_urls.length}`
  );
  if (serp?.outcome === ORGANIC_OUTCOMES.PARTIAL && parsed.best_rank === null) return failed(PARTIAL_NOT_FOUND_ERROR);

  return {
    ranking_urls:  parsed.ranking_urls,
    best_rank:     parsed.best_rank,
    maps_rank:     parsed.maps_rank,
    tracked_depth: depth,
    scan_error:    null,
    attempts:      scan.attempts ?? 1,
    scanned_at:    scan.scanned_at,
    ...(serp ? { serp } : {}),
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
