/**
 * MapsRankingService — Google Maps business rank lookup.
 *
 * Uses DataForSeoService for transport with depth=100. Identity matching lives in mapsBusinessMatcher.js: a rank is only
 * reported for a listing that is the tracked business AT THE TRACKED LOCATION (place_id / address / coordinates), or for a
 * unique business-level match when no branch data exists. A shared chain brand is never enough.
 */

import { DataForSeoService } from './DataForSeoService.js';
import { buildBusinessIdentity, matchBusinessInMapsResults } from './mapsBusinessMatcher.js';

/** Why a Maps check produced no rank, as a short customer-safe string kept next to the status. */
function describeNoMatch(match) {
  if (match.status === 'ambiguous') {
    return 'Several locations of this business appeared in Maps and the tracked location could not be told apart. Confirm the business address in Project Settings.';
  }
  return null;
}

export const MapsRankingService = {
  /**
   * Fetch Google Maps rank for a business.
   *
   * Always resolves (never rejects). The outcome is explicit so a provider failure is never mistaken for "not in Maps":
   *   maps_status 'success'    a listing for this business/location was found (maps_rank may still be null if unranked)
   *   maps_status 'not_found'  the request worked and no listing for THIS business/location is in the results
   *   maps_status 'scan_error' the request itself failed — the caller must keep the previous maps rank
   *
   * @param {string}      keyword
   * @param {string}      businessName  - Business name from verified GMB profile
   * @param {number}      locationCode  - DataForSEO location_code
   * @param {string}      languageCode  - e.g. "en"
   * @param {string|null} targetDomain  - Normalized website domain
   * @param {object|null} [identity]    - { placeId, address, lat, lng, website } when known; absent fields are simply not used
   */
  async fetchMapsRank(keyword, businessName, locationCode, languageCode, targetDomain = null, identity = null) {
    const target = buildBusinessIdentity({ ...(identity || {}), name: businessName, domain: targetDomain || identity?.website });
    console.log(
      `[MAPS_REQUEST] keyword="${keyword}"` +
      ` | businessName="${businessName}"` +
      ` | targetDomain="${target.domain ?? 'null'}"` +
      ` | placeId=${target.placeId ? 'yes' : 'no'} | address=${target.address ? 'yes' : 'no'} | coords=${target.coords ? 'yes' : 'no'}` +
      ` | locationCode=${locationCode}` +
      ` | depth=100` +
      ` | endpoint=serp/google/maps/live/advanced`
    );

    try {
      const data  = await DataForSeoService.getMapsResults(keyword, locationCode, languageCode);
      const attempts = data?.dfsAttempts ?? 1;
      const items = data?.tasks?.[0]?.result?.[0]?.items || [];
      const firstFiveTypes = items.slice(0, 5).map(i => i?.type ?? 'unknown').join(', ');

      console.log(
        `[MAPS_RESPONSE] itemsReturned=${items.length}` +
        ` | rawResultCount=${data?.tasks?.[0]?.result?.length ?? 0}` +
        ` | firstFiveTypes=[${firstFiveTypes}]`
      );

      items.slice(0, 20).forEach((item, idx) => {
        console.log(
          `[MAPS_RESULT] index=${idx}` +
          ` | title="${item.title ?? ''}"` +
          ` | domain="${item.domain ?? ''}"` +
          ` | address="${item.address ?? ''}"` +
          ` | rank_group=${item.rank_group ?? 'null'}`
        );
      });

      const match = matchBusinessInMapsResults(target, items);
      console.log(
        `[MAPS_MATCH] expected="${businessName}" | status=${match.status} | level=${match.level ?? 'null'}` +
        ` | confidence=${match.confidence} | basis=${match.basis.join('+') || 'none'} | candidates=${match.candidates} | reason=${match.reason}` +
        (match.item ? ` | actual="${match.item.title ?? ''}"` : '')
      );

      if (match.status !== 'matched') {
        console.log(`[MAPS_SAVE] maps_rank=null | maps_listing=null | reason=${match.reason}`);
        return {
          maps_rank: null, maps_listing: null, maps_status: 'not_found', maps_error: describeNoMatch(match),
          maps_match: { status: match.status, level: null, confidence: 0, reason: match.reason },
          attempts,
        };
      }

      const item      = match.item;
      const rawRank   = item.rank_group ?? item.rank_absolute ?? null;
      const mapsRank  = (rawRank != null && rawRank >= 1) ? rawRank : null;
      const ratingObj = item.rating;
      const rating    = ratingObj && typeof ratingObj === 'object' ? (ratingObj.value ?? null) : (ratingObj ?? null);
      const reviews   = ratingObj && typeof ratingObj === 'object' ? (ratingObj.votes_count ?? null) : (item.reviews_count ?? null);
      const listing   = { title: item.title || '', rating, reviews, address: item.address ?? null };

      console.log(`[MAPS_SAVE] maps_rank=${mapsRank} | maps_listing=${JSON.stringify(listing)}`);
      return {
        maps_rank: mapsRank, maps_listing: listing, maps_status: 'success', maps_error: null,
        maps_match: { status: 'matched', level: match.level, confidence: match.confidence, reason: match.reason },
        attempts,
      };

    } catch (err) {
      console.error(`[MAPS_SAVE] maps_rank=null | maps_listing=null | reason=api_error | kind=${err.errorKind ?? 'unknown'} | error="${err.message}"`);
      // maps_rank/maps_listing stay null in THIS return value only; maps_status 'scan_error' tells the persistence layer
      // to keep whatever rank was stored before (see rankingHistoryService.buildMapsUpdate).
      return {
        maps_rank: null, maps_listing: null, maps_status: 'scan_error', maps_error: err.message || 'unknown error',
        maps_match: null, attempts: err.attempts ?? 1,
      };
    }
  },
};
