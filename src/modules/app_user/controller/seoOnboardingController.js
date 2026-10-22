import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import { AuthUtil } from '../../../utils/AuthUtil.js';
import { COUNTRY_TO_LOCATION_CODE, extractCityFromAddress } from '../../../services/dataforseoLocationService.js';
import { resolveLocalLocationCode } from '../../../services/localLocationResolver.js';
import { resolveLocationFromWebsiteData } from '../../../services/websiteLocationResolverService.js';
import {
  saveCanonicalRanking,
  mergeSingleKeywordRescan,
  deriveHistoricalRanks,
  deriveHistoricalRanksForProject,
  addKeyword,
  ensureCanonicalRanking,
  deleteKeyword,
  withDeviceStatuses
} from '../../../services/rankingHistoryService.js';
import { canConsumeQuota } from '../../subscription/service/subscriptionLifecycle.js';
import { getKeywordLimit } from '../../../config/plans.js';
import {
  validateKeywordInput,
  isDuplicateKeyword,
  computeKeywordUsage
} from '../../../utils/keywordValidation.js';
import { DataForSeoService }        from '../../ranking/services/DataForSeoService.js';
import { RankingParserService }     from '../../ranking/services/RankingParserService.js';
import { MapsRankingService }       from '../../ranking/services/MapsRankingService.js';
import KeywordRankingService        from '../../keyword_research/service/keywordRankingService.js';
import { scanKeywordDevices, buildDeviceResult } from '../../ranking/services/deviceSerpScan.js';
import { keywordSuggestionService } from '../../ranking/services/keywordSuggestion.service.js';
import SeoRanking        from '../model/SeoRanking.js';
import SeoRankingCurrent from '../model/SeoRankingCurrent.js';
import SeoProject        from '../model/SeoProject.js';
import mongoose from 'mongoose';

// ── Helpers ───────────────────────────────────────────────────────────────────

const STREET_FRAGMENTS = new Set([
  'floor', 'fl', 'road', 'rd', 'society', 'near', 'store', 'lane', 'ln',
  'apartment', 'apt', 'building', 'bldg', 'plot', 'sector', 'phase', 'block',
  'wing', 'level', 'tower', 'complex', 'mall', 'market', 'colony', 'area',
  'nagar', 'layout', 'extension', 'enclave', 'residency', 'gardens', 'park',
  'street', 'st', 'avenue', 'ave', 'boulevard', 'blvd', 'highway', 'expressway',
  'junction', 'circle', 'square', 'place', 'terrace', 'court', 'close',
]);

// State and country names that are never city-level targets
const COMMON_NON_CITIES = new Set([
  // Countries
  'india', 'us', 'usa', 'uk', 'australia', 'canada', 'france', 'germany',
  'china', 'japan', 'brazil', 'russia', 'singapore', 'uae',
  // Indian states (not also primary city names)
  'maharashtra', 'karnataka', 'gujarat', 'rajasthan', 'punjab', 'haryana',
  'kerala', 'andhra', 'telangana', 'odisha', 'assam', 'bihar', 'jharkhand',
  'uttarakhand', 'himachal', 'goa', 'manipur', 'meghalaya', 'mizoram',
  'nagaland', 'sikkim', 'tripura', 'arunachal', 'chhattisgarh',
  'uttarpradesh', 'madhyapradesh', 'westbengal',
  // Geographic scope words
  'state', 'country', 'region', 'province', 'district', 'territory',
]);

function isValidCity(city) {
  if (!city || city.trim().length < 2) return false;
  const lower = city.toLowerCase().trim().replace(/\s+/g, '');
  if (COMMON_NON_CITIES.has(lower)) return false;
  const spaced = city.toLowerCase().trim();
  if (STREET_FRAGMENTS.has(spaced)) return false;
  return !spaced.split(/\s+/).some(word => STREET_FRAGMENTS.has(word));
}

// Maps a raw subType to a high-intent seed phrase for DataForSEO queries.
// Keys are lowercase; values are the commercial phrase to prepend city to.
const BUSINESS_INTENT_MAP = {
  software:           'software company',
  'software company': 'software company',
  agency:             'digital marketing agency',
  'digital marketing':'digital marketing agency',
  marketing:          'marketing agency',
  restaurant:         'restaurant',
  hotel:              'hotel',
  dentist:            'dentist',
  dental:             'dental clinic',
  'dental clinic':    'dental clinic',
  lawyer:             'lawyer',
  'law firm':         'law firm',
  doctor:             'doctor',
  clinic:             'clinic',
  hospital:           'hospital',
  pharmacy:           'pharmacy',
  ecommerce:          'online store',
  'online store':     'online store',
  'real estate':      'real estate company',
  'real_estate':      'real estate company',
  consulting:         'consulting firm',
  'it services':      'IT services company',
  'it company':       'IT company',
  gym:                'gym',
  salon:              'salon',
  spa:                'spa',
  cafe:               'cafe',
  bakery:             'bakery',
  school:             'school',
  college:            'college',
  plumber:            'plumber',
  electrician:        'electrician',
  carpenter:          'carpenter',
  interior:           'interior designer',
  'interior design':  'interior designer',
  architect:          'architect',
  photographer:       'photographer',
  shop:               'shop',
  store:              'store',
  travel:             'travel agency',
  'travel agency':    'travel agency',
  logistics:          'logistics company',
  transport:          'transport company',
  'ca firm':          'CA firm',
  accountant:         'accountant',
  insurance:          'insurance company',
  bank:               'bank',
  ngo:                'NGO',
};


function buildIntentQuery(subType, city) {
  const key  = (subType || '').toLowerCase().trim();
  const seed = BUSINESS_INTENT_MAP[key] || subType.trim();

  if (!city) {
    console.log(`[KW_QUERY_BUILDER] subType="${subType}" | mappedSeed="${seed}" | city="null" | finalQuery="${seed}"`);
    return seed;
  }

  // Guard: city already present in seed (e.g. seed="Nashik consulting" edge case)
  const seedLower = seed.toLowerCase();
  const cityLower = city.toLowerCase();
  const finalQuery = seedLower.includes(cityLower) ? seed : `${seed} ${city}`;

  // Deduplicate consecutive repeated words (paranoia guard)
  const deduped = finalQuery.replace(/\b(\w+)\b(?:\s+\1\b)+/gi, '$1').trim();

  console.log(`[KW_QUERY_BUILDER] subType="${subType}" | mappedSeed="${seed}" | city="${city}" | finalQuery="${deduped}"`);
  return deduped;
}

/**
 * Static fallback keywords when DataForSEO returns nothing.
 * Port of Python _get_fallback_keywords().
 *
 * @returns {Array<{keyword: string, volume: number}>}
 */
function getFallbackKeywords(subType) {
  const st  = subType.toLowerCase().trim();
  const map = {
    'it services':       ['IT services', 'IT support', 'IT company', 'managed IT services', 'IT solutions'],
    'digital marketing': ['digital marketing', 'marketing agency', 'online marketing', 'SEO services', 'social media marketing'],
    'consulting':        ['consulting services', 'business consulting', 'management consulting', 'strategy consulting', 'consulting firm'],
    'restaurant':        ['restaurant', 'local restaurant', 'best restaurant', 'dining', 'food restaurant'],
    'salon':             ['salon', 'beauty salon', 'hair salon', 'local salon', 'salon services'],
    'gym':               ['gym', 'fitness center', 'local gym', 'gym near me', 'fitness gym'],
    'agency':            ['agency', 'digital agency', 'marketing agency', 'creative agency', 'agency services'],
    'software':          ['software', 'software company', 'tech software', 'software solutions', 'software development'],
    'ecommerce':         ['ecommerce', 'online store', 'e-commerce store', 'online shopping', 'buy online'],
  };
  if (map[st]) return map[st].map(keyword => ({ keyword, volume: 0 }));
  for (const [key, vals] of Object.entries(map)) {
    if (key.includes(st) || st.includes(key)) return vals.map(keyword => ({ keyword, volume: 0 }));
  }
  return [subType, `${subType} services`, `professional ${subType}`, `local ${subType}`, `best ${subType}`]
    .map(keyword => ({ keyword, volume: 0 }));
}

