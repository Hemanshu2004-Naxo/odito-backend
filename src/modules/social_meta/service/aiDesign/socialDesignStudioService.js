import os from 'os';
import crypto from 'crypto';
import mongoose from 'mongoose';
import SocialPublication from '../../model/SocialPublication.js';
import SocialDesignGeneration from '../../model/SocialDesignGeneration.js';
import SocialContentCalendarItem from '../../model/SocialContentCalendarItem.js';
import SocialProduct from '../../model/SocialProduct.js';
import { attachGeneratedDesign, submitDesignForApproval, getPublication } from '../socialPublishingService.js';
import mediaStorageService from '../media/mediaStorageService.js';
import {
  getDesignProvider, loadBriefContext, loadDesignAssets, productFacts, activeAccountFor, DESIGNABLE_STATES, designFailureFor, DESIGN_FAILURE_MESSAGES,
  toApiGeneration, recoverStaleDesignGenerations, briefFailureCode,
} from './socialDesignGenerationService.js';
import sharp from 'sharp';
import { buildDesignRequest, DESIGN_PROMPT_VERSION } from './designBrief.js';
import { produceDesign } from './designProducer.js';
import { interpretChange } from './designDirector.js';
import { chooseCandidateTypes, CREATIVE_TYPES, cleanInstruction, parseChanges } from './designStrategy.js';
import { processAndStoreDesign, prepareReferenceImage } from './designMedia.js';
import { PLATFORM_DESIGN, MAX_REFERENCE_IMAGES } from './designConfig.js';
import { LoggerUtil } from '../../../../utils/LoggerUtil.js';

/**
 * socialDesignStudioService - the real Creative Studio. It is a layer on the EXISTING design pipeline (the same
 * SocialDesignGeneration record and lock, the same brief, provider, media validation and storage, the same versioned
 * attachGeneratedDesign and the same design approval); it adds three things:
 *
 *   state      one read of everything the studio shows: the REAL post (caption, hashtags, versions, approval), the plan and
 *              product / service behind it, the real brand data, the format, the approval gate, and the latest candidates.
 *   generate   up to three DISTINCT creative directions for one post (a list, a data design, a modern layout... as the content
 *              supports), made concurrently and stored as candidates. Nothing is attached to the post.
 *   regenerate ONE candidate again (a new variation of the same direction) or refine it from the person's own words, built on the
 *              current image. If that candidate is the post's current design the new image replaces it through the versioned attach.
 *   select     a person picks a candidate: the stored file becomes the post's design through attachGeneratedDesign, pinned to the post's
 *              content / design version and approval state, and the post goes to Design Review. Never auto-approved; an approved design is
 *              only replaced on purpose.
 *
 * Never: call Meta, schedule, publish, approve a design, trust a client-supplied version / state / account / platform / product, store
 * a prompt, a provider response, a key or image bytes (files live in the project's media storage), or let a stale run attach media.
 */

const INSTANCE = `${os.hostname()}:${process.pid}`;
const EVENT = '[SOCIAL_AI_DESIGN_STUDIO]';
const CANDIDATE_COUNT = 3;
const MAX_INSTRUCTION = 400;
const MAX_PRODUCT_ASSETS = 4;
const toId = (id) => (mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : null);
const iso = (d) => (d ? new Date(d).toISOString() : null);
const fail = (code, message, extra = {}) => ({ success: false, error: { code, message, ...extra } });

export const STUDIO_FAILURE_MESSAGES = Object.freeze({
  ...DESIGN_FAILURE_MESSAGES,
  CANDIDATE_STALE: 'These designs were made for an earlier version of the caption. Generate new designs for the current caption.',
  DESIGN_FILE_MISSING: 'That design image is no longer available. Generate new designs.',
  GENERATION_IN_PROGRESS: 'Designs are being generated for this post. Wait for them to finish.',
  GENERATION_SUPERSEDED: 'A newer set of designs exists for this post. Reload and try again.',
});

const FORMAT_LABELS = Object.freeze({
  instagram: { aspectRatio: '1:1', label: 'Instagram feed image (1:1)' },
  facebook: { aspectRatio: '3:2', label: 'Facebook feed image (3:2)' },
});

