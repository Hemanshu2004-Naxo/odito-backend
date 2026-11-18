import os from 'os';
import crypto from 'crypto';
import mongoose from 'mongoose';
import sharp from 'sharp';
import SocialPublication from '../../model/SocialPublication.js';
import SocialDesignGeneration from '../../model/SocialDesignGeneration.js';
import { attachGeneratedDesign, submitDesignForApproval, getPublication } from '../socialPublishingService.js';
import mediaStorageService from '../media/mediaStorageService.js';
import { processAndStoreDesign } from './designMedia.js';
import {
  loadBriefContext, loadDesignAssets, activeAccountFor, DESIGNABLE_STATES, getDesignProvider, isDesignProviderOverridden, recoverStaleDesignGenerations, designFailureFor, DESIGN_FAILURE_MESSAGES,
} from './socialDesignGenerationService.js';
import { loadDesignablePost } from './socialDesignStudioService.js';
import { conceptPipelineActive, conceptBrand, conceptInput, recentConcepts, withBrandFonts, PIPELINE } from './concept/conceptDesign.js';
import { generateCreativeBrief, reviseConcept, words } from './concept/creativeBrief.js';
import { renderConcept } from './concept/conceptPipeline.js';
import { planCarousel, regenerateSlides, captionPoints, getSlide } from './concept/carousel.js';
import { referenceFrom } from './concept/conceptPipeline.js';
import { claudeCostUsd, imageCostUsd, MIN_CAROUSEL_POINTS, MAX_CAROUSEL_POINTS } from './concept/conceptConfig.js';
import { CONCEPT_SIZES } from './designConfig.js';
import { LoggerUtil } from '../../../../utils/LoggerUtil.js';

/**
 * CONCEPT STUDIO - Creative Studio on the concept pipeline (brief -> image -> overlay -> QC).
 *
 *   Compare   3 DIFFERENT concepts (one creative brief), each rendered as a LOW-quality preview - cheap sketches to choose from. No QC.
 *   Pick      the chosen concept is rendered properly at MEDIUM: a single image (QC, concept / picture retries) or a carousel (the chosen
 *             concept is the hook; one slide per caption point and a CTA slide, the hook picture as the reference of every other slide).
 *             The result is attached to the post through the versioned attach and goes to Design Review.
 *   Slides    one carousel slide regenerated (from the stored brief and hook reference), slides reordered or removed (at least 2 stay):
 *             each is a new design version, so an approved carousel goes back to Design Review.
 *
 * Every job runs in the background on ONE generation record (one job in flight per post, database-enforced); its stage and every slide's
 * stage are written as they happen, so the page can be left and the progress read again. Every model call is costed and logged.
 * Posts with real product photos keep the original studio (the concept pipeline cannot place the real product yet).
 */

const INSTANCE = `${os.hostname()}:${process.pid}`;
const EVENT = '[SOCIAL_AI_CONCEPT_STUDIO]';
const toId = (id) => (mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : id);
const fail = (code, message, extra = {}) => ({ success: false, error: { code, message, ...extra } });
const round4 = (n) => Math.round((n || 0) * 10_000) / 10_000;
export const COMPARE_COUNT = 3;
export const PREVIEW_QUALITY = 'low';
export const FINAL_QUALITY = 'medium';
export const MIN_CAROUSEL_SLIDES = 2;
export const MAX_CAROUSEL_SLIDES = 10;
const STYLE_LABELS = { photo: 'Photo', '3d_render': '3D render', editorial_illustration: 'Editorial illustration', bold_typographic: 'Bold type' };

export const CONCEPT_STUDIO_MESSAGES = Object.freeze({
  NOT_A_LIST: 'A carousel needs a caption with 3 to 6 numbered points. Use a single image, or add the points to the caption.',
  CANDIDATE_NOT_READY: 'That concept is not ready yet.',
  SLIDE_NOT_FOUND: 'That slide was not found.',
  TOO_FEW_SLIDES: 'A carousel needs at least 2 slides.',
  ORDER_INVALID: 'The new order must list every slide exactly once.',
  NOT_A_CAROUSEL: 'This post\'s design is not a carousel made in Creative Studio.',
  GENERATION_IN_PROGRESS: 'A design is already being made for this post. Wait for it to finish.',
});

// ── helpers ────────────────────────────────────────────────────────────────

const keyOf = (projectId, url) => (url ? `${projectId}/${String(url).split('/').pop()}` : null);
const costOfCall = (c) => (c.kind === 'image' ? imageCostUsd(c.usage) : claudeCostUsd(c.model, c.usage));
/** A call as stored (no prompt, no provider text) and its cost. */
const callRecord = (c) => ({
  step: c.step || c.kind, kind: c.kind || 'text', model: c.model || null, modelReturned: c.modelReturned || null,
  inputTokens: c.usage?.inputTokens || 0, outputTokens: c.usage?.outputTokens || 0, durationMs: c.durationMs ?? null, usd: round4(c.costUsd ?? costOfCall(c)),
});
/** Every model call is logged (step, model, tokens, USD, time) - never a prompt or a provider message - and added to the record's cost. */
async function recordCalls(lock, ids, calls) {
  const list = (calls || []).map(callRecord);
  if (!list.length) return 0;
  const usd = round4(list.reduce((s, c) => s + (c.usd || 0), 0));
  for (const c of list) LoggerUtil.info(`${EVENT} design_call`, { event: 'design_call', ...ids, ...c });
  await SocialDesignGeneration.updateOne(lock, { $push: { 'cost.calls': { $each: list } }, $inc: { 'cost.usd': usd } });
  return usd;
}

async function storeDesign(png, projectId, platform) {
  const media = await processAndStoreDesign({ buffer: png, projectId, platform, logo: null });
  return { url: media.url, storageKey: keyOf(projectId, media.url), width: media.width, height: media.height, bytes: media.bytes };
}
async function storePicture(picture, projectId) {
  const up = await mediaStorageService.upload({ buffer: await sharp(picture).jpeg({ quality: 88 }).toBuffer(), projectId, extension: '.jpg' });
  return { url: up.url, storageKey: `${projectId}/${up.filename}` };
}
const shapeFor = () => 'portrait'; // 4:5 on both platforms (Instagram's best feed shape; Facebook shows it whole)

/** Does this post use the concept studio? (no real product photo to place, concept pipeline on) */
export async function usesConceptStudio(pub, liveProfile = null) {
  if (!conceptPipelineActive({ imageProviderOverridden: isDesignProviderOverridden() })) return false;
  const assets = await loadDesignAssets(pub, liveProfile).catch(() => ({ references: [] }));
  return !assets.references.length;
}

async function pipelineContext(pub) {
  const context = await loadBriefContext(pub);
  const assets = await loadDesignAssets(pub, context.liveProfile);
  const recentRecords = await SocialDesignGeneration.find({ project_id: pub.project_id, status: 'ready', 'creative.pipeline': PIPELINE.CONCEPT }).sort({ createdAt: -1 }).limit(5).select('creative.concept').lean();
  const brand = await withBrandFonts(conceptBrand(context.snapshotData, context.liveProfile), context.liveProfile);
  const input = conceptInput(pub, context.snapshotData, recentConcepts(recentRecords));
  return { context, assets, brand, input };
}