/**
 * TEMPORARY structured logging for the organic-call-flow investigation
 * (verifying the DataForSEO organic request actually runs, actually
 * succeeds, and is actually parsed correctly — as opposed to a Maps result
 * being mistaken for an organic one, or an API failure silently becoming
 * rank=null). Only called when serpData is non-null, i.e. getSerpOrganic()
 * did NOT throw — a thrown error is logged separately by
 * DataForSeoService's own [DATAFORSEO_ORGANIC_ERROR] and never reaches here.
 * Logs only shape/metadata — never credentials, never the full raw response.
 * Safe to remove once the investigation is closed.
 */
function logSerpOrganicDebug({ keyword, locationCode, languageCode, cleanDomain, serpData }) {
  try {
    const task  = serpData?.tasks?.[0];
    const allItems = RankingParserService._collectAllItems(serpData);

    console.log(
      `[DATAFORSEO_ORGANIC_RESULT] taskId=${task?.id ?? 'null'} | statusCode=${task?.status_code ?? 'null'} | ` +
      `statusMessage="${task?.status_message ?? 'null'}" | resultExists=${task?.result != null} | ` +
      `resultLength=${Array.isArray(task?.result) ? task.result.length : 0} | itemsCount=${allItems.length} | ` +
      `types=${JSON.stringify(allItems.slice(0, 20).map(i => i?.type ?? 'unknown'))}`
    );

    // Step 5/6 sanity check: this MUST be organic items only, never a maps
    // result mistaken for one — RankingParserService.parseOrganic() filters
    // strictly on item.type === 'organic' (schema_rules-style type gate),
    // and 'maps_search'/'local_pack' items are never counted here.
    const organicOnly = allItems.filter(i => i?.type === 'organic');
    const positions = organicOnly.map(i => i.rank_group ?? i.rank_absolute ?? null).filter(p => p != null);

    console.log(
      `[DATAFORSEO_ORGANIC_ITEMS] totalItems=${allItems.length} | organicItems=${organicOnly.length} | ` +
      `firstOrganicPosition=${positions[0] ?? 'null'} | lastOrganicPosition=${positions[positions.length - 1] ?? 'null'}`
    );

    // Match over EVERY organic item (same matcher as parseOrganic) — this used to
    // look at the first 20 only, so "found=false" read like "not in the results"
    // when it only meant "not in the top 20". Only the first 20 are printed.
    let targetMatch = { found: false, position: null, domain: null, url: null };
    organicOnly.forEach((item, idx) => {
      const url    = item.url || item.snippet_url || item.link || '';
      const domain = url ? RankingParserService.normalizeDomain(url) : RankingParserService.normalizeDomain(item.domain || '');
      const position = item.rank_group ?? item.rank_absolute ?? null;

      if (idx < 20) {
        console.log(
          `[DATAFORSEO_ORGANIC_ITEM] position=${position} | rank_group=${item.rank_group ?? 'null'} | ` +
          `rank_absolute=${item.rank_absolute ?? 'null'} | domain="${domain}" | url="${url}" | title="${(item.title || '').slice(0, 80)}"`
        );
      }

      if (!targetMatch.found && RankingParserService.domainMatches(domain, cleanDomain)) {
        targetMatch = { found: true, position, domain, url };
      }
    });

    console.log(
      `[DATAFORSEO_TARGET_MATCH] scope=all_${organicOnly.length}_organic_items | targetDomain="${cleanDomain}" | found=${targetMatch.found} | ` +
      `position=${targetMatch.position ?? 'null'} | domain="${targetMatch.domain ?? ''}" | url="${targetMatch.url ?? ''}"`
    );
  } catch (err) {
    LoggerUtil.warn('[DATAFORSEO_ORGANIC_RESULT] failed to build debug summary (non-fatal)', { keyword, error: err.message });
  }
}

/**
 * Run SERP + optional Maps API in parallel for a single keyword.
 * Returns a result object matching the shape the frontend expects.
 */
async function processKeyword(keyword, cleanDomain, locationCode, languageCode, seoScope, businessName) {
  const shouldFetchMaps = seoScope === 'local' && !!businessName?.trim();

  // Distinguishes "the organic SERP request/parse itself failed" from "the
  // request succeeded and genuinely found no match" — buildKeywordUpdate
  // (rankingHistoryService.js) uses this to decide whether current_rank/
  // ranking_urls may be safely overwritten (real scan) or must be left
  // untouched (a failure carries no information about the real ranking —
  // see that function's own doc comment for the full rationale).
  // Desktop and mobile organic SERPs are requested independently
  // (deviceSerpScan.js): each device carries its own success/failure, so a
  // mobile failure can never mark the desktop scan as failed (or vice versa).
  const [{ desktop: desktopScan, mobile: mobileScan }, mapsResult] = await Promise.all([
    scanKeywordDevices({ keyword, locationCode, languageCode }),
    shouldFetchMaps
      ? MapsRankingService.fetchMapsRank(keyword, businessName.trim(), locationCode, languageCode, cleanDomain)
      : Promise.resolve({ maps_rank: null, maps_listing: null }),
  ]);

  const serpData  = desktopScan.serpData;
  const serpError = desktopScan.serpError;
  const mobile    = buildDeviceResult(mobileScan, cleanDomain);

  let rankingUrls = [], bestRank = null, organicMapsRank = null;
  if (serpData) {
    logSerpOrganicDebug({ keyword, locationCode, languageCode, cleanDomain, serpData });

    const parsed     = RankingParserService.parseOrganic(serpData, cleanDomain);
    rankingUrls      = parsed.ranking_urls;
    bestRank         = parsed.best_rank;
    // Same per-device line deviceSerpScan.buildDeviceResult prints for mobile,
    // so both devices are visible in the logs.
    console.log(
      `[DEVICE_SCAN_RESULT] device=desktop | target="${cleanDomain}" | organicDepth=${RankingParserService.observedOrganicDepth(serpData) ?? 'null'} | ` +
      `matched=${parsed.best_rank !== null} | rank=${parsed.best_rank ?? 'null'} | matchedUrls=${parsed.ranking_urls.length}`
    );
    organicMapsRank  = parsed.maps_rank;
  }

  // Maps merge logic — matches Python exactly:
  //   national:          always null
  //   local + name:      prefer Maps API rank, fall back to organic local_pack
  //   local + no name:   use organic local_pack rank only
  let finalMapsRank, finalMapsListing;
  if (seoScope === 'national') {
    finalMapsRank    = null;
    finalMapsListing = null;
  } else if (shouldFetchMaps) {
    finalMapsRank    = mapsResult.maps_rank ?? organicMapsRank;
    finalMapsListing = mapsResult.maps_listing ?? null;
  } else {
    finalMapsRank    = organicMapsRank;
    finalMapsListing = null;
  }

  console.log(
    `[ONBOARDING] keyword="${keyword}" | rank=${bestRank} | maps_rank=${finalMapsRank} | urls=${rankingUrls.length}` +
    (serpError ? ` | serp_error="${serpError}"` : '')
  );

  // Step 8 trace: the exact value getSerpOrganic()'s result was parsed
  // into, right before it's handed to the caller (checkRanking/rescanKeyword/
  // addKeywordController -> buildKeywordUpdate). rawResultCount reflects the
  // DataForSEO response itself (task.result page count); organicResultCount/
  // urlsCount reflect what survived RankingParserService.parseOrganic's
  // type filter and domain match — if serpData is null (organic call
  // threw), all three are necessarily 0/null, which is the CORRECT signal
  // to distinguish from a real "not found" (see scan_error above, carried
  // separately so this is never conflated with a genuine null rank).
  console.log(
    `[ORGANIC_RETURN] keyword="${keyword}" | rawResultCount=${serpData?.tasks?.[0]?.result?.length ?? 0} | ` +
    `organicResultCount=${serpData ? RankingParserService._collectAllItems(serpData).filter(i => i?.type === 'organic').length : 0} | ` +
    `urlsCount=${rankingUrls.length} | detectedRank=${bestRank}`
  );

  return {
    keyword,
    rank:         bestRank,
    best_rank:    bestRank,
    ranking_urls: rankingUrls,
    maps_rank:    finalMapsRank    ?? null,
    maps_listing: finalMapsListing ?? null,
    // null when the organic scan itself succeeded (even with zero matches);
    // set to the failure message when the request/parse failed outright —
    // see buildKeywordUpdate (rankingHistoryService.js) for how this is used.
    scan_error:   serpError,
    // Desktop result time (provider response received) — used by the persistence
    // layer to refuse an older result overwriting a newer one.
    scanned_at:   desktopScan.scanned_at,
    // Mobile organic result for the same keyword, or undefined when mobile
    // tracking is switched off (KEYWORD_MOBILE_RANKING_ENABLED=false). Shape:
    // { ranking_urls, best_rank, tracked_depth, scan_error, scanned_at }.
    ...(mobile ? { mobile } : {}),
  };
}


