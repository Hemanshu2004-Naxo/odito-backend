/**
 * keywordSuggestion.service.js — Onboarding keyword generation orchestrator.
 *
 * Pipeline (6 phases):
 *  1. Seed expansion  — turns one subType into 5–10 commercial seed phrases
 *  2. Batched fetch   — single DataForSEO request with all seeds as tasks
 *  3. Deduplication   — normalise + collapse duplicates across all task results
 *  4. Noise filter    — remove employment, educational, and piracy terms
 *  5. Intent scoring  — rank by commercial signal strength
 *  6. Final selection — return top 5
 *
 * ISOLATION CONTRACT:
 *  - Never imported by ranking, SERP, Maps, or location modules.
 *  - Accepts an already-resolved locationCode — never re-resolves it.
 *  - Never writes to any database collection.
 *  - Returns [] on any failure; never throws.
 */

import axios from 'axios';
import { SeedExpansionService }        from './SeedExpansionService.js';
import { KeywordDeduplicationService } from './KeywordDeduplicationService.js';
import { KeywordNoiseFilterService }   from './KeywordNoiseFilterService.js';
import { KeywordIntentScoringService } from './KeywordIntentScoringService.js';

const KEYWORD_SUGGESTIONS_URL =
  'https://api.dataforseo.com/v3/dataforseo_labs/google/keyword_suggestions/live';

// ── Auth ─────────────────────────────────────────────────────────────────────

function getAuthHeader() {
  const login    = process.env.DATAFORSEO_LOGIN    || '';
  const password = process.env.DATAFORSEO_PASSWORD || '';
  if (!login || !password) {
    console.warn('[ONBOARDING_KW] DATAFORSEO_LOGIN or DATAFORSEO_PASSWORD is not set');
  }
  return `Basic ${Buffer.from(`${login}:${password}`).toString('base64')}`;
}

// ── Intent classifier (kept for per-item intent tagging) ─────────────────────

const COMMERCIAL_TERMS = [
  'buy', 'price', 'cost', 'cheap', 'best', 'review', 'deal', 'discount',
  'service', 'services', 'agency', 'company', 'near me', 'for sale', 'quote',
  'pricing', 'rates', 'affordable', 'professional', 'expert', 'hire', 'firm',
  'provider', 'solutions', 'development', 'top', 'custom', 'local',
];

function classifyIntent(keyword) {
  const kl = (keyword || '').toLowerCase().trim();
  const navigational = [
    'login', 'signin', 'account', 'dashboard', 'portal', 'console',
    'analytics', 'tools', 'app', 'website', 'official', 'support',
    'help', 'contact', 'customer service',
  ];
  if (COMMERCIAL_TERMS.some(t => kl.includes(t))) return 'commercial';
  if (navigational.some(t => kl.includes(t)))     return 'navigational';
  return 'informational';
}

// ── Raw-item parser (DataForSEO keyword_data or flat structure) ───────────────

function parseRawItems(items) {
  const out = [];
  for (const item of items) {
    if (!item) continue;

    let keyword, search_volume, cpc, competition, competition_level, keyword_difficulty;

    if (item.keyword_data) {
      const kd          = item.keyword_data;
      keyword           = kd.keyword?.trim();
      search_volume     = kd.keyword_info?.search_volume       ?? 0;
      cpc               = kd.keyword_info?.cpc                 ?? 0;
      competition       = kd.keyword_info?.competition         ?? 0;
      competition_level = kd.keyword_info?.competition_level   ?? null;
      keyword_difficulty= kd.keyword_properties?.keyword_difficulty ?? null;
    } else {
      keyword           = item.keyword?.trim();
      search_volume     = item.search_volume     ?? 0;
      cpc               = item.cpc               ?? 0;
      competition       = item.competition       ?? 0;
      competition_level = item.competition_level ?? null;
      keyword_difficulty= item.keyword_difficulty ?? null;
    }

    if (!keyword) continue;

    out.push({
      keyword,
      search_volume:      parseInt(search_volume, 10)  || 0,
      cpc:                parseFloat(cpc)              || 0,
      competition:        parseFloat(competition)      || 0,
      competition_level:  competition_level            ?? null,
      keyword_difficulty: keyword_difficulty != null
                            ? parseInt(keyword_difficulty, 10)
                            : null,
      intent:             classifyIntent(keyword),
    });
  }
  return out;
}

