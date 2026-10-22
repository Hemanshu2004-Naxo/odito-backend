/**
 * Report-specific view models for the AEO / GEO / AISO hubs.
 *
 * The hub handlers return large dashboard payloads (full URL lists, every rule).
 * The report only needs a trimmed, named subset. Nothing here computes a score:
 * every number is copied from the hub response, and a missing value stays null.
 */

import { num } from './reportContract.js';

const SEV_RANK = { critical: 5, high: 4, medium: 3, warning: 3, low: 2, info: 1 };
const sevRank = (s) => SEV_RANK[String(s || '').toLowerCase()] || 0;
const clip = (s, n) => {
  if (s == null) return null;
  const t = String(s).trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

const dist = (d) =>
  d && typeof d === 'object'
    ? { total: num(d.total), critical: num(d.critical), high: num(d.high), medium: num(d.medium), low: num(d.low) }
    : null;

/** Trim a hub issue list (rule-level findings) to what the report prints. */
export function trimHubIssues(issues, { limit = 12, urlSample = 5 } = {}) {
  if (!Array.isArray(issues)) return null;
  return [...issues]
    .sort((a, b) => sevRank(b.severity) - sevRank(a.severity) || (num(b.pages_affected) || 0) - (num(a.pages_affected) || 0))
    .slice(0, limit)
    .map((i) => ({
      ruleId: i.rule_id ?? null,
      card: i.card ?? null,
      title: clip(i.issue_title, 120),
      description: clip(i.issue_description, 260),
      recommendation: clip(i.recommendation, 320),
      severity: i.severity ?? null,
      pagesAffected: num(i.pages_affected),
      totalUrls: Array.isArray(i.affected_urls) ? i.affected_urls.length : null,
      sampleUrls: Array.isArray(i.affected_urls) ? i.affected_urls.slice(0, urlSample) : [],
    }));
}

const cardView = (c) =>
  c && typeof c === 'object'
    ? { score: num(c.score), status: c.status ?? null, ruleCount: num(c.rule_count), failedChecks: num(c.total_failed), pagesScored: num(c.pages_scored) }
    : null;

export function aeoView(d) {
  const cards = d.cards || {};
  const sig = d.signals || {};
  const st = d.structure || {};
  return {
    score: num(d.aeo_score),
    pagesScored: num(d.pages_scored),
    computedAt: d.computed_at ?? null,
    cards: Object.fromEntries(Object.entries(cards).map(([k, v]) => [k, cardView(v)])),
    signals: Object.entries(sig).map(([key, v]) => ({
      key,
      ruleId: v?.rule_id ?? null,
      status: v?.status ?? null,
      score: num(v?.score),
      pagesFailing: num(v?.pages_failing),
      applicablePages: num(v?.applicable_pages),
    })),
    structure: {
      questionHeadings: num(st.question_coverage?.question_h2_sum),
      totalH2: num(st.question_coverage?.total_h2_sum),
      pagesWithFaqSchema: num(st.faq_intelligence?.pages_with_faq_schema),
      schemaQaTotal: num(st.faq_intelligence?.schema_qa_total),
      visibleQaTotal: num(st.faq_intelligence?.visible_qa_total),
      schemaMatchPercent: num(st.faq_intelligence?.schema_match_pct),
      pagesWithSpeakable: num(st.voice_readiness?.pages_speakable),
      speakableCoveragePercent: num(st.voice_readiness?.speakable_coverage_pct),
    },
    issueDistribution: dist(d.issue_distribution),
    faqOpportunities: (Array.isArray(d.faq_opportunities) ? d.faq_opportunities : []).slice(0, 6).map((o) => ({
      question: clip(o.question, 160),
      status: o.status ?? null,
      impact: o.impact ?? null,
      recommendation: clip(o.recommendation, 260),
      affectedUrlCount: num(o.affected_url_count),
    })),
  };
}

export function geoView(d) {
  return {
    score: num(d.geo_score),
    pagesScored: num(d.pages_scored),
    computedAt: d.computed_at ?? null,
    // A letter grade supplied by the hub itself (entity trust); not derived here.
    entityTrustGrade: d.entity_trust_score ?? null,
    validatedEntities: num(d.validated_entities),
    missingLinks: num(d.missing_links),
    cards: (Array.isArray(d.knowledge_graph_cards) ? d.knowledge_graph_cards : []).map((c) => ({
      id: c.id, label: c.label, score: num(c.score), passed: num(c.passed), failed: num(c.failed),
    })),
    validation: (Array.isArray(d.validation) ? d.validation : []).map((v) => ({
      id: v.id, label: v.label, status: v.status ?? null, description: clip(v.description, 160),
      pagesFailing: num(v.pages_failing), applicablePages: num(v.applicable_pages), score: num(v.score),
    })),
    schemaCoverage: (Array.isArray(d.schema_coverage) ? d.schema_coverage : []).map((s) => ({
      schemaType: s.schema_type, applicablePages: num(s.applicable_pages), pagesWithSchema: num(s.pages_with_schema),
      pagesMissingSchema: num(s.pages_missing_schema), coveragePercent: num(s.coverage_percent),
    })),
    opportunities: (Array.isArray(d.opportunities) ? d.opportunities : []).slice(0, 8).map((o) => ({
      priority: o.priority ?? null, title: clip(o.title, 120), description: clip(o.description, 260),
    })),
    issueDistribution: dist(d.issue_distribution),
  };
}

export function aisoView(d) {
  const h = d.hero || {};
  return {
    score: num(d.aiso_score),
    pagesScored: num(d.pages_scored),
    computedAt: d.computed_at ?? null,
    hero: { crawlability: num(h.crawlability), citability: num(h.citability), authority: num(h.authority), coverage: num(h.coverage) },
    bots: d.bots && typeof d.bots === 'object' ? { ...d.bots } : null,
    cards: Object.fromEntries(Object.entries(d.cards || {}).map(([k, v]) => [k, {
      score: num(v?.score), ruleCount: num(v?.rule_count), checksExecuted: num(v?.checks_executed),
      passed: num(v?.total_passed), failed: num(v?.total_failed),
    }])),
    issueDistribution: dist(d.issue_distribution),
  };
}

export const HUB_VIEWS = { aeo: aeoView, geo: geoView, aiso: aisoView };