// ═══════════════════════════════════════════════════════════════════════════
//  1) POST /api/seo/generate-keywords
// ═══════════════════════════════════════════════════════════════════════════

export const generateKeywords = async (req, res) => {
  try {
    const {
      subType,
      city: requestCity = null,
      location,
      lat,
      lng,
      country  = null,
      language = 'en',
    } = req.body;

    if (!subType || typeof subType !== 'string' || subType.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: 'subType is required and must be a non-empty string'
      });
    }

    LoggerUtil.info('Generate keywords request', { subType, location, country });

    const rawLocation    = location?.trim() || null;
    const subTypeTrimmed = subType.trim();
    let   locationCode;
    let   resolvedCity    = null;
    let   resolvedCountry = country; // tracks the best-known country across all resolution paths

    // Priority 1: verified_business.city sent explicitly from frontend
    if (requestCity?.trim()) {
      resolvedCity = requestCity.trim();
      console.log(`[KW_CITY_SOURCE] source=verified_business.city | city=${resolvedCity}`);
    }

    // Resolve locationCode (always needed) and city as priority 2/3
    if (lat != null && lng != null) {
      // Google Places path — full coordinates available
      const resolution = await resolveLocalLocationCode({
        verifiedBusiness: {
          city:     resolvedCity,   // feeds P1 of resolver when already set
          address:  rawLocation,
          location: { lat, lng },
        },
        country,
        address: rawLocation,
      });
      locationCode    = resolution.locationCode;
      resolvedCountry = resolution.country || country;
      console.log(`[LOCATION_TRACE] GENERATE_KW_RESOLVED | locationCode=${locationCode} | method=${resolution.mappingMethod}`);

      // Priority 2/3: city returned by localLocationResolver
      if (!resolvedCity && resolution.city) {
        resolvedCity = resolution.city;
        console.log(`[KW_CITY_SOURCE] source=location_resolver | city=${resolvedCity} | method=${resolution.mappingMethod}`);
      }
    } else if (resolvedCity || rawLocation) {
      // Website manual fallback path — no lat/lng but city name or address string available.
      // Resolves city-level location code and country without coordinates so that
      // keyword generation uses the correct country market (not the US default).
      try {
        const resolution = await resolveLocalLocationCode({
          verifiedBusiness: resolvedCity
            ? { city: resolvedCity, address: rawLocation, location: {} }
            : null,
          country,
          address: rawLocation,
        });
        locationCode    = resolution.locationCode;
        resolvedCountry = resolution.country || country;
        console.log(`[LOCATION_TRACE] GENERATE_KW_ADDR_RESOLVE | locationCode=${locationCode} | method=${resolution.mappingMethod} | city=${resolution.city ?? 'null'}`);
        if (!resolvedCity && resolution.city) {
          resolvedCity = resolution.city;
          console.log(`[KW_CITY_SOURCE] source=addr_resolve | city=${resolvedCity}`);
        }
      } catch (err) {
        locationCode = country ? (COUNTRY_TO_LOCATION_CODE[country.toUpperCase()] ?? null) : null;
        console.log(`[LOCATION_TRACE] GENERATE_KW_ADDR_FAIL | locationCode=${locationCode ?? 'UNRESOLVED'} | ${err.message}`);
      }
    } else {
      locationCode = country ? (COUNTRY_TO_LOCATION_CODE[country.toUpperCase()] ?? null) : null;
      console.log(`[LOCATION_TRACE] GENERATE_KW_COUNTRY | locationCode=${locationCode ?? 'UNRESOLVED'} | country=${country}`);
    }

    // Never silently default to US — suggested keywords targeted at the
    // wrong country market are still a real product bug (a Mumbai business
    // being suggested US-centric search terms), not a cosmetic one.
    if (!locationCode || typeof locationCode !== 'number') {
      return res.status(400).json({
        success: false,
        message: country
          ? `Country "${country}" is not yet supported for keyword suggestions. Supported: ${Object.keys(COUNTRY_TO_LOCATION_CODE).join(', ')}.`
          : 'A location could not be determined for keyword suggestions. Provide a city, address, or country.',
      });
    }

    // Priority 4: direct address parse — last resort, only when all above failed
    if (!resolvedCity && rawLocation) {
      const parsedCity = extractCityFromAddress(rawLocation);
      if (parsedCity && isValidCity(parsedCity)) {
        resolvedCity = parsedCity;
        console.log(`[KW_CITY_SOURCE] source=address_parse_fallback | city=${resolvedCity}`);
      } else if (parsedCity) {
        console.log(`[KW_CITY_SOURCE] source=address_parse_rejected | candidate="${parsedCity}" | reason=street_fragment`);
      }
    }

    // finalQuery appends city ("software company Nashik") — kept for TRACE logs only.
    // keywordSentToApi is mappedSeed alone ("software company").
    const finalQuery       = buildIntentQuery(subTypeTrimmed, resolvedCity);
    const mappedSeed       = BUSINESS_INTENT_MAP[subTypeTrimmed.toLowerCase().trim()] || subTypeTrimmed.trim();
    const keywordSentToApi = mappedSeed;

    // ── Separate location strategies ─────────────────────────────────────────
    // rankingLocationCode (= locationCode) is city-level (e.g. 9040235 for Nashik).
    // It is used by checkRanking / rescanKeyword and must NEVER change here.
    //
    // keyword_suggestions/live requires a country-level code (e.g. 2356 for India)
    // to return meaningful search volume data — city-level codes return sparse/zero
    // results from that endpoint. These two codes are always kept completely separate.
    //
    // No US fallback here either (this used to be the one remaining silent
    // US default in this file — a city can resolve successfully via
    // DataForSEO's global city-name search, with no country filter, leaving
    // `resolvedCountry`/`country` both unknown). When the country genuinely
    // can't be determined, `onboardingKeywordLocationCode` is left `null`:
    // getOnboardingKeywordSuggestions()'s own contract is "never throws,
    // returns [] on failure" (see keywordSuggestion.service.js), so a null
    // location_code degrades to "no volume-enriched suggestions this call"
    // rather than ever attaching US search-volume numbers to a suggestion
    // for a business whose actual market is unknown.
    const onboardingCountryCode = (resolvedCountry || country)?.toUpperCase();
    const onboardingKeywordLocationCode = onboardingCountryCode
      ? (COUNTRY_TO_LOCATION_CODE[onboardingCountryCode] ?? null)
      : null;
    if (!onboardingKeywordLocationCode) {
      console.warn(`[LOCATION_TRACE] onboardingKeywordLocationCode UNRESOLVED — keyword suggestions will return without volume enrichment, never a US-market guess | resolvedCountry=${resolvedCountry ?? 'null'} | country=${country ?? 'null'} | city=${resolvedCity ?? 'null'}`);
    }

    console.log('[KW_LOCATION_STRATEGY]', JSON.stringify({
      country:                      country ?? null,
      city:                         resolvedCity ?? null,
      rankingLocationCode:          locationCode,
      onboardingKeywordLocationCode,
    }));
    console.log(`[KW_TRACE_1] subType="${subTypeTrimmed}" | resolvedCity="${resolvedCity ?? 'null'}" | address="${rawLocation ?? 'null'}" | country="${country ?? 'null'}"`);
    console.log(`[KW_TRACE_2] rawInputUsedForQuery | subType="${subTypeTrimmed}" | location="${rawLocation ?? 'null'}"`);
    console.log(`[KW_TRACE_3] constructedQuery="${finalQuery}" | (subType="${subTypeTrimmed}" + city="${resolvedCity ?? 'none'}")`);
    console.log(`[KW_TRACE_4] finalDataForSeoKeyword="${finalQuery}" | locationCode=${locationCode} | lang=${language}`);
    console.log(`[KW_SEED_TRACE] mappedSeed="${mappedSeed}" | finalQuery="${finalQuery}" | keywordSentToApi="${keywordSentToApi}" | onboardingKeywordLocationCode=${onboardingKeywordLocationCode}`);

    const kwList = await keywordSuggestionService.getOnboardingKeywordSuggestions({
      subType:      subTypeTrimmed,
      seedKeyword:  keywordSentToApi,
      locationCode: onboardingKeywordLocationCode,
      languageCode: language.toLowerCase(),
    });

    const keywords = kwList.length > 0 ? kwList : getFallbackKeywords(subType.trim());

    LoggerUtil.info('Keywords generated successfully', { count: keywords.length });

    return res.status(200).json({
      success: true,
      data: { keywords }
    });

  } catch (error) {
    LoggerUtil.error('Generate keywords error', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error while generating keywords'
    });
  }
};