/** The post text split into the caption and its trailing hashtag block (hashtags are part of the real publication text). */
export function splitContent(text) {
  const value = String(text || '');
  const match = value.match(/(?:\s*#[\p{L}\p{N}_]+)+\s*$/u);
  if (!match) return { caption: value.trim(), hashtags: [] };
  return { caption: value.slice(0, match.index).trim(), hashtags: (match[0].match(/#[\p{L}\p{N}_]+/gu) || []) };
}

const productFilesFor = (product) => (product?.images || []).map((i) => ({ mediaId: String(i.mediaId), url: i.url, altText: i.altText || '', isPrimary: !!i.isPrimary }));

// ── validation shared by every action ────────────────────────────────────────

/**
 * The post must belong to THIS project, be a draft, have APPROVED content for exactly the version the caller saw, and its account
 * must still be connected. Everything is decided from the database: nothing about the post comes from the client.
 */
async function loadDesignablePost(projectId, publicationId, contentVersion) {
  if (typeof publicationId !== 'string' || !mongoose.Types.ObjectId.isValid(publicationId)) return fail('INVALID_PUBLICATION', 'publicationId is required.');
  if (!Number.isInteger(contentVersion) || contentVersion < 1) return fail('INVALID_VERSION', 'contentVersion (the content version you are designing for) is required.');
  const pub = await SocialPublication.findOne({ _id: toId(publicationId), project_id: toId(projectId) }).lean();
  if (!pub) return fail('NOT_FOUND', 'That publication was not found.');
  if (pub.status !== 'draft') return fail('DESIGN_NOT_ALLOWED', `A design can only be created for a draft (this post is ${pub.status}).`);
  if (!DESIGNABLE_STATES.includes(pub.approvalState)) return fail('CONTENT_NOT_APPROVED', 'Content approval required before creating the design.');
  if (pub.contentApprovedVersion !== pub.contentVersion) return fail('CONTENT_NOT_APPROVED', 'The current caption has not been approved yet.');
  if (pub.contentVersion !== contentVersion) return fail('VERSION_MISMATCH', `The caption changed since you loaded it (you saw version ${contentVersion}, current is ${pub.contentVersion}). Reload and try again.`, { currentContentVersion: pub.contentVersion });
  if (!PLATFORM_DESIGN[pub.platform]) return fail('PLATFORM_NOT_SUPPORTED', 'Design generation is not available for this platform.');
  const account = await activeAccountFor(projectId, pub.platform);
  if (!account || String(account._id) !== String(pub.social_account_id)) return fail('PLATFORM_NOT_CONNECTED', `Reconnect the ${pub.platform === 'facebook' ? 'Facebook Page' : 'Instagram account'} before creating a design for this post.`);
  return { success: true, pub };
}

const currentMediaUrl = (pub) => (Array.isArray(pub.media) && pub.media[0]?.type === 'image' ? pub.media[0].url : null);

/** The calendar item the post was written from and its product, both looked up inside this project only. */
async function loadPlan(pub) {
  const planItem = pub.generation?.calendarItemId ? await SocialContentCalendarItem.findOne({ _id: pub.generation.calendarItemId, project_id: pub.project_id }).lean() : null;
  const product = planItem?.productId ? await SocialProduct.findOne({ _id: planItem.productId, project_id: pub.project_id, status: 'active' }).lean() : null;
  return { planItem, product };
}

// ── read model ───────────────────────────────────────────────────────────────

const latestStudioRecord = (projectId, publicationId) => SocialDesignGeneration.findOne({ project_id: toId(projectId), publication_id: toId(publicationId), mode: 'studio' }).sort({ createdAt: -1 }).lean();

/** The generation as the studio shows it: candidates with `current`, the action in flight, and a durable failure. */
export function toApiStudioGeneration(rec, pub) {
  if (!rec) return null;
  const base = toApiGeneration(rec, { currentUrl: currentMediaUrl(pub) });
  const candidates = (base.candidates || []).map((c) => (c.status === 'pending' && !rec.active
    ? { ...c, status: 'failed', failure: { code: 'GENERATION_INTERRUPTED', message: DESIGN_FAILURE_MESSAGES.GENERATION_INTERRUPTED } }
    : c));
  return {
    ...base,
    active: !!rec.active,
    action: rec.studio?.action || null,
    activeCandidateId: rec.active && rec.studio?.action === 'regenerate' && rec.studio?.candidateId ? String(rec.studio.candidateId) : null,
    productMediaIds: (rec.studio?.productMediaIds || []).map(String),
    candidates,
  };
}

/**
 * Everything Creative Studio shows about ONE post, from the real system: the publication, its content, the plan / product /
 * service behind it, the brand data, the format and the approval gate. A post of another project is simply "not found".
 */
export async function getStudioState(projectId, publicationId, { now = new Date() } = {}) {
  if (typeof publicationId !== 'string' || !mongoose.Types.ObjectId.isValid(publicationId)) return fail('NOT_FOUND', 'That publication was not found.');
  const publication = await getPublication(projectId, publicationId);
  if (!publication) return fail('NOT_FOUND', 'That publication was not found.');
  await recoverStaleDesignGenerations(projectId, { publicationId, now });
  const pub = await SocialPublication.findOne({ _id: toId(publicationId), project_id: toId(projectId) }).lean();

  const { caption, hashtags } = splitContent(pub.content);
  const { planItem, product } = await loadPlan(pub);
  const rec = await latestStudioRecord(projectId, publicationId);
  const approved = DESIGNABLE_STATES.includes(pub.approvalState) && pub.contentApprovedVersion === pub.contentVersion;
  const gate = pub.status !== 'draft'
    ? { allowed: false, code: 'DESIGN_NOT_ALLOWED', message: `A design can only be created for a draft (this post is ${pub.status}).` }
    : !approved
      ? { allowed: false, code: 'CONTENT_NOT_APPROVED', message: 'Content approval required before creating the design.' }
      : { allowed: true, code: null, message: null };

  // brand: the real Business Profile / Brand Kit (current colours win over a frozen snapshot, as in design generation)
  const ctx = await loadBriefContext(pub).catch(() => null);
  const liveBrand = ctx?.liveProfile?.brand || {};
  const colors = { primary: ctx?.snapshotData?.brand?.primaryColor || null, secondary: ctx?.snapshotData?.brand?.secondaryColor || null, accent: ctx?.snapshotData?.brand?.accentColor || null };
  const logoUrl = liveBrand.logo?.url && liveBrand.logo?.storageKey ? liveBrand.logo.url : null;

  const selectedForDesign = rec?.studio?.productMediaIds?.length ? rec.studio.productMediaIds.map(String) : (planItem?.selectedMediaIds || []).map(String);
  const files = productFilesFor(product);
  const effective = selectedForDesign.length ? selectedForDesign : (files.find((f) => f.isPrimary)?.mediaId || files[0]?.mediaId ? [files.find((f) => f.isPrimary)?.mediaId || files[0]?.mediaId] : []);

  const spec = FORMAT_LABELS[pub.platform] || { aspectRatio: null, label: pub.platform };
  const plannedFormat = planItem?.format || null;

  return {
    success: true,
    publication,
    content: { caption, hashtags, platform: pub.platform, contentVersion: pub.contentVersion, designVersion: pub.designVersion, approvalState: pub.approvalState ?? null, status: pub.status },
    gate,
    plan: planItem ? { itemId: String(planItem._id), topic: planItem.topic, plannedFormat, objective: planItem.objective, contentPillar: planItem.contentPillar } : null,
    product: product ? { id: String(product._id), name: product.name, images: files.map((f) => ({ ...f, selected: effective.includes(f.mediaId) })) } : null,
    service: planItem?.serviceId ? { id: String(planItem.serviceId), name: planItem.serviceName || null } : null,
    brand: {
      businessName: ctx?.snapshotData?.business?.name || null,
      logo: { available: !!logoUrl, url: logoUrl },
      colors: { ...colors, configured: !!(colors.primary || colors.secondary || colors.accent) },
      fonts: { heading: liveBrand.fontHeading || null, body: liveBrand.fontBody || null, isDefault: !(liveBrand.fontHeading || liveBrand.fontBody) },
      voice: liveBrand.voice || null,
      tone: ctx?.snapshotData?.toneOfVoice?.primary || null,
      visualGuidelines: ctx?.strategy?.brandRules?.visualGuidelines || [],
    },
    format: {
      platform: pub.platform, size: PLATFORM_DESIGN[pub.platform]?.size || null, aspectRatio: spec.aspectRatio, mediaType: 'image', label: spec.label, plannedFormat,
      note: plannedFormat === 'reel' || plannedFormat === 'video' ? 'The plan calls for a video: Creative Studio creates the still image for it.' : plannedFormat === 'carousel' ? 'The plan calls for a carousel: Creative Studio creates one cover image that summarises it.' : null,
    },
    currentDesign: currentMediaUrl(pub) ? {
      url: currentMediaUrl(pub), designVersion: pub.designVersion, approvalState: pub.approvalState ?? null, source: pub.design?.source === 'ai' && pub.design.designVersion === pub.designVersion ? 'ai' : 'upload',
    } : null,
    generation: toApiStudioGeneration(rec, pub),
  };
}

// ── starting a generation ────────────────────────────────────────────────────

const INSTRUCTION_RE = /[\u0000-\u001F\u007F]/;

/** Every stored file a candidate owns: the finished design and the photograph kept for refinements. */
const candidateFiles = (c) => [c?.media?.url, c?.visual?.url].filter(Boolean);

/** A change request that is about the PICTURE (the photograph must be made again); everything else re-composes the same photograph. */
const PHOTO_CHANGE_RE = /\b(photo|photograph|picture|image|scene|background image|people|person|team|office|workspace|different (photo|image|picture|scene)|new (photo|image|picture|scene))\b/i;

/** Deletes the stored files of candidates that were never attached (the person moved on), and drops them from their old records. */
async function discardSupersededCandidates(pub, keepGenerationId) {
  const older = await SocialDesignGeneration.find({ project_id: pub.project_id, publication_id: pub._id, mode: 'studio', _id: { $ne: keepGenerationId }, active: false }).lean();
  const inUse = currentMediaUrl(pub);
  for (const rec of older) {
    for (const c of rec.candidates || []) {
      if (c.media?.url && c.media.url !== inUse) for (const url of candidateFiles(c)) await mediaStorageService.deleteByUrl(url); // eslint-disable-line no-await-in-loop
    }
    const keep = (rec.candidates || []).filter((c) => c.attached && c.media?.url === inUse);
    if (keep.length) await SocialDesignGeneration.updateOne({ _id: rec._id }, { $set: { candidates: keep } }); // eslint-disable-line no-await-in-loop
    else await SocialDesignGeneration.deleteOne({ _id: rec._id }); // eslint-disable-line no-await-in-loop
  }
}

/**
 * Starts (or reports the running) generation.
 * input: { publicationId, contentVersion, action: 'generate_all' | 'regenerate', generationId?, candidateId?, instruction?, productMediaIds?, replaceApproved? }
 */
export async function startStudioGeneration(projectId, userId, input = {}, { now = new Date(), background = true } = {}) {
  const action = input?.action === undefined ? 'generate_all' : input.action;
  if (!['generate_all', 'regenerate'].includes(action)) return fail('INVALID_ACTION', 'action must be generate_all or regenerate.');
  const replaceApproved = input?.replaceApproved === true;

  let instruction = null;
  if (input?.instruction !== undefined && input.instruction !== null) {
    if (typeof input.instruction !== 'string' || input.instruction.length > 2000 || INSTRUCTION_RE.test(input.instruction.replace(/[\r\n\t]/g, ' '))) return fail('INVALID_INSTRUCTION', `Describe the change in plain text (at most ${MAX_INSTRUCTION} characters).`);
    const cleaned = cleanInstruction(input.instruction);
    if (cleaned.length > 0 && input.instruction.trim().length > MAX_INSTRUCTION) return fail('INVALID_INSTRUCTION', `Describe the change in at most ${MAX_INSTRUCTION} characters.`);
    instruction = cleaned || null;
  }
  if (instruction && action !== 'regenerate') return fail('INVALID_INSTRUCTION', 'Changes can only be applied to one design: select it first.');

  const checked = await loadDesignablePost(projectId, input?.publicationId, input?.contentVersion);
  if (!checked.success) return checked;
  const { pub } = checked;

  // the product photos the person chose: only photos of THIS post's planned product (looked up inside the project)
  let productMediaIds = [];
  if (input?.productMediaIds !== undefined && input.productMediaIds !== null) {
    const ids = input.productMediaIds;
    if (!Array.isArray(ids) || ids.length > MAX_PRODUCT_ASSETS || !ids.every((x) => typeof x === 'string' && mongoose.Types.ObjectId.isValid(x))) return fail('INVALID_PRODUCT_ASSET', 'productMediaIds must be a short list of product image ids.');
    const { product } = await loadPlan(pub);
    const owned = new Set(productFilesFor(product).map((f) => f.mediaId));
    if (ids.length && (!product || !ids.every((id) => owned.has(String(id))))) return fail('INVALID_PRODUCT_ASSET', 'Choose images of this post\'s product.');
    productMediaIds = [...new Set(ids)].map(toId);
  }

  // No provider pre-check here: the studio always offers at least one design made only by Odito's own composition (list / statistics / quote / statement),
  // and whether a refinement needs a NEW photograph is only known once the change is read. The producer calls the provider only for a design that carries a
  // photograph and fails THAT design - with the provider-unavailable message - before any request when it is not configured.

  await recoverStaleDesignGenerations(projectId, { publicationId: String(pub._id), now });
  const running = await SocialDesignGeneration.findOne({ publication_id: pub._id, active: true }).lean();
  if (running) return { success: true, started: false, alreadyRunning: true, generation: toApiStudioGeneration(running, pub) };

  const lockedBy = `${INSTANCE}:${crypto.randomUUID()}`;
  let rec;
  try {
    if (action === 'generate_all') {
      rec = await SocialDesignGeneration.create({
        project_id: pub.project_id, publication_id: pub._id, status: 'generating', active: true, mode: 'studio', platform: pub.platform, contentVersion: pub.contentVersion,
        baseDesignVersion: pub.designVersion, baseApprovalState: pub.approvalState, replaceApproved, provider: 'openai', size: PLATFORM_DESIGN[pub.platform].size,
        studio: { action, productMediaIds }, candidates: Array.from({ length: CANDIDATE_COUNT }, (_, slot) => ({ slot, status: 'pending' })),
        generation: { startedAt: now, lockedBy, promptVersion: DESIGN_PROMPT_VERSION }, requestedBy: userId || null,
      });
      await discardSupersededCandidates(pub, rec._id);
    } else {
      const existing = await SocialDesignGeneration.findOne({ _id: toId(input?.generationId), project_id: pub.project_id, publication_id: pub._id, mode: 'studio' }).lean();
      if (!existing) return fail('NOT_FOUND', 'Those designs were not found.');
      const latest = await latestStudioRecord(projectId, String(pub._id));
      if (String(latest._id) !== String(existing._id)) return fail('GENERATION_SUPERSEDED', STUDIO_FAILURE_MESSAGES.GENERATION_SUPERSEDED);
      if (existing.contentVersion !== pub.contentVersion) return fail('CANDIDATE_STALE', STUDIO_FAILURE_MESSAGES.CANDIDATE_STALE);
      const cand = (existing.candidates || []).find((c) => String(c._id) === String(input?.candidateId));
      if (!cand) return fail('NOT_FOUND', 'That design was not found.');
      const isCurrent = cand.attached && cand.media?.url && cand.media.url === currentMediaUrl(pub);
      if (isCurrent && pub.approvalState === 'design_approved' && !replaceApproved) return fail('DESIGN_ALREADY_APPROVED', 'This design is already approved. Changing it sends the post back to design review.');
      rec = await SocialDesignGeneration.findOneAndUpdate(
        { _id: existing._id, active: false, status: { $in: ['ready', 'failed'] } },
        {
          $set: {
            status: 'generating', active: true, baseDesignVersion: pub.designVersion, baseApprovalState: pub.approvalState, replaceApproved,
            'studio.action': 'regenerate', 'studio.candidateId': cand._id, 'studio.instruction': instruction, 'studio.productMediaIds': productMediaIds.length ? productMediaIds : (existing.studio?.productMediaIds || []),
            'generation.startedAt': now, 'generation.finishedAt': null, 'generation.lockedBy': lockedBy, 'generation.promptVersion': DESIGN_PROMPT_VERSION,
            failure: { code: null, message: null, at: null }, requestedBy: userId || null,
          },
        },
        { new: true },
      ).lean();
      if (!rec) {
        const running2 = await SocialDesignGeneration.findOne({ publication_id: pub._id, active: true }).lean();
        return running2 ? { success: true, started: false, alreadyRunning: true, generation: toApiStudioGeneration(running2, pub) } : fail('GENERATION_IN_PROGRESS', STUDIO_FAILURE_MESSAGES.GENERATION_IN_PROGRESS);
      }
    }
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const existingActive = await SocialDesignGeneration.findOne({ publication_id: pub._id, active: true }).lean();
    return { success: true, started: false, alreadyRunning: true, generation: existingActive ? toApiStudioGeneration(existingActive, pub) : null };
  }

  LoggerUtil.info(`${EVENT} design_studio_started`, { event: 'design_studio_started', projectId: String(projectId), publicationId: String(pub._id), generationId: String(rec._id), action, platform: pub.platform, contentVersion: pub.contentVersion });
  const run = () => runStudioGeneration(rec._id, lockedBy, userId).catch((error) => LoggerUtil.error(`${EVENT} Generation bookkeeping failed`, { message: error.message }, { generationId: String(rec._id) }));
  if (background) {
    setImmediate(run);
    return { success: true, started: true, alreadyRunning: false, generation: toApiStudioGeneration(rec.toObject ? rec.toObject() : rec, pub) };
  }
  await run();
  const finished = await SocialDesignGeneration.findById(rec._id).lean();
  return { success: true, started: true, alreadyRunning: false, generation: toApiStudioGeneration(finished, await SocialPublication.findById(pub._id).lean()) };
}

// ── the run ──────────────────────────────────────────────────────────────────

/**
 * Runs one claimed studio generation. Every write is conditional on the lock owner, so a run that was recovered as stale can never
 * write a candidate or attach media; a file that was stored but not recorded is deleted.
 */
export async function runStudioGeneration(generationId, lockedBy, userId = null) {
  const lock = { _id: generationId, active: true, status: 'generating', 'generation.lockedBy': lockedBy };
  const rec = await SocialDesignGeneration.findOne(lock).lean();
  if (!rec) return null;

  const started = Date.now();
  const projectId = String(rec.project_id);
  const ids = { projectId, publicationId: String(rec.publication_id), generationId: String(generationId) };
  const stored = []; // every file this run wrote, so a failed / stale run can remove them
  let usageIn = 0;
  let usageOut = 0;
  let model = null;

  try {
    const pub = await SocialPublication.findOne({ _id: rec.publication_id, project_id: rec.project_id }).lean();
    if (!pub || pub.status !== 'draft' || pub.contentVersion !== rec.contentVersion || !DESIGNABLE_STATES.includes(pub.approvalState)) throw Object.assign(new Error('stale'), { code: 'DESIGN_STALE' });
    const account = await activeAccountFor(rec.project_id, rec.platform);
    if (!account || String(account._id) !== String(pub.social_account_id)) throw Object.assign(new Error('account gone'), { code: 'PLATFORM_NOT_CONNECTED' });

    const context = await loadBriefContext(pub);
    const assets = await loadDesignAssets(pub, context.liveProfile, { productMediaIds: (rec.studio?.productMediaIds || []).map(String) });
    const provider = getDesignProvider();
    const size = PLATFORM_DESIGN[rec.platform].size;
    const regenerating = rec.studio?.action === 'regenerate';

    // which candidates this run produces, and in which creative direction
    let work;
    if (regenerating) {
      const cand = (rec.candidates || []).find((c) => String(c._id) === String(rec.studio.candidateId));
      if (!cand) throw Object.assign(new Error('candidate gone'), { code: 'GENERATION_FAILED' });
      work = [{ cand, type: cand.creativeType || 'premium_editorial' }];
    } else {
      const choices = chooseCandidateTypes({
        caption: pub.content, planItem: assets.planItem, pillar: pub.generation?.contentPillar || '', objective: pub.generation?.objective || '',
        snapshotData: context.snapshotData, hasProduct: !!assets.product, hasProductAsset: assets.references.length > 0, services: context.services, count: CANDIDATE_COUNT,
      });
      work = rec.candidates.map((cand, i) => ({ cand, type: choices[i % choices.length].type }));
      // the directions are known before any image exists, so the cards can name what is being made
      await SocialDesignGeneration.updateOne(lock, { $set: Object.fromEntries(work.flatMap((w, i) => [[`candidates.${i}.creativeType`, w.type], [`candidates.${i}.label`, CREATIVE_TYPES[w.type].label]])) });
    }

    const makeOne = async ({ cand, type }) => {
      const previousRevision = cand.revision || 1;
      const revision = regenerating ? previousRevision + 1 : previousRevision;
      const attemptFiles = []; // files THIS attempt wrote, so a failure removes exactly them
      try {
        const refine = regenerating && rec.studio?.instruction ? rec.studio.instruction : null;
        // The person's words are read by the design director (the AI chooses ONLY among allowed parameters; any text it returns must be
        // the person's own); the keyword rules are the floor when it is unavailable. A change that is not about the picture
        // ("darker background", "larger headline") re-composes the SAME photograph: instant, free, consistent.
        const direction = refine ? await interpretChange({ instruction: refine, context: { layout: cand.layoutId || null, creativeType: type, hasPhotograph: !!cand.visual?.storageKey } }) : null;
        // taking the people out of the picture can only be done by making the picture again
        const removesPeople = direction?.patch?.allowPeople === false || parseChanges(refine || '').allowPeople === false;
        const wantsNewPhoto = removesPeople || (direction ? direction.newPhoto : PHOTO_CHANGE_RE.test(refine || ''));
        const keepVisual = !!refine && !wantsNewPhoto && !!cand.visual?.storageKey;
        const visualBytes = keepVisual ? await mediaStorageService.readByKey(cand.visual.storageKey, { projectId }) : null;
        const reuse = keepVisual && visualBytes ? visualBytes : null;
        const request = buildDesignRequest({
          caption: pub.content, platform: pub.platform, pillar: pub.generation?.contentPillar || null, objective: pub.generation?.objective || null,
          snapshotData: context.snapshotData, strategy: context.strategy, planItem: assets.planItem, product: productFacts(assets.product),
          productAssetCount: assets.references.length, hasLogo: !!assets.logo, services: context.services, contact: context.contact, prohibitedPhrases: context.prohibitedPhrases,
          patch: direction?.patch || {}, visualChange: direction?.photoRequest || null, seed: `${pub._id}:${cand.slot}`, sceneSeed: String(pub._id), sceneOffset: cand.slot + 3 * ((reuse ? previousRevision : revision) - 1), variant: String(reuse ? previousRevision : revision), forceType: type, instruction: refine || '',
        });
        if (request.problems.length) throw Object.assign(new Error('brief invalid'), { code: briefFailureCode(request.problems) });
        const produced = await produceDesign({ request, provider, generationId, logo: assets.logo, productImages: assets.references.map((r) => r.buffer), visualBuffer: reuse });
        usageIn += produced.provider?.usage?.inputTokens || 0; usageOut += produced.provider?.usage?.outputTokens || 0; model = produced.provider?.model || model;
        const media = { ...(await processAndStoreDesign({ buffer: produced.png, projectId, platform: rec.platform, logo: null })), logoApplied: produced.report.logoApplied };
        stored.push(media.url); attemptFiles.push(media.url);
        // the photograph is kept (project-scoped, deleted with its candidate) so a later refinement can re-compose without making a new picture
        let visual = reuse ? cand.visual : null;
        if (produced.provider && produced.visual) {
          const up = await mediaStorageService.upload({ buffer: await sharp(produced.visual).jpeg({ quality: 88 }).toBuffer(), projectId, extension: '.jpg' });
          stored.push(up.url); attemptFiles.push(up.url);
          visual = { url: up.url, storageKey: `${projectId}/${up.filename}` };
        }
        const oldVisualUrl = cand.visual?.url && cand.visual.url !== visual?.url ? cand.visual.url : null;
        const written = await SocialDesignGeneration.updateOne({ ...lock, 'candidates._id': cand._id }, {
          $set: {
            'candidates.$.status': 'ready', 'candidates.$.creativeType': request.brief.creativeType, 'candidates.$.label': request.brief.label, 'candidates.$.layoutId': request.brief.layoutId, 'candidates.$.revision': revision,
            'candidates.$.media': { url: media.url, storageKey: `${projectId}/${media.url.split('/').pop()}`, width: media.width, height: media.height, bytes: media.bytes },
            'candidates.$.visual': visual ? { url: visual.url, storageKey: visual.storageKey } : { url: null, storageKey: null },
            'candidates.$.logoApplied': !!media.logoApplied, 'candidates.$.referencePhotos': request.brief.productAssets.count,
            'candidates.$.notes': [...new Set([...request.brief.notes, ...produced.report.notes, ...(assets.logo && !media.logoApplied ? ['logo_not_applied'] : [])])],
            'candidates.$.instruction': refine || null, 'candidates.$.failure': { code: null, message: null }, 'candidates.$.generatedAt': new Date(),
          },
        });
        if (!written.matchedCount) { for (const url of attemptFiles) await mediaStorageService.deleteByUrl(url); return { ok: false, lost: true, cand }; } // eslint-disable-line no-await-in-loop
        return { ok: true, cand, media, revision, brief: request.brief, oldVisualUrl };
      } catch (error) {
        for (const url of attemptFiles) await mediaStorageService.deleteByUrl(url); // eslint-disable-line no-await-in-loop
        const failure = designFailureFor(error);
        const code = error?.code === 'DESIGN_FILE_MISSING' ? 'DESIGN_FILE_MISSING' : failure.code;
        const message = STUDIO_FAILURE_MESSAGES[code] || failure.message;
        LoggerUtil.error(`${EVENT} design_candidate_failed`, { event: 'design_candidate_failed', ...ids, slot: cand.slot, failureCode: code, providerCode: error?.code || null });
        // a regenerate that fails keeps the previous image (it is still a valid candidate); a first generation records the failure on the card
        if (!regenerating) await SocialDesignGeneration.updateOne({ ...lock, 'candidates._id': cand._id }, { $set: { 'candidates.$.status': 'failed', 'candidates.$.failure': { code, message } } });
        return { ok: false, cand, failure: { code, message } };
      }
    };

    const results = await Promise.all(work.map(makeOne));
    if (results.some((r) => r.lost)) { for (const url of stored) await mediaStorageService.deleteByUrl(url); LoggerUtil.warn(`${EVENT} design_studio_stale`, { event: 'design_studio_stale', ...ids, reason: 'lock_lost' }); return null; } // eslint-disable-line no-await-in-loop

    // the caption may have changed while the images were being made: those designs belong to a caption that no longer exists
    const after = await SocialPublication.findOne({ _id: rec.publication_id, project_id: rec.project_id }).lean();
    if (!after || after.contentVersion !== rec.contentVersion) throw Object.assign(new Error('content changed'), { code: 'DESIGN_STALE' });

    const ok = results.filter((r) => r.ok);
    let attachNote = null;
    if (regenerating && ok.length) {
      // refining / regenerating the design the post currently carries: the new image replaces it through the versioned attach (to Design Review, never approved)
      const { cand, media } = ok[0];
      const wasCurrent = cand.attached && cand.media?.url && cand.media.url === currentMediaUrl(after);
      if (wasCurrent) {
        const attach = await attachGeneratedDesign(rec.project_id, rec.publication_id, userId || rec.requestedBy, {
          contentVersion: rec.contentVersion, baseDesignVersion: rec.baseDesignVersion, baseApprovalState: rec.baseApprovalState, media: [{ url: media.url, type: 'image' }], design: { generationId, model },
        });
        if (attach.success) {
          if (attach.publication.approvalState === 'content_approved') await submitDesignForApproval(rec.project_id, rec.publication_id, userId || rec.requestedBy);
          await SocialDesignGeneration.updateOne({ ...lock, 'candidates._id': cand._id }, { $set: { 'candidates.$.attached': true, 'candidates.$.attachedDesignVersion': attach.designVersion } });
          await mediaStorageService.deleteByUrl(cand.media.url); // the replaced design file is no longer referenced by anything
          if (ok[0].oldVisualUrl) await mediaStorageService.deleteByUrl(ok[0].oldVisualUrl);
        } else {
          // the post changed while the image was being made: the new image stays a candidate to select, the post keeps what it had
          await SocialDesignGeneration.updateOne({ ...lock, 'candidates._id': cand._id }, { $set: { 'candidates.$.attached': false } });
          attachNote = attach.error?.code || 'ATTACH_STALE';
          await mediaStorageService.deleteByUrl(cand.media.url);
          if (ok[0].oldVisualUrl) await mediaStorageService.deleteByUrl(ok[0].oldVisualUrl);
        }
      } else if (cand.media?.url) { await mediaStorageService.deleteByUrl(cand.media.url); if (ok[0].oldVisualUrl) await mediaStorageService.deleteByUrl(ok[0].oldVisualUrl); } // an unselected candidate's old files
    }

    const finishedAt = new Date();
    const closing = { active: false, 'generation.finishedAt': finishedAt, 'generation.durationMs': Date.now() - started, model: model || null };
    const finalLock = { ...lock };
    if (!ok.length) {
      const failure = results[0]?.failure || { code: 'GENERATION_FAILED', message: DESIGN_FAILURE_MESSAGES.GENERATION_FAILED };
      await SocialDesignGeneration.updateOne(finalLock, { $set: { ...closing, status: 'failed', failure: { ...failure, at: finishedAt } }, $inc: { 'generation.usage.inputTokens': usageIn, 'generation.usage.outputTokens': usageOut } });
      return null;
    }
    const saved = await SocialDesignGeneration.findOneAndUpdate(finalLock, { $set: { ...closing, status: 'ready', failure: { code: null, message: null, at: null } }, $inc: { 'generation.usage.inputTokens': usageIn, 'generation.usage.outputTokens': usageOut } }, { new: true }).lean();
    LoggerUtil.info(`${EVENT} design_studio_completed`, { event: 'design_studio_completed', ...ids, ready: ok.length, failed: results.length - ok.length, attachNote, durationMs: Date.now() - started, inputUnits: usageIn, outputUnits: usageOut });
    return saved;
  } catch (error) {
    for (const url of stored) await mediaStorageService.deleteByUrl(url); // eslint-disable-line no-await-in-loop
    const failure = designFailureFor(error);
    const code = error?.code === 'DESIGN_STALE' ? 'DESIGN_STALE' : failure.code;
    const at = new Date();
    await SocialDesignGeneration.updateOne({ _id: generationId, active: true, 'generation.lockedBy': lockedBy }, {
      $set: { status: 'failed', active: false, 'generation.finishedAt': at, 'generation.durationMs': Date.now() - started, failure: { code, message: STUDIO_FAILURE_MESSAGES[code] || failure.message, at } },
    });
    LoggerUtil.error(`${EVENT} design_studio_failed`, { event: 'design_studio_failed', ...ids, failureCode: code, providerCode: error?.code || null, durationMs: Date.now() - started });
    return null;
  }
}

// ── selecting a design ───────────────────────────────────────────────────────

/**
 * Makes a candidate the post's design: its stored file is attached through the existing versioned attach, pinned to the post's
 * content / design version and approval state, and the post goes to Design Review (never approved). The caller names the design
 * version it saw; if the post moved on, nothing is written.
 * input: { publicationId, generationId, candidateId, contentVersion, designVersion, replaceApproved? }
 */
export async function selectStudioCandidate(projectId, userId, input = {}) {
  const checked = await loadDesignablePost(projectId, input?.publicationId, input?.contentVersion);
  if (!checked.success) return checked;
  const { pub } = checked;
  if (!Number.isInteger(input?.designVersion) || input.designVersion < 1) return fail('INVALID_VERSION', 'designVersion (the design version you are looking at) is required.');
  if (pub.designVersion !== input.designVersion) return fail('DESIGN_VERSION_MISMATCH', `The design changed since you loaded it (you saw version ${input.designVersion}, current is ${pub.designVersion}). Reload and try again.`, { currentDesignVersion: pub.designVersion });
  const replaceApproved = input?.replaceApproved === true;

  const rec = await SocialDesignGeneration.findOne({ _id: toId(input?.generationId), project_id: pub.project_id, publication_id: pub._id, mode: 'studio' }).lean();
  if (!rec) return fail('NOT_FOUND', 'Those designs were not found.');
  if (rec.active) return fail('GENERATION_IN_PROGRESS', STUDIO_FAILURE_MESSAGES.GENERATION_IN_PROGRESS);
  const cand = (rec.candidates || []).find((c) => String(c._id) === String(input?.candidateId));
  if (!cand || cand.status !== 'ready' || !cand.media?.url) return fail('NOT_FOUND', 'That design was not found.');
  if (rec.contentVersion !== pub.contentVersion) return fail('CANDIDATE_STALE', STUDIO_FAILURE_MESSAGES.CANDIDATE_STALE);

  if (cand.attached && cand.media.url === currentMediaUrl(pub)) return { success: true, alreadySelected: true, publication: await getPublication(projectId, String(pub._id)), generation: toApiStudioGeneration(rec, pub) };
  if (pub.approvalState === 'design_approved' && Array.isArray(pub.media) && pub.media.length > 0 && !replaceApproved) return fail('DESIGN_ALREADY_APPROVED', 'This design is already approved. Replacing it sends the post back to design review.');
  if (!(await mediaStorageService.storedMediaExists(cand.media.url))) return fail('DESIGN_FILE_MISSING', STUDIO_FAILURE_MESSAGES.DESIGN_FILE_MISSING);

  const attach = await attachGeneratedDesign(pub.project_id, pub._id, userId, {
    contentVersion: pub.contentVersion, baseDesignVersion: pub.designVersion, baseApprovalState: pub.approvalState, media: [{ url: cand.media.url, type: 'image' }], design: { generationId: rec._id, model: rec.model },
  });
  if (!attach.success) return fail(attach.error.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'DESIGN_VERSION_MISMATCH', 'The post changed while you were choosing. Reload and try again.', { reason: attach.error.code });
  let submitFailed = false;
  if (attach.publication.approvalState === 'content_approved') submitFailed = !(await submitDesignForApproval(pub.project_id, pub._id, userId)).success;

  // exactly one candidate of the record is the attached one
  await SocialDesignGeneration.updateOne({ _id: rec._id }, { $set: { 'candidates.$[c].attached': false } }, { arrayFilters: [{ 'c._id': { $ne: cand._id } }] });
  await SocialDesignGeneration.updateOne({ _id: rec._id }, { $set: { 'candidates.$[c].attached': true, 'candidates.$[c].attachedDesignVersion': attach.designVersion } }, { arrayFilters: [{ 'c._id': cand._id }] });
  LoggerUtil.info(`${EVENT} design_studio_selected`, { event: 'design_studio_selected', projectId: String(projectId), publicationId: String(pub._id), generationId: String(rec._id), designVersion: attach.designVersion, submitFailed });
  const fresh = await SocialDesignGeneration.findById(rec._id).lean();
  const freshPub = await SocialPublication.findById(pub._id).lean();
  return { success: true, designVersion: attach.designVersion, submitFailed, publication: await getPublication(projectId, String(pub._id)), generation: toApiStudioGeneration(fresh, freshPub) };
}

export default { getStudioState, startStudioGeneration, runStudioGeneration, selectStudioCandidate, splitContent, toApiStudioGeneration };
