/**
 * Map Claude's structured output onto the Phase 1 AiCampaignDraft input
 * shape (`{ campaign, adGroups }` that campaignDraftService already accepts).
 *
 * This is where "never trust the model" is enforced (spec §9 / §12 / §13):
 *   - objective, dailyBudget, currency, locations, and every ad's finalUrl
 *     are taken from the VALIDATED BRIEF / project data — whatever the model
 *     put there is discarded.
 *   - biddingStrategy / languages are accepted only if they match the Phase
 *     1 enums, else a safe default.
 *   - counts are clamped to the generation limits.
 *   - ad type is forced to RESPONSIVE_SEARCH_AD.
 *
 * RSA text length (spec debugging note, 2026-09): Anthropic's tool-use
 * `maxLength` is a strong nudge, NOT a server-enforced guarantee — real
 * production traffic showed Claude consistently emitting RSA descriptions
 * a small amount (1-11 chars) over the 90-char Google Ads limit even with
 * explicit prompt guidance (generateCampaignPrompt.js v2), which made
 * EVERY ad group in a generation fail campaignStructureValidator's strict
 * check simultaneously. Odito's own validator/limits are unchanged and
 * remain the final, strict authority — but an asset that is a SMALL amount
 * over the limit is now trimmed here, deterministically, at a word
 * boundary where possible, to what the text already says (nothing
 * invented, nothing added) rather than failing the entire generation over
 * a few trailing characters. This is bounded, auditable (every trim is
 * recorded in the returned `truncations` array — lengths only, never the
 * text) and the caller (campaignGenerationService.js) logs it. Anything
 * that is NOT plain text length (missing fields, bad enums, too few
 * headlines, etc.) still fails generation exactly as before — nothing here
 * papers over a structural problem, only a text-length overage.
 */

import {
  KEYWORD_MATCH_TYPES,
  BIDDING_STRATEGIES,
  LANGUAGE_CODE_PATTERN,
  DEFAULT_AD_TYPE,
  RSA_LIMITS,
  ASSET_LIMITS,
  STRUCTURED_SNIPPET_HEADERS,
} from '../constants/aiCampaignEnums.js';
import {
  CAMPAIGN_LIMITS,
  DEFAULT_BIDDING_STRATEGY_BY_OBJECTIVE,
  DEFAULT_LANGUAGE,
  ASSET_TARGETS,
} from '../constants/generationConfig.js';
import { resolveTrustedSitelinkUrls } from './sitelinkResolver.js';

function str(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}
function clamp(arr, max) {
  return Array.isArray(arr) ? arr.slice(0, max) : [];
}
function normMatchType(v, fallback) {
  const t = str(v).toUpperCase();
  return KEYWORD_MATCH_TYPES.includes(t) ? t : fallback;
}

function mapKeyword(kw, fallbackMatch) {
  if (kw == null) return null;
  const text = typeof kw === 'string' ? str(kw) : str(kw.text);
  if (!text) return null;
  return { text, matchType: normMatchType(typeof kw === 'object' ? kw.matchType : null, fallbackMatch) };
}

/**
 * Deterministic, content-preserving trim to `maxChars`. Cuts at the last
 * word boundary within the budget when that still keeps at least 60% of
 * the allowed length (avoids losing so much that the result stops being a
 * complete thought); otherwise falls back to a hard character cut, which
 * still only ever REMOVES characters, never adds or rewrites any.
 */
function trimToLimit(text, maxChars) {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(' ');
  const candidate = lastSpace > maxChars * 0.6 ? slice.slice(0, lastSpace) : slice;
  return candidate.trim().replace(/[,;:\-–—]+$/, '').trim();
}

/**
 * @param {*} a - raw asset ({text} or a plain string)
 * @param {object} opts
 * @param {number} opts.maxChars
 * @param {object[]} opts.truncations - mutated in place: {path, originalLength, maxChars} entries (lengths only, never the text)
 * @param {string} opts.path - diagnostic path for this asset, e.g. "adGroups[0].ads[0].descriptions[1]"
 */
function mapAsset(a, { maxChars, truncations, path }) {
  const raw = typeof a === 'string' ? str(a) : a && typeof a === 'object' ? str(a.text) : '';
  if (!raw) return null;
  if (raw.length <= maxChars) return { text: raw };
  truncations.push({ path, originalLength: raw.length, maxChars });
  return { text: trimToLimit(raw, maxChars) };
}