// ── Main service ─────────────────────────────────────────────────────────────

export const keywordSuggestionService = {
  /**
   * Generate high-quality onboarding keyword suggestions.
   *
   * @param {{
   *   subType:      string,   - Raw business category ("software", "restaurant" …)
   *   seedKeyword:  string,   - Already-mapped commercial seed ("software company")
   *   locationCode: number,   - Country-level DataForSEO code (e.g. 2356 for India)
   *   languageCode: string,   - Language code ("en", "hi" …)
   * }}
   * @returns {Promise<Array>} Top 5 keyword objects, or [] on failure.
   */
  async getOnboardingKeywordSuggestions({ subType, seedKeyword, locationCode, languageCode }) {

    // ── Phase 1: Seed Expansion ─────────────────────────────────────────────
    const seeds = SeedExpansionService.expandKeywordSeeds(subType, seedKeyword);

    // ── Phase 2: Batched DataForSEO request ─────────────────────────────────
    // All seeds are sent as separate tasks in one HTTP call.
    // DataForSEO processes each task independently and returns one result array per task.
    console.log(
      `[KW_PARALLEL_FETCH] seeds=${seeds.length}` +
      ` | locationCode=${locationCode}` +
      ` | lang=${languageCode}` +
      ` | seeds=${seeds.join(' | ')}`
    );

    const payload = seeds.map(seed => ({
      keyword:              seed,
      location_code:        locationCode,
      language_code:        languageCode,
      include_seed_keyword: true,
      include_serp_info:    true,
      limit:                50,
    }));

    console.log(
      `[ONBOARDING_KW] Request` +
      ` | seedCount=${seeds.length}` +
      ` | locationCode=${locationCode}` +
      ` | lang=${languageCode}` +
      ` | firstSeed="${seeds[0]}"`
    );

    let allItems = [];

    try {
      const response = await axios.post(KEYWORD_SUGGESTIONS_URL, payload, {
        headers: {
          Authorization:  getAuthHeader(),
          'Content-Type': 'application/json',
        },
        timeout: 45_000,
      });

      const data = response.data;
      console.log(
        `[ONBOARDING_KW] Response` +
        ` | status_code=${data?.status_code}` +
        ` | tasks=${data?.tasks?.length ?? 0}`
      );

      if (data?.status_code !== 20000) {
        console.error(
          `[ONBOARDING_KW] Error | API error: ${data?.status_message} (code ${data?.status_code})`
        );
        return [];
      }

      // Collect items from every successful task
      let taskSuccess = 0;
      for (const task of (data.tasks || [])) {
        if (task?.status_code !== 20000) continue;
        const items = task?.result?.[0]?.items;
        if (!Array.isArray(items)) continue;
        allItems.push(...parseRawItems(items));
        taskSuccess++;
      }

      console.log(
        `[ONBOARDING_KW] Parsed` +
        ` | tasks_ok=${taskSuccess}/${seeds.length}` +
        ` | raw_count=${allItems.length}`
      );

    } catch (err) {
      console.error(`[ONBOARDING_KW] Error | ${err.message}`);
      return [];
    }

    if (allItems.length === 0) return [];

    // ── Phase 3: Deduplication ──────────────────────────────────────────────
    const deduped = KeywordDeduplicationService.deduplicate(allItems);

    // ── Phase 4: Noise filter ───────────────────────────────────────────────
    const filtered = KeywordNoiseFilterService.filter(deduped);

    if (filtered.length === 0) return [];

    // ── Phase 5: Intent scoring + sort ──────────────────────────────────────
    const top5 = KeywordIntentScoringService.sortByIntent(filtered, 5);

    // ── Phase 6: Final selection log ────────────────────────────────────────
    console.log(
      `[KW_FINAL_SELECTION]` +
      ` count=${top5.length}` +
      ` | keywords=${top5.map(k => k.keyword).join(' | ')}`
    );

    return top5;
  },
};
