import os from 'os';
import crypto from 'crypto';
import mongoose from 'mongoose';
import SocialPublication from '../../model/SocialPublication.js';
import SocialAIStrategy from '../../model/SocialAIStrategy.js';
import SocialDesignGeneration from '../../model/SocialDesignGeneration.js';
import SocialContentCalendarItem from '../../model/SocialContentCalendarItem.js';
import SocialProduct from '../../model/SocialProduct.js';
import { getActiveFacebookAccount, getActiveInstagramAccount } from '../facebookAccountService.js';
import { findProfile } from '../socialBusinessProfileService.js';
import { resolveSocialBusinessProfile } from '../socialBusinessProfileResolver.js';
import { buildProfileData } from '../aiStrategy/profileSnapshot.js';
import { attachGeneratedDesign, submitDesignForApproval, getPublication } from '../socialPublishingService.js';
import mediaStorageService from '../media/mediaStorageService.js';
import { PROVIDER_FAILURE_CODE } from '../aiContent/providers/contentProviderErrors.js';
import { getDefaultImageProvider } from './providers/index.js';
import { IMAGE_REFUSED } from './providers/openAIImageProvider.js';
import { processAndStoreDesign, prepareReferenceImage, prepareLogo } from './designMedia.js';
import { buildDesignRequest, DESIGN_PROMPT_VERSION } from './designBrief.js';
import { produceDesign } from './designProducer.js';
import { CREATIVE_TYPES } from './designStrategy.js';
import { DESIGN_STALE_MS, PLATFORM_DESIGN, MAX_REFERENCE_IMAGES } from './designConfig.js';
import { LoggerUtil } from '../../../../utils/LoggerUtil.js';

/**
 * socialDesignGenerationService - ONE AI design (image) for ONE approved publication, attached to that
 * publication and submitted through the EXISTING design approval.
 *
 *   validate (publication belongs to the project, content is APPROVED, content version is the one the user saw,
 *             platform connected, nothing already generating)
 *     -> claim (database-enforced: one generation in flight per publication)  -> 202
 *     -> background: server-built brief -> image provider -> inspect / re-encode / validate / store
 *     -> attachGeneratedDesign (ONE conditional update pinned to content+design version and approval state)
 *     -> submitDesignForApproval (content_approved -> design_review, the workflow's own transition)
 *
 * The image prompt is not "a picture of the topic": the service gathers the real inputs (the calendar plan the post came from,
 * the real product photos, the real logo, the brand kit, the project's recent creative types), designStrategy.js chooses the
 * creative type and builds a structured brief, designBrief.js renders it, and the provider draws the creative. The real logo is
 * composited afterwards by designMedia.js; it is never drawn by the model.
 *
 * What this service never does: call Meta, schedule, publish, approve, set an approval state itself, trust a
 * client-supplied version/state/account/platform, store a prompt or a provider response, or let a stale run
 * attach media. The state machine is the existing one (approvalWorkflow.js); the versioning is the existing
 * one (planEditEffects, used inside attachGeneratedDesign).
 */

const INSTANCE = `${os.hostname()}:${process.pid}`;
const toId = (id) => (mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : id);
const iso = (d) => (d ? new Date(d).toISOString() : null);
const fail = (code, message, extra = {}) => ({ success: false, error: { code, message, ...extra } });
const EVENT = '[SOCIAL_AI_DESIGN]';

// ── provider seam ────────────────────────────────────────────────────────────

// The service depends on a provider CONTRACT - isAvailable(), generateImage({ prompt, size }) - never on a vendor.
// Which provider draws images is decided in ./providers/index.js.
let _providerOverride = null;
/** Test seam only: substitute the image provider (same contract). Production never sets it. */
export function setDesignProviderOverride(provider) { _providerOverride = provider || null; }
export function resetDesignProviderOverride() { _providerOverride = null; }
const getProvider = () => _providerOverride || getDefaultImageProvider();
/** The same provider (and the same test seam) for Creative Studio (socialDesignStudioService). */
export const getDesignProvider = () => getProvider();