function mapAd(ad, finalUrl, truncations, pathPrefix) {
  const src = ad && typeof ad === 'object' ? ad : {};
  return {
    type: DEFAULT_AD_TYPE, // forced — Phase 2 supports RSA only
    headlines: clamp(src.headlines, CAMPAIGN_LIMITS.headlinesPerAdMax)
      .map((h, i) => mapAsset(h, { maxChars: RSA_LIMITS.HEADLINE_MAX_CHARS, truncations, path: `${pathPrefix}.headlines[${i}]` }))
      .filter(Boolean),
    descriptions: clamp(src.descriptions, CAMPAIGN_LIMITS.descriptionsPerAdMax)
      .map((d, i) => mapAsset(d, { maxChars: RSA_LIMITS.DESCRIPTION_MAX_CHARS, truncations, path: `${pathPrefix}.descriptions[${i}]` }))
      .filter(Boolean),
    finalUrl, // forced from the brief / project, never from the model
    path1: mapPathSegment(src.path1, truncations, `${pathPrefix}.path1`),
    path2: mapPathSegment(src.path2, truncations, `${pathPrefix}.path2`),
  };
}

function mapPathSegment(v, truncations, path) {
  if (v == null || str(v) === '') return null;
  const asset = mapAsset(v, { maxChars: RSA_LIMITS.PATH_MAX_CHARS, truncations, path });
  return asset ? asset.text : null;
}

/** Same shape as mapPathSegment but for a generic optional bounded-length text field (sitelink description1/2). */
function mapOptionalText(v, maxChars, truncations, path) {
  if (v == null || str(v) === '') return null;
  const asset = mapAsset(v, { maxChars, truncations, path });
  return asset ? asset.text : null;
}

/**
 * Sitelinks (spec §12/§13): Claude supplies TEXT only — `finalUrl` is
 * ALWAYS assigned here from `trustedUrls`, one distinct URL per sitelink,
 * NEVER repeated (a repeated URL would fail creativeQualityValidator's
 * DUPLICATE_SITELINK_URL check downstream anyway) and NEVER invented. The
 * generated count is therefore hard-capped at `trustedUrls.length` — see
 * sitelinkResolver.js for why that is realistically 1-2 today, not 6.
 */
function mapSitelinks(rawSitelinks, trustedUrls, truncations) {
  const candidates = clamp(Array.isArray(rawSitelinks) ? rawSitelinks : [], ASSET_TARGETS.sitelinksTarget);
  const count = Math.min(candidates.length, trustedUrls.length);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const src = candidates[i] && typeof candidates[i] === 'object' ? candidates[i] : {};
    const textAsset = mapAsset(src.text, { maxChars: ASSET_LIMITS.SITELINK_TEXT_MAX_CHARS, truncations, path: `campaign.sitelinks[${i}].text` });
    if (!textAsset) continue; // no usable text — skip rather than invent a label
    out.push({
      text: textAsset.text,
      description1: mapOptionalText(src.description1, ASSET_LIMITS.SITELINK_DESCRIPTION_MAX_CHARS, truncations, `campaign.sitelinks[${i}].description1`),
      description2: mapOptionalText(src.description2, ASSET_LIMITS.SITELINK_DESCRIPTION_MAX_CHARS, truncations, `campaign.sitelinks[${i}].description2`),
      finalUrl: trustedUrls[i], // FORCED — never from Claude, see file header
    });
  }
  return out;
}

function mapCallouts(rawCallouts, truncations) {
  return clamp(Array.isArray(rawCallouts) ? rawCallouts : [], ASSET_TARGETS.calloutsTarget)
    .map((c, i) => mapAsset(c, { maxChars: ASSET_LIMITS.CALLOUT_TEXT_MAX_CHARS, truncations, path: `campaign.callouts[${i}]` }))
    .filter(Boolean);
}

/** Drops (never invents) an invalid/duplicate header or an under-filled snippet rather than guessing. */
function mapStructuredSnippets(rawSnippets) {
  const seenHeaders = new Set();
  const out = [];
  for (const raw of Array.isArray(rawSnippets) ? rawSnippets : []) {
    if (!raw || typeof raw !== 'object') continue;
    const header = str(raw.header);
    if (!STRUCTURED_SNIPPET_HEADERS.includes(header) || seenHeaders.has(header)) continue;
    const values = [...new Set(
      clamp(Array.isArray(raw.values) ? raw.values.map(str).filter(Boolean) : [], ASSET_TARGETS.structuredSnippetValuesTarget)
        .map((v) => (v.length > ASSET_LIMITS.SNIPPET_VALUE_MAX_CHARS ? trimToLimit(v, ASSET_LIMITS.SNIPPET_VALUE_MAX_CHARS) : v)),
    )];
    if (values.length < ASSET_TARGETS.structuredSnippetValuesMin) continue;
    seenHeaders.add(header);
    out.push({ header, values });
  }
  return out.slice(0, 2);
}

