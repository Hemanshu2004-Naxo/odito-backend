import { DATAFORSEO_ERROR } from '../../dataforseo-api/shared/providerErrors.js';

/**
 * Pure rules for My Competitors SEO enrichment: provider payload -> stored section, section statuses -> overall status, and what the
 * browser is allowed to show. No I/O, so every rule here is unit-tested.
 *
 * The one rule that matters: a provider answer that means "I have nothing on this domain" is NOT a zero. DataForSEO answers some
 * endpoints with zeros or empty objects for an unknown domain, so each mapper decides explicitly between a real value (a number, zero
 * included) and "no data" (null). Nothing here ever turns a missing value into 0.
 */

export const SECTION_ERROR = Object.freeze({
  HEAD_TO_HEAD_NOT_CONFIGURED: 'HEAD_TO_HEAD_ENDPOINT_NOT_CONFIGURED',
  PROJECT_BUDGET: 'PROJECT_BUDGET_EXCEEDED',
  UNKNOWN: 'ENRICHMENT_ERROR',
});

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const sum = (...parts) => (parts.every((p) => p !== null) ? parts.reduce((a, b) => a + b, 0) : null);

/** `rank-overview` payload ({ organic, paid }) -> section. A domain the provider has no data for has organic: null. */
export function mapRankSection(payload) {
  const o = payload?.organic;
  if (!o || typeof o !== 'object') return { status: 'no_data', data: null };
  const pos1 = num(o.pos_1);
  const top3 = sum(pos1, num(o.pos_2_3));
  return {
    status: 'ok',
    data: {
      organic_traffic: num(o.etv),
      ranking_keywords: num(o.count),
      pos_1: pos1,
      top_3: top3,
      top_10: sum(top3, num(o.pos_4_10)),
      // The provider's position buckets, kept whole so a details view can draw the distribution without another call.
      positions: Object.fromEntries(['pos_1', 'pos_2_3', 'pos_4_10', 'pos_11_20', 'pos_21_30', 'pos_31_40', 'pos_41_50', 'pos_51_60', 'pos_61_70', 'pos_71_80', 'pos_81_90', 'pos_91_100'].map((k) => [k, num(o[k])])),
    },
  };
}

/**
 * `backlinks` summary payload -> section. The provider answers an unknown domain with zero counts; a domain it has really seen carries a
 * `first_seen` date. So zero counts WITHOUT a first_seen mean "no data", while zero counts WITH one are a real zero.
 */
export function mapBacklinksSection(payload) {
  if (!payload || typeof payload !== 'object') return { status: 'no_data', data: null };
  const backlinks = num(payload.backlinks);
  const referring = num(payload.referring_domains);
  const seen = typeof payload.first_seen === 'string' && payload.first_seen.length > 0;
  if (!seen && !backlinks && !referring) return { status: 'no_data', data: null };
  return {
    status: 'ok',
    data: {
      backlinks,
      referring_domains: referring,
      // DataForSEO's own 0-1000 link-strength score. It is NOT Domain Authority / Domain Rating and is never labelled as either.
      dataforseo_rank: num(payload.rank),
      first_seen: seen ? payload.first_seen : null,
    },
  };
}

/**
 * `domain_intersection` payload ({ sharedTotal, keywords }) -> section. These are THE SHARED keywords only: the keywords the project AND
 * this competitor both rank for. Not the competitor's total ranking keywords (rank section), and not either side's own-only keywords.
 *
 * A missing answer is never a zero:
 *   - the provider sent no total_count                                   -> no_data
 *   - total 0 while the competitor itself has no data (rank section)     -> no_data (we cannot tell "nothing shared" from "unknown domain")
 *   - total 0 for a competitor the provider knows                        -> ok, 0 (a real, honest zero)
 * `competitorHasData` is whether this competitor's rank section answered with values.
 */
export function mapSharedSection(payload, { competitorHasData = false } = {}) {
  const total = num(payload?.sharedTotal);
  if (total === null) return { status: 'no_data', data: null };
  if (total === 0 && !competitorHasData) return { status: 'no_data', data: null };
  const keywords = Array.isArray(payload.keywords) ? payload.keywords : [];
  return {
    status: 'ok',
    data: {
      shared_keywords: total,
      // The details view's list: the most-searched shared keywords, at most what was asked for. `shared_keywords` stays the provider's exact total.
      keywords,
      stored_keywords: keywords.length,
      truncated: total > keywords.length,
    },
  };
}

const TRANSIENT = new Set([
  DATAFORSEO_ERROR.RATE_LIMITED, DATAFORSEO_ERROR.TIMEOUT, DATAFORSEO_ERROR.NETWORK, DATAFORSEO_ERROR.UNAVAILABLE, DATAFORSEO_ERROR.MALFORMED_RESPONSE,
  // An operator problem (credits, auth), not the domain's: worth trying again later.
  DATAFORSEO_ERROR.AUTH, DATAFORSEO_ERROR.INSUFFICIENT_CREDITS, DATAFORSEO_ERROR.ACCOUNT_RESTRICTED,
]);

