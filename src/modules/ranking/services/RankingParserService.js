/**
 * RankingParserService — Pure parsing functions. NO HTTP. NO database.
 *
 * All logic ported from Python onboarding.py and keyword_processor.py.
 */

import { URL } from 'url';

export const RankingParserService = {

  // ── Domain helpers ───────────────────────────────────────────────────────────

  normalizeDomain(raw) {
    if (!raw) return '';
    let d = raw.trim().toLowerCase();
    d = d.replace(/^https?:\/\//, '');
    d = d.replace(/^www\./, '');
    d = d.replace(/\/+$/, '');
    d = d.split('/')[0].split('?')[0];
    return d;
  },

  /**
   * Host form used for organic matching: lowercase, no scheme, no path/query,
   * no port, no trailing dot, no leading "www.".
   */
  _matchHost(raw) {
    if (!raw || typeof raw !== 'string') return '';
    let h = raw.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
    h = h.split(/[/?#]/)[0].split('@').pop().replace(/:\d+$/, '').replace(/\.+$/, '');
    return h.replace(/^www\./, '');
  },

  /**
   * True when `serpHost` is the tracked site or one of its subdomains (or the
   * parent domain of a tracked subdomain), compared on whole DNS labels.
   * A plain substring test is NOT used: it matched "tech.com" / "infotech.com"
   * for wowinfotech.com and "wowinfotech.com.example.org", reporting a
   * competitor's page as the tracked site's ranking.
   */
  domainMatches(serpHost, targetHost) {
    const a = this._matchHost(serpHost);
    const b = this._matchHost(targetHost);
    if (!a || !b) return false;
    return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
  },

  classifyUrlType(url) {
    try {
      const path = new URL(url).pathname.replace(/\/+$/, '');
      return path === '' ? 'homepage' : 'internal_page';
    } catch {
      return 'internal_page';
    }
  },

  // ── Keyword Suggestions ──────────────────────────────────────────────────────

  /**
   * Extract keyword suggestions from DataForSEO keyword_suggestions/live response.
   * Port of Python _safe_extract_keywords().
   *
   * @returns {Array<{keyword: string, volume: number}>}
   */
  parseKeywordSuggestions(data) {
    const items = [];
    try {
      const itemsList = data?.tasks?.[0]?.result?.[0]?.items;
      if (!Array.isArray(itemsList)) return items;

      for (const item of itemsList) {
        if (!item) continue;

        // Method 1: nested keyword_data structure
        if (item.keyword_data) {
          const kw = item.keyword_data.keyword?.trim();
          if (!kw) continue;
          const volume = item.keyword_data.keyword_info?.search_volume ?? 0;
          items.push({ keyword: kw, volume: parseInt(volume, 10) || 0 });
          continue;
        }

        // Method 2: direct keyword field
        const kw = item.keyword?.trim();
        if (kw) {
          items.push({ keyword: kw, volume: parseInt(item.search_volume, 10) || 0 });
        }
      }
    } catch (err) {
      console.error('[RANKING_PARSER] parseKeywordSuggestions error:', err.message);
    }
    return items;
  },

  // ── SERP Organic ─────────────────────────────────────────────────────────────

  /** Flatten all SERP items across all result pages in the first task. */
  _collectAllItems(data) {
    const result = data?.tasks?.[0]?.result;
    if (!Array.isArray(result)) return [];
    const all = [];
    for (const page of result) {
      if (Array.isArray(page?.items)) all.push(...page.items);
    }
    return all;
  },

  /**
   * Extract Google Maps local pack rank from organic SERP items.
   * Zero extra API cost — local_pack data is embedded in the organic response.
   * Port of Python _extract_maps_rank().
   *
   * @returns {number|null}
   */
  extractLocalPackRank(items, cleanDomain) {
    for (const item of items) {
      if (item?.type !== 'local_pack') continue;
      for (const nested of (item.items || [])) {
        if (nested?.type !== 'local_pack_element') continue;

        const itemUrl    = nested.url || '';
        let   itemDomain = itemUrl ? this.normalizeDomain(itemUrl) : '';
        if (!itemDomain) itemDomain = this.normalizeDomain(nested.domain || '');
        if (!itemDomain) continue;

        if (
          itemDomain === cleanDomain ||
          cleanDomain.includes(itemDomain) ||
          itemDomain.includes(cleanDomain)
        ) {
          const rank = nested.rank_group ?? nested.rank_absolute;
          if (rank) {
            console.log(`[RANKING_PARSER] Local pack match | rank=${rank} | domain="${itemDomain}"`);
            return rank;
          }
        }
      }
    }
    return null;
  },

  /**
   * Deepest organic position the provider actually returned for this SERP
   * (max organic rank_group, capped at 100). This is the verifiable "tracked
   * range" for a scan: a confirmed "not found" only means "not within the
   * first N organic results", and N comes from the response, not an assumed
   * constant. null when the response carried no organic items at all (we can
   * not claim any range was checked).
   *
   * @returns {number|null}
   */
  observedOrganicDepth(data) {
    let deepest = 0;
    for (const item of this._collectAllItems(data)) {
      if (item?.type !== 'organic') continue;
      const pos = item.rank_group ?? item.rank_absolute;
      if (Number.isFinite(pos) && pos > deepest) deepest = pos;
    }
    return deepest > 0 ? Math.min(deepest, 100) : null;
  },

  /**
   * Parse organic SERP response → ranking_urls, best_rank, maps_rank.
   * Port of Python check_ranking() organic parsing block.
   *
   * @param {Object} data        - Raw DataForSEO response from getSerpOrganic()
   * @param {string} cleanDomain - Pre-normalised target domain
   * @returns {{ ranking_urls: Array, best_rank: number|null, maps_rank: number|null }}
   */
  parseOrganic(data, cleanDomain) {
    const allItems    = this._collectAllItems(data);
    const rankingUrls = [];
    const seenUrls    = new Set();
    let   mapsRank    = null;

    try { mapsRank = this.extractLocalPackRank(allItems, cleanDomain); } catch { /* non-fatal */ }

    for (const item of allItems) {
      if (item?.type !== 'organic') continue;

      const serpUrl    = item.url || item.snippet_url || item.link || '';
      let   serpDomain = item.domain || '';
      if (serpUrl) {
        const extracted = this.normalizeDomain(serpUrl);
        if (extracted) serpDomain = extracted;
      }
      const serpDomainClean = this.normalizeDomain(serpDomain);
      const rank = item.rank_group ?? item.rank_absolute;

      const isMatch = this.domainMatches(serpDomainClean, cleanDomain);

      if (isMatch && rank && !seenUrls.has(serpUrl)) {
        seenUrls.add(serpUrl);
        rankingUrls.push({ rank, url: serpUrl, type: this.classifyUrlType(serpUrl) });
      }
    }

    rankingUrls.sort((a, b) => a.rank - b.rank);
    const bestRank = rankingUrls.length > 0 ? rankingUrls[0].rank : null;

    return { ranking_urls: rankingUrls, best_rank: bestRank, maps_rank: mapsRank };
  },

  // ── Related Keywords (async job pipeline) ────────────────────────────────────

  /**
   * Parse DataForSEO related_keywords/live response.
   * Port of Python KeywordProcessor.process_results().
   *
   * @returns {Array<Object>} Normalised keyword records
   */
  parseRelatedKeywords(data, seedKeyword) {
    const keywords = [];
    const seen     = new Set();

    try {
      const firstTask = data?.tasks?.[0];
      if (!firstTask || firstTask.status_code !== 20000) return keywords;

      const results = firstTask.result || [];
      if (!results.length) return keywords;

      const items = results[0]?.items || [];
      if (items.length) {
        for (const item of items) {
          const kw = this._extractKeywordItem(item, seen, seedKeyword);
          if (kw) keywords.push(kw);
        }
      } else {
        for (const kwData of (results[0]?.related_keywords || [])) {
          const kw = this._extractRelatedKeyword(kwData, seen, seedKeyword);
          if (kw) keywords.push(kw);
        }
      }
    } catch (err) {
      console.error('[RANKING_PARSER] parseRelatedKeywords error:', err.message);
    }

    return keywords;
  },

  _extractKeywordItem(item, seen, seedKeyword) {
    let keyword, searchVolume = 0, cpc = 0, difficulty = 0, serpFeatures = [];

    if (item.keyword_data) {
      const kd   = item.keyword_data;
      keyword      = kd.keyword;
      searchVolume = kd.keyword_info?.search_volume ?? 0;
      cpc          = kd.keyword_info?.cpc ?? 0;
      difficulty   = kd.keyword_properties?.keyword_difficulty ?? 0;
      if (kd.keyword_info?.serp_info) serpFeatures = Object.keys(kd.keyword_info.serp_info);
    } else if (item.keyword) {
      keyword      = item.keyword;
      searchVolume = item.search_volume ?? 0;
      cpc          = item.cpc ?? 0;
      difficulty   = item.difficulty ?? item.keyword_difficulty ?? 0;
      const raw    = item.serp_features;
      serpFeatures = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? Object.keys(raw) : []);
    } else {
      return null;
    }

    if (!keyword?.trim()) return null;
    const kwl = keyword.toLowerCase().trim();
    if (seen.has(kwl)) return null;
    seen.add(kwl);

    if (!serpFeatures.length) serpFeatures = this.detectSerpFeatures(keyword, searchVolume);

    return {
      keyword:       keyword.trim(),
      search_volume: parseInt(searchVolume, 10) || 0,
      cpc:           parseFloat(cpc) || 0,
      difficulty:    parseInt(difficulty, 10) || 0,
      intent:        this.classifyIntent(keyword),
      serp_features: serpFeatures.length ? serpFeatures : ['organic'],
      source_keyword: seedKeyword,
    };
  },

  _extractRelatedKeyword(kwData, seen, seedKeyword) {
    const keyword = kwData.keyword || kwData.related_keyword;
    if (!keyword) return null;
    const kwl = keyword.toLowerCase().trim();
    if (seen.has(kwl)) return null;
    seen.add(kwl);

    const searchVolume = parseInt(kwData.search_volume, 10) || 0;
    const raw = kwData.serp_features;
    let serpFeatures = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? Object.keys(raw) : []);
    if (!serpFeatures.length) serpFeatures = this.detectSerpFeatures(keyword, searchVolume);

    return {
      keyword:       keyword.trim(),
      search_volume: searchVolume,
      cpc:           parseFloat(kwData.cpc) || 0,
      difficulty:    parseInt(kwData.difficulty, 10) || 0,
      intent:        this.classifyIntent(keyword),
      serp_features: serpFeatures.length ? serpFeatures : ['organic'],
      source_keyword: seedKeyword,
    };
  },

  // ── Intent + SERP feature heuristics ────────────────────────────────────────

  classifyIntent(keyword) {
    const kl = keyword.toLowerCase().trim();
    const commercial   = ['buy','price','cost','cheap','best','review','deal','discount','service','agency','company','near me','for sale','quote','pricing','rates','affordable','professional','expert'];
    const navigational = ['login','signin','account','dashboard','portal','console','analytics','tools','software','app','website','official','support','help','contact','customer service'];
    if (commercial.some(p   => kl.includes(p))) return 'commercial';
    if (navigational.some(p => kl.includes(p))) return 'navigational';
    return 'informational';
  },

  detectSerpFeatures(keyword, searchVolume) {
    const kl       = (keyword || '').toLowerCase().trim();
    const features = ['organic'];
    if (searchVolume > 10000) features.push('ai_overview');
    if (['how','what','why','guide','tutorial'].some(p => kl.includes(p))) features.push('people_also_ask');
    if (['near me','local','services','company'].some(p => kl.includes(p))) features.push('local_pack');
    if (['video','youtube'].some(p => kl.includes(p))) features.push('video');
    return [...new Set(features)];
  },
};