// ── failures (user-safe; never a provider message, prompt, key or file path) ─

export const DESIGN_FAILURE_MESSAGES = Object.freeze({
  AI_UNAVAILABLE: 'This design needs an AI-generated photograph, and AI image generation is not available right now. Designs without a photograph (lists, statistics, quotes) can still be created. Please try again later.',
  AI_BUSY: 'The AI service is busy right now. Please try again in a few minutes.',
  AI_TIMEOUT: 'The AI took too long to draw the design. Please try again.',
  AI_UNREACHABLE: 'Odito could not reach the AI service. Please try again.',
  AI_BAD_OUTPUT: 'The AI did not return a usable image. Please try again.',
  DESIGN_REJECTED: 'The AI provider declined to draw this image. Try again, or upload your own design.',
  MEDIA_INVALID: 'The generated image did not meet the platform\'s requirements. Please try again.',
  STORAGE_FAILED: 'The design was created but could not be saved. Please try again.',
  DESIGN_STALE: 'The post changed while the design was being generated, so the new design was discarded. Generate it again from the latest version.',
  DESIGN_SUBMIT_FAILED: 'The design was added to the post but could not be submitted for review. Submit it from Content Approvals.',
  PLATFORM_NOT_CONNECTED: 'That account is no longer connected. Reconnect it and try again.',
  GENERATION_INTERRUPTED: 'Design generation was interrupted. Please try again.',
  DESIGN_BRIEF_INVALID: 'Odito could not build a safe design brief for this post. Try again, or upload your own design.',
  // the caption has nothing to build a headline from (too short, only emoji or a link, or one long run of filler)
  DESIGN_NEEDS_TEXT: 'This post has no clear sentence Odito can use as the design\'s headline. Add a short opening sentence of a few real words (the post will need approving again), or upload your own design.',
  // the layout could not show everything the post needs (a text missing, empty or not fitting), or the finished picture was blank: nothing was saved
  DESIGN_COMPOSE_FAILED: 'Odito could not lay this post out as a complete design, so nothing was saved and your current design is unchanged. Try again, or upload your own design.',
  GENERATION_FAILED: 'Design generation failed. Please try again.',
});

/** Why a brief was refused, as a failure code: a missing headline has its own plain message; every other problem is the general one. */
export const briefFailureCode = (problems) => ((problems || []).some((p) => p === 'no headline') ? 'DESIGN_NEEDS_TEXT' : 'DESIGN_BRIEF_INVALID');

export function designFailureFor(error) {
  const code = error?.code;
  let key = 'GENERATION_FAILED';
  if (code === IMAGE_REFUSED) key = 'DESIGN_REJECTED';
  else if (PROVIDER_FAILURE_CODE[code]) key = PROVIDER_FAILURE_CODE[code];
  else if (DESIGN_FAILURE_MESSAGES[code]) key = code;
  return { code: key, message: DESIGN_FAILURE_MESSAGES[key] };
}

// ── read model ───────────────────────────────────────────────────────────────

export function toApiGeneration(rec, { currentUrl = null } = {}) {
  return {
    id: String(rec._id),
    mode: rec.mode || 'single',
    publicationId: String(rec.publication_id),
    status: rec.status,
    platform: rec.platform,
    contentVersion: rec.contentVersion,
    designVersion: rec.status === 'ready' ? (rec.result?.designVersion ?? null) : null,
    // which creative direction was chosen, and which real assets were used (codes and counts only - never any text of the post)
    // Creative Studio: the candidate designs of this generation (files in project storage; NOT yet the post's design unless `attached`)
    candidates: rec.mode === 'studio' ? (rec.candidates || []).map((c) => toApiCandidate(c, { currentUrl })) : undefined,
    creative: rec.creative?.type ? { type: rec.creative.type, label: rec.creative.label || null, layoutId: rec.creative.layoutId || null, logoApplied: !!rec.creative.logoApplied, referencePhotos: rec.creative.referencePhotos || 0, notes: [...(rec.creative.notes || [])] } : null,
    startedAt: iso(rec.generation?.startedAt),
    finishedAt: iso(rec.generation?.finishedAt),
    failure: rec.status === 'failed' ? { code: rec.failure?.code || 'GENERATION_FAILED', message: rec.failure?.message || DESIGN_FAILURE_MESSAGES.GENERATION_FAILED } : null,
  };
}

