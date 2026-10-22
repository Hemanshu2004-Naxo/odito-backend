import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import AiCampaignDraft from '../model/AiCampaignDraft.js';
import { validateCampaignDraftStructure } from '../validator/campaignStructureValidator.js';
import {
  MICROS_PER_UNIT,
  DRAFT_STATUSES,
  CHANGE_SOURCES,
  CHANGE_ACTIONS,
  AI_PROVIDERS,
  canTransitionDraftStatus,
} from '../constants/aiCampaignEnums.js';
import {
  NotFoundError,
  ValidationError,
  ConflictError,
} from '../../../utils/ErrorUtil.js';

/**
 * campaignDraftService — business logic + MongoDB access for the AI
 * Campaign Draft domain.
 *
 * Controllers stay thin: they do auth + response shaping only, everything
 * else is here (same split as leadService.js / taskService.js).
 *
 * PHASE 1 scope: createDraft / getDraft / listDrafts / updateDraft /
 * deleteDraft. `recordChange` and `transitionStatus` are the tested domain
 * primitives Phases 4 and 5/6 will build on — no route calls them yet.
 *
 * Security posture:
 *   - Every write goes through an explicit field ALLOW-LIST
 *     (normalizeCampaignInput / normalizeAdGroups). The client object is
 *     never spread into a document or a `$set`, so unknown/hostile keys and
 *     Mongo operators ($set, $where, …) cannot ride along (mass-assignment
 *     + operator-injection defence).
 *   - `sanitizeKeysDeep` strips `__proto__` / `constructor` / `prototype`
 *     from any free-form value (change before/after) — prototype-pollution
 *     defence.
 *   - Ownership is NOT checked here — it is enforced upstream by
 *     validateProjectAccess() / AuthUtil in the route+controller layer. The
 *     service is given an already-authorized projectId/userId.
 */

// ── helpers ────────────────────────────────────────────────────────────────