// ═══════════════════════════════════════════════════════════════════════════
//  2) POST /api/seo/check-ranking
// ═══════════════════════════════════════════════════════════════════════════

export const checkRanking = async (req, res) => {
  try {
    const { domain, keywords, location, country = null, language = 'en', businessLocation, seoScope = null, cityName = null, businessName = null } = req.body;

    if (!domain || typeof domain !== 'string') {
      return res.status(400).json({ success: false, message: 'domain is required' });
    }

    if (!keywords || !Array.isArray(keywords) || keywords.length === 0) {
      return res.status(400).json({ success: false, message: 'keywords array is required and must not be empty' });
    }

    // ── Location resolution ────────────────────────────────────────────────────
    let locationCode, mappingMethod, finalCountry = country;

    console.log(`[LOCATION_TRACE] CHECK_RANKING_RECEIVED | seoScope=${seoScope} | country=${country} | cityName=${cityName ?? 'null'} | lat=${businessLocation?.lat ?? 'null'} | lng=${businessLocation?.lng ?? 'null'} | hasAddress=${!!businessLocation?.address}`);

    if (seoScope === 'local') {
      const resolution = await resolveLocalLocationCode({
        verifiedBusiness: (businessLocation || cityName) ? {
          city:     cityName || null,
          address:  businessLocation?.address || null,
          location: { lat: businessLocation?.lat ?? null, lng: businessLocation?.lng ?? null },
        } : null,
        country,
        address: typeof location === 'string' ? location : null,
      });
      locationCode  = resolution.locationCode;
      mappingMethod = resolution.mappingMethod;
      finalCountry  = resolution.country || country;
      console.log(`[LOCATION_TRACE] RESOLUTION_RESULT | locationCode=${locationCode} | method=${mappingMethod} | confidence=${resolution.confidence} | city=${resolution.city ?? 'null'}`);
    } else {
      locationCode  = country ? (COUNTRY_TO_LOCATION_CODE[country.toUpperCase()] ?? null) : null;
      mappingMethod = 'national_country_code';
      finalCountry  = country;
      console.log(`[LOCATION_TRACE] RESOLUTION_RESULT | locationCode=${locationCode ?? 'UNRESOLVED'} | method=${mappingMethod} | confidence=${locationCode ? 'high' : 'none'}`);
    }

    // Never silently default to US here — this endpoint directly produces
    // the ranking position shown to the user, so an unresolved location
    // must be a clear error, not a guess. Previously: any of "no country on
    // file", "local scope with only a bare city name and the DataForSEO
    // locations API unreachable", or "country not in COUNTRY_TO_LOCATION_CODE"
    // fell all the way through to `COUNTRY_TO_LOCATION_CODE['US']` here (and
    // a second time in the "emergency fallback" below), producing a real,
    // wrong-market ranking number with no indication anything was off.
    if (!locationCode || typeof locationCode !== 'number') {
      console.log(`[LOCATION_TRACE] UNRESOLVED — refusing to guess a location | seoScope=${seoScope} | country=${country}`);
      return res.status(400).json({
        success: false,
        message: country
          ? `Country "${country}" is not yet supported for keyword ranking. Supported: ${Object.keys(COUNTRY_TO_LOCATION_CODE).join(', ')}.`
          : 'This project\'s location could not be determined. Configure a country or verified business location before checking keyword rankings.',
      });
    }

    LoggerUtil.info('Check ranking request', { domain, keywords, country: finalCountry, locationCode, seoScope });

    // ── Keyword integrity enforcement ──────────────────────────────────────────
    const cleanedKeywords = keywords.map(k => k.trim()).filter(k => k.length > 0);

    for (let i = 0; i < cleanedKeywords.length; i++) {
      if (cleanedKeywords[i] !== keywords[i]?.trim()) {
        LoggerUtil.error('[KEYWORD_INTEGRITY] Keyword mismatch detected after cleaning', {
          index: i, original: keywords[i], cleaned: cleanedKeywords[i]
        });
      }
    }

    const cleanDomain  = RankingParserService.normalizeDomain(domain);
    const langCode     = language?.toLowerCase() || 'en';
    const kwSlice      = cleanedKeywords.slice(0, 5); // hard cap at 5, matching Python

    console.log(`[LOCATION_TRACE] DIRECT_RANKING | locationCode=${locationCode} | country=${finalCountry} | seoScope=${seoScope} | domain="${cleanDomain}" | keywords=${kwSlice.length}`);

    console.log(
      `[MAPS_REQUEST_CONTEXT]` +
      ` seoScope="${seoScope}"` +
      ` | businessName="${businessName ?? 'null'}"` +
      ` | shouldFetchMaps=${seoScope === 'local' && !!businessName?.trim()}`
    );

    // Process all keywords in parallel (SERP + Maps per keyword run concurrently)
    const results = await Promise.all(
      kwSlice.map(kw =>
        processKeyword(kw, cleanDomain, locationCode, langCode, seoScope, businessName)
          .then(r => {
            console.log(
              `[MAPS_SAVE]` +
              ` keyword="${kw}"` +
              ` | maps_rank=${r.maps_rank ?? 'null'}` +
              ` | maps_listing=${r.maps_listing ? JSON.stringify(r.maps_listing) : 'null'}`
            );
            return r;
          })
          .catch(err => {
            console.error(`[RANKING] Keyword processing failed | keyword="${kw}" | ${err.message}`);
            return { keyword: kw, rank: null, best_rank: null, ranking_urls: [], maps_rank: null, maps_listing: null };
          })
      )
    );

    LoggerUtil.info('Ranking check completed', { resultsCount: results.length });

    return res.status(200).json({
      success: true,
      data: {
        results,
        location_code:  locationCode,
        mapping_method: mappingMethod,
      }
    });

  } catch (error) {
    LoggerUtil.error('Check ranking error', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error while checking rankings'
    });
  }
};


