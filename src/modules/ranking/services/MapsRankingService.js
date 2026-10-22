/**
 * MapsRankingService — Google Maps business rank lookup.
 *
 * Uses DataForSeoService for transport with depth=100.
 * Weighted fuzzy confidence scoring handles GMB listing name variations
 * (e.g. "WOW Infotech" vs "WOW Infotech Private Limited").
 */

import { DataForSeoService } from './DataForSeoService.js';

// ── Similarity helpers ─────────────────────────────────────────────────────

function _bigramSimilarity(a, b) {
  if (a === b) return 100;
  if (a.length < 2 || b.length < 2) return 0;

  const buildBigrams = s => {
    const freq = {};
    for (let i = 0; i < s.length - 1; i++) {
      const bg = s.slice(i, i + 2);
      freq[bg] = (freq[bg] || 0) + 1;
    }
    return freq;
  };

  const ba = buildBigrams(a);
  const bb = buildBigrams(b);

  let shared = 0;
  for (const bg of Object.keys(ba)) {
    if (bb[bg]) shared += Math.min(ba[bg], bb[bg]);
  }

  const total = (a.length - 1) + (b.length - 1);
  return total === 0 ? 0 : Math.round((2 * shared / total) * 100);
}

function _tokenize(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(t => t.length > 2);
}

// ── Scoring functions ──────────────────────────────────────────────────────

function computeNameScore(expected, actual) {
  const ne = (expected || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const na = (actual   || '').toLowerCase().replace(/[^a-z0-9]/g, '');

  if (!ne || !na) return 0;
  if (ne === na)                          return 100;
  if (na.includes(ne) || ne.includes(na)) return 90;

  // Token overlap on meaningful words (>2 chars)
  const tokE = new Set(_tokenize(expected));
  const tokA = _tokenize(actual);
  if (tokE.size > 0) {
    const shared = tokA.filter(t => tokE.has(t)).length;
    if (shared > 0) {
      const tokScore = Math.round((shared / Math.max(tokE.size, new Set(tokA).size)) * 70);
      return Math.max(tokScore, _bigramSimilarity(ne, na));
    }
  }

  return _bigramSimilarity(ne, na);
}

function computeDomainScore(itemUrl, targetDomain) {
  if (!itemUrl || !targetDomain) return 0;
  const normalise = s => (s || '').toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split(/[/?#]/)[0]
    .replace(/\/$/, '');
  const d1 = normalise(itemUrl);
  const d2 = normalise(targetDomain);
  if (!d1 || !d2) return 0;
  if (d1 === d2)                          return 100;
  if (d1.includes(d2) || d2.includes(d1)) return 80;
  return 0;
}

/**
 * Confidence score combining nameScore and domainScore.
 * Domain URL is the strongest identity signal — a matching website is
 * near-proof the listing belongs to the target business.
 *   domain match:  nameScore needs to be only plausibly related
 *   no domain:     name match must be strong on its own
 */
function computeConfidence(nameScore, domainScore) {
  if (domainScore === 100) {
    return Math.round(nameScore * 0.4 + 60);
  }
  if (domainScore === 80) {
    return Math.round(nameScore * 0.5 + 40);
  }
  return Math.round(nameScore);
}

const MATCH_THRESHOLD = 70;

// ── Service ────────────────────────────────────────────────────────────────

export const MapsRankingService = {
  /**
   * Fetch Google Maps rank for a business by name.
   *
   * Always resolves (never rejects) — errors return null rank so a single Maps
   * failure does not abort the entire keyword ranking check.
   *
   * @param {string}      keyword
   * @param {string}      businessName  - Business name from verified GMB profile
   * @param {number}      locationCode  - DataForSEO location_code
   * @param {string}      languageCode  - e.g. "en"
   * @param {string|null} targetDomain  - Normalized website domain for domain scoring
   * @returns {Promise<{ maps_rank: number|null, maps_listing: Object|null }>}
   */
  async fetchMapsRank(keyword, businessName, locationCode, languageCode, targetDomain = null) {
    console.log(
      `[MAPS_REQUEST] keyword="${keyword}"` +
      ` | businessName="${businessName}"` +
      ` | targetDomain="${targetDomain ?? 'null'}"` +
      ` | locationCode=${locationCode}` +
      ` | depth=100` +
      ` | endpoint=serp/google/maps/live/advanced`
    );

    try {
      const data  = await DataForSeoService.getMapsResults(keyword, locationCode, languageCode);
      const items = data?.tasks?.[0]?.result?.[0]?.items || [];
      const firstFiveTypes = items.slice(0, 5).map(i => i?.type ?? 'unknown').join(', ');

      console.log(
        `[MAPS_RESPONSE] itemsReturned=${items.length}` +
        ` | rawResultCount=${data?.tasks?.[0]?.result?.length ?? 0}` +
        ` | firstFiveTypes=[${firstFiveTypes}]`
      );

      // Dump first 20 results for diagnosis
      items.slice(0, 20).forEach((item, idx) => {
        console.log(
          `[MAPS_RESULT] index=${idx}` +
          ` | title="${item.title ?? ''}"` +
          ` | domain="${item.domain ?? ''}"` +
          ` | url="${item.url ?? ''}"` +
          ` | address="${item.address ?? ''}"` +
          ` | rank_group=${item.rank_group ?? 'null'}` +
          ` | rank_absolute=${item.rank_absolute ?? 'null'}`
        );
      });

      for (const item of items) {
        const title      = item.title || '';
        const itemUrl    = item.url || item.domain || '';

        const nameScore   = computeNameScore(businessName, title);
        const domainScore = computeDomainScore(itemUrl, targetDomain);
        const confidence  = computeConfidence(nameScore, domainScore);
        const isMatch     = confidence >= MATCH_THRESHOLD;

        console.log(
          `[MAPS_COMPARE]` +
          ` expected="${businessName}"` +
          ` | actual="${title}"` +
          ` | nameScore=${nameScore}` +
          ` | domainScore=${domainScore}` +
          ` | confidence=${confidence}` +
          ` | finalDecision=${isMatch ? 'MATCH' : 'SKIP'}`
        );

        if (!title || !isMatch) continue;

        const rawRank   = item.rank_group ?? item.rank_absolute ?? null;
        const mapsRank  = (rawRank != null && rawRank >= 1) ? rawRank : null;
        const ratingObj = item.rating;
        const rating    = ratingObj && typeof ratingObj === 'object'
          ? (ratingObj.value       ?? null)
          : (ratingObj             ?? null);
        const reviews   = ratingObj && typeof ratingObj === 'object'
          ? (ratingObj.votes_count ?? null)
          : (item.reviews_count    ?? null);

        const listing = { title, rating, reviews, address: item.address ?? null };

        console.log(`[MAPS_SAVE] maps_rank=${mapsRank} | maps_listing=${JSON.stringify(listing)}`);
        return { maps_rank: mapsRank, maps_listing: listing };
      }

      console.log(`[MAPS_SAVE] maps_rank=null | maps_listing=null | reason=no_match_in_top_${items.length}`);
      return { maps_rank: null, maps_listing: null };

    } catch (err) {
      console.error(`[MAPS_SAVE] maps_rank=null | maps_listing=null | reason=api_error | error="${err.message}"`);
      return { maps_rank: null, maps_listing: null };
    }
  },
};