function toObjectId(id) {
  if (!id || !mongoose.isValidObjectId(id)) return null;
  return new mongoose.Types.ObjectId(id);
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Deep-clone a JSON-ish value while dropping prototype-pollution keys. */
function sanitizeKeysDeep(value, depth = 0) {
  if (depth > 12 || value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => sanitizeKeysDeep(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (UNSAFE_KEYS.has(k)) continue;
    out[k] = sanitizeKeysDeep(v, depth + 1);
  }
  return out;
}

function str(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

/**
 * Normalize a client-supplied budget into an integer number of micros.
 * Accepts `dailyBudgetMicros` (already micros) or `dailyBudget` (major
 * currency units, e.g. 1000 for ₹1,000). Never produces a float — the
 * result is Math.round()-ed to whole micros. Throws ValidationError on a
 * non-finite / non-positive amount.
 */
function resolveBudgetMicros(campaign) {
  const hasMicros = campaign.dailyBudgetMicros !== undefined && campaign.dailyBudgetMicros !== null;
  const hasMajor = campaign.dailyBudget !== undefined && campaign.dailyBudget !== null;

  if (!hasMicros && !hasMajor) {
    throw new ValidationError('campaign.dailyBudget (or campaign.dailyBudgetMicros) is required');
  }

  let micros;
  if (hasMicros) {
    micros = Number(campaign.dailyBudgetMicros);
    if (!Number.isFinite(micros) || !Number.isInteger(micros)) {
      throw new ValidationError('campaign.dailyBudgetMicros must be an integer number of micros');
    }
  } else {
    const major = Number(campaign.dailyBudget);
    if (!Number.isFinite(major)) {
      throw new ValidationError('campaign.dailyBudget must be a number');
    }
    micros = Math.round(major * MICROS_PER_UNIT);
  }

  if (micros < 1) {
    throw new ValidationError('campaign.dailyBudget must be greater than zero');
  }
  return micros;
}

// Value-object normalizers — each returns ONLY whitelisted keys.

function normalizeLocation(loc) {
  if (!loc || typeof loc !== 'object') return null;
  return {
    name: str(loc.name),
    countryCode: str(loc.countryCode).toUpperCase(),
    type: str(loc.type).toUpperCase(),
    region: loc.region != null ? str(loc.region) : null,
    postalCode: loc.postalCode != null ? str(loc.postalCode) : null,
  };
}

function normalizeLanguage(lang) {
  if (!lang || typeof lang !== 'object') return null;
  return { code: str(lang.code), name: str(lang.name) };
}

function normalizeKeyword(kw) {
  if (kw == null) return null;
  if (typeof kw === 'string') return { text: str(kw), matchType: 'BROAD' };
  return {
    text: str(kw.text),
    matchType: kw.matchType != null ? str(kw.matchType).toUpperCase() : 'BROAD',
  };
}

function normalizeAsset(asset, pinnedAllowed) {
  const text = typeof asset === 'string' ? asset : asset && typeof asset === 'object' ? asset.text : '';
  const out = { text: str(text) };
  const pinned = asset && typeof asset === 'object' ? asset.pinnedField : null;
  if (pinnedAllowed && pinned != null) out.pinnedField = str(pinned).toUpperCase();
  return out;
}

// Campaign-level extension assets (sitelinks/callouts/structured snippets —
// Phase 9, RSA/Ad-Strength quality work). Allow-list only, same discipline
// as every normalizer above; char-limit/header-enum/URL-trust enforcement
// stays campaignStructureValidator.js's job, not this layer's.
function normalizeSitelink(sl) {
  if (!sl || typeof sl !== 'object') return null;
  return {
    id: isStableId(sl.id) ? sl.id : randomUUID(),
    text: str(sl.text),
    description1: sl.description1 != null && str(sl.description1) !== '' ? str(sl.description1) : null,
    description2: sl.description2 != null && str(sl.description2) !== '' ? str(sl.description2) : null,
    finalUrl: sl.finalUrl != null ? str(sl.finalUrl) : '',
  };
}

function normalizeCallout(co) {
  if (co == null) return null;
  if (typeof co === 'string') return { id: randomUUID(), text: str(co) };
  if (typeof co !== 'object') return null;
  return { id: isStableId(co.id) ? co.id : randomUUID(), text: str(co.text) };
}

function normalizeStructuredSnippet(sn) {
  if (!sn || typeof sn !== 'object') return null;
  return {
    id: isStableId(sn.id) ? sn.id : randomUUID(),
    header: str(sn.header),
    values: Array.isArray(sn.values) ? sn.values.map((v) => str(v)).filter((v) => v !== '') : [],
  };
}

function normalizeAd(ad) {
  if (!ad || typeof ad !== 'object') return null;
  return {
    id: isStableId(ad.id) ? ad.id : randomUUID(),
    type: ad.type != null ? str(ad.type).toUpperCase() : 'RESPONSIVE_SEARCH_AD',
    headlines: Array.isArray(ad.headlines) ? ad.headlines.map((h) => normalizeAsset(h, true)) : [],
    descriptions: Array.isArray(ad.descriptions) ? ad.descriptions.map((d) => normalizeAsset(d, true)) : [],
    finalUrl: ad.finalUrl != null && str(ad.finalUrl) !== '' ? str(ad.finalUrl) : null,
    path1: ad.path1 != null ? str(ad.path1) : null,
    path2: ad.path2 != null ? str(ad.path2) : null,
  };
}

function isStableId(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= 64 && /^[A-Za-z0-9_-]+$/.test(v);
}

function normalizeAdGroups(adGroups) {
  if (adGroups === undefined) return undefined;
  if (!Array.isArray(adGroups)) throw new ValidationError('adGroups must be an array');
  return adGroups.map((ag) => {
    if (!ag || typeof ag !== 'object') throw new ValidationError('each ad group must be an object');
    return {
      id: isStableId(ag.id) ? ag.id : randomUUID(),
      name: str(ag.name),
      keywords: Array.isArray(ag.keywords) ? ag.keywords.map(normalizeKeyword).filter(Boolean) : [],
      negativeKeywords: Array.isArray(ag.negativeKeywords)
        ? ag.negativeKeywords.map(normalizeKeyword).filter(Boolean)
        : [],
      ads: Array.isArray(ag.ads) ? ag.ads.map(normalizeAd).filter(Boolean) : [],
    };
  });
}

/**
 * Build the persisted `campaign` sub-document from client input — allow-list
 * only, budget normalized to micros, codes upper-cased.
 */
function normalizeCampaignInput(campaign) {
  if (!campaign || typeof campaign !== 'object') {
    throw new ValidationError('campaign is required and must be an object');
  }
  return {
    name: str(campaign.name),
    objective: campaign.objective != null ? str(campaign.objective).toUpperCase() : undefined,
    dailyBudgetMicros: resolveBudgetMicros(campaign),
    currency: campaign.currency != null ? str(campaign.currency).toUpperCase() : undefined,
    biddingStrategy:
      campaign.biddingStrategy != null ? str(campaign.biddingStrategy).toUpperCase() : 'MAXIMIZE_CONVERSIONS',
    locations: Array.isArray(campaign.locations) ? campaign.locations.map(normalizeLocation).filter(Boolean) : [],
    languages: Array.isArray(campaign.languages) ? campaign.languages.map(normalizeLanguage).filter(Boolean) : [],
    sitelinks: Array.isArray(campaign.sitelinks) ? campaign.sitelinks.map(normalizeSitelink).filter(Boolean) : [],
    callouts: Array.isArray(campaign.callouts) ? campaign.callouts.map(normalizeCallout).filter(Boolean) : [],
    structuredSnippets: Array.isArray(campaign.structuredSnippets)
      ? campaign.structuredSnippets.map(normalizeStructuredSnippet).filter(Boolean)
      : [],
  };
}

function normalizeCustomerId(raw) {
  const cleaned = str(raw).replace(/[\s-]/g, '');
  if (!/^\d{10}$/.test(cleaned)) {
    throw new ValidationError('googleAdsCustomerId must be a 10-digit Google Ads customer ID (no dashes)');
  }
  return cleaned;
}

/**
 * Run the centralized structure validator and convert a failure into the
 * repo-standard typed ValidationError (with `.details`), so the controller's
 * existing handleError maps it to a 400.
 */
function assertValidStructure(draftLike, opts) {
  const result = validateCampaignDraftStructure(draftLike, opts);
  if (!result.valid) {
    throw new ValidationError('Campaign draft failed validation', result.errors);
  }
  return result;
}

// ── CRUD ───────────────────────────────────────────────────────────────────

/**
 * Create a draft. Always starts at status='draft', version=1. projectId and
 * userId are supplied by the (already-authorized) controller — the client's
 * body value for either is never trusted here.
 */
async function createDraft({ projectId, userId, googleAdsCustomerId, campaign, adGroups } = {}) {
  const pid = toObjectId(projectId);
  if (!pid) throw new ValidationError('Invalid projectId');
  const uid = toObjectId(userId);
  if (!uid) throw new ValidationError('Invalid user id');

  const customerId = normalizeCustomerId(googleAdsCustomerId);
  const normalizedCampaign = normalizeCampaignInput(campaign);
  const normalizedAdGroups = normalizeAdGroups(adGroups) ?? [];

  assertValidStructure(
    { campaign: normalizedCampaign, adGroups: normalizedAdGroups },
    { requireAdGroups: false, strictRsa: false },
  );

  const doc = await AiCampaignDraft.create({
    projectId: pid,
    createdBy: uid,
    updatedBy: uid,
    googleAdsCustomerId: customerId,
    status: 'draft',
    version: 1,
    campaign: normalizedCampaign,
    adGroups: normalizedAdGroups,
    aiMetadata: {},
    changes: [],
  });

  return doc;
}

async function getDraft(draftId) {
  const id = toObjectId(draftId);
  if (!id) throw new ValidationError('Invalid draft id');
  const draft = await AiCampaignDraft.findOne({ _id: id, isDeleted: { $ne: true } });
  if (!draft) throw new NotFoundError('Campaign draft not found');
  return draft;
}

async function listDrafts(projectId, { status, page = 1, limit = 20, sort = 'createdAt', sortOrder = 'desc' } = {}) {
  const pid = toObjectId(projectId);
  if (!pid) throw new ValidationError('Invalid projectId');

  if (status !== undefined && !DRAFT_STATUSES.includes(status)) {
    throw new ValidationError(`Invalid status. Must be one of: ${DRAFT_STATUSES.join(', ')}`);
  }

  const query = { projectId: pid, isDeleted: { $ne: true } };
  if (status) query.status = status;

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const skip = (pageNum - 1) * limitNum;
  const sortField = ['createdAt', 'updatedAt'].includes(sort) ? sort : 'createdAt';
  const sortDir = sortOrder === 'asc' ? 1 : -1;

  const [rows, total] = await Promise.all([
    AiCampaignDraft.find(query).sort({ [sortField]: sortDir }).skip(skip).limit(limitNum).lean(),
    AiCampaignDraft.countDocuments(query),
  ]);

  // `.lean()` skips schema virtuals in Mongoose 7, so re-derive the one the
  // single-draft (non-lean) responses expose, to keep the response shape
  // consistent between GET list and GET :id.
  const drafts = rows.map((d) => {
    if (d.campaign && typeof d.campaign.dailyBudgetMicros === 'number') {
      d.campaign.dailyBudget = d.campaign.dailyBudgetMicros / MICROS_PER_UNIT;
    }
    return d;
  });

  return {
    drafts,
    pagination: {
      page: pageNum,
      limit: limitNum,
      total,
      totalPages: Math.max(1, Math.ceil(total / limitNum)),
    },
  };
}

/**
 * Update safe draft fields. Phase 1 permits: the whole `campaign`
 * sub-document, the whole `adGroups` array, and `googleAdsCustomerId`.
 * Everything else (status, version, createdBy/At, aiMetadata, changes,
 * published Google Ads ids, projectId) is immutable here — the request
 * validator already 400s on those, and this allow-list is the belt-and-
 * braces backstop.
 *
 * The merged result is re-validated through the structure validator before
 * it is written.
 */
async function updateDraft(draftId, { updates = {}, userId } = {}) {
  const draft = await getDraft(draftId);

  const $set = { updatedBy: toObjectId(userId) || null };

  if (updates.campaign !== undefined) {
    $set.campaign = normalizeCampaignInput(updates.campaign);
  }
  if (updates.adGroups !== undefined) {
    $set.adGroups = normalizeAdGroups(updates.adGroups);
  }
  if (updates.googleAdsCustomerId !== undefined) {
    $set.googleAdsCustomerId = normalizeCustomerId(updates.googleAdsCustomerId);
  }

  const hasRealChange = ['campaign', 'adGroups', 'googleAdsCustomerId'].some((k) => k in $set);
  if (!hasRealChange) {
    throw new ValidationError('No updatable fields provided');
  }

  // Validate the resulting draft as a whole.
  assertValidStructure(
    {
      campaign: $set.campaign ?? draft.campaign.toObject(),
      adGroups: $set.adGroups ?? draft.adGroups.map((a) => a.toObject()),
    },
    { requireAdGroups: false, strictRsa: false },
  );

  // Bump `version` on every accepted manual edit (Phase 4, spec §9). This is
  // the optimistic-concurrency fingerprint a Claude change proposal records
  // as its `baseVersion` — an in-flight proposal generated before this edit
  // must be detected as stale once the user accepts it, and a manual edit
  // is exactly the case that must invalidate it. Phase 1 only bumped
  // version via transitionStatus(); every structural draft write bumps it
  // now, matching the model's own doc comment ("every accepted modification
  // to the draft should eventually be able to increment the version").
  $set.version = draft.version + 1;

  const updated = await AiCampaignDraft.findOneAndUpdate(
    { _id: draft._id, isDeleted: { $ne: true } },
    { $set },
    { new: true, runValidators: true },
  );
  if (!updated) throw new NotFoundError('Campaign draft not found');
  return updated;
}

// Statuses whose drafts are safe to (soft-) delete. A published campaign
// representation is deliberately NOT deletable through this API (spec §24);
// tearing down a live campaign needs an explicit Phase 6 decision.
const DELETABLE_STATUSES = ['draft', 'failed'];

async function deleteDraft(draftId) {
  const draft = await getDraft(draftId);
  if (!DELETABLE_STATUSES.includes(draft.status)) {
    throw new ConflictError(
      `A draft in status "${draft.status}" cannot be deleted. Only ${DELETABLE_STATUSES.join(' / ')} drafts are deletable.`,
    );
  }
  draft.isDeleted = true;
  draft.deletedAt = new Date();
  await draft.save();
  return draft;
}

// ── Domain primitives for later phases (tested, not route-wired yet) ────────

/**
 * Append an entry to a draft's change history. Phase 4 (AI conversational
 * editing) is the first caller. `before`/`after` are sanitised against
 * prototype pollution and can be any JSON-ish value.
 */
async function recordChange(draftId, { source, action, path, before = null, after = null, userId = null } = {}) {
  const draft = await getDraft(draftId);

  if (!CHANGE_SOURCES.includes(source)) {
    throw new ValidationError(`change.source must be one of: ${CHANGE_SOURCES.join(', ')}`);
  }
  if (!CHANGE_ACTIONS.includes(action)) {
    throw new ValidationError(`change.action must be one of: ${CHANGE_ACTIONS.join(', ')}`);
  }
  if (typeof path !== 'string' || path.trim() === '') {
    throw new ValidationError('change.path is required');
  }

  const entry = {
    id: randomUUID(),
    source,
    action,
    path: path.trim(),
    before: sanitizeKeysDeep(before),
    after: sanitizeKeysDeep(after),
    createdBy: toObjectId(userId) || null,
    createdAt: new Date(),
  };

  draft.changes.push(entry);
  await draft.save();
  return draft;
}

/**
 * Move a draft to a new status, rejecting any transition not permitted by
 * the status machine in aiCampaignEnums.js. No Phase 1 route calls this —
 * Phases 2/5/6 will. Optionally bumps `version` (used when an accepted
 * revision changes the draft's shape).
 */
async function transitionStatus(draftId, nextStatus, { bumpVersion = false } = {}) {
  const draft = await getDraft(draftId);
  if (!DRAFT_STATUSES.includes(nextStatus)) {
    throw new ValidationError(`Unknown status "${nextStatus}"`);
  }
  if (!canTransitionDraftStatus(draft.status, nextStatus)) {
    throw new ValidationError(`Invalid status transition: ${draft.status} → ${nextStatus}`);
  }
  draft.status = nextStatus;
  if (bumpVersion) draft.version += 1;
  await draft.save();
  return draft;
}

const MAX_AI_ERROR_MESSAGE_LEN = 300;

/**
 * Persist AI-generation provenance onto a draft's `aiMetadata` (Phase 2).
 * Written through an explicit allow-list — the caller can never set arbitrary
 * document fields this way. Does NOT change `status` (the generation service
 * calls transitionStatus separately, so a draft only becomes `ready` once
 * everything — including this write — has succeeded).
 *
 * @param {string} draftId
 * @param {object} meta
 * @param {'CLAUDE'|'OPENAI'|'GEMINI'} meta.provider
 * @param {string} meta.model
 * @param {string} meta.promptVersion
 * @param {string} meta.generationId
 * @param {{inputTokens?:number,outputTokens?:number}} [meta.usage]
 * @param {number} [meta.generationDurationMs]
 */
async function recordAiGeneration(draftId, {
  provider, model, promptVersion, generationId, usage = null, generationDurationMs = null,
} = {}) {
  const draft = await getDraft(draftId);

  if (!AI_PROVIDERS.includes(provider)) {
    throw new ValidationError(`aiMetadata.provider must be one of: ${AI_PROVIDERS.join(', ')}`);
  }

  const $set = {
    'aiMetadata.provider': provider,
    'aiMetadata.model': model ? String(model).slice(0, 200) : null,
    'aiMetadata.promptVersion': promptVersion ? String(promptVersion).slice(0, 100) : null,
    'aiMetadata.generationId': generationId ? String(generationId).slice(0, 100) : null,
    'aiMetadata.generatedAt': new Date(),
  };
  if (usage && typeof usage === 'object') {
    $set['aiMetadata.usage.inputTokens'] = Number.isFinite(usage.inputTokens) ? usage.inputTokens : null;
    $set['aiMetadata.usage.outputTokens'] = Number.isFinite(usage.outputTokens) ? usage.outputTokens : null;
  }
  if (Number.isFinite(generationDurationMs)) {
    $set['aiMetadata.generationDurationMs'] = generationDurationMs;
  }

  const updated = await AiCampaignDraft.findOneAndUpdate(
    { _id: draft._id, isDeleted: { $ne: true } },
    { $set },
    { new: true, runValidators: true },
  );
  if (!updated) throw new NotFoundError('Campaign draft not found');
  return updated;
}

/**
 * Record a SAFE, classified failure on a draft's `aiMetadata.lastError`
 * (Phase 2). Never stores a raw provider error, stack trace, or payload.
 */
async function recordAiGenerationError(draftId, { generationId = null, code = null, message = null } = {}) {
  const draft = await getDraft(draftId);
  const $set = {
    'aiMetadata.lastError.code': code ? String(code).slice(0, 100) : 'UNKNOWN',
    'aiMetadata.lastError.message': message ? String(message).slice(0, MAX_AI_ERROR_MESSAGE_LEN) : null,
    'aiMetadata.lastError.generationId': generationId ? String(generationId).slice(0, 100) : null,
    'aiMetadata.lastError.at': new Date(),
  };
  const updated = await AiCampaignDraft.findOneAndUpdate(
    { _id: draft._id, isDeleted: { $ne: true } },
    { $set },
    { new: true },
  );
  if (!updated) throw new NotFoundError('Campaign draft not found');
  return updated;
}

/**
 * Atomically apply an already-validated, already-normalized campaign result
 * onto a draft — Phase 4's ONLY write path for accepting a change proposal.
 * Callers (campaignProposalService) do all the domain work (apply changes
 * in memory, re-normalize, re-validate with the strict structure validator)
 * and hand this the final `{ campaign, adGroups }` plus the audit log
 * entries to append; this function's only job is the ATOMIC, RACE-FREE
 * persistence step.
 *
 * Optimistic concurrency control: the filter requires
 * `version: expectedVersion` (the draft's version when the proposal was
 * generated / last confirmed fresh). If the draft changed in the meantime
 * (a manual edit, or another proposal accepted first), `version` no longer
 * matches, the filter matches zero documents, and this throws ConflictError
 * — never a silent lost update. `version` is bumped to `expectedVersion + 1`
 * in the SAME write, and the change-log entries are appended in the SAME
 * write (`$push` alongside `$set`) — one document, one atomic Mongo
 * operation. No multi-document transaction is needed because this touches
 * exactly one document (spec §11's "atomic acceptance" is satisfied by
 * MongoDB's own single-document write atomicity + this version guard, not
 * by a transaction).
 *
 * @param {string} draftId
 * @param {object} args
 * @param {object} args.campaign        normalized campaign sub-document
 * @param {object[]} args.adGroups      normalized ad groups array
 * @param {number} args.expectedVersion the draft's version this result was computed against
 * @param {string} args.userId
 * @param {object[]} [args.changeLogEntries] entries to $push onto `changes[]`
 *        (already shaped per the changeSchema: {id,source,action,path,before,after,createdBy,createdAt})
 * @returns {Promise<object>} the updated draft
 * @throws {ConflictError} when `version` no longer matches `expectedVersion`
 *         (stale — someone else changed the draft first)
 */
async function applyValidatedChanges(draftId, { campaign, adGroups, expectedVersion, userId, changeLogEntries = [] } = {}) {
  const id = toObjectId(draftId);
  if (!id) throw new ValidationError('Invalid draft id');
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new ValidationError('expectedVersion must be a positive integer');
  }

  const update = {
    $set: {
      campaign,
      adGroups,
      updatedBy: toObjectId(userId) || null,
      version: expectedVersion + 1,
    },
  };
  if (changeLogEntries.length > 0) {
    update.$push = { changes: { $each: changeLogEntries } };
  }

  const updated = await AiCampaignDraft.findOneAndUpdate(
    { _id: id, version: expectedVersion, isDeleted: { $ne: true } },
    update,
    { new: true, runValidators: true },
  );
  if (!updated) {
    // Either the draft doesn't exist, or (far more likely, since the
    // controller already loaded it) its version moved on — stale.
    const stillExists = await AiCampaignDraft.exists({ _id: id, isDeleted: { $ne: true } });
    if (!stillExists) throw new NotFoundError('Campaign draft not found');
    throw new ConflictError('This campaign draft has changed since this proposal was generated.');
  }
  return updated;
}

export default {
  createDraft,
  getDraft,
  listDrafts,
  updateDraft,
  deleteDraft,
  recordChange,
  transitionStatus,
  recordAiGeneration,
  recordAiGenerationError,
  applyValidatedChanges,
  // exported for unit tests / later-phase reuse
  _internals: {
    normalizeCampaignInput,
    normalizeAdGroups,
    normalizeAd,
    normalizeAsset,
    normalizeSitelink,
    normalizeCallout,
    normalizeStructuredSnippet,
    resolveBudgetMicros,
    sanitizeKeysDeep,
    DELETABLE_STATUSES,
  },
};