// ═══════════════════════════════════════════════════════════════════════════
//  3) POST /api/seo/save-ranking
// ═══════════════════════════════════════════════════════════════════════════

export const saveRanking = async (req, res) => {
  try {
    const { projectId, domain, location, keywords, locationCode, country, language, seoScope, ranking_source } = req.body;

    if (!projectId) {
      return res.status(400).json({ success: false, message: 'projectId is required' });
    }

    if (!mongoose.Types.ObjectId.isValid(projectId)) {
      return res.status(400).json({ success: false, message: 'Invalid projectId format' });
    }

    if (!keywords || !Array.isArray(keywords) || keywords.length === 0) {
      return res.status(400).json({ success: false, message: 'keywords array is required' });
    }

    const userId = req.user?._id;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    // The caller must own the project: the canonical document is keyed by
    // project_id alone, so without this any authenticated user could overwrite
    // (and take ownership of) another tenant's ranking data.
    try {
      await AuthUtil.validateProjectAccess(userId, projectId);
    } catch (accessErr) {
      const status = accessErr.statusCode === 404 ? 404 : 403;
      return res.status(status).json({ success: false, message: status === 404 ? 'Project not found' : 'Access denied' });
    }

    LoggerUtil.info('Save ranking request', { projectId, domain, keywordsCount: keywords.length });

    console.log(`[LOCATION_TRACE] SAVE_RECEIVED | locationCode=${locationCode} | type=${typeof locationCode} | projectId=${projectId} | country=${country}`);

    const ranking = new SeoRanking({
      project_id:    projectId,
      user_id:       userId,
      domain:        domain?.trim()?.toLowerCase() || '',
      location:      location?.trim() || null,
      location_code: typeof locationCode === 'number' ? locationCode : null,
      country:       country?.toUpperCase() || null,
      language:      language?.toLowerCase() || 'en',
      seo_scope:     seoScope || null,
      keywords: keywords.map(kw => {
        const bestRank = kw.best_rank != null ? parseInt(kw.best_rank, 10)
          : kw.rank     != null ? parseInt(kw.rank,      10)
          : null;
        return {
          keyword:      kw.keyword?.trim() || '',
          rank:         bestRank,
          best_rank:    bestRank,
          maps_rank:    kw.maps_rank    ?? null,
          maps_listing: kw.maps_listing ?? null,
          ranking_urls: Array.isArray(kw.ranking_urls)
            ? kw.ranking_urls
                .filter(u => u.rank != null && u.url)
                .map(u => ({
                  rank: parseInt(u.rank, 10),
                  url:  u.url.trim(),
                  type: u.type === 'homepage' ? 'homepage' : 'internal_page'
                }))
            : []
        };
      })
    });

    const saved = await ranking.save();

    // Verify what was actually written to Mongo for maps fields
    saved.keywords?.forEach(kw => {
      console.log(
        `[MAPS_MONGO_VERIFY]` +
        ` keyword="${kw.keyword}"` +
        ` | storedMapsRank=${kw.maps_rank ?? 'null'}` +
        ` | storedMapsListing=${kw.maps_listing ? JSON.stringify(kw.maps_listing) : 'null'}`
      );
    });

    const scanSource       = ranking_source || 'onboarding';
    const canonicalKeywords = keywords.map(kw => {
      const mr = kw.maps_rank;
      return {
        keyword:      kw.keyword?.trim() || '',
        ranking_urls: kw.ranking_urls    || [],
        maps_rank:    (mr != null && mr >= 1) ? mr : null,
        maps_listing: kw.maps_listing    ?? null,
        // Echoed back from checkRanking's response (see processKeyword) —
        // must survive this round-trip so buildKeywordUpdate can tell a
        // genuine "not found" apart from a failed scan (rankingHistoryService.js).
        scan_error:   kw.scan_error      ?? null,
        // Per-device mobile result echoed from checkRanking (same round-trip as
        // scan_error); sanitised again in rankingHistoryService.buildMobileUpdate.
        ...(kw.mobile && typeof kw.mobile === 'object' ? { mobile: kw.mobile } : {}),
      };
    });

    try {
      console.log(`[LOCATION_TRACE] MONGO_WRITE | locationCode=${typeof locationCode === 'number' ? locationCode : null} | projectId=${projectId}`);
      await saveCanonicalRanking({
        projectId,
        userId,
        domain:       domain?.trim()?.toLowerCase() || '',
        location:     location?.trim() || null,
        locationCode: typeof locationCode === 'number' ? locationCode : null,
        country:      country?.toUpperCase() || null,
        language:     language?.toLowerCase() || 'en',
        seoScope:     seoScope || null,
        keywords:     canonicalKeywords,
        scanSource
      });
    } catch (canonicalErr) {
      LoggerUtil.error('[CANONICAL] saveCanonicalRanking failed — legacy archive still saved', {
        projectId,
        error: canonicalErr.message,
        stack: canonicalErr.stack
      });
    }

    LoggerUtil.info('Ranking saved successfully', { rankingId: saved._id, projectId });

    return res.status(201).json({
      success: true,
      message: 'Ranking data saved successfully',
      data: { rankingId: saved._id }
    });

  } catch (error) {
    LoggerUtil.error('Save ranking error', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error while saving ranking data'
    });
  }
};


// ═══════════════════════════════════════════════════════════════════════════
//  4) GET /api/seo/rankings/:projectId
// ═══════════════════════════════════════════════════════════════════════════

