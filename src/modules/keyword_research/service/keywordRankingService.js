/**
 * Keyword Ranking Service
 *
 * Handles keyword ranking checks using DataForSEO SERP API directly.
 * All Python worker calls have been removed.
 */

import { DataForSeoService }    from '../../ranking/services/DataForSeoService.js';
import { RankingParserService }  from '../../ranking/services/RankingParserService.js';
import { scanKeywordDevices, buildDeviceResult } from '../../ranking/services/deviceSerpScan.js';
import SeoRanking        from '../../app_user/model/SeoRanking.js';
import SeoProject        from '../../app_user/model/SeoProject.js';
import { COUNTRY_TO_LOCATION_CODE } from '../../../services/dataforseoLocationService.js';
import { resolveLocalLocationCode } from '../../../services/localLocationResolver.js';
import { ValidationError } from '../../../utils/ErrorUtil.js';

class KeywordRankingService {
  /**
   * Check keyword rankings for a domain.
   * @param {Object} params - { userId, projectId, domain, keywords, language }
   * @returns {Object} Created ranking document
   */
  async checkKeywordRankings({ userId, projectId, domain, keywords, language = 'en' }) {
    try {
      // No blind US default here — see resolveLocationForProject() below.
      // A project whose location genuinely cannot be resolved must fail
      // with a clear, actionable error, never silently rank against
      // Google US SERPs (the bug this replaces: a 'local' scope project
      // targeting Mumbai, with no `country` stored and the DataForSEO
      // locations API unreachable, previously fell all the way through to
      // locationCode 2840 / 'US' without any indication anything was wrong).
      const { locationCode, resolvedCountry } = await this.resolveLocationForProject(projectId);

      console.log(`[KEYWORD_RANKING] Starting ranking check | projectId=${projectId} | domain="${domain}" | keywords=${keywords.length} | locationCode=${locationCode}`);

      const rankingResults = await this.callRankingWorker({ domain, keywords, locationCode, language });

      const rankingDocument = await this.saveRankingResults({
        userId,
        projectId,
        domain,
        locationCode,
        country:  resolvedCountry,
        language,
        keywords: rankingResults
      });

      console.log(`[KEYWORD_RANKING] Ranking check completed | rankingId=${rankingDocument._id} | keywordsChecked=${rankingResults.length}`);

      return rankingDocument;

    } catch (error) {
      console.error(`[KEYWORD_RANKING] Ranking check failed | projectId=${projectId} | reason="${error.message}"`);
      throw error;
    }
  }

  /**
   * Resolve the DataForSEO location_code to rank against for a project.
   *
   * Throws ValidationError (HTTP 400) — never silently defaults to US —
   * when the project's location genuinely cannot be determined. Callers
   * must surface this as "please configure this project's location" to
   * the user, not swallow it and rank against an arbitrary country.
   *
   * @returns {{ locationCode: number, resolvedCountry: string }}
   */
  async resolveLocationForProject(projectId) {
    if (!projectId) {
      throw new ValidationError('A projectId is required to resolve keyword ranking location.');
    }

    const project = await SeoProject.findById(projectId)
      .select('country seo_scope verified_business location')
      .lean();

    if (!project) {
      throw new ValidationError(`Project ${projectId} not found — cannot resolve keyword ranking location.`);
    }

    if (project.seo_scope === 'local') {
      const resolution = await resolveLocalLocationCode({
        verifiedBusiness: project.verified_business || null,
        country:          project.country           || null,
        address:          project.location          || null,
      });

      if (resolution.locationCode == null) {
        throw new ValidationError(
          'This project\'s location could not be determined (no country on file and the ' +
          'location-lookup service is unavailable). Configure a country or verified business ' +
          'location for this project before checking keyword rankings.'
        );
      }

      return { locationCode: resolution.locationCode, resolvedCountry: resolution.country || project.country || null };
    }

    // National scope: country must be an explicit, supported ISO-2 code.
    // Previously `|| 2840` meant a project with no country configured (or
    // one outside the small COUNTRY_TO_LOCATION_CODE map) silently ranked
    // against Google US — same failure mode as the local-scope path above,
    // just without a lookup service involved.
    const countryCode = project.country?.toUpperCase();
    const locationCode = countryCode ? COUNTRY_TO_LOCATION_CODE[countryCode] : null;

    if (!locationCode) {
      throw new ValidationError(
        countryCode
          ? `Project country "${countryCode}" is not yet supported for keyword ranking. Supported: ${Object.keys(COUNTRY_TO_LOCATION_CODE).join(', ')}.`
          : 'This project has no country configured. Set a target country for this project before checking keyword rankings.'
      );
    }

    return { locationCode, resolvedCountry: countryCode };
  }