/** One Creative Studio candidate as the API shows it: the image URL, the creative direction, its state - never a storage key or a prompt. */
export function toApiCandidate(c, { currentUrl = null } = {}) {
  return {
    id: String(c._id),
    slot: c.slot,
    creativeType: c.creativeType || null,
    layoutId: c.layoutId || null,
    label: c.label || null,
    status: c.status,
    revision: c.revision || 1,
    imageUrl: c.status === 'ready' ? (c.media?.url || null) : null,
    width: c.media?.width ?? null,
    height: c.media?.height ?? null,
    logoApplied: !!c.logoApplied,
    referencePhotos: c.referencePhotos || 0,
    notes: [...(c.notes || [])],
    instruction: c.instruction || null,
    failure: c.status === 'failed' ? { code: c.failure?.code || 'GENERATION_FAILED', message: c.failure?.message || DESIGN_FAILURE_MESSAGES.GENERATION_FAILED } : null,
    attached: !!c.attached,
    // the post's design right now: this candidate was attached AND the post still carries exactly this image
    current: !!c.attached && !!currentUrl && c.media?.url === currentUrl,
    attachedDesignVersion: c.attachedDesignVersion ?? null,
    generatedAt: iso(c.generatedAt),
  };
}

/** Fails any generation that has been in flight longer than DESIGN_STALE_MS (process died / provider hung). */
export async function recoverStaleDesignGenerations(projectId, { publicationId = null, now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - DESIGN_STALE_MS);
  const filter = { project_id: toId(projectId), active: true, 'generation.startedAt': { $lt: cutoff } };
  if (publicationId) filter.publication_id = toId(publicationId);
  const stale = await SocialDesignGeneration.find(filter).select('_id publication_id').lean();
  if (!stale.length) return 0;
  const result = await SocialDesignGeneration.updateMany(
    { _id: { $in: stale.map((s) => s._id) }, active: true },
    { $set: { status: 'failed', active: false, 'generation.finishedAt': now, failure: { code: 'GENERATION_INTERRUPTED', message: DESIGN_FAILURE_MESSAGES.GENERATION_INTERRUPTED, at: now } } },
  );
  for (const s of stale) LoggerUtil.warn(`${EVENT} design_generation_stale`, { event: 'design_generation_stale', projectId: String(projectId), publicationId: String(s.publication_id), generationId: String(s._id) });
  return result.modifiedCount;
}

/**
 * Status of one generation (by id) or, without an id, the publication's most recent one - plus the REAL
 * publication (media, design version, approval state), re-read now. 404 for a publication that is not in the project.
 */
export async function getDesignGenerationStatus(projectId, { publicationId, generationId = null, now = new Date() } = {}) {
  if (!mongoose.Types.ObjectId.isValid(publicationId)) return fail('NOT_FOUND', 'That publication was not found.');
  const publication = await getPublication(projectId, publicationId);
  if (!publication) return fail('NOT_FOUND', 'That publication was not found.');
  await recoverStaleDesignGenerations(projectId, { publicationId, now });

  let rec;
  if (generationId) {
    if (!mongoose.Types.ObjectId.isValid(generationId)) return fail('NOT_FOUND', 'That generation was not found.');
    rec = await SocialDesignGeneration.findOne({ _id: generationId, project_id: toId(projectId), publication_id: toId(publicationId) }).lean();
    if (!rec) return fail('NOT_FOUND', 'That generation was not found.');
  } else {
    rec = await SocialDesignGeneration.findOne({ project_id: toId(projectId), publication_id: toId(publicationId) }).sort({ createdAt: -1 }).lean();
  }
  const status = rec ? (rec.active ? 'generating' : rec.status) : 'none';
  return { success: true, status, generation: rec ? toApiGeneration(rec) : null, publication };
}

// ── starting a generation ────────────────────────────────────────────────────

