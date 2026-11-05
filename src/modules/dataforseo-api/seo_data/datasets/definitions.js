import { createHash } from 'node:crypto';
import SeoKeywordRanking from '../model/SeoKeywordRanking.js';
import SeoBacklink from '../model/SeoBacklink.js';
import SeoReferringDomain from '../model/SeoReferringDomain.js';

/**
 * Everything that is specific to one stored dataset, in one place: the model, how a parsed provider row becomes a stored document, the
 * natural key, and the WHITELISTS that tie the pages' provider-shaped filters and sorts to stored fields. A field that is not listed here
 * cannot be filtered or sorted on, which is what keeps request input out of MongoDB queries.
 *
 * `row` (the parsed record, as the pages consume it) is stored untouched next to the flat fields, so reading a page from MongoDB returns
 * exactly the shape the cache path returned. Missing values stay null.
 */

const ROW = 'ranked_serp_element.serp_item';
const sha1 = (s) => createHash('sha1').update(s).digest('hex').slice(0, 32);
const lower = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');

/** The provider writes "2020-11-26 10:11:12 +00:00"; null when it is absent or unreadable (never a made-up date). */
export function parseProviderDate(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const iso = value.trim().replace(' ', 'T').replace(/\s*\+00:00$/, 'Z').replace(/\s*([+-]\d{2}):?(\d{2})$/, '$1:$2');
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strOrNull = (v) => (typeof v === 'string' && v ? v : null);
const boolOrNull = (v) => (typeof v === 'boolean' ? v : null);

export const KINDS = Object.freeze({
  keywords: {
    model: SeoKeywordRanking,
    section: 'ranked-keywords',
    endpoint: 'dataforseo_labs/google/ranked_keywords/live',
    naturalKey: (r, ctx) => sha1([lower(r.keyword), r.url ?? '', ctx.market.location_name, ctx.market.language_name, ''].join('|')),
    toDoc: (r, ctx) => ({
      keyword: r.keyword,
      normalizedKeyword: lower(r.keyword),
      location: ctx.market.location_name ?? null,
      language: ctx.market.language_name ?? null,
      device: null,
      position: numOrNull(r.position),
      positionAbsolute: numOrNull(r.position_absolute),
      previousPosition: numOrNull(r.previous_position),
      rankingUrl: strOrNull(r.url),
      relativeUrl: strOrNull(r.relative_url),
      title: strOrNull(r.title),
      searchVolume: numOrNull(r.search_volume),
      keywordDifficulty: numOrNull(r.keyword_difficulty),
      cpc: numOrNull(r.cpc),
      searchIntent: strOrNull(r.intent),
      trafficEstimate: numOrNull(r.etv),
      serpFeatures: Array.isArray(r.serp_features) ? r.serp_features : [],
      competitionLevel: strOrNull(r.competition_level),
      isNewRanking: boolOrNull(r.is_new),
      isUp: boolOrNull(r.is_up),
      isDown: boolOrNull(r.is_down),
      provider: { name: 'dataforseo', endpoint: 'dataforseo_labs/google/ranked_keywords/live', lastUpdatedTime: r.last_updated_time ?? null },
    }),
    // The pages' provider-shaped filter fields -> stored fields.
    fieldMap: {
      'keyword_data.keyword': { path: 'normalizedKeyword' },
      [`${ROW}.relative_url`]: { path: 'relativeUrl' },
      [`${ROW}.rank_group`]: { path: 'position' },
      'keyword_data.keyword_info.search_volume': { path: 'searchVolume' },
      'keyword_data.keyword_properties.keyword_difficulty': { path: 'keywordDifficulty' },
      'keyword_data.search_intent_info.main_intent': { path: 'searchIntent' },
      [`${ROW}.rank_changes.is_new`]: { path: 'isNewRanking' },
      [`${ROW}.rank_changes.is_up`]: { path: 'isUp' },
      [`${ROW}.rank_changes.is_down`]: { path: 'isDown' },
    },
    orderMap: {
      [`${ROW}.etv`]: 'trafficEstimate',
      [`${ROW}.rank_group`]: 'position',
      'keyword_data.keyword_info.search_volume': 'searchVolume',
      'keyword_data.keyword_properties.keyword_difficulty': 'keywordDifficulty',
      'keyword_data.keyword_info.cpc': 'cpc',
      'keyword_data.keyword': 'normalizedKeyword',
    },
    defaultSort: { trafficEstimate: -1 },
    identity: ['normalizedKeyword'],
  },

  backlinks: {
    model: SeoBacklink,
    section: 'backlinks-list',
    endpoint: 'backlinks/backlinks/live',
    naturalKey: (r, ctx) => sha1([ctx.status, r.url_from ?? '', r.url_to ?? '', r.anchor ?? '', r.item_type ?? ''].join('|')),
    toDoc: (r, ctx) => ({
      status: ctx.status,
      sourceUrl: strOrNull(r.url_from),
      targetUrl: strOrNull(r.url_to),
      sourceDomain: strOrNull(r.domain_from),
      anchor: strOrNull(r.anchor),
      linkType: strOrNull(r.item_type),
      isFollow: boolOrNull(r.dofollow),
      rank: numOrNull(r.rank),
      pageRank: numOrNull(r.page_from_rank),
      domainRank: numOrNull(r.domain_from_rank),
      spamScore: numOrNull(r.backlink_spam_score),
      firstSeen: parseProviderDate(r.first_seen),
      lastSeen: parseProviderDate(r.last_seen),
      semanticLocation: strOrNull(r.semantic_location),
      sourceCountry: strOrNull(r.domain_from_country),
      isNewLink: boolOrNull(r.is_new),
      isBroken: boolOrNull(r.is_broken),
      linkAttributes: Array.isArray(r.attributes) ? r.attributes : [],
      provider: { name: 'dataforseo', endpoint: 'backlinks/backlinks/live' },
    }),
    fieldMap: {
      url_from: { path: 'sourceUrl' },
      anchor: { path: 'anchor' },
      url_to: { path: 'targetUrl' },
      domain_from: { path: 'sourceDomain' },
      dofollow: { path: 'isFollow' },
      item_type: { path: 'linkType' },
      semantic_location: { path: 'semanticLocation' },
      domain_from_country: { path: 'sourceCountry' },
      domain_from_rank: { path: 'domainRank' },
      backlink_spam_score: { path: 'spamScore' },
      first_seen: { path: 'firstSeen', kind: 'date' },
      is_new: { path: 'isNewLink' },
      is_broken: { path: 'isBroken' },
    },
    orderMap: {
      rank: 'rank', domain_from_rank: 'domainRank', page_from_rank: 'pageRank', backlink_spam_score: 'spamScore', first_seen: 'firstSeen', last_seen: 'lastSeen',
    },
    defaultSort: { rank: -1 },
    identity: [],
  },

  referringDomains: {
    model: SeoReferringDomain,
    section: 'referring-domains',
    endpoint: 'backlinks/referring_domains/live',
    naturalKey: (r, ctx) => sha1(`${ctx.status}|${r.domain}`),
    toDoc: (r, ctx) => {
      const pages = numOrNull(r.referring_pages);
      const nofollow = numOrNull(r.referring_pages_nofollow);
      return {
        status: ctx.status,
        referringDomain: r.domain,
        domainRank: numOrNull(r.rank),
        backlinksCount: numOrNull(r.backlinks),
        referringPages: pages,
        followCount: pages !== null && nofollow !== null ? Math.max(0, pages - nofollow) : null,
        nofollowCount: nofollow,
        referringIps: numOrNull(r.referring_ips),
        referringSubnets: numOrNull(r.referring_subnets),
        country: strOrNull(r.top_country),
        spamScore: numOrNull(r.backlinks_spam_score),
        brokenBacklinks: numOrNull(r.broken_backlinks),
        firstSeen: parseProviderDate(r.first_seen),
        lostDate: parseProviderDate(r.lost_date),
        qualityMetrics: {
          quality: strOrNull(r.quality), dofollowPct: numOrNull(r.dofollow_pct), isSitewide: boolOrNull(r.is_sitewide),
          topCountry: strOrNull(r.top_country), mainPlacement: strOrNull(r.main_placement),
        },
        provider: { name: 'dataforseo', endpoint: 'backlinks/referring_domains/live' },
      };
    },
    fieldMap: {
      domain: { path: 'referringDomain' },
      rank: { path: 'domainRank' },
      backlinks_spam_score: { path: 'spamScore' },
      backlinks: { path: 'backlinksCount' },
      broken_backlinks: { path: 'brokenBacklinks' },
      first_seen: { path: 'firstSeen', kind: 'date' },
    },
    orderMap: {
      rank: 'domainRank', backlinks: 'backlinksCount', referring_pages: 'referringPages', backlinks_spam_score: 'spamScore', broken_backlinks: 'brokenBacklinks', first_seen: 'firstSeen',
    },
    defaultSort: { domainRank: -1 },
    identity: ['referringDomain'],
  },
});

/** Dataset-state snapshots (Phase 1's seo_snapshots): which scan is the latest COMPLETE set of each kind. */
export const STATE_PART = Object.freeze({ keywords: 'dataset:keywords', backlinks: 'dataset:backlinks', referringDomains: 'dataset:referring-domains' });
export const STATE_TYPE = Object.freeze({ keywords: 'organic_keyword_dataset', backlinks: 'backlink_dataset', referringDomains: 'referring_domain_dataset' });
export const SECTION_TO_KIND = Object.freeze({ 'ranked-keywords': 'keywords', 'backlinks-list': 'backlinks', 'referring-domains': 'referringDomains' });