// ── read model ─────────────────────────────────────────────────────────────

const conceptView = (c) => (c ? { bigIdea: c.big_idea || null, headline: c.hook_headline || null, visualStyle: c.visual_style || null, layout: c.layout || null, label: c.visual_style ? `${STYLE_LABELS[c.visual_style] || c.visual_style}` : null } : null);

/** The concept-studio record as the UI shows it: phase, format, live stage, the compare previews, the slides (with needs-attention), the cost. */
export function toApiConceptGeneration(rec, pub = null) {
  if (!rec) return null;
  const currentUrls = new Set((pub?.media || []).map((m) => m.url));
  const slides = [...(rec.slides || [])].sort((a, b) => a.position - b.position).map((s) => ({
    key: s.key, kind: s.kind, position: s.position, status: s.status === 'generating' && !rec.active ? 'failed' : s.status, stage: rec.active ? s.stage || null : null,
    url: s.media?.url || null, width: s.media?.width || null, height: s.media?.height || null, inPost: !!(s.media?.url && currentUrls.has(s.media.url)),
    headline: s.concept?.hook_headline || null, number: s.concept?.number ?? null,
    qc: { score: s.qc?.score ?? null, passed: !!s.qc?.passed, retries: [...(s.qc?.retries || [])], needsAttention: s.qc?.needsAttention?.reasons ? { score: s.qc.needsAttention.score ?? null, failure: s.qc.needsAttention.failure || null, reasons: [...s.qc.needsAttention.reasons] } : null },
    costUsd: s.costUsd ?? null, revision: s.revision || 1, failure: s.failure?.code ? { code: s.failure.code, message: s.failure.message } : null,
  }));
  return {
    id: String(rec._id), pipeline: 'concept', status: rec.status, active: !!rec.active,
    phase: rec.studio?.phase || null, format: rec.studio?.format || null, action: rec.studio?.action || null, slideKey: rec.studio?.slideKey || null,
    stage: rec.active ? rec.generation?.stage || null : null,
    pickedCandidateId: rec.studio?.pickedCandidateId ? String(rec.studio.pickedCandidateId) : null,
    candidates: (rec.candidates || []).map((c) => ({
      id: String(c._id), slot: c.slot, status: c.status === 'pending' && !rec.active ? 'failed' : c.status, label: c.label || null, concept: conceptView(c.concept),
      preview: c.media?.url ? { url: c.media.url, width: c.media.width, height: c.media.height, quality: c.quality || PREVIEW_QUALITY } : null,
      picked: !!(rec.studio?.pickedCandidateId && String(rec.studio.pickedCandidateId) === String(c._id)),
      costUsd: c.costUsd ?? null, failure: c.failure?.code ? { code: c.failure.code, message: c.failure.message } : null,
    })),
    slides,
    single: rec.studio?.format === 'single' && rec.result?.mediaUrl ? { url: rec.result.mediaUrl, qc: rec.creative?.qc?.score != null ? { score: rec.creative.qc.score, passed: !!rec.creative.qc.passed, retries: [...(rec.creative.qc.retries || [])], needsAttention: rec.creative.qc.needsAttention?.reasons ? { ...rec.creative.qc.needsAttention } : null } : null } : null,
    needsAttention: slides.filter((s) => s.qc.needsAttention && s.inPost).length + (rec.creative?.qc?.needsAttention?.reasons?.length ? 1 : 0),
    costUsd: rec.cost?.usd != null ? round4(rec.cost.usd) : null,
    startedAt: rec.generation?.startedAt ? new Date(rec.generation.startedAt).toISOString() : null,
    finishedAt: rec.generation?.finishedAt ? new Date(rec.generation.finishedAt).toISOString() : null,
    failure: rec.status === 'failed' ? { code: rec.failure?.code || 'GENERATION_FAILED', message: rec.failure?.message || DESIGN_FAILURE_MESSAGES.GENERATION_FAILED } : null,
  };
}

export const latestConceptRecord = (projectId, publicationId) => SocialDesignGeneration.findOne({ project_id: toId(projectId), publication_id: toId(publicationId), mode: 'studio', 'studio.pipeline': 'concept' }).sort({ createdAt: -1 }).lean();

/** The record whose slides ARE the post's current carousel (the one the post's design provenance names). */
async function carouselRecordFor(pub) {
  if (!pub.design?.generationId) return null;
  const rec = await SocialDesignGeneration.findOne({ _id: pub.design.generationId, project_id: pub.project_id, publication_id: pub._id, 'studio.pipeline': 'concept' }).lean();
  return rec?.slides?.length ? rec : null;
}

/** Slides of the post's carousel (for Content Approvals): order, files, QC and needs-attention. */
export async function getCarouselSlides(projectId, publicationId) {
  if (typeof publicationId !== 'string' || !mongoose.Types.ObjectId.isValid(publicationId)) return fail('INVALID_PUBLICATION', 'publicationId is required.');
  const pub = await SocialPublication.findOne({ _id: toId(publicationId), project_id: toId(projectId) }).lean();
  if (!pub) return fail('NOT_FOUND', 'That publication was not found.');
  await recoverStaleDesignGenerations(projectId, { publicationId });
  const rec = await carouselRecordFor(pub);
  const active = await SocialDesignGeneration.findOne({ publication_id: pub._id, active: true }).lean();
  return { success: true, designVersion: pub.designVersion, approvalState: pub.approvalState ?? null, generation: rec ? toApiConceptGeneration(active && String(active._id) === String(rec._id) ? active : rec, pub) : null, busy: !!active };
}

// ── costs ──────────────────────────────────────────────────────────────────