export const getProjectRankings = async (req, res) => {
  try {
    const { projectId } = req.params;

    if (!projectId) {
      return res.status(400).json({ success: false, message: 'projectId is required' });
    }

    if (!mongoose.Types.ObjectId.isValid(projectId)) {
      return res.status(400).json({ success: false, message: 'Invalid projectId format' });
    }

    const userId = req.user?._id;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    LoggerUtil.info('Get project rankings request', { projectId });

    // Primary: canonical document from seo_rankings_current (single, always up-to-date)
    const canonical = await SeoRankingCurrent
      .findOne({ project_id: projectId, user_id: userId })
      .lean();

    if (canonical) {
      // The canonical doc is ALWAYS the source of truth for the currently
      // tracked keyword set once it exists — every keyword written to it
      // (via saveCanonicalRanking/addKeyword/mergeSingleKeywordRescan) has
      // already been through a real DataForSEO scan (buildKeywordUpdate
      // always sets scan_count >= 1 and an explicit last_scan_status of
      // 'ok' or 'error'; there is no server-side path that leaves a
      // placeholder/unscanned keyword on this document). So a keyword with
      // current_rank === null here is a genuine, common, fully-valid
      // "scanned successfully, not found in top 100" result — NOT a sign
      // the doc is unpopulated.
      //
      // This used to be gated behind a `hasAtLeastOneRank` check that
      // treated "no keyword currently ranks" as "doc isn't really
      // populated yet" and fell back to the legacy seo_rankings archive
      // instead. That archive has no `usage`/`scan_count`/`status` fields
      // and isn't kept in sync with add/delete, so any project whose
      // keywords simply hadn't ranked yet (e.g. a freshly onboarded
      // project) silently lost its usage/limit header and other canonical
      // fields — while a project with at least one ranked keyword worked
      // fine. Falling back to the archive is now reserved for the one case
      // where it's actually correct: no canonical doc exists at all.
      LoggerUtil.info('Rankings retrieved from canonical store', { projectId });

      // Overlay live-derived prev-week/prev-month ranks (relative to NOW,
      // not to whenever the last scan happened to run) so infrequently
      // scanned ("manual tracking") projects never show stale comparison
      // values. Cached fields on the doc itself are left untouched — this
      // only affects what's sent in the response.
      try {
        const [{ weekByKeyword, monthByKeyword }, mobileHist] = await Promise.all([
          deriveHistoricalRanksForProject(projectId),
          deriveHistoricalRanksForProject(projectId, 'mobile')
        ]);
        canonical.keywords = canonical.keywords.map(kw => {
          const normalized = (kw.keyword || '').toLowerCase().trim();
          return {
            ...kw,
            // Mobile previous ranks come from MOBILE history only; a keyword
            // never scanned for mobile has no `mobile` object and gets none.
            ...(kw.mobile ? { mobile: {
              ...kw.mobile,
              prev_week_rank:  mobileHist.weekByKeyword.has(normalized)  ? mobileHist.weekByKeyword.get(normalized)  : null,
              prev_month_rank: mobileHist.monthByKeyword.has(normalized) ? mobileHist.monthByKeyword.get(normalized) : null
            } } : {}),
            // last_scan_rank: the immediately-previous scan's rank, date-agnostic —
            // an alias of prev_scan_rank (already computed correctly in
            // buildKeywordUpdate as "current_rank before this update"). No new
            // calculation here; prev_week_rank/prev_month_rank logic is untouched.
            last_scan_rank:  kw.prev_scan_rank ?? null,
            prev_week_rank:  weekByKeyword.has(normalized)  ? weekByKeyword.get(normalized)  : null,
            prev_month_rank: monthByKeyword.has(normalized) ? monthByKeyword.get(normalized) : null
          };
        });
      } catch (deriveErr) {
        LoggerUtil.warn('Live prev-week/month derivation failed — serving cached values', {
          projectId, error: deriveErr.message
        });
        // Live derivation failed, but last_scan_rank doesn't depend on it —
        // still alias it so the field is never missing from the response.
        canonical.keywords = canonical.keywords.map(kw => ({ ...kw, last_scan_rank: kw.prev_scan_rank ?? null }));
      }

      // Usage (used/limit/remaining) — additive field, existing consumers
      // reading canonical.keywords/etc. are unaffected. Needed so the
      // Keywords page can show "1/5 Used" on first load, not only after
      // an add/delete mutation (whose own responses already include this).
      // Same computeKeywordUsage/getKeywordLimit pair addKeywordController
      // and deleteKeywordController already use — one source of truth for
      // the limit, keyed off canonical.keywords.length (THIS project's
      // actual tracked-keyword count), never a second hardcoded value.
      const keywordLimit = getKeywordLimit(req.user.subscription.plan);
      canonical.usage = computeKeywordUsage(canonical.keywords.length, keywordLimit);

      // Explicit status ('ranked'|'not_ranked'|'scan_error') alongside the
      // existing current_rank/last_scan_status fields — additive, nothing
      // removed or renamed (Section E, UX/state-handling audit).
      canonical.keywords = canonical.keywords.map(withDeviceStatuses);

      return res.status(200).json({ success: true, data: [canonical] });
    }

    // Fallback: legacy seo_rankings archive
    const rankings = await SeoRanking
      .find({ project_id: projectId, user_id: userId })
      .sort({ created_at: -1 })
      .limit(10)
      .lean();

    LoggerUtil.info('Rankings retrieved from archive (no canonical doc yet)', {
      projectId,
      rankingsCount: rankings.length
    });

    return res.status(200).json({ success: true, data: rankings });

  } catch (error) {
    LoggerUtil.error('Get project rankings error', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error while fetching rankings'
    });
  }
};


// ═══════════════════════════════════════════════════════════════════════════
//  Shared helper — Maps business-name lookup (local-scope projects only)
//  Used by both rescanKeyword and addKeywordController; extracted verbatim
//  from the two identical inline blocks, no logic changes.
// ═══════════════════════════════════════════════════════════════════════════

async function resolveMapsBusinessName(projectId, userId, seoScope, logLabel) {
  let businessName = null;
  if (seoScope === 'local') {
    try {
      const project = await SeoProject
        .findOne({ _id: projectId, user_id: userId })
        .select('verified_business.name')
        .lean();
      businessName = project?.verified_business?.name || null;
    } catch (projErr) {
      LoggerUtil.warn(`${logLabel}: could not load project for Maps business_name`, {
        projectId, error: projErr.message
      });
    }
  }
  return businessName;
}


// ═══════════════════════════════════════════════════════════════════════════
//  5) POST /api/seo/keywords/:projectId/rescan
// ═══════════════════════════════════════════════════════════════════════════

