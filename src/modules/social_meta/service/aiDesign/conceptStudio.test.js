import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import '../../testSupport/storedMedia.js'; // public https media origin for this process (scheduling needs it)
import SeoProject from '../../../app_user/model/SeoProject.js';
import SocialAccount from '../../model/SocialAccount.js';
import SocialAIStrategy from '../../model/SocialAIStrategy.js';
import SocialDesignGeneration from '../../model/SocialDesignGeneration.js';
import SocialPublication from '../../model/SocialPublication.js';
import SocialApprovalSettings from '../../model/SocialApprovalSettings.js';
import SocialBusinessProfile from '../../model/SocialBusinessProfile.js';
import adapters from '../platformAdapters/index.js';
import { createPublication, submitContentForApproval, approveContent, approveDesign, schedulePublication, getPublication } from '../socialPublishingService.js';
import { setDesignProviderOverride, resetDesignProviderOverride } from './socialDesignGenerationService.js';
import {
  startConceptCompare, startConceptRender, regenerateCarouselSlide, reorderCarouselSlides, deleteCarouselSlide, getCarouselSlides, getDesignCosts, getDesignJobs, studioPipelineFor,
  startPostDesign, designFormatFor,
} from './conceptStudioService.js';
import SocialContentCalendarItem from '../../model/SocialContentCalendarItem.js';
import { getStudioState } from './socialDesignStudioService.js';
import { setBriefProviderOverride } from './concept/creativeBrief.js';
import { setQualityProviderOverride } from './concept/conceptQuality.js';
import { validRawStrategy } from '../../testSupport/aiStrategyFixtures.js';
import { asWaitingForDesign } from '../../testSupport/approvalFixtures.js';
import { removeProjectMedia, listProjectMedia, makeImage } from '../../testSupport/designFixtures.js';

/**
 * CONCEPT STUDIO end to end on real MongoDB + sharp + storage, with Claude and the image model scripted: Compare (3 low previews, no QC),
 * pick -> carousel render (hook first, the hook picture as the reference of every other slide), attach (ordered media, Design Review),
 * approve the whole carousel, per-slide regenerate / reorder / delete (each back to Design Review), needs-attention, costs, jobs and a
 * DRY-RUN schedule that validates the carousel for the platform and returns the planned Graph calls without writing anything.
 */

let mongoAvailable = false;
before(async () => {
  try { await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 }); mongoAvailable = true; await SocialDesignGeneration.init(); } catch { mongoAvailable = false; }
});
after(async () => { resetDesignProviderOverride(); setBriefProviderOverride(null); setQualityProviderOverride(null); if (mongoAvailable) await mongoose.connection.close(); });

const CAPTION = ['Most agencies hit a growth ceiling - not because of clients, but because of capacity.', '',
  '1. You\'re turning down new service requests', 'Your team simply cannot take on more delivery.',
  '2. Your team is stretched across too many services', 'One team can only do so much well.',
  '3. Delivery quality is slipping under volume', 'Quality is the first thing to suffer.', '',
  'Which of these signs sounds familiar? Drop your answer in the comments.'].join('\n');

// The same caption with NO list (prose): Odito must outline it into points with Claude before the carousel can be planned.
const PROSE_CAPTION = ['Most agencies hit a growth ceiling - not because of clients, but because of capacity.', '',
  'You\'re turning down new service requests. Your team simply cannot take on more delivery.',
  'Your team is stretched across too many services. One team can only do so much well.',
  'Delivery quality is slipping under volume. Quality is the first thing to suffer.', '',
  'Which of these signs sounds familiar? Drop your answer in the comments.'].join('\n');
const OUTLINE_ANSWER = { points: [
  { text: 'You\'re turning down new service requests', source: 'turning down new service requests' },
  { text: 'Your team is stretched across too many services', source: 'stretched across too many services' },
  { text: 'Delivery quality is slipping under volume', source: 'Delivery quality is slipping under volume' },
] };