export const DESIGNABLE_STATES = ['content_approved', 'design_review', 'design_approved'];

export async function activeAccountFor(projectId, platform) {
  return platform === 'facebook' ? getActiveFacebookAccount(projectId) : getActiveInstagramAccount(projectId);
}

/**
 * Validates the request, claims the work and (by default) runs it in the background.
 *
 * @param {object} input  { publicationId, contentVersion, replaceApproved } - nothing else is read from the client
 * @param {object} [options]
 * @param {boolean} [options.background=true]  false awaits the whole run (tests)
 */
export async function startDesignGeneration(projectId, userId, input = {}, { now = new Date(), background = true } = {}) {
  const { publicationId } = input || {};
  const contentVersion = input?.contentVersion;
  const replaceApproved = input?.replaceApproved === true;

  if (typeof publicationId !== 'string' || !mongoose.Types.ObjectId.isValid(publicationId)) return fail('INVALID_PUBLICATION', 'publicationId is required.');
  if (!Number.isInteger(contentVersion) || contentVersion < 1) return fail('INVALID_VERSION', 'contentVersion (the content version you are designing for) is required.');

  // The publication must belong to THIS project; another project's id is simply "not found".
  const pub = await SocialPublication.findOne({ _id: toId(publicationId), project_id: toId(projectId) }).lean();
  if (!pub) return fail('NOT_FOUND', 'That publication was not found.');

  if (pub.status !== 'draft') return fail('DESIGN_NOT_ALLOWED', `A design can only be generated for a draft (this post is ${pub.status}).`);
  if (!DESIGNABLE_STATES.includes(pub.approvalState)) return fail('CONTENT_NOT_APPROVED', 'Approve the post\'s content before generating its design.');
  if (pub.contentApprovedVersion !== pub.contentVersion) return fail('CONTENT_NOT_APPROVED', 'The current caption has not been approved yet.');
  if (pub.contentVersion !== contentVersion) {
    return fail('VERSION_MISMATCH', `The caption changed since you loaded it (you saw version ${contentVersion}, current is ${pub.contentVersion}). Reload and try again.`, { currentContentVersion: pub.contentVersion });
  }
  // An approved design is only replaced on purpose. (A post with NO media yet - design approval switched off - is simply getting its first design.)
  if (pub.approvalState === 'design_approved' && Array.isArray(pub.media) && pub.media.length > 0 && !replaceApproved) {
    return fail('DESIGN_ALREADY_APPROVED', 'This design is already approved. Replacing it sends the post back to design review.');
  }

  if (!PLATFORM_DESIGN[pub.platform]) return fail('PLATFORM_NOT_SUPPORTED', 'Design generation is not available for this platform.');
  // Connection is decided HERE, from the database, for the post's own account.
  const account = await activeAccountFor(projectId, pub.platform);
  if (!account || String(account._id) !== String(pub.social_account_id)) return fail('PLATFORM_NOT_CONNECTED', `Reconnect the ${pub.platform === 'facebook' ? 'Facebook Page' : 'Instagram account'} before generating a design for this post.`);

  // The image provider is required only by a design that carries an AI photograph. A design made entirely by Odito's own composition does not call it.
  const provider = getProvider();
  if (!provider.isAvailable() && (await designNeedsProvider(pub))) {
    LoggerUtil.warn(`${EVENT} design_generation_rejected`, { event: 'design_generation_rejected', projectId: String(projectId), publicationId, reason: 'provider_unavailable' });
    return fail('AI_UNAVAILABLE', DESIGN_FAILURE_MESSAGES.AI_UNAVAILABLE);
  }

  await recoverStaleDesignGenerations(projectId, { publicationId, now });
  const running = await SocialDesignGeneration.findOne({ publication_id: pub._id, active: true }).lean();
  if (running) return { success: true, started: false, alreadyRunning: true, generation: toApiGeneration(running) };

  const lockedBy = `${INSTANCE}:${crypto.randomUUID()}`;
  let rec;
  try {
    rec = await SocialDesignGeneration.create({
      project_id: toId(projectId),
      publication_id: pub._id,
      status: 'generating',
      active: true,
      platform: pub.platform,
      contentVersion: pub.contentVersion,
      baseDesignVersion: pub.designVersion,
      baseApprovalState: pub.approvalState,
      replaceApproved,
      provider: 'openai',
      size: PLATFORM_DESIGN[pub.platform].size,
      generation: { startedAt: now, lockedBy, promptVersion: DESIGN_PROMPT_VERSION },
      requestedBy: userId || null,
    });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const existing = await SocialDesignGeneration.findOne({ publication_id: pub._id, active: true }).lean();
    return { success: true, started: false, alreadyRunning: true, generation: existing ? toApiGeneration(existing) : null };
  }

  LoggerUtil.info(`${EVENT} design_generation_started`, { event: 'design_generation_started', projectId: String(projectId), publicationId, generationId: String(rec._id), platform: pub.platform, contentVersion: pub.contentVersion, baseDesignVersion: pub.designVersion });

  const run = () => runDesignGeneration(rec._id, lockedBy, userId).catch((error) => {
    LoggerUtil.error(`${EVENT} Generation bookkeeping failed`, { message: error.message }, { generationId: String(rec._id) });
  });
  if (background) {
    setImmediate(run);
    return { success: true, started: true, alreadyRunning: false, generation: toApiGeneration(rec) };
  }
  await run();
  return { success: true, started: true, alreadyRunning: false, generation: toApiGeneration(await SocialDesignGeneration.findById(rec._id).lean()) };
}