  /**
   * Check rankings for multiple keywords via DataForSEO organic SERP, for
   * desktop and (unless disabled) mobile. Each device is independent: a failed
   * device is reported via scan_error / mobile.scan_error — it is NEVER folded
   * into rank:null (which means "checked, not found").
   *
   * @returns {Array<{ keyword, rank, found, scan_error, mobile? }>}
   */
  async callRankingWorker({ domain, keywords, locationCode, language }) {
    const cleanDomain = RankingParserService.normalizeDomain(domain);
    const langCode    = (language || 'en').toLowerCase();

    console.log(`[KEYWORD_RANKING] Fetching SERP for ${keywords.length} keywords | domain="${cleanDomain}" | loc=${locationCode}`);

    const results = await Promise.all(
      keywords.map(async keyword => {
        const { desktop, mobile } = await scanKeywordDevices({ keyword, locationCode, languageCode: langCode });
        const d = buildDeviceResult(desktop, cleanDomain);
        const m = buildDeviceResult(mobile, cleanDomain);
        return {
          keyword,
          rank:       d.scan_error ? null : d.best_rank,
          found:      !d.scan_error && d.best_rank !== null,
          scan_error: d.scan_error,
          ...(m ? { mobile: {
            rank:       m.scan_error ? null : m.best_rank,
            found:      !m.scan_error && m.best_rank !== null,
            scan_error: m.scan_error,
          } } : {}),
        };
      })
    );

    return results;
  }

  /**
   * Save ranking results to the seo_rankings archive collection.
   */
  async saveRankingResults({ userId, projectId, domain, locationCode, country, language, keywords }) {
    try {
      const keywordData = keywords.map(result => ({
        keyword:    result.keyword,
        rank:       result.found ? result.rank : null,
        scan_error: result.scan_error ?? null,
        // mobile_status unset => mobile not collected; 'error' => rank unknown
        ...(result.mobile ? {
          mobile_rank:   result.mobile.found ? result.mobile.rank : null,
          mobile_status: result.mobile.scan_error ? 'error' : 'ok',
        } : {})
      }));

      const rankingDocument = new SeoRanking({
        project_id:    projectId,
        user_id:       userId,
        domain:        domain.toLowerCase(),
        location_code: locationCode,
        country:       country || 'US',
        language:      language || 'en',
        keywords:      keywordData
      });

      await rankingDocument.save();

      console.log(`[KEYWORD_RANKING] Results saved | rankingId=${rankingDocument._id} | keywords=${keywordData.length}`);

      return rankingDocument;

    } catch (error) {
      console.error(`[KEYWORD_RANKING] Failed to save results | reason="${error.message}"`);
      throw error;
    }
  }

  /**
   * Get latest ranking results for a project.
   */
  async getProjectRankings({ projectId, limit = 10 }) {
    try {
      return await SeoRanking
        .find({ project_id: projectId })
        .sort({ created_at: -1 })
        .limit(limit)
        .populate('user_id', 'name email')
        .lean();
    } catch (error) {
      console.error(`[KEYWORD_RANKING] Failed to get project rankings | projectId=${projectId} | reason="${error.message}"`);
      throw error;
    }
  }

  /**
   * Get ranking summary for a project.
   */
  async getRankingSummary(projectId) {
    try {
      const latestRanking = await SeoRanking
        .findOne({ project_id: projectId })
        .sort({ created_at: -1 })
        .lean();

      if (!latestRanking) {
        return { hasRankings: false, message: 'No ranking data available' };
      }

      const keywords      = latestRanking.keywords || [];
      const foundKeywords = keywords.filter(k => k.rank !== null);
      const averageRank   = foundKeywords.length > 0
        ? Math.round(foundKeywords.reduce((sum, k) => sum + k.rank, 0) / foundKeywords.length)
        : 0;

      return {
        hasRankings:   true,
        domain:        latestRanking.domain,
        location:      latestRanking.location,
        totalKeywords: keywords.length,
        foundKeywords: foundKeywords.length,
        averageRank,
        topRankings:   foundKeywords.filter(k => k.rank <= 10).length,
        lastChecked:   latestRanking.created_at,
        keywords:      keywords.map(k => ({
          keyword: k.keyword,
          rank:    k.rank || 'Not Found',
          found:   k.rank !== null
        }))
      };

    } catch (error) {
      console.error(`[KEYWORD_RANKING] Failed to get ranking summary | projectId=${projectId} | reason="${error.message}"`);
      throw error;
    }
  }

  /**
   * Track ranking changes over time.
   */
  async getRankingHistory(projectId, days = 30) {
    try {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);

      const rankings = await SeoRanking
        .find({ project_id: projectId, created_at: { $gte: startDate } })
        .sort({ created_at: -1 })
        .lean();

      return rankings.map(ranking => ({
        id:           ranking._id,
        domain:       ranking.domain,
        location:     ranking.location,
        date:         ranking.created_at,
        keywordCount: ranking.keywords.length,
        foundCount:   ranking.keywords.filter(k => k.rank !== null).length,
        averageRank:  this.calculateAverageRank(ranking.keywords)
      }));

    } catch (error) {
      console.error(`[KEYWORD_RANKING] Failed to get ranking history | projectId=${projectId} | reason="${error.message}"`);
      throw error;
    }
  }

  calculateAverageRank(keywords) {
    const found = keywords.filter(k => k.rank !== null);
    if (!found.length) return 0;
    return Math.round(found.reduce((sum, k) => sum + k.rank, 0) / found.length);
  }
}

export default KeywordRankingService;