const PROMPT = 'A real photograph of one cramped low-ceilinged agency office at dusk, warm desk lamp, navy walls, burnt-orange folders, one clear subject on the desk, the bottom 45% of the frame a darker calm desk front with no objects for the text.';
const heads = (h) => [h, `${h} now`, `So, ${h}`, `${h} today`, `${h} again`];
const concept = (i) => ({
  format: 'single_image', big_idea: ['A founder at a desk under client folders stacked to the ceiling.', 'An overflowing in-tray on a desk in a quiet office at night.', 'A wall planner with no free square left for new work.'][i],
  headline_candidates: heads(['Your agency is out of room', 'Too busy to grow', 'No room for new work'][i]), hook_headline: ['Your agency is out of room', 'Too busy to grow', 'No room for new work'][i],
  subline: '', cta: '', slides: [], visual_style: ['photo', '3d_render', 'photo'][i], layout: ['full_bleed_bottom', 'editorial_cover', 'split_image_text'][i],
  image_prompt: i === 1 ? 'A 3D render of an overflowing in-tray on a desk on a solid navy rendered background, soft studio light, orange and amber accents on the folders, a single warm rim light from the left, the top 35% of the frame empty, plain and calm for the headline text.' : PROMPT,
  image_labels: [], symbols: [], why_it_works: 'Literal and specific.',
});
const slide = (h, extra = {}) => ({ headline_candidates: heads(h), headline: h, image_prompt: PROMPT, image_labels: [], symbols: [], ...extra });
const CAROUSEL = () => ({
  big_idea: 'A cramped office where client work has hit the ceiling.', visual_style: 'photo', world: 'One cramped office at dusk, warm lamp, navy walls.',
  hook: slide('Your agency is out of room to grow', { subline: '', cta: 'Swipe for the signs' }),
  points: [
    slide('Turning down work you could win', { number: 1, from_caption: "You're turning down new service requests", visual_idea: 'A founder declining a call at a full desk' }),
    slide('One team, too many services', { number: 2, from_caption: 'Your team is stretched across too many services', visual_idea: 'One person at a small desk buried under work for every service' }),
    slide('Quality slips under the volume', { number: 3, from_caption: 'Delivery quality is slipping under volume', visual_idea: 'A coffee-stained draft on top of a tall pile' }),
  ],
  cta_slide: slide('Which sign sounds familiar?', { subline: '', cta: 'Tell us in the comments' }),
});
const QC = (score = 8, extra = {}) => ({ score, readable_at_phone_size: true, spelling_errors: [], word_count: 9, matches_big_idea: true, ai_artifacts: [], looks_stock_or_template: false, on_brand: true, invented_facts: [], cut_off_text: false, text_over_busy_area: false, sensitive_reading: [], mixed_styles: false, unclear_symbols: [], headline_awkward: false, issues: score >= 8 ? [] : ['the picture is weak'], ...extra });

function claude({ qcFor = () => QC() } = {}) {
  const log = [];
  let single = 0;
  const done = (parsed) => ({ parsed, model: 'claude-sonnet-4-6', usage: { inputTokens: 1000, outputTokens: 300 }, durationMs: 1 });
  const brief = {
    log,
    async generateStructured(req) {
      log.push(req.tool.name);
      // one concept at a time rotates (the brief refuses a layout + style the project's latest design just used)
      if (req.tool.name === 'emit_design_concepts') {
        const n = req.tool.schema.properties.concepts.minItems;
        if (n === 1) { single += 1; return done({ concepts: [concept((single - 1) % 3)] }); }
        return done({ concepts: [0, 1, 2].map(concept) });
      }
      if (req.tool.name === 'emit_carousel_look' || req.tool.name === 'emit_carousel_slide') return done(splitAnswer(CAROUSEL(), req));
      if (req.tool.name === 'emit_carousel_points') return done(OUTLINE_ANSWER);
      if (req.tool.name === 'judge_headlines') {
        const sets = [...req.user.matchAll(/<set id="([^"]+)"[^>]*>\n([\s\S]*?)\n<\/set>/g)].map((m) => ({ id: m[1], scores: m[2].split('\n').map((l) => ({ headline: l.replace(/^- /, ''), natural: 5, clear: 5, fits: 5, issue: '' })) }));
        return done({ sets });
      }
      if (req.tool.name === 'emit_revised_slide') return done({ visual_idea: 'A literal new scene at the same desk', image_prompt: PROMPT, image_labels: [], symbols: [], headline_candidates: heads('Turning down work you could win'), headline: 'Turning down work you could win' });
      if (req.tool.name === 'emit_revised_concept') return done({ big_idea: 'A literal new scene', image_prompt: PROMPT, image_labels: [], symbols: [] });
      throw new Error(`unexpected tool ${req.tool.name}`);
    },
  };
  const qcLog = [];
  const qc = { log: qcLog, async generateStructured(req) { const text = req.user.find((b) => b.type === 'text')?.text || ''; qcLog.push(text); return done(qcFor(text, qcLog.length)); } };
  return { brief, qc };
}