// ── the run ──────────────────────────────────────────────────────────────────

/** The brief for the post's ONE design, from the approved caption + stored business/brand context + the real assets. Shared by the run and by the provider pre-flight, so the design type is decided in one place. */
async function prepareDesignRequest(pub) {
  const { snapshotData, strategy, liveProfile, prohibitedPhrases, services, contact } = await loadBriefContext(pub);
  const assets = await loadDesignAssets(pub, liveProfile);
  const request = buildDesignRequest({
    caption: pub.content, platform: pub.platform, pillar: pub.generation?.contentPillar || null, objective: pub.generation?.objective || null, snapshotData, strategy,
    planItem: assets.planItem, product: productFacts(assets.product), productAssetCount: assets.references.length, hasLogo: !!assets.logo,
    services, contact, prohibitedPhrases, recentTypes: assets.recentTypes, seed: String(pub._id),
  });
  return { request, assets };
}

/** Does the design this post would get carry an AI photograph? Only then is the image provider needed. If that cannot be worked out here, the run itself reports the real problem (and never calls an unavailable provider). */
async function designNeedsProvider(pub) {
  try {
    const { request } = await prepareDesignRequest(pub);
    return request.brief.photography.required === true;
  } catch { return false; }
}

/** Business + brand context for the brief: the STORED strategy snapshot when there is one, else the existing live resolver. */
export async function loadBriefContext(pub) {
  let strategyDoc = null;
  if (pub.generation?.strategyId) strategyDoc = await SocialAIStrategy.findOne({ _id: pub.generation.strategyId, project_id: pub.project_id }).lean();
  if (!strategyDoc?.profileSnapshot?.data) strategyDoc = await SocialAIStrategy.findOne({ project_id: pub.project_id, status: 'ready' }).sort({ version: -1 }).lean();

  let snapshotData;
  let strategy = null;
  if (strategyDoc?.profileSnapshot?.data) {
    snapshotData = strategyDoc.profileSnapshot.data;
    strategy = strategyDoc.strategy || null;
  } else {
    const resolved = await resolveSocialBusinessProfile(pub.project_id, { includeLogo: false });
    if (!resolved?.resolvedProfile) throw Object.assign(new Error('no profile'), { code: 'GENERATION_FAILED' });
    snapshotData = buildProfileData(resolved.resolvedProfile);
  }

  // Colours are visual preferences, not facts: the CURRENT brand kit wins over the one frozen in an older snapshot.
  const live = await findProfile(pub.project_id);
  const brand = { ...(snapshotData.brand || {}) };
  for (const key of ['primaryColor', 'secondaryColor', 'accentColor']) if (live?.brand?.[key]) brand[key] = live.brand[key];
  const prohibitedPhrases = [...new Set([...(snapshotData.prohibitedPhrases || []), ...(strategy?.brandRules?.prohibitedPhrases || []), ...(live?.prohibitedPhrases || [])].map((p) => String(p).trim()).filter(Boolean))];

  // The facts a design may SHOW - the business's real services and contact details - are read live (the Business Profile resolver:
  // the user's own overrides, then Google, then the website), not from a snapshot frozen when the strategy was made.
  let services = (snapshotData.services || []).filter((s) => s?.name).map((s) => ({ name: s.name, features: s.features || [] }));
  const contact = { phone: null, website: snapshotData.business?.website || null, email: null };
  try {
    const resolved = await resolveSocialBusinessProfile(pub.project_id, { includeLogo: false });
    const rp = resolved?.resolvedProfile;
    if (rp) {
      const fact = (f) => (f && f.source !== 'unavailable' && f.value !== undefined ? f.value : null);
      contact.phone = fact(rp.business?.phone);
      contact.website = fact(rp.business?.website) || contact.website;
      const activeServices = (rp.services || []).filter((s) => s?.name && (!s.status || s.status === 'active'));
      if (activeServices.length) services = activeServices.map((s) => ({ name: s.name, features: s.features || [] }));
    }
  } catch { /* the snapshot values stand */ }
  return { snapshotData: { ...snapshotData, brand }, strategy, liveProfile: live, prohibitedPhrases, services, contact };
}