export const rescanKeyword = async (req, res) => {
  try {
    const { projectId } = req.params;
    const { keyword }   = req.body;

    if (!projectId || !mongoose.Types.ObjectId.isValid(projectId)) {
      return res.status(400).json({ success: false, message: 'Invalid projectId' });
    }
    if (!keyword || typeof keyword !== 'string' || keyword.trim().length === 0) {
      return res.status(400).json({ success: false, message: 'keyword is required' });
    }

    const userId = req.user?._id;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const canonical = await SeoRankingCurrent
      .findOne({ project_id: projectId, user_id: userId })
      .lean();

    if (!canonical) {
      return res.status(404).json({
        success: false,
        message: 'No ranking data found for this project. Run a full scan first.'
      });
    }

    const kwNormalized = keyword.toLowerCase().trim();
    const existingKw   = canonical.keywords?.find(
      k => k.keyword.toLowerCase().trim() === kwNormalized
    );

    if (!existingKw) {
      return res.status(404).json({
        success: false,
        message: `Keyword "${keyword}" is not tracked for this project.`
      });
    }

    // Per-keyword cooldown: 30 minutes between rescans
    const COOLDOWN_MS = 30 * 60 * 1000;
    if (existingKw.last_rescanned_at) {
      const elapsed = Date.now() - new Date(existingKw.last_rescanned_at).getTime();
      if (elapsed < COOLDOWN_MS) {
        const retryAfterSec = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
        return res.status(429).json({
          success:     false,
          error:       'keyword_cooldown',
          message:     `This keyword was rescanned recently. Retry in ${Math.ceil(retryAfterSec / 60)} minute(s).`,
          retry_after: retryAfterSec
        });
      }
    }

    LoggerUtil.info('Keyword rescan request', { projectId, keyword });

    // Look up business name for local projects (needed by Maps API)
    const rescanBusinessName = await resolveMapsBusinessName(projectId, userId, canonical.seo_scope, 'rescanKeyword');

    const cleanDomain  = RankingParserService.normalizeDomain(canonical.domain);
    // No `|| 2840` here — a rescan must use the SAME market the keyword was
    // originally tracked against, or make it obvious that can't be done.
    // Only legacy documents predating the location-resolution fix in
    // checkRanking/addKeyword should ever be missing this field going
    // forward.
    if (!canonical.location_code) {
      return res.status(422).json({
        success: false,
        message: 'This project\'s tracked location is missing or invalid. Remove and re-add this keyword to re-resolve its location before rescanning.',
      });
    }
    const locationCode = canonical.location_code;
    const langCode     = canonical.language       || 'en';
    const seoScope     = canonical.seo_scope      || null;

    const result = await processKeyword(
      keyword.trim(),
      cleanDomain,
      locationCode,
      langCode,
      seoScope,
      rescanBusinessName
    );

    const updated = await mergeSingleKeywordRescan({
      projectId,
      userId,
      domain: canonical.domain,
      keywordResult: {
        keyword:      result.keyword,
        ranking_urls: result.ranking_urls || [],
        maps_rank:    result.maps_rank    ?? null,
        maps_listing: result.maps_listing ?? null,
        scan_error:   result.scan_error   ?? null,
        scanned_at:   result.scanned_at   ?? null,
        mobile:       result.mobile       ?? null,
      },
      scanSource: 'manual_rescan'
    });

    const updatedKwDoc = updated.keywords?.find(
      k => k.keyword.toLowerCase().trim() === kwNormalized
    );
    let updatedKw = updatedKwDoc ? updatedKwDoc.toObject() : undefined;

    // last_scan_rank: alias of prev_scan_rank, already correctly computed by
    // buildKeywordUpdate on this same rescan (the "before overwrite" snapshot).
    if (updatedKw) {
      updatedKw = { ...updatedKw, last_scan_rank: updatedKw.prev_scan_rank ?? null };
    }

    // Same live-derivation overlay as getProjectRankings — otherwise the
    // rescanned keyword the UI merges in would carry the write-time-cached
    // (and often stale) prev_week_rank/prev_month_rank instead of values
    // computed relative to now.
    if (updatedKw) {
      try {
        const { prev_week_rank, prev_month_rank } = await deriveHistoricalRanks(projectId, updatedKw.keyword);
        updatedKw = { ...updatedKw, prev_week_rank, prev_month_rank };
        if (updatedKw.mobile) {
          const m = await deriveHistoricalRanks(projectId, updatedKw.keyword, 'mobile');
          updatedKw = { ...updatedKw, mobile: { ...updatedKw.mobile, prev_week_rank: m.prev_week_rank, prev_month_rank: m.prev_month_rank } };
        }
      } catch (deriveErr) {
        LoggerUtil.warn('Live prev-week/month derivation failed on rescan — serving cached values', {
          projectId, keyword, error: deriveErr.message
        });
      }
    }

    // Explicit status ('ranked'|'not_ranked'|'scan_error') — additive,
    // alongside the existing current_rank/last_scan_status fields (Section E).
    // success/200 stay true here even for 'scan_error': the REQUEST and the
    // write both genuinely succeeded (the previous valid rank was correctly
    // preserved, per buildKeywordUpdate) — it's the underlying DataForSEO
    // scan that degraded, not this endpoint. Flipping success to false for
    // that case would make the frontend treat a gracefully-handled scan
    // failure as a hard request failure, exactly the conflation this fix
    // exists to prevent.
    if (updatedKw) {
      updatedKw = withDeviceStatuses(updatedKw);
    }

    LoggerUtil.info('Keyword rescan complete', {
      projectId, keyword, newRank: updatedKw?.current_rank, status: updatedKw?.status
    });

    return res.status(200).json({
      success: true,
      message: 'Keyword rescanned successfully',
      data:    { keyword: updatedKw }
    });

  } catch (error) {
    LoggerUtil.error('rescanKeyword error', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error during keyword rescan'
    });
  }
};


// ═══════════════════════════════════════════════════════════════════════════
//  POST /api/seo/keywords/:projectId
//  Add one new keyword to an already-onboarded project's tracked list.
// ═══════════════════════════════════════════════════════════════════════════