/** What the designs cost: this post (every generation, ever) and the brand (project) this calendar month (UTC). */
export async function getDesignCosts(projectId, { publicationId = null, now = new Date() } = {}) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const [month] = await SocialDesignGeneration.aggregate([
    { $match: { project_id: toId(projectId), createdAt: { $gte: start, $lt: end } } },
    { $group: { _id: null, usd: { $sum: { $ifNull: ['$cost.usd', 0] } }, generations: { $sum: 1 }, calls: { $sum: { $size: { $ifNull: ['$cost.calls', []] } } } } },
  ]);
  let post = null;
  if (publicationId && mongoose.Types.ObjectId.isValid(publicationId)) {
    const [p] = await SocialDesignGeneration.aggregate([
      { $match: { project_id: toId(projectId), publication_id: toId(publicationId) } },
      { $group: { _id: null, usd: { $sum: { $ifNull: ['$cost.usd', 0] } }, generations: { $sum: 1 }, calls: { $sum: { $size: { $ifNull: ['$cost.calls', []] } } } } },
    ]);
    post = { usd: round4(p?.usd || 0), generations: p?.generations || 0, calls: p?.calls || 0 };
  }
  return { success: true, currency: 'USD', post, month: { key: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`, usd: round4(month?.usd || 0), generations: month?.generations || 0, calls: month?.calls || 0 } };
}

// ── claiming ───────────────────────────────────────────────────────────────

/** Claims the post for a job: a new record (compare) or the existing one (render / slide). One job in flight per post. */
async function claimExisting(rec, pub, set) {
  const lockedBy = `${INSTANCE}:${crypto.randomUUID()}`;
  const claimed = await SocialDesignGeneration.findOneAndUpdate(
    { _id: rec._id, active: false },
    { $set: { ...set, status: 'generating', active: true, baseDesignVersion: pub.designVersion, baseApprovalState: pub.approvalState, contentVersion: pub.contentVersion, 'generation.startedAt': new Date(), 'generation.finishedAt': null, 'generation.lockedBy': lockedBy, 'generation.stage': null, failure: { code: null, message: null, at: null } } },
    { new: true },
  ).lean().catch((error) => { if (error?.code === 11000) return null; throw error; });
  return claimed ? { rec: claimed, lockedBy } : null;
}

function runInBackground(fn, background) {
  if (!background) return fn();
  setImmediate(() => fn().catch((error) => LoggerUtil.error(`${EVENT} job bookkeeping failed`, { message: error.message })));
  return null;
}

// ── 1. Compare ─────────────────────────────────────────────────────────────

/** Starts Compare: 3 concepts as low previews. input: { publicationId, contentVersion, format: 'single' | 'carousel', replaceApproved? } */
export async function startConceptCompare(projectId, userId, input = {}, { background = true } = {}) {
  const format = input?.format === 'carousel' ? 'carousel' : 'single';
  const checked = await loadDesignablePost(projectId, input?.publicationId, input?.contentVersion);
  if (!checked.success) return checked;
  const { pub } = checked;
  if (format === 'carousel') {
    const n = captionPoints(pub.content).length;
    if (n < MIN_CAROUSEL_POINTS || n > MAX_CAROUSEL_POINTS) return fail('CAROUSEL_NEEDS_POINTS', CONCEPT_STUDIO_MESSAGES.NOT_A_LIST);
  }
  await recoverStaleDesignGenerations(projectId, { publicationId: String(pub._id) });
  const running = await SocialDesignGeneration.findOne({ publication_id: pub._id, active: true }).lean();
  if (running) return { success: true, started: false, alreadyRunning: true, generation: running.studio?.pipeline === 'concept' ? toApiConceptGeneration(running, pub) : null };

  const lockedBy = `${INSTANCE}:${crypto.randomUUID()}`;
  let rec;
  try {
    rec = await SocialDesignGeneration.create({
      project_id: pub.project_id, publication_id: pub._id, status: 'generating', active: true, mode: 'studio', platform: pub.platform, contentVersion: pub.contentVersion,
      baseDesignVersion: pub.designVersion, baseApprovalState: pub.approvalState, replaceApproved: input?.replaceApproved === true, provider: 'openai', size: CONCEPT_SIZES.portrait.request,
      studio: { pipeline: 'concept', phase: 'compare', format, action: 'generate_all' },
      candidates: Array.from({ length: COMPARE_COUNT }, (_, slot) => ({ slot, status: 'pending' })),
      generation: { startedAt: new Date(), lockedBy, stage: 'concept', promptVersion: 'concept-studio-v1' }, cost: { usd: 0, calls: [] }, requestedBy: userId || null,
    });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const active = await SocialDesignGeneration.findOne({ publication_id: pub._id, active: true }).lean();
    return { success: true, started: false, alreadyRunning: true, generation: active ? toApiConceptGeneration(active, pub) : null };
  }
  LoggerUtil.info(`${EVENT} compare_started`, { event: 'compare_started', projectId: String(projectId), publicationId: String(pub._id), generationId: String(rec._id), format });
  const done = runInBackground(() => runConceptCompare(rec._id, lockedBy), background);
  if (done) await done;
  const fresh = await SocialDesignGeneration.findById(rec._id).lean();
  return { success: true, started: true, alreadyRunning: false, generation: toApiConceptGeneration(fresh, pub) };
}

export async function runConceptCompare(generationId, lockedBy) {
  const lock = { _id: generationId, active: true, 'generation.lockedBy': lockedBy };
  const rec = await SocialDesignGeneration.findOne(lock).lean();
  if (!rec) return null;
  const projectId = String(rec.project_id);
  const ids = { projectId, publicationId: String(rec.publication_id), generationId: String(generationId) };
  const started = Date.now();
  const stored = [];
  try {
    const pub = await SocialPublication.findOne({ _id: rec.publication_id, project_id: rec.project_id }).lean();
    if (!pub || pub.status !== 'draft' || pub.contentVersion !== rec.contentVersion) throw Object.assign(new Error('stale'), { code: 'DESIGN_STALE' });
    const { brand, input } = await pipelineContext(pub);
    const provider = getDesignProvider();
    await SocialDesignGeneration.updateOne(lock, { $set: { 'generation.stage': 'concept' } });
    const carousel = rec.studio?.format === 'carousel';
    const brief = await generateCreativeBrief({
      ...input, count: COMPARE_COUNT, brand, format: 'single_image',
      direction: carousel ? 'These are three different HOOK concepts for a carousel (the cover slide that makes people swipe); the chosen one opens the carousel.' : '',
    });
    await recordCalls(lock, ids, brief.calls.map((c) => ({ kind: 'text', ...c })));
    await SocialDesignGeneration.updateOne(lock, { $set: { 'generation.stage': 'previews', ...Object.fromEntries(brief.concepts.flatMap((c, i) => [[`candidates.${i}.concept`, c], [`candidates.${i}.label`, `${STYLE_LABELS[c.visual_style] || c.visual_style} · ${c.layout.replace(/_/g, ' ')}`]])) } });

    const results = await Promise.all(brief.concepts.map(async (concept, i) => {
      try {
        const out = await renderConcept({ concept, provider, brand, caption: input.caption, facts: input.facts, shape: shapeFor(), quality: PREVIEW_QUALITY, qcRetries: 0, kicker: input.pillar || null, skipQc: true });
        const media = await storeDesign(out.png, projectId, pub.platform); stored.push(media.url);
        const picture = await storePicture(out.picture, projectId); stored.push(picture.url);
        await recordCalls(lock, ids, out.calls);
        await SocialDesignGeneration.updateOne({ ...lock, [`candidates.${i}.slot`]: i }, { $set: { [`candidates.${i}.status`]: 'ready', [`candidates.${i}.media`]: media, [`candidates.${i}.visual`]: picture, [`candidates.${i}.quality`]: PREVIEW_QUALITY, [`candidates.${i}.costUsd`]: out.costUsd, [`candidates.${i}.layoutId`]: concept.layout, [`candidates.${i}.creativeType`]: concept.visual_style, [`candidates.${i}.generatedAt`]: new Date() } });
        return { ok: true };
      } catch (error) {
        const f = designFailureFor(error);
        await SocialDesignGeneration.updateOne(lock, { $set: { [`candidates.${i}.status`]: 'failed', [`candidates.${i}.failure`]: { code: f.code, message: f.message } } });
        LoggerUtil.warn(`${EVENT} preview_failed`, { event: 'preview_failed', ...ids, slot: i, code: error?.code || null, reason: error?.reason || null });
        return { ok: false, failure: f };
      }
    }));
    const ok = results.filter((r) => r.ok).length;
    const status = ok ? 'ready' : 'failed';
    const failure = ok ? { code: null, message: null, at: null } : { ...(results[0]?.failure || { code: 'GENERATION_FAILED', message: DESIGN_FAILURE_MESSAGES.GENERATION_FAILED }), at: new Date() };
    const saved = await SocialDesignGeneration.findOneAndUpdate(lock, { $set: { status, active: false, failure, 'generation.stage': null, 'generation.finishedAt': new Date(), 'generation.durationMs': Date.now() - started } }, { new: true }).lean();
    if (!saved) { for (const url of stored) await mediaStorageService.deleteByUrl(url); return null; } // eslint-disable-line no-await-in-loop
    LoggerUtil.info(`${EVENT} compare_completed`, { event: 'compare_completed', ...ids, ready: ok, durationMs: Date.now() - started, costUsd: saved.cost?.usd ?? null });
    return saved;
  } catch (error) {
    for (const url of stored) await mediaStorageService.deleteByUrl(url); // eslint-disable-line no-await-in-loop
    if (error?.calls) await recordCalls(lock, ids, error.calls.map((c) => ({ kind: 'text', ...c })));
    const f = designFailureFor(error);
    await SocialDesignGeneration.updateOne(lock, { $set: { status: 'failed', active: false, 'generation.stage': null, 'generation.finishedAt': new Date(), failure: { code: error?.code === 'DESIGN_STALE' ? 'DESIGN_STALE' : f.code, message: f.message, at: new Date() } } });
    LoggerUtil.error(`${EVENT} compare_failed`, { event: 'compare_failed', ...ids, failureCode: f.code, providerCode: error?.code || null });
    return null;
  }
}

/** One Compare preview again: a DIFFERENT concept for that slot (optionally steered by the person's words), as a low preview. */
export async function regenerateConceptPreview(projectId, userId, input = {}, { background = true } = {}) {
  const checked = await loadDesignablePost(projectId, input?.publicationId, input?.contentVersion);
  if (!checked.success) return checked;
  const { pub } = checked;
  const rec = await SocialDesignGeneration.findOne({ _id: toId(input?.generationId), project_id: pub.project_id, publication_id: pub._id, 'studio.pipeline': 'concept' }).lean();
  if (!rec) return fail('NOT_FOUND', 'Those designs were not found.');
  const cand = (rec.candidates || []).find((c) => String(c._id) === String(input?.candidateId));
  if (!cand?.concept) return fail('NOT_FOUND', 'That design was not found.');
  // control characters are removed from the person's words on purpose
  // eslint-disable-next-line no-control-regex
  const instruction = typeof input?.instruction === 'string' ? input.instruction.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, 400) : '';
  const claim = await claimExisting(rec, pub, { 'studio.phase': 'compare', 'studio.action': 'regenerate', 'studio.candidateId': cand._id, 'generation.stage': 'concept' });
  if (!claim) return fail('GENERATION_IN_PROGRESS', CONCEPT_STUDIO_MESSAGES.GENERATION_IN_PROGRESS);
  const job = async () => {
    const lock = { _id: rec._id, active: true, 'generation.lockedBy': claim.lockedBy };
    const ids = { projectId: String(projectId), publicationId: String(pub._id), generationId: String(rec._id) };
    const i = (rec.candidates || []).findIndex((c) => String(c._id) === String(cand._id));
    try {
      const { brand, input: pin } = await pipelineContext(pub);
      await SocialDesignGeneration.updateOne(lock, { $set: { [`candidates.${i}.status`]: 'pending' } });
      const others = rec.candidates.filter((c) => String(c._id) !== String(cand._id) && c.concept).map((c) => c.concept.big_idea);
      const revised = await reviseConcept({ concept: cand.concept, problems: [instruction ? `The person asked: "${instruction}"` : 'The person wants a different idea for this option.', ...(others.length ? [`It must differ from the other options: ${others.join(' | ')}`] : [])], input: pin, brand });
      await recordCalls(lock, ids, revised.calls.map((c) => ({ kind: 'text', ...c })));
      await SocialDesignGeneration.updateOne(lock, { $set: { 'generation.stage': 'previews' } });
      const out = await renderConcept({ concept: revised.concept, provider: getDesignProvider(), brand, caption: pin.caption, facts: pin.facts, shape: shapeFor(), quality: PREVIEW_QUALITY, qcRetries: 0, skipQc: true });
      const media = await storeDesign(out.png, String(projectId), pub.platform);
      const picture = await storePicture(out.picture, String(projectId));
      await recordCalls(lock, ids, out.calls);
      const old = [cand.media?.url, cand.visual?.url].filter(Boolean);
      await SocialDesignGeneration.updateOne(lock, { $set: { [`candidates.${i}.status`]: 'ready', [`candidates.${i}.concept`]: revised.concept, [`candidates.${i}.media`]: media, [`candidates.${i}.visual`]: picture, [`candidates.${i}.revision`]: (cand.revision || 1) + 1, [`candidates.${i}.instruction`]: instruction || null, [`candidates.${i}.costUsd`]: out.costUsd, [`candidates.${i}.label`]: `${STYLE_LABELS[revised.concept.visual_style] || revised.concept.visual_style} · ${revised.concept.layout.replace(/_/g, ' ')}` } });
      for (const url of old) await mediaStorageService.deleteByUrl(url); // eslint-disable-line no-await-in-loop
      await SocialDesignGeneration.updateOne(lock, { $set: { status: 'ready', active: false, 'generation.stage': null, 'generation.finishedAt': new Date() } });
    } catch (error) {
      const f = designFailureFor(error);
      await SocialDesignGeneration.updateOne(lock, { $set: { [`candidates.${i}.status`]: cand.media?.url ? 'ready' : 'failed', status: 'ready', active: false, 'generation.stage': null, 'generation.finishedAt': new Date(), failure: { code: f.code, message: f.message, at: new Date() } } });
      LoggerUtil.warn(`${EVENT} preview_regenerate_failed`, { event: 'preview_regenerate_failed', ...ids, code: error?.code || null });
    }
  };
  const done = runInBackground(job, background);
  if (done) await done;
  return { success: true, started: true, alreadyRunning: false, generation: toApiConceptGeneration(await SocialDesignGeneration.findById(rec._id).lean(), pub) };
}

// ── 2. Pick -> render ──────────────────────────────────────────────────────

/** The chosen concept, rendered at MEDIUM as a single image or as a carousel, then attached (to Design Review). */
export async function startConceptRender(projectId, userId, input = {}, { background = true } = {}) {
  const checked = await loadDesignablePost(projectId, input?.publicationId, input?.contentVersion);
  if (!checked.success) return checked;
  const { pub } = checked;
  if (!Number.isInteger(input?.designVersion) || input.designVersion !== pub.designVersion) return fail('DESIGN_VERSION_MISMATCH', 'The design changed since you loaded it. Reload and try again.', { currentDesignVersion: pub.designVersion });
  if (pub.approvalState === 'design_approved' && (pub.media || []).length && input?.replaceApproved !== true) return fail('DESIGN_ALREADY_APPROVED', 'This design is already approved. Replacing it sends the post back to design review.');
  const rec = await SocialDesignGeneration.findOne({ _id: toId(input?.generationId), project_id: pub.project_id, publication_id: pub._id, 'studio.pipeline': 'concept' }).lean();
  if (!rec) return fail('NOT_FOUND', 'Those designs were not found.');
  if (rec.contentVersion !== pub.contentVersion) return fail('CANDIDATE_STALE', 'These designs were made for an earlier caption. Generate new ones.');
  const cand = (rec.candidates || []).find((c) => String(c._id) === String(input?.candidateId));
  if (!cand || cand.status !== 'ready' || !cand.concept) return fail('CANDIDATE_NOT_READY', CONCEPT_STUDIO_MESSAGES.CANDIDATE_NOT_READY);
  const format = input?.format === 'carousel' || input?.format === 'single' ? input.format : (rec.studio?.format || 'single');
  if (format === 'carousel') {
    const n = captionPoints(pub.content).length;
    if (n < MIN_CAROUSEL_POINTS || n > MAX_CAROUSEL_POINTS) return fail('CAROUSEL_NEEDS_POINTS', CONCEPT_STUDIO_MESSAGES.NOT_A_LIST);
  }
  const claim = await claimExisting(rec, pub, { 'studio.phase': 'render', 'studio.format': format, 'studio.action': 'render', 'studio.pickedCandidateId': cand._id, replaceApproved: input?.replaceApproved === true, 'generation.stage': 'concept', slides: [] });
  if (!claim) return fail('GENERATION_IN_PROGRESS', CONCEPT_STUDIO_MESSAGES.GENERATION_IN_PROGRESS);
  LoggerUtil.info(`${EVENT} render_started`, { event: 'render_started', projectId: String(projectId), publicationId: String(pub._id), generationId: String(rec._id), format });
  const done = runInBackground(() => runConceptRender(rec._id, claim.lockedBy, userId), background);
  if (done) await done;
  return { success: true, started: true, alreadyRunning: false, generation: toApiConceptGeneration(await SocialDesignGeneration.findById(rec._id).lean(), await SocialPublication.findById(pub._id).lean()) };
}

/** Attaches the ordered media and submits a first design for review (the workflow's own transition). */
async function attachMedia(rec, pub, userId, mediaUrls, format, model) {
  const attach = await attachGeneratedDesign(rec.project_id, rec.publication_id, userId || rec.requestedBy, {
    contentVersion: rec.contentVersion, baseDesignVersion: rec.baseDesignVersion, baseApprovalState: rec.baseApprovalState,
    media: mediaUrls.map((url) => ({ url, type: 'image' })), design: { generationId: rec._id, model, format },
  });
  if (!attach.success) return attach;
  if (attach.publication.approvalState === 'content_approved') await submitDesignForApproval(rec.project_id, rec.publication_id, userId || rec.requestedBy);
  return attach;
}

export async function runConceptRender(generationId, lockedBy, userId = null) {
  const lock = { _id: generationId, active: true, 'generation.lockedBy': lockedBy };
  const rec = await SocialDesignGeneration.findOne(lock).lean();
  if (!rec) return null;
  const projectId = String(rec.project_id);
  const ids = { projectId, publicationId: String(rec.publication_id), generationId: String(generationId) };
  const started = Date.now();
  const stored = [];
  try {
    const pub = await SocialPublication.findOne({ _id: rec.publication_id, project_id: rec.project_id }).lean();
    if (!pub || pub.status !== 'draft' || pub.contentVersion !== rec.contentVersion || !DESIGNABLE_STATES.includes(pub.approvalState)) throw Object.assign(new Error('stale'), { code: 'DESIGN_STALE' });
    const account = await activeAccountFor(rec.project_id, rec.platform);
    if (!account || String(account._id) !== String(pub.social_account_id)) throw Object.assign(new Error('account gone'), { code: 'PLATFORM_NOT_CONNECTED' });
    const cand = rec.candidates.find((c) => String(c._id) === String(rec.studio.pickedCandidateId));
    const { brand, input } = await pipelineContext(pub);
    const provider = getDesignProvider();
    const format = rec.studio.format;
    let mediaUrls; let model = null; let creative = null;

    if (format === 'single') {
      await SocialDesignGeneration.updateOne(lock, { $set: { 'generation.stage': 'image' } });
      const out = await renderConcept({
        concept: cand.concept, provider, brand, caption: input.caption, facts: input.facts, shape: shapeFor(), quality: FINAL_QUALITY, kicker: input.pillar || null,
        onStage: (s) => SocialDesignGeneration.updateOne(lock, { $set: { 'generation.stage': s === 'image' ? 'image' : s === 'quality' ? 'quality' : 'image' } }),
        reviseConcept: ({ concept: cur, qc }) => reviseConcept({ concept: cur, problems: (qc.issues || []).filter((i) => !/^possible \(mild\)/.test(i)).slice(0, 6), input, brand }),
      });
      await recordCalls(lock, ids, out.calls);
      const media = await storeDesign(out.png, projectId, pub.platform); stored.push(media.url);
      mediaUrls = [media.url]; model = out.image?.model || null;
      creative = {
        pipeline: 'concept', type: out.concept.visual_style, label: `${STYLE_LABELS[out.concept.visual_style] || out.concept.visual_style} · ${out.concept.layout.replace(/_/g, ' ')}`, layoutId: out.concept.layout,
        concept: { format: 'single_image', big_idea: out.concept.big_idea, hook_headline: out.concept.hook_headline, subline: out.concept.subline || '', cta: out.concept.cta || '', visual_style: out.concept.visual_style, layout: out.concept.layout, image_prompt: out.concept.image_prompt },
        imagePrompt: out.imagePrompt, image: { model: out.image?.model || null, modelReturned: out.image?.modelReturned || null, fallbackUsed: !!out.image?.fallbackUsed, quality: FINAL_QUALITY, size: out.image?.size || null, seed: null, referenceImages: 0 },
        qc: { score: out.qc.score, passed: out.qc.passed, hardFail: out.qc.hardFail, issues: out.qc.issues.slice(0, 10), retries: out.retries, needsAttention: out.needsAttention, attempts: out.attempts.length },
      };
      await SocialDesignGeneration.updateOne(lock, { $set: { creative, 'result.mediaUrl': media.url, 'result.width': media.width, 'result.height': media.height, 'result.bytes': media.bytes } });
    } else {
      // CAROUSEL: the chosen concept is the hook
      await SocialDesignGeneration.updateOne(lock, { $set: { 'generation.stage': 'concept' } });
      const c0 = cand.concept;
      // the SPLIT brief: the look + hook first (the hook picture starts at once), the other slides written in parallel meanwhile
      const plan = await planCarousel({
        ...input, brand,
        direction: `Hook slide: use THIS chosen concept - idea: ${c0.big_idea}; visual style: ${c0.visual_style}; headline: "${c0.hook_headline}"; picture: ${c0.image_prompt}. Every other slide continues the same world and style.`,
      });
      await recordCalls(lock, ids, plan.calls.map((c) => ({ kind: 'text', ...c })));
      const points = plan.points;
      const order = ['hook', ...points.map((p) => `p${p.number}`), 'cta'];
      const slideDoc = (key, position) => ({ key, kind: key === 'hook' ? 'hook' : key === 'cta' ? 'cta' : 'point', position, status: 'pending', concept: { hook_headline: key === 'hook' ? plan.look.hook.headline : null, number: key.startsWith('p') ? Number(key.slice(1)) : null, big_idea: null } });
      await SocialDesignGeneration.updateOne(lock, { $set: { slides: order.map(slideDoc), 'generation.stage': 'hook' } });
      const hookJudgeFor = async (id) => (await plan.hookJudge).picks?.[id] || null;
      // the other slides' briefs arrive while the hook picture is made; their headlines show in the progress as soon as they do
      const restReady = plan.rest.then(async (rest) => {
        await recordCalls(lock, ids, rest.calls.map((c) => ({ kind: 'text', ...c })));
        await SocialDesignGeneration.updateOne(lock, { $set: { 'carousel.brief': rest.carousel, ...Object.fromEntries(order.slice(1).flatMap((key, i) => { const s = getSlide(rest.carousel, key); return [[`slides.${i + 1}.concept.hook_headline`, s?.headline || null], [`slides.${i + 1}.concept.big_idea`, s?.visual_idea || null]]; })) } });
        return rest;
      });
      const persist = async (out) => {
        const key = out.id;
        if (out.error) {
          await SocialDesignGeneration.updateOne({ ...lock, 'slides.key': key }, { $set: { 'slides.$.status': 'failed', 'slides.$.stage': null, 'slides.$.failure': { code: out.error.code, message: designFailureFor(out.error).message } } });
          return null;
        }
        const media = await storeDesign(out.png, projectId, pub.platform); stored.push(media.url);
        const picture = await storePicture(out.picture, projectId); stored.push(picture.url);
        await recordCalls(lock, ids, out.calls);
        await SocialDesignGeneration.updateOne({ ...lock, 'slides.key': key }, { $set: {
          'slides.$.status': 'ready', 'slides.$.stage': null, 'slides.$.media': media, 'slides.$.picture': picture, 'slides.$.concept': { ...out.concept, number: out.concept.number ?? null },
          'slides.$.imagePrompt': out.imagePrompt, 'slides.$.image': { model: out.image?.model || null, modelReturned: out.image?.modelReturned || null, fallbackUsed: !!out.image?.fallbackUsed, quality: FINAL_QUALITY, size: out.image?.size || null, references: out.image?.references || 0 },
          'slides.$.qc': { score: out.qc.score, passed: out.qc.passed, issues: out.qc.issues.slice(0, 10), retries: out.retries, needsAttention: out.needsAttention }, 'slides.$.costUsd': out.costUsd, 'slides.$.generatedAt': new Date(),
        } });
        model = out.image?.model || model;
        return { media, picture };
      };
      const onSlideStart = (key) => SocialDesignGeneration.updateOne({ ...lock, 'slides.key': key }, { $set: { 'slides.$.status': 'generating', 'slides.$.stage': 'image' } });
      const [[hook], rest] = await Promise.all([
        regenerateSlides({ carousel: plan.partial, ids: ['hook'], reference: null, provider, brand, input, points, quality: FINAL_QUALITY, judgeFor: hookJudgeFor, onSlideStart, total: plan.total }),
        restReady,
      ]);
      const hookStored = await persist(hook);
      if (!hookStored) throw Object.assign(new Error('hook failed'), { code: hook.error?.code || 'GENERATION_FAILED' });
      await SocialDesignGeneration.updateOne(lock, { $set: { 'carousel.reference': hookStored.picture, 'carousel.brief': { ...rest.carousel, hook: { ...rest.carousel.hook, headline: hook.concept?.hook_headline || rest.carousel.hook.headline } }, 'generation.stage': 'slides' } });
      const reference = await referenceFrom(hook.picture);
      const judgeFor = async (id) => (await rest.judge).picks?.[id] || null;
      await regenerateSlides({ carousel: rest.carousel, ids: order.slice(1), reference, provider, brand, input, points, quality: FINAL_QUALITY, judgeFor, onSlideStart, onSlideDone: persist });
      const [hj, rj] = await Promise.all([plan.hookJudge, rest.judge]);
      await recordCalls(lock, ids, [{ kind: 'text', ...hj.call }, { kind: 'text', ...rj.call }]);
      await SocialDesignGeneration.updateOne(lock, { $set: { 'generation.stage': 'quality' } });
      const now = await SocialDesignGeneration.findById(generationId).lean();
      const ready = (now.slides || []).filter((s) => s.status === 'ready').sort((a, b) => a.position - b.position);
      if (ready.length < MIN_CAROUSEL_SLIDES) throw Object.assign(new Error('too few slides'), { code: 'GENERATION_FAILED' });
      mediaUrls = ready.map((s) => s.media.url);
    }

    // the caption may have changed while the images were being made
    const after = await SocialPublication.findOne({ _id: rec.publication_id, project_id: rec.project_id }).lean();
    if (!after || after.contentVersion !== rec.contentVersion) throw Object.assign(new Error('content changed'), { code: 'DESIGN_STALE' });
    const attach = await attachMedia(rec, after, userId, mediaUrls, format, model);
    if (!attach.success) throw Object.assign(new Error('attach'), { code: 'DESIGN_STALE', reason: attach.error?.code });
    const saved = await SocialDesignGeneration.findOneAndUpdate(lock, { $set: { status: 'ready', active: false, model, 'result.designVersion': attach.designVersion, 'generation.stage': null, 'generation.finishedAt': new Date(), 'generation.durationMs': Date.now() - started, failure: { code: null, message: null, at: null } } }, { new: true }).lean();
    // the post's previous design files are kept (as every other design path does): only files this run made are ever removed by it
    LoggerUtil.info(`${EVENT} render_completed`, { event: 'render_completed', ...ids, format, slides: mediaUrls.length, designVersion: attach.designVersion, durationMs: Date.now() - started, costUsd: saved?.cost?.usd ?? null, needsAttention: (saved?.slides || []).filter((s) => s.qc?.needsAttention).length });
    return saved;
  } catch (error) {
    for (const url of stored) await mediaStorageService.deleteByUrl(url); // eslint-disable-line no-await-in-loop
    if (error?.calls) await recordCalls(lock, ids, error.calls.map((c) => ({ kind: 'text', ...c })));
    const f = designFailureFor(error);
    const code = error?.code === 'DESIGN_STALE' ? 'DESIGN_STALE' : error?.code === 'CAROUSEL_NEEDS_POINTS' ? 'CAROUSEL_NEEDS_POINTS' : f.code;
    await SocialDesignGeneration.updateOne(lock, { $set: { status: 'failed', active: false, 'generation.stage': null, 'generation.finishedAt': new Date(), 'generation.durationMs': Date.now() - started, failure: { code, message: code === 'CAROUSEL_NEEDS_POINTS' ? CONCEPT_STUDIO_MESSAGES.NOT_A_LIST : f.message, at: new Date() } } });
    LoggerUtil.error(`${EVENT} render_failed`, { event: 'render_failed', ...ids, failureCode: code, providerCode: error?.code || null, reason: error?.reason || null, durationMs: Date.now() - started });
    return null;
  }
}

// ── 3. Slides: regenerate one, reorder, remove ─────────────────────────────

async function loadCarouselForEdit(projectId, input) {
  const checked = await loadDesignablePost(projectId, input?.publicationId, input?.contentVersion);
  if (!checked.success) return checked;
  const { pub } = checked;
  if (!Number.isInteger(input?.designVersion) || input.designVersion !== pub.designVersion) return fail('DESIGN_VERSION_MISMATCH', 'The design changed since you loaded it. Reload and try again.', { currentDesignVersion: pub.designVersion });
  const rec = await carouselRecordFor(pub);
  if (!rec) return fail('NOT_A_CAROUSEL', CONCEPT_STUDIO_MESSAGES.NOT_A_CAROUSEL);
  if (rec.active) return fail('GENERATION_IN_PROGRESS', CONCEPT_STUDIO_MESSAGES.GENERATION_IN_PROGRESS);
  return { success: true, pub, rec };
}

const inPostSlides = (rec, pub) => {
  const urls = (pub.media || []).map((m) => m.url);
  return urls.map((u) => (rec.slides || []).find((s) => s.media?.url === u)).filter(Boolean);
};

/** "Regenerate this slide": the slide again from the stored carousel brief (the hook picture as reference), then the post's media updated. */
export async function regenerateCarouselSlide(projectId, userId, input = {}, { background = true } = {}) {
  const loaded = await loadCarouselForEdit(projectId, input);
  if (!loaded.success) return loaded;
  const { pub, rec } = loaded;
  const slide = (rec.slides || []).find((s) => s.key === input?.slideKey);
  if (!slide || !inPostSlides(rec, pub).some((s) => s.key === slide.key)) return fail('SLIDE_NOT_FOUND', CONCEPT_STUDIO_MESSAGES.SLIDE_NOT_FOUND);
  const claim = await claimExisting(rec, pub, { 'studio.phase': 'slide', 'studio.action': 'regenerate_slide', 'studio.slideKey': slide.key, 'generation.stage': 'image' });
  if (!claim) return fail('GENERATION_IN_PROGRESS', CONCEPT_STUDIO_MESSAGES.GENERATION_IN_PROGRESS);
  const job = async () => {
    const lock = { _id: rec._id, active: true, 'generation.lockedBy': claim.lockedBy };
    const ids = { projectId: String(projectId), publicationId: String(pub._id), generationId: String(rec._id), slide: slide.key };
    const stored = [];
    try {
      const { brand, input: pin } = await pipelineContext(pub);
      const refBytes = slide.key === 'hook' ? null : await mediaStorageService.readByKey(rec.carousel?.reference?.storageKey, { projectId: String(projectId) });
      const reference = refBytes ? await referenceFrom(refBytes) : null;
      if (slide.key !== 'hook' && !reference) throw Object.assign(new Error('reference missing'), { code: 'DESIGN_FILE_MISSING' });
      await SocialDesignGeneration.updateOne({ ...lock, 'slides.key': slide.key }, { $set: { 'slides.$.status': 'generating', 'slides.$.stage': 'image' } });
      const c = rec.carousel.brief;
      const [out] = await regenerateSlides({ carousel: c, ids: [slide.key], reference, provider: getDesignProvider(), brand, input: pin, points: captionPoints(pub.content), quality: FINAL_QUALITY });
      if (out.error) throw Object.assign(new Error('slide failed'), { code: out.error.code });
      const media = await storeDesign(out.png, String(projectId), pub.platform); stored.push(media.url);
      const picture = await storePicture(out.picture, String(projectId)); stored.push(picture.url);
      await recordCalls(lock, ids, out.calls);
      const current = await SocialPublication.findById(pub._id).lean();
      const urls = (current.media || []).map((m) => (m.url === slide.media.url ? media.url : m.url));
      const attach = await attachMedia({ ...rec, contentVersion: current.contentVersion, baseDesignVersion: current.designVersion, baseApprovalState: current.approvalState }, current, userId, urls, 'carousel', out.image?.model || rec.model);
      if (!attach.success) throw Object.assign(new Error('attach'), { code: 'DESIGN_STALE' });
      await SocialDesignGeneration.updateOne({ ...lock, 'slides.key': slide.key }, { $set: {
        'slides.$.status': 'ready', 'slides.$.stage': null, 'slides.$.media': media, 'slides.$.picture': picture, 'slides.$.concept': { ...out.concept, number: out.concept.number ?? null }, 'slides.$.imagePrompt': out.imagePrompt,
        'slides.$.qc': { score: out.qc.score, passed: out.qc.passed, issues: out.qc.issues.slice(0, 10), retries: out.retries, needsAttention: out.needsAttention }, 'slides.$.costUsd': out.costUsd, 'slides.$.revision': (slide.revision || 1) + 1, 'slides.$.generatedAt': new Date(), 'slides.$.failure': { code: null, message: null },
      } });
      if (slide.key === 'hook') await SocialDesignGeneration.updateOne(lock, { $set: { 'carousel.reference': picture } });
      await SocialDesignGeneration.updateOne(lock, { $set: { status: 'ready', active: false, 'result.designVersion': attach.designVersion, 'generation.stage': null, 'generation.finishedAt': new Date() } });
      for (const url of [slide.media?.url, slide.key === 'hook' ? null : slide.picture?.url].filter(Boolean)) await mediaStorageService.deleteByUrl(url); // eslint-disable-line no-await-in-loop
      LoggerUtil.info(`${EVENT} slide_regenerated`, { event: 'slide_regenerated', ...ids, qcScore: out.qc.score, designVersion: attach.designVersion, costUsd: out.costUsd });
    } catch (error) {
      for (const url of stored) await mediaStorageService.deleteByUrl(url); // eslint-disable-line no-await-in-loop
      const f = designFailureFor(error);
      await SocialDesignGeneration.updateOne({ ...lock, 'slides.key': slide.key }, { $set: { 'slides.$.status': 'ready', 'slides.$.stage': null } });
      await SocialDesignGeneration.updateOne(lock, { $set: { status: 'ready', active: false, 'generation.stage': null, 'generation.finishedAt': new Date(), failure: { code: f.code, message: f.message, at: new Date() } } });
      LoggerUtil.warn(`${EVENT} slide_regenerate_failed`, { event: 'slide_regenerate_failed', ...ids, code: error?.code || null });
    }
  };
  const done = runInBackground(job, background);
  if (done) await done;
  const fresh = await SocialDesignGeneration.findById(rec._id).lean();
  return { success: true, started: true, generation: toApiConceptGeneration(fresh, await SocialPublication.findById(pub._id).lean()) };
}

/** New slide order (every slide in the post exactly once). A new design version: an approved carousel goes back to review. */
export async function reorderCarouselSlides(projectId, userId, input = {}) {
  const loaded = await loadCarouselForEdit(projectId, input);
  if (!loaded.success) return loaded;
  const { pub, rec } = loaded;
  const current = inPostSlides(rec, pub);
  const order = Array.isArray(input?.order) ? input.order.map(String) : [];
  if (order.length !== current.length || new Set(order).size !== order.length || !order.every((k) => current.some((s) => s.key === k))) return fail('ORDER_INVALID', CONCEPT_STUDIO_MESSAGES.ORDER_INVALID);
  const urls = order.map((k) => current.find((s) => s.key === k).media.url);
  const attach = await attachMedia({ ...rec, contentVersion: pub.contentVersion, baseDesignVersion: pub.designVersion, baseApprovalState: pub.approvalState }, pub, userId, urls, 'carousel', rec.model);
  if (!attach.success) return fail('DESIGN_VERSION_MISMATCH', 'The post changed. Reload and try again.');
  await SocialDesignGeneration.updateOne({ _id: rec._id }, { $set: Object.fromEntries((rec.slides || []).map((s, i) => [`slides.${i}.position`, order.includes(s.key) ? order.indexOf(s.key) : 9])) });
  LoggerUtil.info(`${EVENT} slides_reordered`, { event: 'slides_reordered', projectId: String(projectId), publicationId: String(pub._id), designVersion: attach.designVersion });
  return { success: true, designVersion: attach.designVersion, publication: await getPublication(projectId, String(pub._id)), generation: toApiConceptGeneration(await SocialDesignGeneration.findById(rec._id).lean(), await SocialPublication.findById(pub._id).lean()) };
}

/** Removes one slide from the post (at least 2 stay). A new design version: an approved carousel goes back to review. */
export async function deleteCarouselSlide(projectId, userId, input = {}) {
  const loaded = await loadCarouselForEdit(projectId, input);
  if (!loaded.success) return loaded;
  const { pub, rec } = loaded;
  const current = inPostSlides(rec, pub);
  const slide = current.find((s) => s.key === input?.slideKey);
  if (!slide) return fail('SLIDE_NOT_FOUND', CONCEPT_STUDIO_MESSAGES.SLIDE_NOT_FOUND);
  if (current.length - 1 < MIN_CAROUSEL_SLIDES) return fail('TOO_FEW_SLIDES', CONCEPT_STUDIO_MESSAGES.TOO_FEW_SLIDES);
  const keep = current.filter((s) => s.key !== slide.key);
  const attach = await attachMedia({ ...rec, contentVersion: pub.contentVersion, baseDesignVersion: pub.designVersion, baseApprovalState: pub.approvalState }, pub, userId, keep.map((s) => s.media.url), 'carousel', rec.model);
  if (!attach.success) return fail('DESIGN_VERSION_MISMATCH', 'The post changed. Reload and try again.');
  await SocialDesignGeneration.updateOne({ _id: rec._id }, { $pull: { slides: { key: slide.key } } });
  const fresh = await SocialDesignGeneration.findById(rec._id).lean();
  const order = keep.map((s) => s.key);
  await SocialDesignGeneration.updateOne({ _id: rec._id }, { $set: Object.fromEntries((fresh.slides || []).map((s, i) => [`slides.${i}.position`, order.includes(s.key) ? order.indexOf(s.key) : 9])) });
  for (const url of [slide.media?.url, slide.key === 'hook' ? null : slide.picture?.url].filter(Boolean)) await mediaStorageService.deleteByUrl(url); // eslint-disable-line no-await-in-loop
  LoggerUtil.info(`${EVENT} slide_deleted`, { event: 'slide_deleted', projectId: String(projectId), publicationId: String(pub._id), slide: slide.key, designVersion: attach.designVersion });
  return { success: true, designVersion: attach.designVersion, publication: await getPublication(projectId, String(pub._id)), generation: toApiConceptGeneration(await SocialDesignGeneration.findById(rec._id).lean(), await SocialPublication.findById(pub._id).lean()) };
}

// ── jobs of the project (for the "done" notification) ──────────────────────

/** Running design jobs of the project, and the ones that finished in the last `sinceMs` (so a page that was left can announce them). */
export async function getDesignJobs(projectId, { sinceMs = 10 * 60 * 1000, now = new Date() } = {}) {
  await recoverStaleDesignGenerations(projectId, { now });
  const since = new Date(now.getTime() - sinceMs);
  const recs = await SocialDesignGeneration.find({ project_id: toId(projectId), $or: [{ active: true }, { 'generation.finishedAt': { $gte: since } }] }).sort({ updatedAt: -1 }).limit(20)
    .select('publication_id status active mode studio generation.stage generation.finishedAt generation.startedAt slides.status slides.qc.needsAttention cost.usd failure.code').lean();
  return {
    success: true,
    jobs: recs.map((r) => ({
      id: String(r._id), publicationId: String(r.publication_id), status: r.status, active: !!r.active, phase: r.studio?.phase || null, format: r.studio?.format || null, stage: r.active ? r.generation?.stage || null : null,
      slides: (r.slides || []).length, slidesReady: (r.slides || []).filter((s) => s.status === 'ready').length, needsAttention: (r.slides || []).filter((s) => s.qc?.needsAttention).length,
      finishedAt: r.generation?.finishedAt ? new Date(r.generation.finishedAt).toISOString() : null, costUsd: r.cost?.usd ?? null, failureCode: r.status === 'failed' ? r.failure?.code || null : null,
    })),
  };
}

/** Which studio a post uses (the controller dispatches on it). null = not found in the project. */
export async function studioPipelineFor(projectId, publicationId) {
  if (typeof publicationId !== 'string' || !mongoose.Types.ObjectId.isValid(publicationId)) return null;
  const pub = await SocialPublication.findOne({ _id: toId(publicationId), project_id: toId(projectId) }).lean();
  if (!pub) return null;
  const ctx = await loadBriefContext(pub).catch(() => null);
  return (await usesConceptStudio(pub, ctx?.liveProfile || null)) ? 'concept' : 'rules';
}

export const wordsIn = words;
export default {
  startConceptCompare, runConceptCompare, regenerateConceptPreview, startConceptRender, runConceptRender, regenerateCarouselSlide, reorderCarouselSlides, deleteCarouselSlide,
  getCarouselSlides, getDesignCosts, getDesignJobs, toApiConceptGeneration, usesConceptStudio, latestConceptRecord,
};