/** The catalog facts a product design may show (the product's own name, benefits and features - nothing composed). */
export const productFacts = (product) => (product ? { name: product.name, benefits: product.benefits || [], features: product.features || [] } : null);

/**
 * The REAL assets and plan behind the post, all read inside the post's own project: the calendar item it was written from
 * (topic, headline text, points, creative direction), the planned product and its real photos (the ones the person selected,
 * else its primary photo), the uploaded logo, and the creative types of the project's latest designs (for variety).
 * Anything missing or unreadable is simply absent - never replaced by an invented stand-in.
 */
export async function loadDesignAssets(pub, liveProfile, { productMediaIds = null } = {}) {
  const projectId = String(pub.project_id);
  const planItem = pub.generation?.calendarItemId ? await SocialContentCalendarItem.findOne({ _id: pub.generation.calendarItemId, project_id: pub.project_id }).lean() : null;

  let product = null;
  const references = [];
  if (planItem?.productId) {
    product = await SocialProduct.findOne({ _id: planItem.productId, project_id: pub.project_id, status: 'active' }).lean();
    if (product) {
      const images = product.images || [];
      // the photos the person chose for THIS design (Creative Studio), else the ones planned on the calendar item; only ever this product's own
      const wanted = productMediaIds?.length ? productMediaIds : (planItem.selectedMediaIds || []);
      const selected = wanted.map((id) => images.find((i) => String(i.mediaId) === String(id))).filter(Boolean);
      const chosen = selected.length ? selected : [images.find((i) => i.isPrimary) || images[0]].filter(Boolean);
      for (const image of chosen.slice(0, MAX_REFERENCE_IMAGES)) {
        // eslint-disable-next-line no-await-in-loop
        const bytes = await mediaStorageService.readByKey(image.storageKey, { projectId });
        // eslint-disable-next-line no-await-in-loop
        const prepared = bytes ? await prepareReferenceImage(bytes) : null;
        if (prepared) references.push(prepared);
      }
    }
  }

  const logoBytes = liveProfile?.brand?.logo?.storageKey ? await mediaStorageService.readByKey(liveProfile.brand.logo.storageKey, { projectId }) : null;
  const logo = logoBytes ? await prepareLogo(logoBytes) : null;

  const recent = await SocialDesignGeneration.find({ project_id: pub.project_id, status: 'ready', 'creative.type': { $ne: null } }).sort({ createdAt: -1 }).limit(3).select('creative.type').lean();
  return { planItem, product, references, logo, recentTypes: recent.map((r) => r.creative.type).filter((t) => CREATIVE_TYPES[t]) };
}

