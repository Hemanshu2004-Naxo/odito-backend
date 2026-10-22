/**
 * Single source of truth for the STRUCTURED OUTPUT contract Claude must
 * return (spec §10/§11/§12).
 *
 * Built programmatically from the Phase 1 enums (aiCampaignEnums.js) and the
 * Phase 2 limits (generationConfig.js) so the schema can never drift from
 * what campaignStructureValidator.js will actually accept. Used two ways:
 *   1. As the Anthropic tool `input_schema` (native structured output).
 *   2. Rendered into the system prompt as a human-readable contract.
 *
 * The shape maps 1:1 onto the Phase 1 AiCampaignDraft `{ campaign, adGroups }`
 * input the campaignDraftService already accepts — there is no second
 * campaign structure here.
 */

import {
  CAMPAIGN_OBJECTIVES,
  BIDDING_STRATEGIES,
  LOCATION_TYPES,
  KEYWORD_MATCH_TYPES,
  AD_TYPES,
  RSA_LIMITS,
  ASSET_LIMITS,
  STRUCTURED_SNIPPET_HEADERS,
} from '../constants/aiCampaignEnums.js';
import { CAMPAIGN_LIMITS, RSA_QUALITY_TARGETS, ASSET_TARGETS } from '../constants/generationConfig.js';

export const TOOL_NAME = 'emit_campaign';

/**
 * JSON Schema (draft-07-ish subset Anthropic accepts) for the campaign the
 * model must emit. Objective / budget / currency / locations are included so
 * the model returns a complete object, but the generation service OVERRIDES
 * them from the validated brief afterwards — the model is never trusted to
 * set them (prompt-injection defence, spec §9/§13).
 */
export function buildCampaignToolSchema() {
  const keywordSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['text', 'matchType'],
    properties: {
      text: { type: 'string', minLength: 1, maxLength: 80, description: 'A single keyword phrase. No brackets, quotes, or match-type symbols.' },
      matchType: { type: 'string', enum: KEYWORD_MATCH_TYPES },
    },
  };

  const assetSchema = (maxChars, what) => ({
    type: 'object',
    additionalProperties: false,
    required: ['text'],
    properties: {
      text: { type: 'string', minLength: 1, maxLength: maxChars, description: `${what} — at most ${maxChars} characters, no line breaks.` },
    },
  });

  const adSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['type', 'headlines', 'descriptions'],
    properties: {
      type: { type: 'string', enum: AD_TYPES },
      // minItems is deliberately the QUALITY target, not Google's own raw
      // floor (RSA_LIMITS.HEADLINES_MIN=3) — Anthropic's structured-output
      // minItems is a strong nudge, not a hard guarantee, and a schema that
      // only asks for 3 will often get exactly 3. campaignStructureValidator.js
      // still accepts anything down to Google's real floor; this schema's
      // job is to bias generation toward Odito's own quality bar.
      headlines: {
        type: 'array',
        minItems: RSA_QUALITY_TARGETS.headlinesQualityMin,
        maxItems: RSA_LIMITS.HEADLINES_MAX,
        items: assetSchema(RSA_LIMITS.HEADLINE_MAX_CHARS, 'Headline'),
        description: `Aim for ${RSA_QUALITY_TARGETS.headlinesTarget} genuinely distinct headlines (never fewer than ${RSA_QUALITY_TARGETS.headlinesQualityMin}) — see the diversity categories in the system prompt.`,
      },
      descriptions: {
        type: 'array',
        minItems: RSA_QUALITY_TARGETS.descriptionsQualityMin,
        maxItems: RSA_LIMITS.DESCRIPTIONS_MAX,
        items: assetSchema(RSA_LIMITS.DESCRIPTION_MAX_CHARS, 'Description'),
        description: `Exactly ${RSA_QUALITY_TARGETS.descriptionsTarget} genuinely distinct descriptions.`,
      },
      path1: { type: 'string', maxLength: RSA_LIMITS.PATH_MAX_CHARS, description: 'Optional display-URL path segment.' },
      path2: { type: 'string', maxLength: RSA_LIMITS.PATH_MAX_CHARS, description: 'Optional second display-URL path segment.' },
    },
  };

  const adGroupSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'keywords', 'ads'],
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 120 },
      keywords: {
        type: 'array',
        minItems: CAMPAIGN_LIMITS.keywordsPerGroupMin,
        maxItems: CAMPAIGN_LIMITS.keywordsPerGroupMax,
        items: keywordSchema,
      },
      negativeKeywords: {
        type: 'array',
        maxItems: CAMPAIGN_LIMITS.negativeKeywordsMax,
        items: keywordSchema,
      },
      ads: {
        type: 'array',
        minItems: CAMPAIGN_LIMITS.adsPerGroupMin,
        maxItems: CAMPAIGN_LIMITS.adsPerGroupMax,
        items: adSchema,
        description: `Aim for ${RSA_QUALITY_TARGETS.adsPerGroupTarget} ads per ad group sharing the same strategic theme but with meaningfully different headline/description combinations — never trivial duplicates of each other.`,
      },
    },
  };

  return {
    type: 'object',
    additionalProperties: false,
    required: ['campaign', 'adGroups'],
    properties: {
      campaign: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'objective', 'biddingStrategy'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 255 },
          objective: { type: 'string', enum: CAMPAIGN_OBJECTIVES },
          biddingStrategy: { type: 'string', enum: BIDDING_STRATEGIES },
          languages: {
            type: 'array',
            maxItems: 5,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['code', 'name'],
              properties: {
                code: { type: 'string', pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$' },
                name: { type: 'string', minLength: 1, maxLength: 100 },
              },
            },
          },
          // Sitelinks deliberately have NO url/finalUrl field here — Claude
          // never chooses a sitelink's destination (spec §13: no invented
          // landing pages). Odito's mapper assigns each sitelink's finalUrl
          // from its own server-resolved list of already-trusted project
          // URLs (see sitelinkResolver.js), and truncates the array to
          // however many trusted URLs actually exist.
          sitelinks: {
            type: 'array',
            maxItems: ASSET_TARGETS.sitelinksTarget,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['text'],
              properties: {
                text: { type: 'string', minLength: 1, maxLength: ASSET_LIMITS.SITELINK_TEXT_MAX_CHARS, description: 'Short link label, e.g. "Contact Us" or "Our Services".' },
                description1: { type: 'string', maxLength: ASSET_LIMITS.SITELINK_DESCRIPTION_MAX_CHARS },
                description2: { type: 'string', maxLength: ASSET_LIMITS.SITELINK_DESCRIPTION_MAX_CHARS },
              },
            },
          },
          callouts: {
            type: 'array',
            maxItems: ASSET_TARGETS.calloutsTarget,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['text'],
              properties: {
                text: { type: 'string', minLength: 1, maxLength: ASSET_LIMITS.CALLOUT_TEXT_MAX_CHARS, description: 'A short, factual selling point, e.g. "Data Driven Strategy". Never an unverifiable claim.' },
              },
            },
          },
          structuredSnippets: {
            type: 'array',
            maxItems: 2,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['header', 'values'],
              properties: {
                header: { type: 'string', enum: STRUCTURED_SNIPPET_HEADERS },
                values: {
                  type: 'array',
                  minItems: ASSET_TARGETS.structuredSnippetValuesMin,
                  maxItems: ASSET_TARGETS.structuredSnippetValuesTarget,
                  items: { type: 'string', minLength: 1, maxLength: ASSET_LIMITS.SNIPPET_VALUE_MAX_CHARS },
                },
              },
            },
          },
        },
      },
      adGroups: {
        type: 'array',
        minItems: CAMPAIGN_LIMITS.adGroupsMin,
        maxItems: CAMPAIGN_LIMITS.adGroupsMax,
        items: adGroupSchema,
      },
    },
  };
}