function mapAdGroup(ag, finalUrl, truncations, groupIndex) {
  const src = ag && typeof ag === 'object' ? ag : {};
  const pathPrefix = `adGroups[${groupIndex}]`;
  return {
    name: str(src.name),
    keywords: clamp(src.keywords, CAMPAIGN_LIMITS.keywordsPerGroupMax)
      .map((k) => mapKeyword(k, 'PHRASE'))
      .filter(Boolean),
    negativeKeywords: clamp(src.negativeKeywords, CAMPAIGN_LIMITS.negativeKeywordsMax)
      .map((k) => mapKeyword(k, 'BROAD'))
      .filter(Boolean),
    ads: clamp(src.ads, CAMPAIGN_LIMITS.adsPerGroupMax)
      .map((ad, i) => mapAd(ad, finalUrl, truncations, `${pathPrefix}.ads[${i}]`)),
  };
}

function mapLanguages(langs) {
  if (!Array.isArray(langs) || langs.length === 0) return [{ ...DEFAULT_LANGUAGE }];
  const out = [];
  for (const l of langs) {
    if (!l || typeof l !== 'object') continue;
    const code = str(l.code);
    const name = str(l.name);
    if (code && name && LANGUAGE_CODE_PATTERN.test(code)) out.push({ code, name });
  }
  return out.length ? out : [{ ...DEFAULT_LANGUAGE }];
}

/**
 * @param {object} args
 * @param {object} args.parsed   Claude's tool output ({ campaign, adGroups })
 * @param {object} args.brief    normalized brief (campaignBriefValidator)
 * @param {object} args.context  generation context (campaignContextBuilder)
 * @returns {{ campaign: object, adGroups: object[], truncations: object[], assetObservability: object }} Phase 1 draft input.
 *   `truncations` is empty unless one or more RSA headlines/descriptions/
 *   path segments arrived over their character limit and were deterministically
 *   trimmed — see mapAsset/trimToLimit above. Entries carry lengths only,
 *   never the text itself. `assetObservability` (spec §13/§30) reports
 *   sitelinksGenerated/sitelinksSkipped/sitelinkReason for logging.
 */
export function mapGeneratedCampaign({ parsed, brief, context }) {
  const gen = parsed && typeof parsed === 'object' ? parsed : {};
  const genCampaign = gen.campaign && typeof gen.campaign === 'object' ? gen.campaign : {};

  // The one URL every ad points at — the brief's landing page, else the
  // project website. Never the model's value.
  const finalUrl = brief.landingPageUrl || context?.project?.websiteUrl || null;

  const biddingStrategy = BIDDING_STRATEGIES.includes(str(genCampaign.biddingStrategy).toUpperCase())
    ? str(genCampaign.biddingStrategy).toUpperCase()
    : (DEFAULT_BIDDING_STRATEGY_BY_OBJECTIVE[brief.campaignGoal] || 'MAXIMIZE_CONVERSIONS');

  const truncations = [];
  const { urls: trustedSitelinkUrls, reason: sitelinkReason } = resolveTrustedSitelinkUrls({ brief, context });
  const sitelinks = mapSitelinks(genCampaign.sitelinks, trustedSitelinkUrls, truncations);
  const sitelinksTarget = ASSET_TARGETS.sitelinksTarget;

  const campaign = {
    name: str(genCampaign.name) || `${brief.businessName || context?.project?.name || 'Campaign'} — ${brief.location.name}`,
    // ── forced from trusted data ──
    objective: brief.campaignGoal,
    dailyBudget: brief.dailyBudget, // major units; campaignDraftService converts to micros
    currency: brief.currency,
    locations: [{ name: brief.location.name, countryCode: brief.location.countryCode, type: brief.location.type }],
    // ── model-suggested, enum-guarded ──
    biddingStrategy,
    languages: mapLanguages(genCampaign.languages),
    // ── campaign extension assets (never invented URLs/headers — see the
    //    dedicated mapper functions above) ──
    sitelinks,
    callouts: mapCallouts(genCampaign.callouts, truncations),
    structuredSnippets: mapStructuredSnippets(genCampaign.structuredSnippets),
  };

  const adGroups = clamp(gen.adGroups, CAMPAIGN_LIMITS.adGroupsMax)
    .map((ag, i) => mapAdGroup(ag, finalUrl, truncations, i));

  return {
    campaign,
    adGroups,
    truncations,
    assetObservability: {
      sitelinksGenerated: sitelinks.length,
      sitelinksSkipped: Math.max(0, sitelinksTarget - sitelinks.length),
      sitelinkReason: sitelinks.length < sitelinksTarget ? sitelinkReason : null,
      trustedUrlCount: trustedSitelinkUrls.length,
    },
  };
}

export default { mapGeneratedCampaign };