/** Scripted answer of the SPLIT carousel brief: the look + hook, or the ONE slide the prompt asks for. */
function splitAnswer(full, req) {
  if (req.tool.name === 'emit_carousel_look') return { big_idea: full.big_idea, visual_style: full.visual_style, world: full.world, hook: full.hook };
  const m = req.user.match(/Write ONLY point slide (\d+)/);
  return { slide: m ? full.points[Number(m[1]) - 1] : full.cta_slide };
}

function imageProvider() {
  const calls = [];
  return {
    calls,
    isAvailable: () => true,
    async generateImage({ prompt, size, quality, referenceImages = [] }) {
      calls.push({ size, quality, refs: referenceImages.length, reference: /reference image ONLY/.test(prompt) });
      const [w, h] = String(size).split('x').map(Number);
      return { buffer: await makeImage({ width: w, height: h }), usage: { textInputTokens: 400, imageInputTokens: referenceImages.length ? 1500 : 0, imageOutputTokens: quality === 'low' ? 300 : 1300, inputTokens: 400, outputTokens: 1300 }, model: 'gpt-image-2.6-flare', modelReturned: null, durationMs: 1, quality };
    },
  };
}

describe('Concept Studio (real MongoDB + sharp + storage; Claude and the image model scripted)', () => {
  let userId, reviewerId, project, pid, fb, created, metaCalls, original, realConsole;

  async function seedPost(content = CAPTION) {
    const r = await createPublication(pid, userId, { platform: 'facebook', socialAccountId: fb._id.toString(), content, media: [] });
    assert.equal(r.success, true);
    assert.equal((await submitContentForApproval(pid, r.publication.id, userId)).success, true);
    assert.equal((await approveContent(pid, r.publication.id, reviewerId, 1)).success, true);
    await asWaitingForDesign(r.publication.id);
    return getPublication(pid, r.publication.id);
  }
  const row = (id) => SocialPublication.findById(id).lean();

  beforeEach(async () => {
    if (!mongoAvailable) return;
    created = [];
    userId = new mongoose.Types.ObjectId();
    reviewerId = new mongoose.Types.ObjectId();
    project = await SeoProject.create({ user_id: userId, project_name: `Concept ${Date.now()} ${Math.random().toString(36).slice(2, 8)}`, main_url: 'https://example.com', seo_scope: 'local', keywords: ['k'], description: 'Agency' });
    created.push(project);
    pid = project._id.toString();
    fb = await SocialAccount.create({ user_id: userId, project_id: project._id, platform: 'facebook', platformAccountId: 'pgc', platformAccountName: 'Page', accountType: 'page', pageId: 'pgc', accessToken: 'FB-SECRET-TOKEN', status: 'active', isActive: true });
    await SocialAIStrategy.create({ project_id: project._id, version: 1, status: 'ready', strategy: { ...validRawStrategy(), brandRules: { visualGuidelines: [], prohibitedPhrases: [] } }, profileSnapshot: { generatedAt: new Date(), hash: 'h', data: { business: { name: 'Sapphire Digital Agency', description: 'White-label agency' }, audience: { primary: 'Agency owners' }, toneOfVoice: { primary: 'Direct' }, brand: { primaryColor: '#073B73', secondaryColor: '#E65F00', accentColor: '#F4A62A' }, offers: [], competitors: [], prohibitedPhrases: [] } }, generation: { startedAt: new Date(), finishedAt: new Date() } });
    metaCalls = [];
    original = {};
    for (const p of ['facebook', 'instagram']) for (const m of ['publish', 'remove', 'reconcile']) { original[`${p}.${m}`] = adapters[p][m]; adapters[p][m] = async () => { metaCalls.push(`${p}.${m}`); return { success: false }; }; }
    realConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
    for (const k of Object.keys(realConsole)) console[k] = () => {};
  });

  afterEach(async () => {
    if (realConsole) for (const k of Object.keys(realConsole)) console[k] = realConsole[k];
    resetDesignProviderOverride(); setBriefProviderOverride(null); setQualityProviderOverride(null);
    for (const key of Object.keys(original || {})) { const [p, m] = key.split('.'); adapters[p][m] = original[key]; }
    if (!mongoAvailable) return;
    await SocialContentCalendarItem.collection.deleteMany({ _id: { $in: created.filter((d) => d.isPlanItem).map((d) => d._id) } });
    const ids = created.filter((d) => !d.isPlanItem).map((d) => d._id);
    await Promise.all([SocialDesignGeneration.deleteMany({ project_id: { $in: ids } }), SocialPublication.deleteMany({ project_id: { $in: ids } }), SocialAIStrategy.deleteMany({ project_id: { $in: ids } }), SocialApprovalSettings.deleteMany({ project_id: { $in: ids } }), SocialAccount.deleteMany({ project_id: { $in: ids } }), SocialBusinessProfile.deleteMany({ project_id: { $in: ids } })]);
    await SeoProject.deleteMany({ _id: { $in: ids } });
    for (const id of ids) await removeProjectMedia(id);
  });

  async function carouselPost({ qcFor, content } = {}) {
    const { brief, qc } = claude({ qcFor });
    setBriefProviderOverride(brief); setQualityProviderOverride(qc);
    const provider = imageProvider();
    setDesignProviderOverride(provider);
    const pub = await seedPost(content);
    const compare = await startConceptCompare(pid, userId, { publicationId: pub.id, contentVersion: 1, format: 'carousel' }, { background: false });
    assert.equal(compare.success, true, JSON.stringify(compare));
    const fresh = await row(pub.id);
    const pick = compare.generation.candidates[0];
    const render = await startConceptRender(pid, userId, { publicationId: pub.id, contentVersion: 1, designVersion: fresh.designVersion, generationId: compare.generation.id, candidateId: pick.id }, { background: false });
    assert.equal(render.success, true, JSON.stringify(render));
    return { pub, compare, render, provider, brief, qc };
  }

  test('1: the post uses the concept studio; Compare = 3 DIFFERENT concepts as LOW previews, no quality check, cost recorded', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { brief, qc } = claude();
    setBriefProviderOverride(brief); setQualityProviderOverride(qc);
    const provider = imageProvider();
    setDesignProviderOverride(provider);
    const pub = await seedPost();
    assert.equal(await studioPipelineFor(pid, pub.id), 'concept');
    const r = await startConceptCompare(pid, userId, { publicationId: pub.id, contentVersion: 1, format: 'carousel' }, { background: false });
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(r.generation.status, 'ready', JSON.stringify({ f: r.generation.failure, c: r.generation.candidates.map((c) => c.failure) }));
    assert.equal(r.generation.candidates.length, 3);
    assert.ok(r.generation.candidates.every((c) => c.status === 'ready' && c.preview?.url && c.preview.quality === 'low'));
    assert.equal(new Set(r.generation.candidates.map((c) => c.concept.layout)).size, 3);
    assert.ok(provider.calls.every((c) => c.quality === 'low' && c.size === '1088x1360'));
    assert.equal(qc.log.length, 0, 'previews are not quality-checked');
    assert.ok(r.generation.costUsd > 0);
    const state = await getStudioState(pid, pub.id);
    assert.equal(state.pipeline, 'concept');
    assert.equal(state.formats.carousel.allowed, true);
    assert.equal(state.generation.id, r.generation.id);
    assert.equal((await row(pub.id)).media.length, 0, 'a preview is never the post\'s design');
  });

  test('2: picking a concept renders the CAROUSEL at medium: hook first, then every slide from the hook picture as reference; ordered media attached, Design Review', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { render, provider, pub } = await carouselPost();
    const g = render.generation;
    assert.equal(g.status, 'ready', JSON.stringify(g.failure));
    assert.equal(g.format, 'carousel');
    assert.deepEqual(g.slides.map((s) => s.key), ['hook', 'p1', 'p2', 'p3', 'cta']);
    assert.ok(g.slides.every((s) => s.status === 'ready' && s.inPost && s.qc.score === 8 && !s.qc.needsAttention));
    const medium = provider.calls.filter((c) => c.quality === 'medium');
    assert.equal(medium[0].refs, 0, 'the hook has no reference');
    assert.ok(medium.slice(1).every((c) => c.refs === 1 && c.reference), 'every other slide uses the hook picture');
    const after = await row(pub.id);
    assert.equal(after.media.length, 5);
    assert.deepEqual(after.media.map((m) => m.url), g.slides.map((s) => s.url));
    assert.equal(after.design.format, 'carousel');
    assert.equal(after.approvalState, 'design_review');
    assert.equal(metaCalls.length, 0);
    const slides = await getCarouselSlides(pid, pub.id);
    assert.equal(slides.generation.slides.length, 5);
  });

  test('2b: a caption with NO list (prose) becomes a carousel: Claude outlines 3 points once, they are stored and used for every slide', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const state0 = await (async () => { const { brief, qc } = claude(); setBriefProviderOverride(brief); setQualityProviderOverride(qc); setDesignProviderOverride(imageProvider()); const pb = await seedPost(PROSE_CAPTION); return { st: await getStudioState(pid, pb.id) }; })();
    assert.equal(state0.st.formats.carousel.allowed, true, 'the Carousel option is enabled for a caption without a list');
    assert.equal(state0.st.formats.carousel.source, 'outline');
    const { render, brief, pub } = await carouselPost({ content: PROSE_CAPTION });
    const g = render.generation;
    assert.equal(g.status, 'ready', JSON.stringify(g.failure));
    assert.deepEqual(g.slides.map((s) => s.key), ['hook', 'p1', 'p2', 'p3', 'cta']);
    assert.equal(brief.log.filter((n) => n === 'emit_carousel_points').length, 1, 'outlined once');
    const rec = await SocialDesignGeneration.findById(g.id).lean();
    assert.equal(rec.carousel.pointsSource, 'outline');
    assert.deepEqual(rec.carousel.points.map((p) => p.text), OUTLINE_ANSWER.points.map((p) => p.text));
    assert.ok((rec.cost?.calls || []).some((c) => c.step === 'carousel_outline'), 'the outline call is costed');
    assert.equal((await row(pub.id)).media.length, 5);
  });

  test('2c: a too-short caption is refused as a carousel with a clear message', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { brief, qc } = claude(); setBriefProviderOverride(brief); setQualityProviderOverride(qc); setDesignProviderOverride(imageProvider());
    const pub = await seedPost('Big news this week. Stay tuned.');
    const st = await getStudioState(pid, pub.id);
    assert.equal(st.formats.carousel.allowed, false);
    const r = await startConceptCompare(pid, userId, { publicationId: pub.id, contentVersion: 1, format: 'carousel' }, { background: false });
    assert.equal(r.success, false);
    assert.equal(r.error?.code || r.code, 'CAROUSEL_NEEDS_POINTS');
  });

  // ── Content Approvals: the format rule (choice -> calendar plan -> caption), carousels from Generate / Regenerate ──────────────

  async function planItem(pub, format) {
    const _id = new mongoose.Types.ObjectId();
    // raw insert: only the fields the design path reads (the calendar's own validation is tested elsewhere)
    await SocialContentCalendarItem.collection.insertOne({ _id, project_id: project._id, calendar_id: new mongoose.Types.ObjectId(), format, topic: 'Signs of a growth ceiling', platforms: ['facebook'] });
    created.push({ _id, isPlanItem: true });
    await SocialPublication.updateOne({ _id: pub.id }, { $set: { 'generation.calendarItemId': _id } });
    return _id;
  }
  const scripted = () => { const { brief, qc } = claude(); setBriefProviderOverride(brief); setQualityProviderOverride(qc); const provider = imageProvider(); setDesignProviderOverride(provider); return { brief, qc, provider }; };
  const planFormat = async (id) => (await SocialContentCalendarItem.collection.findOne({ _id: id }))?.format;

  test('A1: Approvals Generate on a post PLANNED as Carousel makes a carousel (hook + 3 points + CTA), no format sent', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { brief } = scripted();
    const pub = await seedPost();
    const item = await planItem(pub, 'carousel');
    const before = await designFormatFor(pid, pub.id);
    assert.deepEqual([before.recommended, before.source, before.plannedFormat, before.needsChoice], ['carousel', 'plan', 'carousel', false]);
    const r = await startPostDesign(pid, userId, { publicationId: pub.id, contentVersion: 1 }, { background: false });
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(r.format, 'carousel');
    assert.equal(r.generation.status, 'ready', JSON.stringify(r.generation.failure));
    assert.deepEqual(r.generation.slides.map((s) => s.key), ['hook', 'p1', 'p2', 'p3', 'cta']);
    assert.equal(brief.log.filter((n) => n === 'emit_design_concepts').length, 1, 'one hook concept, no Compare');
    const after = await row(pub.id);
    assert.equal(after.media.length, 5);
    assert.equal(after.design.format, 'carousel');
    assert.equal(after.approvalState, 'design_review');
    assert.equal(await planFormat(item), 'carousel');
    const slides = await getCarouselSlides(pid, pub.id);
    assert.equal(slides.generation.slides.length, 5, 'Approvals reads the carousel slides');
  });

  test('A2: Regenerate re-checks the format every time: an explicit Single overrides the plan (calendar follows), then no choice -> the caption list', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    scripted();
    const pub = await seedPost();
    const item = await planItem(pub, 'carousel');
    const single = await startPostDesign(pid, userId, { publicationId: pub.id, contentVersion: 1, format: 'single' }, { background: false });
    assert.equal(single.success, true, JSON.stringify(single));
    assert.equal(single.format, 'single');
    let now = await row(pub.id);
    assert.equal(now.media.length, 1);
    assert.equal(now.design.format, 'single');
    assert.equal(await planFormat(item), 'static_post', 'the calendar shows the format that was made');
    // no choice now: the plan says static_post -> single (the earlier carousel plan is not remembered)
    assert.equal((await designFormatFor(pid, pub.id)).recommended, 'single');
    // explicit carousel: re-checked, made, and the calendar follows again
    const carousel = await startPostDesign(pid, userId, { publicationId: pub.id, contentVersion: 1, format: 'carousel' }, { background: false });
    assert.equal(carousel.success, true, JSON.stringify(carousel));
    now = await row(pub.id);
    assert.equal(now.media.length, 5);
    assert.equal(await planFormat(item), 'carousel');
  });

  test('A3: no plan: a caption list -> carousel by default; a Regenerate after a single image does not inherit "single"', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    scripted();
    const pub = await seedPost();
    assert.equal((await startPostDesign(pid, userId, { publicationId: pub.id, contentVersion: 1, format: 'single' }, { background: false })).format, 'single');
    const again = await startPostDesign(pid, userId, { publicationId: pub.id, contentVersion: 1 }, { background: false });
    assert.equal(again.format, 'carousel');
    assert.equal(again.generation.status, 'ready', JSON.stringify(again.generation.failure));
    assert.equal((await row(pub.id)).media.length, 5);
  });

  test('A4: planned carousel with no clear points -> the question (422 code), nothing made; "Make a single image" then works', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { provider } = scripted();
    const pub = await seedPost('Big news this week. Stay tuned.');
    await planItem(pub, 'carousel');
    const r = await startPostDesign(pid, userId, { publicationId: pub.id, contentVersion: 1 }, { background: false });
    assert.equal(r.success, false);
    assert.equal(r.error.code, 'CAROUSEL_NEEDS_POINTS');
    assert.equal(r.error.message, 'Planned as carousel, but the caption has no clear points. Make a single image or edit the caption?');
    assert.equal(r.error.format.needsChoice, true);
    assert.equal(await SocialDesignGeneration.countDocuments({ publication_id: pub.id }), 0, 'no generation was started');
    assert.equal(provider.calls.length, 0);
    assert.equal((await row(pub.id)).media.length, 0, 'never a quiet single image');
    const single = await startPostDesign(pid, userId, { publicationId: pub.id, contentVersion: 1, format: 'single' }, { background: false });
    assert.equal(single.success, true, JSON.stringify(single));
    assert.equal((await row(pub.id)).media.length, 1);
  });

  test('A5: an existing single image on a post planned as carousel is flagged (mismatch), not changed; Studio defaults to carousel', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    scripted();
    const pub = await seedPost();
    await startPostDesign(pid, userId, { publicationId: pub.id, contentVersion: 1, format: 'single' }, { background: false });
    const before = await row(pub.id);
    // the plan says carousel (an old design made before formats were followed)
    const item = await planItem(pub, 'carousel');
    const f = await designFormatFor(pid, pub.id);
    assert.deepEqual([f.mismatch, f.current, f.recommended], [true, 'single', 'carousel']);
    const after = await row(pub.id);
    assert.equal(after.designVersion, before.designVersion, 'nothing is changed automatically');
    assert.equal(await planFormat(item), 'carousel');
    const st = await getStudioState(pid, pub.id);
    assert.equal(st.formats.recommended.recommended, 'carousel');
    assert.equal(st.format.note, 'The plan calls for a carousel.');
  });

  test('3: approving the design approves the WHOLE carousel; regenerating one slide makes a new design version back in Design Review, same position', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { pub } = await carouselPost();
    const before = await row(pub.id);
    assert.equal((await approveDesign(pid, pub.id, reviewerId, before.designVersion)).success, true);
    assert.equal((await row(pub.id)).approvalState, 'design_approved');
    const r = await regenerateCarouselSlide(pid, userId, { publicationId: pub.id, contentVersion: 1, designVersion: before.designVersion, slideKey: 'p2' }, { background: false });
    assert.equal(r.success, true, JSON.stringify(r));
    const after = await row(pub.id);
    assert.equal(after.approvalState, 'design_review', 'any slide change goes back to review');
    assert.equal(after.designVersion, before.designVersion + 1);
    assert.equal(after.media.length, 5);
    assert.notEqual(after.media[2].url, before.media[2].url);
    assert.deepEqual([0, 1, 3, 4].map((i) => after.media[i].url), [0, 1, 3, 4].map((i) => before.media[i].url));
  });

  test('4: reorder (every slide once) and delete (at least 2 stay) are new design versions; a stale design version is refused', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { pub } = await carouselPost();
    let doc = await row(pub.id);
    const base = { publicationId: pub.id, contentVersion: 1 };
    assert.equal((await reorderCarouselSlides(pid, userId, { ...base, designVersion: doc.designVersion, order: ['hook', 'p1'] })).error.code, 'ORDER_INVALID');
    const re = await reorderCarouselSlides(pid, userId, { ...base, designVersion: doc.designVersion, order: ['hook', 'p3', 'p2', 'p1', 'cta'] });
    assert.equal(re.success, true, JSON.stringify(re));
    const reordered = await row(pub.id);
    assert.deepEqual(reordered.media.map((m) => m.url), [doc.media[0], doc.media[3], doc.media[2], doc.media[1], doc.media[4]].map((m) => m.url));
    assert.equal((await reorderCarouselSlides(pid, userId, { ...base, designVersion: doc.designVersion, order: ['hook', 'p1', 'p2', 'p3', 'cta'] })).error.code, 'DESIGN_VERSION_MISMATCH');
    doc = reordered;
    for (const key of ['p1', 'p2', 'p3']) {
      // eslint-disable-next-line no-await-in-loop
      const d = await deleteCarouselSlide(pid, userId, { ...base, designVersion: (await row(pub.id)).designVersion, slideKey: key });
      assert.equal(d.success, true, JSON.stringify(d));
    }
    assert.equal((await row(pub.id)).media.length, 2);
    const refused = await deleteCarouselSlide(pid, userId, { ...base, designVersion: (await row(pub.id)).designVersion, slideKey: 'cta' });
    assert.equal(refused.error.code, 'TOO_FEW_SLIDES');
  });

  test('5: a slide still below 8 after its retry is shipped ONLY with a "needs attention" mark and the QC reason', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { render, pub } = await carouselPost({ qcFor: (text) => (/point 2/.test(text) ? QC(6, { ai_artifacts: ['fused fingers'], issues: ['the hands look wrong'] }) : QC()) });
    const p2 = render.generation.slides.find((s) => s.key === 'p2');
    assert.equal(p2.qc.passed, false);
    assert.deepEqual(p2.qc.retries, ['picture']);
    assert.ok(p2.qc.needsAttention.reasons.some((r) => /hands/.test(r)));
    const slides = await getCarouselSlides(pid, pub.id);
    assert.equal(slides.generation.needsAttention, 1);
  });

  test('5b: APPROVE GUARD: a design with a slide that needs attention is refused with the slide and reason; "approve anyway" approves it and records who', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { pub } = await carouselPost({ qcFor: (text) => (/point 2/.test(text) ? QC(6, { ai_artifacts: ['fused fingers'], issues: ['the hands look wrong'] }) : QC()) });
    const doc = await row(pub.id);
    const refused = await approveDesign(pid, pub.id, reviewerId, doc.designVersion);
    assert.equal(refused.success, false);
    assert.equal(refused.error.code, 'DESIGN_NEEDS_ATTENTION');
    assert.deepEqual(refused.error.attention.map((a) => [a.slide, a.key]), [[3, 'p2']]);
    assert.ok(refused.error.attention[0].reasons.some((r) => /hands/.test(r)));
    assert.match(refused.error.message, /1 slide needs attention: slide 3/);
    assert.equal((await row(pub.id)).approvalState, 'design_review', 'nothing approved');
    const ok = await approveDesign(pid, pub.id, reviewerId, doc.designVersion, { acknowledgeAttention: true });
    assert.equal(ok.success, true, JSON.stringify(ok));
    assert.equal((await row(pub.id)).approvalState, 'design_approved');
    const after = await row(pub.id);
    const rec = await SocialDesignGeneration.findById(after.design.generationId).lean();
    assert.equal(rec.approvedWithAttention.length, 1);
    assert.equal(String(rec.approvedWithAttention[0].userId), String(reviewerId));
    assert.deepEqual(rec.approvedWithAttention[0].slides, [3]);
    assert.equal(rec.approvedWithAttention[0].designVersion, doc.designVersion);
  });

  test('5c: a design with nothing that needs attention is approved directly (no acknowledgement needed)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { pub } = await carouselPost();
    const doc = await row(pub.id);
    assert.equal((await approveDesign(pid, pub.id, reviewerId, doc.designVersion)).success, true);
  });

  test('6: every call is costed: the post total and the brand total this month; the jobs list announces a finished job', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { pub } = await carouselPost();
    const costs = await getDesignCosts(pid, { publicationId: pub.id });
    assert.ok(costs.post.usd > 0);
    assert.ok(costs.post.calls >= 1 + 3 + 1 + 5 * 2, 'brief + 3 previews + carousel brief + per slide image and QC');
    assert.equal(costs.month.usd, costs.post.usd);
    const rec = await SocialDesignGeneration.findOne({ publication_id: pub.id }).lean();
    assert.ok(['brief', 'headline_judge', 'carousel_look', 'slide_brief_p1', 'slide_brief_cta', 'slide_1', 'quality_check'].every((s) => rec.cost.calls.some((c) => c.step === s)));
    const jobs = await getDesignJobs(pid);
    assert.ok(jobs.jobs.some((j) => j.publicationId === pub.id && !j.active && j.status === 'ready' && j.slides === 5));
  });

  test('7: DRY-RUN schedule of the approved carousel: platform checks pass, the multi-photo Graph plan is returned, nothing is written or sent', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { pub } = await carouselPost();
    const doc = await row(pub.id);
    assert.equal((await approveDesign(pid, pub.id, reviewerId, doc.designVersion)).success, true);
    const at = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
    const r = await schedulePublication(pid, pub.id, userId, at, 'UTC', { dryRun: true });
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(r.dryRun, true);
    assert.equal(r.wouldSchedule.format, 'carousel');
    assert.equal(r.wouldSchedule.media, 5);
    assert.deepEqual(r.publishPlan.map((s) => s.step), ['upload_photo_1', 'upload_photo_2', 'upload_photo_3', 'upload_photo_4', 'upload_photo_5', 'publish']);
    assert.equal(JSON.stringify(r).includes('FB-SECRET-TOKEN'), false);
    const after = await row(pub.id);
    assert.equal(after.status, 'draft');
    assert.equal(after.scheduledAt ?? null, null);
    assert.equal(metaCalls.length, 0);
  });

  test('8: Instagram size rules are checked before scheduling: a slide of a different shape is refused', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { platformMediaProblem } = await import('../socialPublishingService.js');
    const { default: mediaStorageService } = await import('../media/mediaStorageService.js');
    const store = async (w, h) => (await mediaStorageService.upload({ buffer: await sharp({ create: { width: w, height: h, channels: 3, background: '#335577' } }).jpeg().toBuffer(), projectId: pid, extension: '.jpg' })).url;
    const portrait = await store(1080, 1350);
    const square = await store(1080, 1080);
    const tall = await store(600, 1200);
    assert.equal(await platformMediaProblem(pid, 'instagram', [{ url: portrait, type: 'image' }, { url: portrait, type: 'image' }]), null);
    assert.equal((await platformMediaProblem(pid, 'instagram', [{ url: portrait, type: 'image' }, { url: square, type: 'image' }])).code, 'MEDIA_SIZE_NOT_SUPPORTED');
    assert.equal((await platformMediaProblem(pid, 'instagram', [{ url: tall, type: 'image' }])).code, 'MEDIA_SIZE_NOT_SUPPORTED');
    assert.equal(await platformMediaProblem(pid, 'facebook', [{ url: portrait, type: 'image' }, { url: square, type: 'image' }]), null, 'Facebook takes mixed shapes');
    assert.equal((await listProjectMedia(pid)).length >= 3, true);
  });
});