export const addKeywordController = async (req, res) => {
  try {
    const { projectId } = req.params;
    const { keyword: rawKeyword } = req.body;

    if (!projectId || !mongoose.Types.ObjectId.isValid(projectId)) {
      return res.status(400).json({ success: false, message: 'Invalid projectId' });
    }

    const userId = req.user?._id;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    // Same subscription-lifecycle gate seoProjectController.js already uses
    // for project creation — a lapsed subscription shouldn't be able to
    // consume more of a resource it's no longer paying for.
    if (!canConsumeQuota(req.user.subscription.status)) {
      return res.status(403).json({
        success: false,
        code: 'SUBSCRIPTION_NOT_ACTIVE',
        message: `Your subscription is ${req.user.subscription.status}. Resolve this via Billing Portal to add more keywords.`
      });
    }

    let trimmedKeyword;
    try {
      trimmedKeyword = validateKeywordInput(rawKeyword);
    } catch (validationErr) {
      return res.status(400).json({ success: false, code: validationErr.code, message: validationErr.message });
    }

    let canonical = await SeoRankingCurrent
      .findOne({ project_id: projectId, user_id: userId })
      .lean();

    // A project with no ranking document yet (never onboarded for keywords, or
    // its ranking data was cleared) can start tracking right here: create an
    // empty document from the project's own saved location. Ownership is
    // verified first, so this can never create/alter another tenant's data.
    if (!canonical) {
      const owned = await SeoProject
        .findOne({ _id: projectId, user_id: userId, is_deleted: { $ne: true } })
        .select('main_url location language seo_scope country verified_business.address')
        .lean();
      if (!owned) {
        return res.status(404).json({
          success: false,
          code: 'PROJECT_NOT_FOUND',
          message: 'Project not found.'
        });
      }

      let resolved;
      try {
        resolved = await new KeywordRankingService().resolveLocationForProject(projectId);
      } catch (locErr) {
        return res.status(locErr.statusCode === 400 ? 422 : 500).json({
          success: false,
          code: 'LOCATION_UNRESOLVED',
          message: locErr.statusCode === 400
            ? locErr.message
            : 'Could not determine the tracking location for this project. Please try again.'
        });
      }

      await ensureCanonicalRanking({
        projectId,
        userId,
        domain:       owned.main_url,
        location:     owned.location || owned.verified_business?.address || null,
        locationCode: resolved.locationCode,
        country:      resolved.resolvedCountry || owned.country,
        language:     owned.language || 'en',
        seoScope:     owned.seo_scope || null
      });

      canonical = await SeoRankingCurrent
        .findOne({ project_id: projectId, user_id: userId })
        .lean();
      if (!canonical) {
        return res.status(404).json({
          success: false,
          code: 'PROJECT_NOT_FOUND',
          message: 'No ranking data found for this project.'
        });
      }
    }

    // Fast-fail pre-checks BEFORE spending a real DataForSEO credit. The
    // atomic guard inside addKeyword() (rankingHistoryService.js) is what
    // actually prevents a race between two concurrent requests — these
    // checks exist purely so an obviously-doomed request never reaches the
    // external API at all.
    const existingKeywordStrings = (canonical.keywords || []).map(k => k.keyword);
    if (isDuplicateKeyword(trimmedKeyword, existingKeywordStrings)) {
      return res.status(409).json({
        success: false,
        code: 'DUPLICATE_KEYWORD',
        message: `"${trimmedKeyword}" is already tracked for this project.`
      });
    }

    const planId = req.user.subscription.plan;
    const limit  = getKeywordLimit(planId);
    if (limit !== null && canonical.keywords.length >= limit) {
      return res.status(403).json({
        success: false,
        code: 'KEYWORD_LIMIT_REACHED',
        message: `Your plan allows tracking up to ${limit} keyword${limit === 1 ? '' : 's'}.`,
        limit
      });
    }

    LoggerUtil.info('Add keyword request', { projectId, keyword: trimmedKeyword });

    // Business name for Maps (local-scope projects only) — shared with rescanKeyword.
    const addBusinessName = await resolveMapsBusinessName(projectId, userId, canonical.seo_scope, 'addKeywordController');

    const cleanDomain  = RankingParserService.normalizeDomain(canonical.domain);
    // No `|| 2840` — see the identical check in rescanKeyword above.
    if (!canonical.location_code) {
      return res.status(422).json({
        success: false,
        message: 'This project\'s tracked location is missing or invalid. Please reconfigure the project\'s location before adding keywords.',
      });
    }
    const locationCode = canonical.location_code;
    const langCode     = canonical.language       || 'en';
    const seoScope     = canonical.seo_scope      || null;

    // Real external SERP/Maps call — reused from rescanKeyword, unchanged.
    const result = await processKeyword(
      trimmedKeyword,
      cleanDomain,
      locationCode,
      langCode,
      seoScope,
      addBusinessName
    );

    let updated;
    try {
      updated = await addKeyword({
        projectId,
        userId,
        domain: canonical.domain,
        keywordResult: {
          keyword:      result.keyword,
          ranking_urls: result.ranking_urls || [],
          maps_rank:    result.maps_rank    ?? null,
          maps_listing: result.maps_listing ?? null,
          scan_error:   result.scan_error   ?? null,
          scanned_at:   result.scanned_at   ?? null,
          mobile:       result.mobile       ?? null,
        },
        planId,
        scanSource: 'manual_add'
      });
    } catch (addErr) {
      // The atomic guard rejected the write — most likely the narrow race
      // window between the pre-checks above and this write. Map its typed
      // error code to the same HTTP response the pre-check would have given.
      const statusByCode = {
        DUPLICATE_KEYWORD:     409,
        KEYWORD_LIMIT_REACHED: 403,
        PROJECT_NOT_FOUND:     404,
      };
      const status = statusByCode[addErr.code] || 500;
      return res.status(status).json({ success: false, code: addErr.code || 'UNEXPECTED_ERROR', message: addErr.message });
    }

    const kwNormalized = trimmedKeyword.toLowerCase().trim();
    const newKwDoc = updated.keywords?.find(k => k.keyword.toLowerCase().trim() === kwNormalized);
    let newKw = newKwDoc ? newKwDoc.toObject() : undefined;

    if (newKw) {
      newKw = { ...newKw, last_scan_rank: newKw.prev_scan_rank ?? null };
      // A brand new keyword has no history yet, so this will correctly
      // resolve to null/null — computed live rather than hardcoded, so the
      // response shape matches getProjectRankings/rescanKeyword exactly.
      try {
        const { prev_week_rank, prev_month_rank } = await deriveHistoricalRanks(projectId, newKw.keyword);
        newKw = { ...newKw, prev_week_rank, prev_month_rank };
        if (newKw.mobile) {
          const m = await deriveHistoricalRanks(projectId, newKw.keyword, 'mobile');
          newKw = { ...newKw, mobile: { ...newKw.mobile, prev_week_rank: m.prev_week_rank, prev_month_rank: m.prev_month_rank } };
        }
      } catch (deriveErr) {
        LoggerUtil.warn('Live prev-week/month derivation failed on add — serving cached values', {
          projectId, keyword: trimmedKeyword, error: deriveErr.message
        });
      }
    }

    const usage = computeKeywordUsage(updated.keywords.length, limit);

    // Explicit status ('ranked'|'not_ranked'|'scan_error') — additive, same
    // reasoning as rescanKeyword above. A newly added keyword whose initial
    // scan hit a DataForSEO failure is still added successfully (201,
    // success:true) — it must stay visible in the table as "Scan Error",
    // never silently dropped or mislabeled "Not ranked".
    if (newKw) {
      newKw = withDeviceStatuses(newKw);
    }

    LoggerUtil.info('Add keyword complete', { projectId, keyword: trimmedKeyword, newRank: newKw?.current_rank, status: newKw?.status, usage });

    return res.status(201).json({
      success: true,
      message: 'Keyword added successfully',
      data: { keyword: newKw, usage }
    });

  } catch (error) {
    LoggerUtil.error('addKeywordController error', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error while adding keyword'
    });
  }
};


// ═══════════════════════════════════════════════════════════════════════════
//  DELETE /api/seo/keywords/:projectId/:keyword
//  Remove one keyword from active tracking. History is preserved.
// ═══════════════════════════════════════════════════════════════════════════

export const deleteKeywordController = async (req, res) => {
  try {
    const { projectId, keyword } = req.params;

    if (!projectId || !mongoose.Types.ObjectId.isValid(projectId)) {
      return res.status(400).json({ success: false, message: 'Invalid projectId' });
    }
    if (!keyword || typeof keyword !== 'string' || keyword.trim().length === 0) {
      return res.status(400).json({ success: false, message: 'keyword is required' });
    }

    const userId = req.user?._id;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    let updated;
    try {
      // decodeURIComponent: the keyword arrives URL-encoded as a path segment.
      updated = await deleteKeyword({ projectId, userId, keyword: decodeURIComponent(keyword) });
    } catch (deleteErr) {
      const status = deleteErr.code === 'PROJECT_NOT_FOUND' ? 404 : 500;
      return res.status(status).json({ success: false, code: deleteErr.code || 'UNEXPECTED_ERROR', message: deleteErr.message });
    }

    const planId = req.user.subscription.plan;
    const limit  = getKeywordLimit(planId);
    const usage  = computeKeywordUsage(updated.keywords.length, limit);

    LoggerUtil.info('Delete keyword complete', { projectId, keyword, usage });

    return res.status(200).json({
      success: true,
      message: 'Keyword removed successfully',
      data: { usage }
    });

  } catch (error) {
    LoggerUtil.error('deleteKeywordController error', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error while removing keyword'
    });
  }
};


// ═══════════════════════════════════════════════════════════════════════════
//  POST /api/seo/resolve-website-location
//
//  Called by the frontend when Google Places failed and the user selected
//  Local SEO.  Inspects the extracted website metadata + address string and
//  returns the resolved city/country/locationCode so the onboarding flow
//  can either proceed automatically or ask the user to confirm the city.
// ═══════════════════════════════════════════════════════════════════════════

export const resolveWebsiteLocation = async (req, res) => {
  try {
    const { address = null, extractedMetadata = null } = req.body;

    console.log('[LOCAL_LOCATION] Website Location Resolution Request');

    const result = await resolveLocationFromWebsiteData({ address, extractedMetadata });

    if (result) {
      return res.status(200).json({ success: true, data: result });
    }
    return res.status(200).json({ success: true, data: null });

  } catch (error) {
    console.error(`[LOCAL_LOCATION] Resolution failed | reason=${error.message}`);
    return res.status(500).json({ success: false, message: error.message });
  }
};
