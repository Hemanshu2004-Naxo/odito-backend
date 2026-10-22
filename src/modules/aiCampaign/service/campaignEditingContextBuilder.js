/**
 * Campaign EDITING context builder (Phase 4, spec §13).
 *
 * Produces the minimum campaign representation Claude needs to propose
 * edits to an EXISTING draft — deliberately NOT the raw Mongoose document.
 * Strictly an allow-list, same principle as campaignContextBuilder.js
 * (Phase 2), but built from a draft instead of a project + brief.
 *
 * DELIBERATELY EXCLUDED: _id, projectId, createdBy/updatedBy,
 * googleAdsCustomerId, status, version, aiMetadata, changes[], published
 * Google Ads identifiers, timestamps, isDeleted. `id` on ad groups/ads IS
 * included — Claude needs those to reference existing entities for
 * remove/replace, and they are draft-local correlation ids, not secrets.
 */

function safeText(v) {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

/**
 * @param {object} draft - an AiCampaignDraft document or plain object
 * @returns {{ campaign: object, adGroups: object[] }}
 */
export function buildEditingContext(draft) {
  const c = draft?.campaign || {};
  const loc = Array.isArray(c.locations) ? c.locations[0] : null;
  const lang = Array.isArray(c.languages) ? c.languages[0] : null;

  const campaign = {
    name: safeText(c.name),
    objective: safeText(c.objective),
    dailyBudget: c.dailyBudget != null ? c.dailyBudget : (c.dailyBudgetMicros != null ? c.dailyBudgetMicros / 1_000_000 : null),
    currency: safeText(c.currency),
    biddingStrategy: safeText(c.biddingStrategy),
    location: loc ? `${safeText(loc.name)}${loc.countryCode ? `, ${loc.countryCode}` : ''}` : null,
    language: lang ? safeText(lang.name) : null,
  };

  const adGroups = (Array.isArray(draft?.adGroups) ? draft.adGroups : []).map((ag) => ({
    id: ag.id,
    name: safeText(ag.name),
    keywords: (ag.keywords || []).map((k) => ({ text: safeText(k.text), matchType: safeText(k.matchType) })),
    negativeKeywords: (ag.negativeKeywords || []).map((k) => ({ text: safeText(k.text), matchType: safeText(k.matchType) })),
    ads: (ag.ads || []).map((ad) => ({
      id: ad.id,
      finalUrl: ad.finalUrl || null,
      headlines: (ad.headlines || []).map((h) => safeText(h.text)),
      descriptions: (ad.descriptions || []).map((d) => safeText(d.text)),
    })),
  }));

  return { campaign, adGroups };
}

export default { buildEditingContext };