/**
 * Runs one claimed generation to completion. Every write is a conditional update keyed on the lock owner, so
 * an interrupted (stale-recovered) run can never attach media or overwrite a newer outcome; a file that was
 * stored but not attached is deleted.
 */
export async function runDesignGeneration(generationId, lockedBy, userId = null) {
  const lock = { _id: generationId, active: true, status: 'generating', 'generation.lockedBy': lockedBy };
  const rec = await SocialDesignGeneration.findOne(lock).lean();
  if (!rec) return null;

  const started = Date.now();
  const ids = { projectId: String(rec.project_id), publicationId: String(rec.publication_id), generationId: String(generationId) };
  let stored = null; // the file we wrote
  let attached = false;
  let providerResult = null;

  try {
    // 1. Cheap pre-flight before paying for an image: is the post still what the claim saw?
    const pub = await SocialPublication.findOne({ _id: rec.publication_id, project_id: rec.project_id }).lean();
    if (!pub || pub.status !== 'draft' || pub.contentVersion !== rec.contentVersion || pub.designVersion !== rec.baseDesignVersion || pub.approvalState !== rec.baseApprovalState) {
      throw Object.assign(new Error('stale'), { code: 'DESIGN_STALE' });
    }
    const account = await activeAccountFor(rec.project_id, rec.platform);
    if (!account || String(account._id) !== String(pub.social_account_id)) throw Object.assign(new Error('account gone'), { code: 'PLATFORM_NOT_CONNECTED' });

    // 2. The brief: built on the server from the approved caption + stored business/brand context.
    const { request, assets } = await prepareDesignRequest(pub);
    const { brief, problems } = request;
    // the deterministic quality check of the brief: nothing unsupported (a figure, a prohibited phrase, a list without points...) may reach the design
    if (problems.length) {
      LoggerUtil.warn(`${EVENT} design_brief_rejected`, { event: 'design_brief_rejected', ...ids, problemCount: problems.length });
      throw Object.assign(new Error('brief invalid'), { code: briefFailureCode(problems) });
    }

    // 3. The design: the photograph (only when the layout carries one) from the image provider, then Odito's own composition of every
    //    word, the real logo and the real product photos over it.
    const produced = await produceDesign({ request, provider: getProvider(), generationId, logo: assets.logo, productImages: assets.references.map((r) => r.buffer) });
    providerResult = produced.provider || { model: 'odito-composer', attempts: 1, durationMs: null, usage: { inputTokens: 0, outputTokens: 0 } };

    // 4. Inspect -> re-encode -> validate -> store (the shared media services). The logo is already part of the composition.
    const media = { ...(await processAndStoreDesign({ buffer: produced.png, projectId: String(rec.project_id), platform: rec.platform, logo: null })), logoApplied: produced.report.logoApplied };
    stored = media;

    // 5. Still the active run? (a recovered/superseded run must not attach anything)
    const attaching = await SocialDesignGeneration.findOneAndUpdate(lock, {
      $set: {
        status: 'attaching', model: providerResult.model || null,
        'generation.attempts': providerResult.attempts || 1, 'generation.providerMs': providerResult.durationMs ?? null,
        'generation.usage': { inputTokens: providerResult.usage?.inputTokens || 0, outputTokens: providerResult.usage?.outputTokens || 0 },
        creative: {
          type: brief.creativeType, label: brief.label, layoutId: brief.layoutId, briefVersion: brief.version, logoApplied: !!media.logoApplied, referencePhotos: brief.productAssets.count,
          notes: [...new Set([...brief.notes, ...produced.report.notes, ...(assets.logo && !media.logoApplied ? ['logo_not_applied'] : [])])],
        },
      },
    }, { new: true }).lean();
    if (!attaching) {
      LoggerUtil.warn(`${EVENT} design_generation_stale`, { event: 'design_generation_stale', ...ids, reason: 'lock_lost_before_attach' });
      await mediaStorageService.deleteByUrl(stored.url);
      return null;
    }

    // 6. Attach: ONE conditional update pinned to the versions + approval state the claim saw.
    const result = await attachGeneratedDesign(rec.project_id, rec.publication_id, userId || rec.requestedBy, {
      contentVersion: rec.contentVersion,
      baseDesignVersion: rec.baseDesignVersion,
      baseApprovalState: rec.baseApprovalState,
      media: [{ url: media.url, type: 'image' }],
      design: { generationId, model: providerResult.model },
    });
    if (!result.success) throw Object.assign(new Error(result.error.code), { code: 'DESIGN_STALE', reason: result.error.code });
    attached = true;

    // 7. A FIRST design goes to review through the workflow's own transition (never a hand-set state).
    //    A replacement inside design_review / design_approved is already handled by the version rules.
    let submitFailed = false;
    if (rec.baseApprovalState === 'content_approved' && result.publication.approvalState === 'content_approved') {
      const submitted = await submitDesignForApproval(rec.project_id, rec.publication_id, userId || rec.requestedBy);
      submitFailed = !submitted.success;
      if (submitFailed) LoggerUtil.warn(`${EVENT} design_generation_failed`, { event: 'design_generation_failed', ...ids, failureCategory: 'submit_design', code: submitted.error?.code });
    }

    const resultFields = { 'result.designVersion': result.designVersion, 'result.mediaUrl': media.url, 'result.width': media.width, 'result.height': media.height, 'result.bytes': media.bytes };
    const finishedAt = new Date();
    const closing = { 'generation.finishedAt': finishedAt, 'generation.durationMs': Date.now() - started, active: false, ...resultFields };
    const finalLock = { _id: generationId, active: true, status: 'attaching', 'generation.lockedBy': lockedBy };
    if (submitFailed) {
      const failure = { code: 'DESIGN_SUBMIT_FAILED', message: DESIGN_FAILURE_MESSAGES.DESIGN_SUBMIT_FAILED, at: finishedAt };
      await SocialDesignGeneration.findOneAndUpdate(finalLock, { $set: { ...closing, status: 'failed', failure } });
      return null;
    }
    const saved = await SocialDesignGeneration.findOneAndUpdate(finalLock, { $set: { ...closing, status: 'ready', failure: { code: null, message: null, at: null } } }, { new: true }).lean();
    LoggerUtil.info(`${EVENT} design_generation_completed`, {
      event: 'design_generation_completed', ...ids, designVersion: result.designVersion, provider: 'openai', model: providerResult.model, platform: rec.platform,
      providerMs: providerResult.durationMs, attempts: providerResult.attempts, durationMs: Date.now() - started, inputUnits: providerResult.usage?.inputTokens || 0, outputUnits: providerResult.usage?.outputTokens || 0,
    });
    return saved;
  } catch (error) {
    // a file that was stored but never attached must not linger
    if (stored && !attached) await mediaStorageService.deleteByUrl(stored.url);
    const failure = designFailureFor(error);
    const at = new Date();
    await SocialDesignGeneration.findOneAndUpdate(
      { _id: generationId, active: true, 'generation.lockedBy': lockedBy },
      {
        $set: {
          status: 'failed', active: false, 'generation.finishedAt': at, 'generation.durationMs': Date.now() - started,
          ...(providerResult ? { model: providerResult.model || null, 'generation.attempts': providerResult.attempts || 1, 'generation.providerMs': providerResult.durationMs ?? null } : {}),
          failure: { ...failure, at },
        },
      },
    );
    // technical detail goes to the server log as a CODE only (never a provider message that could echo a key or prompt)
    LoggerUtil.error(`${EVENT} design_generation_failed`, { event: 'design_generation_failed', ...ids, failureCode: failure.code, providerCode: error?.code || null, reason: error?.reason || null, durationMs: Date.now() - started });
    return null;
  }
}

export default {
  startDesignGeneration, runDesignGeneration, getDesignGenerationStatus, recoverStaleDesignGenerations,
  setDesignProviderOverride, resetDesignProviderOverride, designFailureFor,
};