/** A thrown provider / budget error -> a safe code (never a message) and whether trying again can help. */
export function classifyFailure(err) {
  if (err?.name === 'ProviderBudgetExceeded' || err?.code === SECTION_ERROR.PROJECT_BUDGET) return { code: SECTION_ERROR.PROJECT_BUDGET, retryable: true, countsAsAttempt: false };
  const code = typeof err?.code === 'string' && err.code.length <= 60 ? err.code : SECTION_ERROR.UNKNOWN;
  return { code, retryable: TRANSIENT.has(code), countsAsAttempt: true };
}

/** The sections every competitor needs. Overall status looks at ALL of them, so a missing one can never hide behind the others. */
export const REQUIRED_SECTIONS = Object.freeze(['rank', 'backlinks', 'shared']);

/**
 * Overall status from the required sections (a section that is absent or `not_configured` counts as not answered):
 *   enriched = every required section has values        partial = some have values and some do not (failed, no data, or not fetched yet)
 *   no_data  = none has values, none failed (the provider knows nothing about this site)           failed = none has values and one failed
 */
export function overallStatus(sections) {
  const states = REQUIRED_SECTIONS.map((k) => sections?.[k]?.status ?? 'missing');
  const ok = states.filter((s) => s === 'ok').length;
  const failed = states.filter((s) => s === 'failed').length;
  if (ok === REQUIRED_SECTIONS.length) return 'enriched';
  if (ok > 0) return 'partial';
  if (failed > 0) return 'failed';
  return 'no_data';
}

const isStaleAt = (finishedAt, now, staleAfterMs) => (finishedAt ? now - new Date(finishedAt).getTime() > staleAfterMs : false);

/**
 * What the browser gets for one competitor's enrichment. Metrics are null unless their section really has values.
 * `status` is the stored status, or `not_started` for an older record that has a website but was never queued (nothing is fetched for it
 * until the user asks), or `no_website`. `stale` is derived from age.
 */
export function toEnrichmentDto(doc, { now = Date.now(), staleAfterMs = 14 * 24 * 60 * 60_000 } = {}) {
  const e = doc?.enrichment ?? null;
  const hasWebsite = typeof doc?.domain === 'string' && doc.domain.length > 0;
  const storedStatus = !hasWebsite ? 'no_website' : e?.status ?? 'not_started';
  // A record finished before every required section existed (older ones have no shared section) must not read as complete.
  const status = storedStatus === 'enriched' && REQUIRED_SECTIONS.some((k) => e?.sections?.[k]?.status !== 'ok') ? 'partial' : storedStatus;
  const section = (key) => {
    const s = e?.sections?.[key];
    return s ? { status: s.status, fetchedAt: s.fetched_at ?? null, errorCode: s.error_code ?? null } : null;
  };
  const rank = e?.sections?.rank?.status === 'ok' ? e.sections.rank.data : null;
  const links = e?.sections?.backlinks?.status === 'ok' ? e.sections.backlinks.data : null;
  const shared = e?.sections?.shared?.status === 'ok' ? e.sections.shared.data : null;
  const pick = (obj, key) => (obj && typeof obj[key] === 'number' ? obj[key] : null);
  return {
    status,
    requestedAt: e?.requested_at ?? null,
    finishedAt: e?.finished_at ?? null,
    lastSuccessAt: e?.last_success_at ?? null,
    attempts: e?.attempts ?? 0,
    nextAttemptAt: status === 'pending' ? e?.next_attempt_at ?? null : null,
    errorCode: e?.last_error_code ?? null,
    market: e?.market ? { location: e.market.location ?? null, language: e.market.language ?? null } : null,
    stale: status === 'enriched' || status === 'partial' ? isStaleAt(e?.last_success_at ?? e?.finished_at, now, staleAfterMs) : false,
    sections: { rank: section('rank'), backlinks: section('backlinks'), shared: section('shared') },
    metrics: {
      organicTraffic: pick(rank, 'organic_traffic'),
      rankingKeywords: pick(rank, 'ranking_keywords'),
      pos1: pick(rank, 'pos_1'),
      top3: pick(rank, 'top_3'),
      top10: pick(rank, 'top_10'),
      positions: rank?.positions ?? null,
      backlinks: pick(links, 'backlinks'),
      referringDomains: pick(links, 'referring_domains'),
      dataforseoRank: pick(links, 'dataforseo_rank'),
      // The keywords the project AND this competitor both rank for. null = not known (see sections.shared for why); 0 = really none shared.
      sharedKeywords: pick(shared, 'shared_keywords'),
      sharedStored: pick(shared, 'stored_keywords'),
      sharedTruncated: shared ? Boolean(shared.truncated) : null,
    },
  };
}