/** A compact, human-readable rendering of the same contract for the prompt. */
export function renderOutputContractForPrompt() {
  const L = CAMPAIGN_LIMITS;
  const Q = RSA_QUALITY_TARGETS;
  const A = ASSET_TARGETS;
  return [
    `Return your result by calling the ${TOOL_NAME} tool. Its input MUST be an object with exactly two keys: "campaign" and "adGroups".`,
    ``,
    `campaign:`,
    `  - name: string (<=255 chars)`,
    `  - objective: one of ${CAMPAIGN_OBJECTIVES.join(' | ')}`,
    `  - biddingStrategy: one of ${BIDDING_STRATEGIES.join(' | ')}`,
    `  - languages: optional array of { code (e.g. "en"), name (e.g. "English") }`,
    `  - sitelinks: 0-${A.sitelinksTarget} of { text (<=${ASSET_LIMITS.SITELINK_TEXT_MAX_CHARS} chars), description1?, description2? (<=${ASSET_LIMITS.SITELINK_DESCRIPTION_MAX_CHARS} chars each) } — NO url field; Odito assigns the destination.`,
    `  - callouts: 0-${A.calloutsTarget} of { text (<=${ASSET_LIMITS.CALLOUT_TEXT_MAX_CHARS} chars) } — short factual selling points, never unverifiable claims.`,
    `  - structuredSnippets: 0-2 of { header: one of ${STRUCTURED_SNIPPET_HEADERS.join(' | ')}, values: ${A.structuredSnippetValuesMin}-${A.structuredSnippetValuesTarget} of string (<=${ASSET_LIMITS.SNIPPET_VALUE_MAX_CHARS} chars) }`,
    ``,
    `adGroups: array of ${L.adGroupsMin}-${L.adGroupsMax} objects, each:`,
    `  - name: string (<=120 chars)`,
    `  - keywords: ${L.keywordsPerGroupMin}-${L.keywordsPerGroupMax} of { text, matchType: ${KEYWORD_MATCH_TYPES.join(' | ')} }`,
    `  - negativeKeywords: 0-${L.negativeKeywordsMax} of { text, matchType }`,
    `  - ads: ${L.adsPerGroupMin}-${L.adsPerGroupMax} of (aim for ${Q.adsPerGroupTarget}) {`,
    `      type: "${AD_TYPES[0]}",`,
    `      headlines: ${Q.headlinesQualityMin}-${RSA_LIMITS.HEADLINES_MAX} of { text } (each text <=${RSA_LIMITS.HEADLINE_MAX_CHARS} chars) — AIM FOR ${Q.headlinesTarget}, every one meaningfully different,`,
    `      descriptions: exactly ${Q.descriptionsTarget} of { text } (each text <=${RSA_LIMITS.DESCRIPTION_MAX_CHARS} chars), every one meaningfully different,`,
    `      path1, path2: optional strings (<=${RSA_LIMITS.PATH_MAX_CHARS} chars)`,
    `    }`,
    ``,
    `Do NOT include: campaign budget, currency, locations, finalUrl, sitelink/callout urls, ad group ids, ad ids, status, version — Odito sets those from trusted data.`,
  ].join('\n');
}
