import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import {
  applyAltFix, getAltFixPreview, listAltImages, listAltImagesWithSummary, renderedAltCheck, reverifyAltFix, rollbackAltFix,
} from './altFixService.js';
import WordPressFixRecord from '../model/WordPressFixRecord.js';
import { WordPressConnectionError } from '../service/wordPressService.js';
import { attachmentExactPaths } from './imageIdentity.js';
import { SITE, UPLOADS, mediaItem, snapshot } from './__fixtures__/media.js';

/**
 * The image alt-text fix end to end against a STATEFUL double of the WordPress media library (it applies PUTs, can fail, time out,
 * be edited by a "human" between reads) and a live local Mongo for the audit record (auto-skipped when unreachable). Nothing here
 * touches a real WordPress site.
 */

let mongoAvailable = false;
before(async () => {
  try { await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 }); mongoAvailable = true; } catch { mongoAvailable = false; }
});
const projectIds = [];
after(async () => {
  if (mongoAvailable) {
    await WordPressFixRecord.deleteMany({ projectId: { $in: projectIds } });
    for (const c of ['seo_page_issues']) await mongoose.connection.db.collection(c).deleteMany({ projectId: { $in: projectIds } });
    await mongoose.connection.close();
  }
});
const skip = (t) => { if (!mongoAvailable) { t.skip('local MongoDB not reachable'); return true; } return false; };

const PAGE = `${SITE}/our-doctors`;
const SRC = `${UPLOADS}/2024/10/dr-rao.jpg`;

/** A media library + the page's raw content, with call recording and fault injection. */
function makeWp({ items = [mediaItem(42, '2024/10/dr-rao.jpg')], raw = '<p>Our doctors</p>' } = {}) {
  const lib = new Map(items.map((i) => [i.id, structuredClone(i)]));
  const wp = {
    lib, raw, writes: [], reads: 0,
    failWrite: null,       // an Error to throw (every attempt)
    failFirst: 0,          // fail this many write attempts with `transientError`, then succeed
    landThenTimeout: false, // the first write LANDS but the response is lost (a timeout)
    transientError: new WordPressConnectionError('TIMEOUT', 'timed out', 504),
    editBeforeNextRead: null, // (item) => void — a human edit that lands before the next read
    readError: null,
    async readMediaById(id) {
      wp.reads += 1;
      if (wp.readError) throw wp.readError;
      if (wp.editBeforeNextRead) { const fn = wp.editBeforeNextRead; wp.editBeforeNextRead = null; const it = lib.get(id); if (it) fn(it); }
      const it = lib.get(Number(id));
      return it ? structuredClone(it) : null;
    },
    async searchMedia(term, page) {
      if (page > 1) return [];
      return [...lib.values()].filter((m) => (m.media_details.file || '').includes(term)).map((m) => structuredClone(m));
    },
    async readPostRawContent() { return wp.raw; },
    async writeAltTextForAttachment(id, alt) {
      wp.writes.push({ id, body: { alt_text: alt } });
      if (wp.failWrite) throw wp.failWrite;
      if (wp.landThenTimeout) { wp.landThenTimeout = false; lib.get(id).alt_text = alt; throw wp.transientError; }
      if (wp.failFirst > 0) { wp.failFirst -= 1; throw wp.transientError; }
      lib.get(id).alt_text = alt;
      return { httpStatus: 200, wordpressPostId: id };
    },
  };
  return wp;
}

function world({ wp = makeWp(), snap = snapshot(), taskOver = {}, siteUrl = SITE, flagged, bridge = null } = {}) {
  const projectId = new mongoose.Types.ObjectId();
  projectIds.push(projectId);
  const task = {
    _id: new mongoose.Types.ObjectId(), projectId, issueKey: 'images_missing_alt_text', pageUrl: PAGE, status: 'task_created', recommendationId: null,
    fixHistory: [], saves: 0, async save() { this.saves += 1; }, markModified() {}, ...taskOver,
  };
  const transitions = [];
  const connectionId = new mongoose.Types.ObjectId();
  const deps = {
    wordPressService: {
      getHydratedConnectionOrThrow: async () => ({ _id: connectionId, site_url: siteUrl, application_password: 'secret' }),
      resolvePostIdFromUrl: async () => ({ postId: 10, postType: 'pages' }),
    },
    makeAdapter: () => wp,
    bridge: bridge || { getBridgeStatus: async () => ({ installed: false, mediaAltSupported: false }) }, // default: no Bridge, the core-REST fallback path
    loadFlaggedImages: async () => flagged || [{ before_snapshot: snap }],
    loadPageDoc: async () => world.pageDoc || null,
    // The live page is never fetched in tests unless a test supplies it.
    checkLiveAlt: async () => ({ status: 'unavailable', instances: [] }),
    taskHistory: { applyImplementedTransition: async (t, opts) => { transitions.push(opts); t.status = 'implemented'; t.fixHistory.push({ fixApplied: { expectedAfterValue: opts.expectedAfterValueOverride } }); } },
    sleep: async () => {},
  };
  return { wp, task, deps, transitions, snap, projectId };
}
world.pageDoc = null;

const INPUT = { imageSrc: SRC, proposedAlt: 'Dr Rao examining a patient with a slit lamp' };
const preview = (w, input = INPUT) => getAltFixPreview(w.task, input, w.deps);
const apply = async (w, over = {}) => applyAltFix(w.task, { ...INPUT, approved: true, expectedPlanFingerprint: (await preview(w, over.input || INPUT)).plan.fingerprint, actorId: new mongoose.Types.ObjectId(), ...over }, w.deps);

beforeEach(() => { world.pageDoc = null; });

describe('listing — only this task\'s own findings', () => {
  test('lists the flagged images with missing-vs-empty state and any fix already made', async (t) => {
    if (skip(t)) return;
    const w = world({ flagged: [{ before_snapshot: snapshot({ altState: 'missing', wpAttachmentId: 42 }) }, { before_snapshot: snapshot({ src: `${UPLOADS}/2024/10/deco.jpg`, altState: 'empty' }) }] });
    const images = await listAltImages(w.task, w.deps);
    assert.deepEqual(images.map((i) => [i.altState, i.hasAttachmentHint, i.decorativeSignals, i.fix]), [['missing', true, false, null], ['empty', false, true, null]]);
  });

  test('CROSS-PROJECT: the default loader is scoped by project id — another project\'s finding for the same page and image is never listed', async (t) => {
    if (skip(t)) return;
    const a = new mongoose.Types.ObjectId(); const b = new mongoose.Types.ObjectId();
    projectIds.push(a, b);
    const col = mongoose.connection.db.collection('seo_page_issues');
    const doc = (projectId, src) => ({ projectId, dedup_key: `${projectId}|${src}`, page_url: PAGE, rule_id: 'images_missing_alt_text', status: 'open', before_snapshot: snapshot({ src }) });
    await col.insertMany([doc(a, `${UPLOADS}/2024/10/a-only.jpg`), doc(b, `${UPLOADS}/2024/10/b-only.jpg`)]);
    const images = await listAltImages({ _id: new mongoose.Types.ObjectId(), projectId: a, pageUrl: PAGE });
    assert.deepEqual(images.map((i) => i.src), [`${UPLOADS}/2024/10/a-only.jpg`]);
  });
});

describe('preview — read-only, with the exact target', () => {
  test('a resolved image shows its identity evidence, current/proposed alt, the field and setting, and writes NOTHING', async (t) => {
    if (skip(t)) return;
    const w = world({ snap: snapshot({ wpAttachmentId: 42 }) });
    const p = await preview(w);
    assert.equal(p.fixType, 'image_alt');
    assert.equal(p.targetUrl, PAGE);
    assert.equal(p.image.sourceUrl, SRC);
    assert.equal(p.identity.status, 'resolved');
    assert.equal(p.identity.attachmentId, 42);
    assert.equal(p.identity.confidence, 'high');
    assert.equal(p.identity.method, 'attachment_id_class');
    assert.ok(p.identity.evidence.length >= 2);
    assert.equal(p.field, 'alt_text');
    assert.match(p.setting, /attachment 42/);
    assert.equal(p.current.alt, '');
    assert.equal(p.proposed.alt, 'Dr Rao examining a patient with a slit lamp');
    assert.equal(p.classification.kind, 'informative');
    assert.equal(p.approvalStatus, 'awaiting_approval');
    assert.equal(p.plan.status, 'ready');
    assert.equal(p.plan.fingerprint.length, 64);
    assert.equal(w.wp.writes.length, 0);
    assert.equal(await WordPressFixRecord.countDocuments({ taskId: w.task._id }), 0);
  });

  test('without a class the image is resolved by the EXACT file path found through a search', async (t) => {
    if (skip(t)) return;
    const w = world();
    const p = await preview(w);
    assert.equal(p.identity.method, 'exact_source_url');
    assert.equal(p.identity.attachmentId, 42);
  });

  test('an image that is not one of THIS task\'s findings is refused before WordPress is touched', async (t) => {
    if (skip(t)) return;
    const w = world();
    await assert.rejects(getAltFixPreview(w.task, { imageSrc: `${UPLOADS}/2024/10/someone-elses.jpg`, proposedAlt: 'x y z' }, w.deps), (e) => e.code === 'IMAGE_NOT_FLAGGED' && e.statusCode === 422);
    await assert.rejects(getAltFixPreview(w.task, { imageSrc: '', proposedAlt: 'x' }, w.deps), (e) => e.code === 'IMAGE_NOT_FLAGGED');
    assert.equal(w.wp.reads, 0);
  });

  test('a page that is not on the connected site is refused (host validation)', async (t) => {
    if (skip(t)) return;
    const w = world({ siteUrl: 'https://different-site.example' });
    await assert.rejects(getAltFixPreview(w.task, INPUT, w.deps), (e) => e.code === 'FIELD_NOT_WRITABLE' && e.details.reason === 'site_mismatch');
  });

  test('missing identity -> unsupported; ambiguous evidence -> ambiguous_target; each explains what is missing and offers nothing to approve', async (t) => {
    if (skip(t)) return;
    const none = world({ wp: makeWp({ items: [] }) });
    const n = await preview(none);
    assert.equal(n.plan.status, 'unsupported');
    assert.equal(n.plan.code, 'NOT_IN_MEDIA_LIBRARY');
    assert.equal(n.approvalStatus, 'not_available');

    const amb = world({ wp: makeWp({ items: [mediaItem(42, '2024/10/dr-rao.jpg'), mediaItem(77, '2024/10/dr-rao.jpg')] }) });
    const a = await preview(amb);
    assert.equal(a.plan.status, 'ambiguous_target');
    assert.equal(a.plan.code, 'MULTIPLE_ATTACHMENTS_MATCH');

    const wrongId = world({ snap: snapshot({ wpAttachmentId: 5 }), wp: makeWp({ items: [mediaItem(5, '2023/01/other.jpg')] }) });
    assert.equal((await preview(wrongId)).plan.code, 'ID_AND_URL_DISAGREE');
  });

  test('a duplicate file NAME in another folder does not confuse the target', async (t) => {
    if (skip(t)) return;
    const w = world({ wp: makeWp({ items: [mediaItem(9, '2022/01/dr-rao.jpg'), mediaItem(42, '2024/10/dr-rao.jpg')] }) });
    assert.equal((await preview(w)).identity.attachmentId, 42);
  });

  test('responsive variants: an image observed only through srcset/lazy URLs resolves', async (t) => {
    if (skip(t)) return;
    const w = world({ snap: snapshot({ src: 'data:image/gif;base64,AAA', imageUrl: null, lazySrc: `${UPLOADS}/2024/10/dr-rao-768x512.jpg`, srcsetUrls: [`${UPLOADS}/2024/10/dr-rao-300x200.jpg`] }) });
    w.deps.loadFlaggedImages = async () => [{ before_snapshot: w.snap }];
    const p = await getAltFixPreview(w.task, { imageSrc: 'data:image/gif;base64,AAA', proposedAlt: INPUT.proposedAlt }, w.deps);
    assert.equal(p.identity.attachmentId, 42);
  });

  test('decorative only on EVIDENCE (aria-hidden, role, a named link); alt="" alone is a reviewed finding, or plainly missing when the library produced it', async (t) => {
    if (skip(t)) return;
    // explicit evidence: left alone, no fix required
    for (const over of [{ ariaHidden: true }, { role: 'presentation' }, { altState: 'empty', inLink: true, linkText: 'Read the case study' }]) {
      const p = await preview(world({ snap: snapshot(over) }));
      assert.equal(p.plan.status, 'decorative', JSON.stringify(over));
      assert.equal(p.diagnosis.state, 'decorative');
      assert.equal(p.diagnosis.fixMechanism, 'none');
      assert.equal(p.approvalStatus, 'not_available');
    }
    // alt="" and nothing says it was deliberate (the source of the markup is unknown): a person must review it, never auto-decorative
    const review = await preview(world({ snap: snapshot({ altState: 'empty' }), wp: makeWp({ raw: null }) }));
    assert.equal(review.plan.status, 'needs_review');
    assert.equal(review.classification.decorative, false);
    assert.equal(review.classification.kind, 'ambiguous');
    assert.equal(review.approvalStatus, 'not_available');
    // ...and once the person confirms it carries meaning, the normal workflow applies
    const confirmed = await preview(world({ snap: snapshot({ altState: 'empty' }), wp: makeWp({ raw: null }) }), { ...INPUT, informative: true });
    assert.equal(confirmed.plan.status, 'ready');
    // an alt="" the AUTHOR typed inside the page content lives there: a library write cannot change it
    const authored = '<img class="wp-image-42" src="https://clinic.example/wp-content/uploads/2024/10/dr-rao.jpg" alt="">';
    const emb = await preview(world({ snap: snapshot({ altState: 'empty' }), wp: makeWp({ raw: authored }) }), { ...INPUT, informative: true });
    assert.equal(emb.plan.status, 'unsupported');
    assert.equal(emb.plan.code, 'ALT_EMBEDDED_IN_CONTENT');
    // theme-rendered from a library with no alt: the empty alt IS the library's emptiness: missing, not decorative
    const library = await preview(world({ snap: snapshot({ altState: 'empty' }) }));
    assert.equal(library.classification.decorative, false);
    assert.equal(library.diagnosis.state, 'missing');
    assert.equal(library.plan.status, 'ready');
    // the only content of an UNNAMED link is never decorative, even with aria-hidden
    const logo = await preview(world({ snap: snapshot({ altState: 'empty', inLink: true, ariaHidden: true }) }));
    assert.equal(logo.diagnosis.state, 'link_without_name');
    assert.equal(logo.plan.status, 'ready');
    // a person says an aria-hidden image carries meaning
    assert.equal((await preview(world({ snap: snapshot({ ariaHidden: true }) }), { ...INPUT, informative: true })).plan.status, 'ready');
  });

  test('no alt text proposed -> needs_input with suggestions from the site\'s own text only; invalid text is refused with the reason', async (t) => {
    if (skip(t)) return;
    const w = world({ snap: snapshot({ figcaption: 'Dr Rao with a patient' }) });
    const p = await getAltFixPreview(w.task, { imageSrc: SRC }, w.deps);
    assert.equal(p.plan.status, 'needs_input');
    assert.deepEqual(p.suggestions.map((s) => s.source), ['figcaption']);
    assert.equal(p.proposed.alt, null);
    const bad = await getAltFixPreview(w.task, { imageSrc: SRC, proposedAlt: 'dr-rao-768x512.jpg' }, w.deps);
    assert.equal(bad.plan.status, 'validation_failed');
    assert.match(bad.plan.message, /file name/);
  });

  test('meaningful library alt that the page does not render is a MISMATCH, never an overwrite: no write is offered', async (t) => {
    if (skip(t)) return;
    const w = world({ wp: makeWp({ items: [mediaItem(42, '2024/10/dr-rao.jpg', { alt_text: 'Dr Rao, senior surgeon' })] }) });
    const p = await preview(w);
    assert.equal(p.plan.status, 'rendered_mismatch');
    assert.equal(p.plan.code, 'RENDERED_ALT_OVERRIDES_LIBRARY');
    assert.match(p.plan.message, /Dr Rao, senior surgeon/);
    assert.equal(p.approvalStatus, 'not_available');
    assert.equal(p.diagnosis.libraryAlt, 'Dr Rao, senior surgeon');
    assert.equal(p.diagnosis.supported, false);
    // even with a proposed text, nothing is writable
    const proposed = await preview(w, { ...INPUT, proposedAlt: 'A different description of the surgeon' });
    assert.equal(proposed.plan.status, 'rendered_mismatch');
    await assert.rejects(applyAltFix(w.task, { ...INPUT, approved: true, expectedPlanFingerprint: proposed.plan.fingerprint, actorId: new mongoose.Types.ObjectId() }, w.deps), (e) => e.code === 'FIELD_NOT_WRITABLE');
    assert.equal(w.wp.writes.length, 0);
  });

  test('existing alt text is kept and "nothing to change" stays reachable when a person confirms an evidence-decorative image is informative', async (t) => {
    if (skip(t)) return;
    const w = world({ snap: snapshot({ ariaHidden: true }), wp: makeWp({ items: [mediaItem(42, '2024/10/dr-rao.jpg', { alt_text: 'Dr Rao, senior surgeon' })] }) });
    const kept = await preview(w, { ...INPUT, informative: true });
    assert.equal(kept.plan.status, 'existing_alt_preserved');
    assert.match(kept.plan.message, /Dr Rao, senior surgeon/);
    const same = await preview(w, { ...INPUT, proposedAlt: 'Dr Rao, senior surgeon', informative: true });
    assert.equal(same.plan.status, 'nothing_to_change');
  });

  test('an image whose alt lives in the PAGE CONTENT is unsupported: a library write could not change the page', async (t) => {
    if (skip(t)) return;
    const w = world({ wp: makeWp({ raw: '<img class="wp-image-42" src="https://clinic.example/wp-content/uploads/2024/10/dr-rao.jpg" alt="">' }) });
    const p = await preview(w);
    assert.equal(p.plan.status, 'unsupported');
    assert.equal(p.plan.code, 'ALT_EMBEDDED_IN_CONTENT');
    assert.match(p.plan.message, /page editor/);
    assert.equal(p.contentEffect.status, 'embedded');
  });

  test('permission denied while reading the attachment surfaces as PERMISSION_DENIED', async (t) => {
    if (skip(t)) return;
    const w = world({ snap: snapshot({ wpAttachmentId: 42 }) });
    w.wp.readError = new WordPressConnectionError('PERMISSION_DENIED', 'no', 403);
    await assert.rejects(preview(w), (e) => e.code === 'PERMISSION_DENIED' && e.statusCode === 403);
  });
});

describe('apply — exact target, approval bound to the preview, compare-before-write', () => {
  test('writes ONLY alt_text of THAT attachment, records before/after + actor + identity, reads back, and never marks the task verified', async (t) => {
    if (skip(t)) return;
    const w = world();
    const actorId = new mongoose.Types.ObjectId();
    const r = await apply(w, { actorId });

    assert.deepEqual(w.wp.writes, [{ id: 42, body: { alt_text: INPUT.proposedAlt } }], 'one write, one field, one attachment');
    assert.equal(w.wp.lib.get(42).alt_text, INPUT.proposedAlt);
    assert.equal(r.alreadyApplied, false);
    assert.equal(r.immediateVerification, 'success');
    assert.equal(r.fix.status, 'applied');
    assert.equal(r.fix.verification.saved.status, 'verified');
    assert.equal(r.fix.verification.rendered.status, 'pending');
    assert.equal(w.task.status, 'implemented');
    assert.equal(w.transitions.length, 1);
    assert.deepEqual(w.transitions[0].expectedAfterValueOverride.images.map((i) => [i.src, i.attachmentId, i.alt]), [[SRC, 42, INPUT.proposedAlt]]);
    assert.equal(w.transitions[0].externalWrite.field, 'image_alt');

    const rec = await WordPressFixRecord.findOne({ taskId: w.task._id });
    assert.equal(String(rec.approvedBy), String(actorId));
    assert.equal(rec.fixType, 'image_alt');
    assert.equal(rec.target.attachmentId, 42);
    assert.equal(rec.target.imageSourceUrl, SRC);
    assert.equal(rec.target.identityMethod, 'exact_source_url');
    assert.deepEqual(rec.changes.map((c) => [c.field, c.before, c.after, c.applied]), [['alt_text', '', INPUT.proposedAlt, true]]);
  });

  test('without approval, without the fingerprint, or for another issue type, nothing is written', async (t) => {
    if (skip(t)) return;
    const w = world();
    const fp = (await preview(w)).plan.fingerprint;
    await assert.rejects(applyAltFix(w.task, { ...INPUT, approved: false, expectedPlanFingerprint: fp }, w.deps), (e) => e.code === 'WRITE_FAILED' && e.statusCode === 400);
    await assert.rejects(applyAltFix(w.task, { ...INPUT, approved: true }, w.deps), (e) => e.code === 'EXPECTED_STATE_REQUIRED');
    await assert.rejects(applyAltFix(w.task, { ...INPUT, approved: true, expectedPlanFingerprint: 'nope' }, w.deps), (e) => e.code === 'EXPECTED_STATE_REQUIRED');
    w.task.issueKey = 'title_missing';
    await assert.rejects(applyAltFix(w.task, { ...INPUT, approved: true, expectedPlanFingerprint: fp }, w.deps), (e) => e.code === 'FIELD_NOT_WRITABLE');
    assert.equal(w.wp.writes.length, 0);
  });

  test('approval is bound to the exact text: a different proposed alt (or a changed current alt) invalidates the previewed fingerprint', async (t) => {
    if (skip(t)) return;
    const w = world();
    const fp = (await preview(w)).plan.fingerprint;
    await assert.rejects(applyAltFix(w.task, { ...INPUT, proposedAlt: 'A different description of the doctor', approved: true, expectedPlanFingerprint: fp }, w.deps), (e) => e.code === 'CONFLICT' && e.details.reason === 'preview_stale');
    w.wp.lib.get(42).alt_text = 'Edited by an editor';
    await assert.rejects(applyAltFix(w.task, { ...INPUT, approved: true, expectedPlanFingerprint: fp }, w.deps), (e) => e.code === 'CONFLICT');
    assert.equal(w.wp.writes.length, 0);
  });

  test('a human edit AFTER the fingerprint check but BEFORE the write is detected: conflict_detected, the editor\'s value is intact', async (t) => {
    if (skip(t)) return;
    const w = world();
    const fp = (await preview(w)).plan.fingerprint;
    // Without a wp-image hint the plan is built from a search; the FIRST attachment read is the one made immediately before the write.
    let reads = 0; const orig = w.wp.readMediaById.bind(w.wp);
    w.wp.readMediaById = async (id) => { reads += 1; if (reads === 1) w.wp.lib.get(id).alt_text = 'Typed by a person a moment ago'; return orig(id); };
    await assert.rejects(applyAltFix(w.task, { ...INPUT, approved: true, expectedPlanFingerprint: fp }, w.deps), (e) => e.code === 'CONFLICT' && e.details.reason === 'alt_changed');
    assert.equal(w.wp.writes.length, 0);
    assert.equal(w.wp.lib.get(42).alt_text, 'Typed by a person a moment ago');
    assert.equal((await WordPressFixRecord.findOne({ taskId: w.task._id })).status, 'conflict_detected');
    assert.equal(w.task.status, 'task_created');
  });

  test('the target attachment was REPLACED between preview and write (its files no longer list the observed image) -> conflict, no write', async (t) => {
    if (skip(t)) return;
    const w = world();
    const fp = (await preview(w)).plan.fingerprint;
    let reads = 0; const orig = w.wp.readMediaById.bind(w.wp);
    w.wp.readMediaById = async (id) => { reads += 1; if (reads === 1) w.wp.lib.set(42, mediaItem(42, '2025/01/replacement.jpg')); return orig(id); };
    await assert.rejects(applyAltFix(w.task, { ...INPUT, approved: true, expectedPlanFingerprint: fp }, w.deps), (e) => e.details?.reason === 'target_changed');
    assert.equal(w.wp.writes.length, 0);
  });

  test('permission denied on the write is recorded as permission_denied; the task is untouched', async (t) => {
    if (skip(t)) return;
    const w = world();
    w.wp.failWrite = new WordPressConnectionError('PERMISSION_DENIED', 'This WordPress account does not have permission to edit this field.', 403);
    await assert.rejects(apply(w), (e) => e.code === 'PERMISSION_DENIED');
    assert.equal((await WordPressFixRecord.findOne({ taskId: w.task._id })).status, 'permission_denied');
    assert.equal(w.task.status, 'task_created');
    assert.equal(w.wp.writes.length, 1, 'a 403 is not retried');
  });

  test('a rejected write (4xx) is not retried: apply_failed after ONE attempt', async (t) => {
    if (skip(t)) return;
    const w = world();
    w.wp.failWrite = new WordPressConnectionError('WRITE_FAILED', 'WordPress rejected this change.', 422);
    await assert.rejects(apply(w), (e) => e.code === 'WRITE_FAILED');
    assert.equal(w.wp.writes.length, 1);
    assert.equal((await WordPressFixRecord.findOne({ taskId: w.task._id })).status, 'apply_failed');
  });

  test('a transient failure is retried within a bound, then succeeds', async (t) => {
    if (skip(t)) return;
    const w = world();
    w.wp.failFirst = 1;
    const r = await apply(w);
    assert.equal(r.fix.status, 'applied');
    assert.equal(w.wp.writes.length, 2);
    const never = world();
    never.wp.failWrite = new WordPressConnectionError('TIMEOUT', 'timed out', 504);
    await assert.rejects(apply(never));
    assert.equal(never.wp.writes.length, 3, 'one write + two bounded retries, never more');
  });

  test('a write that LANDED but whose response was lost is not repeated on retry', async (t) => {
    if (skip(t)) return;
    const w = world();
    w.wp.landThenTimeout = true;
    const r = await apply(w);
    assert.equal(r.fix.status, 'applied');
    assert.equal(w.wp.writes.length, 1, 'the retry read the value, saw it was already there, and did not write again');
  });

  test('SAVED-state mismatch (200 but WordPress does not hold the value): verification_failed, never verified', async (t) => {
    if (skip(t)) return;
    const w = world();
    const orig = w.wp.writeAltTextForAttachment.bind(w.wp);
    w.wp.writeAltTextForAttachment = async (id, alt) => { await orig(id, alt); w.wp.lib.get(id).alt_text = 'something else'; return { httpStatus: 200, wordpressPostId: id }; };
    const r = await apply(w);
    assert.equal(r.immediateVerification, 'failed');
    assert.equal(r.fix.status, 'verification_failed');
    assert.match(r.fix.verification.saved.reasons.join(' '), /something else/);
  });

  test('IDEMPOTENCY: two simultaneous identical requests write exactly once', async (t) => {
    if (skip(t)) return;
    const w = world();
    const fp = (await preview(w)).plan.fingerprint;
    const results = await Promise.allSettled([
      applyAltFix(w.task, { ...INPUT, approved: true, expectedPlanFingerprint: fp }, w.deps),
      applyAltFix(w.task, { ...INPUT, approved: true, expectedPlanFingerprint: fp }, w.deps),
    ]);
    assert.equal(w.wp.writes.length, 1);
    assert.equal(await WordPressFixRecord.countDocuments({ taskId: w.task._id }), 1);
    assert.ok(results.some((r) => r.status === 'fulfilled'));
  });

  test('a second image on a page whose task is already implemented is added to the task\'s expected after-state; verified tasks are refused', async (t) => {
    if (skip(t)) return;
    const second = `${UPLOADS}/2024/11/nurse.jpg`;
    const flagged = [{ before_snapshot: snapshot() }, { before_snapshot: snapshot({ src: second, imageUrl: second }) }];
    const w = world({ wp: makeWp({ items: [mediaItem(42, '2024/10/dr-rao.jpg'), mediaItem(43, '2024/11/nurse.jpg')] }), flagged });
    await apply(w);
    assert.equal(w.task.status, 'implemented');
    await applyAltFix(w.task, { imageSrc: second, proposedAlt: 'A nurse preparing the surgical instruments', approved: true, expectedPlanFingerprint: (await getAltFixPreview(w.task, { imageSrc: second, proposedAlt: 'A nurse preparing the surgical instruments' }, w.deps)).plan.fingerprint }, w.deps);
    assert.equal(w.transitions.length, 1, 'no second transition');
    const images = w.task.fixHistory[0].fixApplied.expectedAfterValue.images;
    assert.deepEqual(images.map((i) => i.attachmentId).sort(), [42, 43]);
    w.task.status = 'verified_fixed';
    await assert.rejects(applyAltFix(w.task, { ...INPUT, approved: true, expectedPlanFingerprint: 'a'.repeat(64) }, w.deps), (e) => e.code === 'CONFLICT');
  });
});

describe('rollback — only what Odito changed, only while it still holds Odito\'s value', () => {
  test('restores the previous (empty) alt, records it, and cannot be rolled back twice', async (t) => {
    if (skip(t)) return;
    const w = world();
    await apply(w);
    const out = await rollbackAltFix(w.task, { imageSrc: SRC }, w.deps);
    assert.equal(w.wp.lib.get(42).alt_text, '');
    assert.equal(out.fix.status, 'rolled_back');
    assert.equal(out.fix.rollback.status, 'verified', 'restored and read back from WordPress');
    assert.equal(out.fix.rollback.saved.status, 'verified');
    assert.match(out.message, /missing alt text from an empty one/);
    await assert.rejects(rollbackAltFix(w.task, { imageSrc: SRC }, w.deps), (e) => e.statusCode === 404);
    assert.equal(w.wp.writes.length, 2, 'one apply + one restore');
  });

  test('a newer human edit is never overwritten: the rollback is refused for that field and says so', async (t) => {
    if (skip(t)) return;
    const w = world();
    await apply(w);
    w.wp.lib.get(42).alt_text = 'Rewritten by the editor-in-chief';
    const out = await rollbackAltFix(w.task, { imageSrc: SRC }, w.deps);
    assert.equal(w.wp.lib.get(42).alt_text, 'Rewritten by the editor-in-chief');
    assert.equal(out.fix.rollback.status, 'failed');
    assert.deepEqual(out.fix.rollback.conflictFields, ['alt_text']);
    assert.match(out.message, /left as it is now/);
    assert.equal(w.wp.writes.length, 1);
  });

  test('already restored by someone else is idempotent (no write); nothing applied -> nothing to roll back', async (t) => {
    if (skip(t)) return;
    const w = world();
    await assert.rejects(rollbackAltFix(w.task, { imageSrc: SRC }, w.deps), (e) => e.statusCode === 404);
    await apply(w);
    w.wp.lib.get(42).alt_text = '';
    const out = await rollbackAltFix(w.task, { imageSrc: SRC }, w.deps);
    assert.equal(out.fix.status, 'rolled_back');
    assert.equal(w.wp.writes.length, 1);
  });

  test('after a rollback the same plan can be approved and applied again', async (t) => {
    if (skip(t)) return;
    const w = world();
    await apply(w);
    await rollbackAltFix(w.task, { imageSrc: SRC }, w.deps);
    w.task.status = 'reopened';
    const again = await apply(w);
    assert.equal(again.fix.status, 'applied');
    assert.equal(w.wp.lib.get(42).alt_text, INPUT.proposedAlt);
  });
});

describe('rendered-page verification — the SAME image, found by stable evidence', () => {
  const target = { attachmentId: 42, exactPaths: [...attachmentExactPaths(mediaItem(42, '2024/10/dr-rao.jpg'))] };
  const applied = new Date('2026-10-15T10:00:00Z');
  const crawl = (images, scraped = '2026-10-15T12:00:00Z') => ({ scraped_at: scraped, images });
  const run = (pageDoc) => renderedAltCheck({ pageDoc, target, expected: INPUT.proposedAlt, appliedAt: applied, now: new Date() });

  test('the matched image shows the approved alt -> verified', () => {
    assert.equal(run(crawl([{ src: SRC, alt: INPUT.proposedAlt, wp_attachment_id: 42 }])).status, 'verified');
  });
  test('responsive / lazy / CDN variants of the same attachment are matched by exact path', () => {
    const r = run(crawl([
      { src: 'https://cdn.example/wp-content/uploads/2024/10/dr-rao-768x512.jpg', alt: INPUT.proposedAlt },
      { src: 'data:image/gif;base64,AAA', lazy_src: SRC, alt: INPUT.proposedAlt },
    ]));
    assert.equal(r.status, 'verified');
  });
  test('the page still shows the old alt (a stale cache / CDN, or alt stored in the content) -> failed, explained, and nothing is rewritten', () => {
    const r = run(crawl([{ src: SRC, alt: '', wp_attachment_id: 42 }]));
    assert.equal(r.status, 'failed');
    assert.match(r.reasons.join(' '), /cache or CDN/);
    assert.match(r.reasons.join(' '), /does not re-write the same value/);
  });
  test('STALE crawl (older than the write) -> PENDING (a recrawl will settle it), never a pass', () => {
    const r = run(crawl([{ src: SRC, alt: INPUT.proposedAlt, wp_attachment_id: 42 }], '2026-10-15T09:00:00Z'));
    assert.equal(r.status, 'pending');
    assert.equal(r.reasonCode, 'NO_POST_WRITE_CRAWL');
    assert.match(r.reasons.join(' '), /cannot_be_checked/);
  });
  test('the image cannot be matched with stable evidence (file-name similarity only) -> cannot be checked', () => {
    const r = run(crawl([{ src: `${UPLOADS}/2023/01/dr-rao.jpg`, alt: INPUT.proposedAlt }]));
    assert.equal(r.status, 'unverifiable');
  });
  test('a rendered image that names ANOTHER attachment but uses this file is not unambiguously this image', () => {
    const r = run(crawl([{ src: SRC, alt: INPUT.proposedAlt, wp_attachment_id: 77 }]));
    assert.equal(r.status, 'unverifiable');
    assert.match(r.reasons.join(' '), /different attachment/);
  });
  test('the page missing from the crawl is cannot-be-checked; one matched image wrong among several is a failure', () => {
    assert.equal(run(null).status, 'pending');
    assert.equal(run(null).reasonCode, 'PAGE_NOT_CRAWLED');
    assert.equal(run(crawl([{ src: SRC, alt: INPUT.proposedAlt }, { src: SRC, alt: '' }])).status, 'failed');
  });
});

describe('reverify — saved and rendered reported separately', () => {
  test('saved ok + stale crawl -> saved verified, rendered cannot be checked, the fix stays applied', async (t) => {
    if (skip(t)) return;
    const w = world();
    await apply(w);
    world.pageDoc = { scraped_at: new Date(Date.now() - 3600 * 1000), images: [{ src: SRC, alt: INPUT.proposedAlt, wp_attachment_id: 42 }] };
    const r = await reverifyAltFix(w.task, { imageSrc: SRC }, w.deps);
    assert.equal(r.fix.verification.saved.status, 'verified');
    assert.equal(r.fix.verification.rendered.status, 'pending');
    assert.equal(r.fix.verification.rendered.reasonCode, 'NO_POST_WRITE_CRAWL');
    assert.equal(r.fix.status, 'applied');
  });
  test('saved ok + fresh crawl showing the alt on the same image -> verified', async (t) => {
    if (skip(t)) return;
    const w = world();
    await apply(w);
    world.pageDoc = { scraped_at: new Date(Date.now() + 60 * 1000), images: [{ src: SRC, alt: INPUT.proposedAlt, wp_attachment_id: 42 }] };
    const r = await reverifyAltFix(w.task, { imageSrc: SRC }, w.deps);
    assert.equal(r.fix.status, 'verified');
    assert.equal(w.wp.writes.length, 1, 're-verifying never writes');
  });
  test('saved ok but the crawl shows no alt -> verification_failed; WordPress changed later -> saved failed', async (t) => {
    if (skip(t)) return;
    const w = world();
    await apply(w);
    world.pageDoc = { scraped_at: new Date(Date.now() + 60 * 1000), images: [{ src: SRC, alt: '', wp_attachment_id: 42 }] };
    const r = await reverifyAltFix(w.task, { imageSrc: SRC }, w.deps);
    assert.equal(r.fix.status, 'verification_failed');
    assert.equal(r.fix.verification.rendered.status, 'failed');
    assert.equal(w.wp.writes.length, 1, 'a stale cache is never "fixed" by writing the same value again');
    w.wp.lib.get(42).alt_text = 'changed later';
    assert.equal((await reverifyAltFix(w.task, { imageSrc: SRC }, w.deps)).fix.verification.saved.status, 'failed');
  });
  test('nothing applied for the image -> a clear error', async (t) => {
    if (skip(t)) return;
    const w = world();
    await assert.rejects(reverifyAltFix(w.task, { imageSrc: SRC }, w.deps), (e) => e.statusCode === 404);
  });
});

// ── Reliability hardening: Bridge compare-and-swap, ambiguity, crash recovery, staged rollback, per-image roll-up ──────────

const timeout = () => new WordPressConnectionError('TIMEOUT', 'timed out', 504);
const conflictReason = (reason) => { const e = new WordPressConnectionError('CONFLICT', 'changed', 409); e.reason = reason; return e; };
const recordFor = (w, src = SRC) => WordPressFixRecord.findOne({ taskId: w.task._id, 'target.imageSourceUrl': src });

/** A Bridge 1.5.0 double over the SAME media library, with the real conditional semantics (expected value + approved file). */
function makeBridge(wp, { installed = true, mediaAlt = true } = {}) {
  const b = {
    calls: [], faults: [], beforeSwap: null,
    status: { installed, mediaAltSupported: mediaAlt, conditionalWritesSupported: mediaAlt },
    async getBridgeStatus() { return b.status; },
    async swapMediaAlt(_c, id, { value, expected, expectedFile }) {
      b.calls.push({ id, value, expected, expectedFile });
      if (b.beforeSwap) { const fn = b.beforeSwap; b.beforeSwap = null; fn(wp.lib.get(id)); }
      const item = wp.lib.get(id);
      const fault = b.faults.find((f) => (f.times ?? 1) > 0 && (f.id == null || f.id === id));
      if (fault && fault.mode === 'throw') { fault.times = (fault.times ?? 1) - 1; throw fault.error; }
      if (!item || item.media_details.file !== expectedFile) throw conflictReason('target_changed');
      const stored = String(item.alt_text ?? '');
      let alreadyApplied = false;
      const creating = stored === '' && expected === ''; // WordPress cannot tell a missing record from an empty one; an absent row is CREATED check-then-insert
      if (stored !== expected) {
        if (stored !== value) throw conflictReason('expected_mismatch');
        alreadyApplied = true;
      } else {
        item.alt_text = value;
      }
      if (fault && fault.mode === 'commit_then_throw') { fault.times = (fault.times ?? 1) - 1; if (fault.then) fault.then(); throw fault.error; }
      return { id, alt: item.alt_text, file: item.media_details.file, operation: { id: `op-${b.calls.length}`, atomic: !creating, alreadyApplied, created: creating && !alreadyApplied, attempts: null } };
    },
  };
  return b;
}

const bridged = (over = {}) => { const wp = over.wp || makeWp(); const bridge = makeBridge(wp, over.bridge || {}); return { ...world({ ...over, wp, bridge }), bridge }; };

/** A record as a crashed process leaves it. */
async function seedRecord(w, { status = 'applying', landed = false, ageMs = 10 * 60 * 1000, rollback = null, restored = false, src = SRC } = {}) {
  const p = await preview(w);
  const { idempotencyKey } = await import('../ledger/fixLedger.js');
  const doc = await WordPressFixRecord.create({
    projectId: w.projectId, connectionId: new mongoose.Types.ObjectId(), taskId: w.task._id, fixType: 'image_alt', targetUrl: w.task.pageUrl,
    targetWordPressObjectId: 42, scope: 'post', provider: 'none',
    target: { imageSourceUrl: src, attachmentId: 42, identityMethod: 'exact_path', identityConfidence: 'high', exactPaths: [...attachmentExactPaths(w.wp.lib.get(42))], altStateObserved: 'missing' },
    planFingerprint: p.plan.fingerprint, idempotencyKey: idempotencyKey(w.task._id, 'image_alt', 42, p.plan.fingerprint),
    status, approvedAt: new Date(Date.now() - 60000), appliedAt: ['applied', 'rolled_back'].includes(status) ? new Date(Date.now() - 120000) : null,
    changes: [{ field: 'alt_text', before: '', after: INPUT.proposedAlt, source: 'human_input', applied: landed, restored, writeState: landed ? 'landed' : 'in_flight' }],
    ...(rollback ? { rollback } : {}),
  });
  await WordPressFixRecord.collection.updateOne({ _id: doc._id }, { $set: { updatedAt: new Date(Date.now() - ageMs) } });
  return { fp: p.plan.fingerprint, id: doc._id };
}

describe('Bridge conditional write — the identity and the expected value are checked where the write happens', () => {
  test('with Bridge 1.5.0 the write goes through the conditional route, sends no field name, and the core PUT is never used', async (t) => {
    if (skip(t)) return;
    const w = bridged();
    const p = await preview(w);
    assert.equal(p.concurrency.writes, 'database_conditional');
    assert.equal(p.concurrency.creationWindow, true, 'an image with no alt text record yet is created check-then-insert, and the preview says so');
    const r = await apply(w);
    assert.equal(r.fix.status, 'applied');
    assert.equal(w.bridge.calls.length, 1);
    assert.deepEqual(w.bridge.calls[0], { id: 42, value: INPUT.proposedAlt, expected: '', expectedFile: '2024/10/dr-rao.jpg' });
    assert.equal(w.wp.writes.length, 0, 'the non-atomic core PUT was not used');
    const rec = await recordFor(w);
    assert.equal(rec.changes[0].writeMode, 'conditional_insert', 'creating the first alt-text record is check-then-insert and is recorded as such, never as one atomic step');
    assert.equal(rec.changes[0].atomic, false);
    assert.equal(rec.changes[0].operationId, 'op-1');
    assert.equal(rec.changes[0].attribution, 'response');
  });

  test('without the Bridge the core PUT is used and the record says it was NOT atomic', async (t) => {
    if (skip(t)) return;
    const w = world();
    assert.equal((await preview(w)).concurrency.writes, 'read_then_write');
    await apply(w);
    assert.equal(w.wp.writes.length, 1);
    assert.equal((await recordFor(w)).changes[0].atomic, false);
    assert.equal((await recordFor(w)).changes[0].writeMode, 'read_then_write');
    const old = bridged({ bridge: { installed: true, mediaAlt: false } });
    assert.equal((await preview(old)).concurrency.writes, 'read_then_write', 'a Bridge older than 1.5.0 is not claimed to be conditional');
  });

  test('a person edits the alt INSIDE the window the core PUT cannot see: the Bridge refuses, nothing is written, the edit survives', async (t) => {
    if (skip(t)) return;
    const w = bridged();
    w.bridge.beforeSwap = (item) => { item.alt_text = 'Written by the editor a millisecond earlier'; };
    await assert.rejects(apply(w), (e) => e.code === 'CONFLICT' && e.details.reason === 'alt_changed');
    assert.equal(w.wp.lib.get(42).alt_text, 'Written by the editor a millisecond earlier');
    assert.equal((await recordFor(w)).status, 'conflict_detected');
    assert.equal(w.task.status, 'task_created');
  });

  test('the attachment is REPLACED inside that window: the Bridge validates the approved file and refuses (target_changed)', async (t) => {
    if (skip(t)) return;
    const w = bridged();
    w.bridge.beforeSwap = (item) => { item.media_details.file = '2025/03/different-photo.jpg'; };
    await assert.rejects(apply(w), (e) => e.code === 'CONFLICT' && e.details.reason === 'target_changed');
    assert.equal(w.wp.lib.get(42).alt_text, '');
    assert.equal((await recordFor(w)).status, 'conflict_detected');
  });

  test('the exact stored value is what the Bridge is asked to match, not a normalised one', async (t) => {
    if (skip(t)) return;
    const w = bridged({ wp: makeWp({ items: [mediaItem(42, '2024/10/dr-rao.jpg', { alt_text: '   ' })] }) });
    const r = await apply(w);
    assert.equal(r.fix.status, 'applied');
    assert.equal(w.bridge.calls[0].expected, '   ', 'raw value, so the conditional UPDATE matches the real row');
  });
});

describe('ambiguous outcomes — read first, repeat never', () => {
  test('timeout AFTER the Bridge saved it: reconciled, attributed as such, written exactly once', async (t) => {
    if (skip(t)) return;
    const w = bridged();
    w.bridge.faults.push({ mode: 'commit_then_throw', error: timeout() });
    const r = await apply(w);
    assert.equal(w.bridge.calls.length, 1);
    assert.equal(r.fix.status, 'applied');
    assert.equal(r.fix.changes[0].attribution, 'reconciled');
  });

  test('a 500 after the write landed (not just a timeout) is also reconciled, never reported as a plain failure', async (t) => {
    if (skip(t)) return;
    const w = world();
    const orig = w.wp.writeAltTextForAttachment.bind(w.wp);
    w.wp.writeAltTextForAttachment = async (id, alt) => { await orig(id, alt); throw new WordPressConnectionError('WRITE_FAILED', 'Failed to write this change to WordPress.', 502); };
    const r = await apply(w);
    assert.equal(r.fix.status, 'applied');
    assert.equal(w.wp.writes.length, 1);
    assert.equal(r.fix.changes[0].attribution, 'reconciled');
  });

  test('timeout BEFORE it saved: one retry conditional on the value just read, then success', async (t) => {
    if (skip(t)) return;
    const w = bridged();
    w.bridge.faults.push({ mode: 'throw', error: timeout() });
    const r = await apply(w);
    assert.equal(w.bridge.calls.length, 2);
    assert.ok(w.bridge.calls.every((c) => c.expected === '' && c.expectedFile === '2024/10/dr-rao.jpg'));
    assert.equal(r.fix.changes[0].attribution, 'response');
  });

  test('bounded: a write that never lands is tried three times at most, then apply_failed with the alt untouched', async (t) => {
    if (skip(t)) return;
    const w = bridged();
    w.bridge.faults.push({ mode: 'throw', error: timeout(), times: 99 });
    await assert.rejects(apply(w), (e) => e.code === 'TIMEOUT');
    assert.equal(w.bridge.calls.length, 3);
    assert.equal(w.wp.lib.get(42).alt_text, '');
    assert.equal((await recordFor(w)).status, 'apply_failed');
  });

  test('timeout then a person typed something else: a conflict, their text is kept', async (t) => {
    if (skip(t)) return;
    const w = bridged();
    w.bridge.faults.push({ mode: 'throw', error: timeout(), then: () => {} });
    const orig = w.bridge.swapMediaAlt.bind(w.bridge);
    w.bridge.swapMediaAlt = async (...args) => { try { return await orig(...args); } catch (e) { w.wp.lib.get(42).alt_text = 'Typed by a person'; throw e; } };
    await assert.rejects(apply(w), (e) => e.code === 'CONFLICT');
    assert.equal(w.wp.lib.get(42).alt_text, 'Typed by a person');
  });

  test('timeout and the image cannot be re-read: apply_uncertain, nothing repeated; the next request reconciles instead of stalling', async (t) => {
    if (skip(t)) return;
    const w = bridged();
    const fp = (await preview(w)).plan.fingerprint;
    w.bridge.faults.push({ mode: 'commit_then_throw', error: timeout(), then: () => { w.wp.readError = timeout(); } });
    await assert.rejects(applyAltFix(w.task, { ...INPUT, approved: true, expectedPlanFingerprint: fp }, w.deps), (e) => e.code === 'OUTCOME_UNKNOWN' && Boolean(e.details.fixId));
    const rec = await recordFor(w);
    assert.equal(rec.status, 'apply_uncertain');
    assert.equal(w.bridge.calls.length, 1);
    assert.equal(w.task.status, 'task_created');
    const listed = await listAltImages(w.task, w.deps);
    assert.equal(listed[0].targetStatus, 'needs_reconcile');
    assert.equal(listed[0].recoverable, true);

    w.wp.readError = null;
    const again = await applyAltFix(w.task, { ...INPUT, approved: true, expectedPlanFingerprint: fp }, w.deps);
    assert.equal(again.recovered, true);
    assert.equal(again.fix.status, 'applied');
    assert.equal(w.bridge.calls.length, 1, 'still written once');
    assert.equal(w.task.status, 'implemented');
    assert.equal(w.transitions.length, 1);
  });
});

describe('crash recovery — a record left in flight is reconciled before anything else happens to it', () => {
  test('crash after the write landed: finished (verification + task) without another write', async (t) => {
    if (skip(t)) return;
    const w = bridged();
    const { fp } = await seedRecord(w);
    w.wp.lib.get(42).alt_text = INPUT.proposedAlt; // committed, the process died before recording it
    const r = await applyAltFix(w.task, { ...INPUT, approved: true, expectedPlanFingerprint: fp }, w.deps);
    assert.equal(w.bridge.calls.length, 0);
    assert.equal(r.recovered, true);
    assert.equal(r.fix.status, 'applied');
    assert.equal(r.fix.verification.saved.status, 'verified');
    assert.equal(w.transitions.length, 1);
    assert.equal(r.fix.changes[0].attribution, 'reconciled');
  });

  test('crash before anything was written: the abandoned record is settled and the fresh approval proceeds on the same row', async (t) => {
    if (skip(t)) return;
    const w = bridged();
    const { fp } = await seedRecord(w);
    const r = await applyAltFix(w.task, { ...INPUT, approved: true, expectedPlanFingerprint: fp }, w.deps);
    assert.equal(r.fix.status, 'applied');
    assert.equal(w.bridge.calls.length, 1);
    assert.equal(await WordPressFixRecord.countDocuments({ taskId: w.task._id }), 1);
  });

  test('crash while a person edited the alt: nothing is overwritten and the record says conflict', async (t) => {
    if (skip(t)) return;
    const w = bridged();
    const { fp } = await seedRecord(w);
    w.wp.lib.get(42).alt_text = 'Edited by a person';
    await assert.rejects(applyAltFix(w.task, { ...INPUT, approved: true, expectedPlanFingerprint: fp }, w.deps), (e) => e.code === 'CONFLICT');
    assert.equal(w.wp.lib.get(42).alt_text, 'Edited by a person');
    assert.equal(w.bridge.calls.length, 0);
    assert.equal((await recordFor(w)).status, 'conflict_detected');
  });

  test('crash while the attachment file was replaced: never treated as "landed"', async (t) => {
    if (skip(t)) return;
    const w = bridged();
    const { fp } = await seedRecord(w);
    w.wp.lib.get(42).alt_text = INPUT.proposedAlt;
    w.wp.lib.get(42).media_details = { file: '2025/05/another.jpg', sizes: {} };
    w.wp.lib.get(42).source_url = `${UPLOADS}/2025/05/another.jpg`;
    await assert.rejects(applyAltFix(w.task, { ...INPUT, approved: true, expectedPlanFingerprint: fp }, w.deps));
    assert.equal((await recordFor(w)).status, 'conflict_detected');
  });

  test('a record that is still fresh is never touched', async (t) => {
    if (skip(t)) return;
    const w = bridged();
    const { fp } = await seedRecord(w, { ageMs: 1000 });
    await assert.rejects(applyAltFix(w.task, { ...INPUT, approved: true, expectedPlanFingerprint: fp }, w.deps), (e) => e.details?.reason === 'fix_in_progress');
    assert.equal(w.bridge.calls.length, 0);
  });

  test('crash between "applied" and the task update: Re-verify finishes the task bookkeeping exactly once', async (t) => {
    if (skip(t)) return;
    const w = bridged();
    await seedRecord(w, { status: 'applied', landed: true });
    w.wp.lib.get(42).alt_text = INPUT.proposedAlt;
    await reverifyAltFix(w.task, { imageSrc: SRC }, w.deps);
    await reverifyAltFix(w.task, { imageSrc: SRC }, w.deps);
    assert.equal(w.task.status, 'implemented');
    assert.equal(w.transitions.length, 1);
  });

  test('Re-verify reconciles an abandoned apply (the image alt holds the text) instead of reporting on a half-known state', async (t) => {
    if (skip(t)) return;
    const w = bridged();
    await seedRecord(w, { status: 'apply_uncertain' });
    w.wp.lib.get(42).alt_text = INPUT.proposedAlt;
    const out = await reverifyAltFix(w.task, { imageSrc: SRC }, w.deps);
    assert.equal(out.fix.status, 'applied');
    assert.equal(w.bridge.calls.length, 0);
  });
});

describe('rollback — staged, resumable, identity-checked', () => {
  test('through the Bridge: conditional on the applied text, verified by reading the saved alt back', async (t) => {
    if (skip(t)) return;
    const w = bridged();
    await apply(w);
    const out = await rollbackAltFix(w.task, { imageSrc: SRC, actorId: new mongoose.Types.ObjectId() }, w.deps);
    assert.equal(w.bridge.calls[1].expected, INPUT.proposedAlt);
    assert.equal(w.bridge.calls[1].value, '');
    assert.equal(out.fix.rollback.status, 'verified');
    assert.ok(out.fix.rollback.requestedAt);
    assert.equal(out.fix.changes[0].restored, true);
  });

  test('restored but the read-back disagrees (WordPress acknowledged and stored nothing): "applied", not "verified"', async (t) => {
    if (skip(t)) return;
    const w = world();
    await apply(w);
    const orig = w.wp.writeAltTextForAttachment.bind(w.wp);
    w.wp.writeAltTextForAttachment = async (id) => ({ httpStatus: 200, wordpressPostId: id }); // acknowledged, stored nothing
    const out = await rollbackAltFix(w.task, { imageSrc: SRC }, w.deps);
    assert.equal(out.fix.rollback.status, 'applied');
    assert.equal(out.fix.rollback.saved.status, 'failed');
    w.wp.lib.get(42).alt_text = '';
    w.wp.writeAltTextForAttachment = orig;
    const again = await reverifyAltFix(w.task, { imageSrc: SRC }, w.deps);
    assert.equal(again.fix.rollback.status, 'verified');
  });

  test('a rollback that died halfway resumes: the alt was already put back, so it is recorded as restored without another write', async (t) => {
    if (skip(t)) return;
    const w = bridged();
    await seedRecord(w, { status: 'applied', landed: true, rollback: { status: 'requested', requestedAt: new Date(), restoredFields: [], conflictFields: [] } });
    w.wp.lib.get(42).alt_text = ''; // the restore committed before the crash
    const out = await rollbackAltFix(w.task, { imageSrc: SRC }, w.deps);
    assert.equal(w.bridge.calls.length, 0);
    assert.equal(out.fix.rollback.status, 'verified');
  });

  test('a replaced attachment is never written to by a rollback', async (t) => {
    if (skip(t)) return;
    const w = bridged();
    await apply(w);
    w.wp.lib.get(42).media_details = { file: '2025/05/another.jpg', sizes: {} };
    w.wp.lib.get(42).source_url = `${UPLOADS}/2025/05/another.jpg`;
    const out = await rollbackAltFix(w.task, { imageSrc: SRC }, w.deps);
    assert.equal(out.fix.rollback.status, 'failed');
    assert.equal(w.bridge.calls.length, 1, 'only the original apply');
    assert.equal(w.wp.lib.get(42).alt_text, INPUT.proposedAlt);
  });

  test('a repeated rollback after verification changes and writes nothing', async (t) => {
    if (skip(t)) return;
    const w = bridged();
    await apply(w);
    await rollbackAltFix(w.task, { imageSrc: SRC }, w.deps);
    const calls = w.bridge.calls.length;
    await assert.rejects(rollbackAltFix(w.task, { imageSrc: SRC }, w.deps), (e) => e.statusCode === 404);
    assert.equal(w.bridge.calls.length, calls);
  });

  test('after the rollback the page is re-checked: pending until a crawl newer than the rollback; failed if the page still shows Odito\'s text', async (t) => {
    if (skip(t)) return;
    const w = bridged();
    await apply(w);
    world.pageDoc = { scraped_at: new Date(Date.now() - 3600 * 1000), images: [{ src: SRC, alt: INPUT.proposedAlt, wp_attachment_id: 42 }] };
    const out = await rollbackAltFix(w.task, { imageSrc: SRC }, w.deps);
    assert.equal(out.fix.rollback.rendered.status, 'pending');
    world.pageDoc = { scraped_at: new Date(Date.now() + 60 * 1000), images: [{ src: SRC, alt: INPUT.proposedAlt, wp_attachment_id: 42 }] };
    const stale = await reverifyAltFix(w.task, { imageSrc: SRC }, w.deps);
    assert.equal(stale.fix.rollback.rendered.status, 'failed');
    assert.equal(stale.fix.rollback.rendered.reasonCode, 'RENDERED_STILL_SHOWS_APPLIED_TEXT');
    world.pageDoc = { scraped_at: new Date(Date.now() + 120 * 1000), images: [{ src: SRC, alt: '', wp_attachment_id: 42 }] };
    assert.equal((await reverifyAltFix(w.task, { imageSrc: SRC }, w.deps)).fix.rollback.rendered.status, 'verified');
  });
});

describe('several images on one task — per-target status and an honest roll-up', () => {
  const SECOND = `${UPLOADS}/2024/11/nurse.jpg`;
  const THIRD = `${UPLOADS}/2024/12/lab.jpg`;
  const multi = () => {
    const flagged = [{ before_snapshot: snapshot() }, { before_snapshot: snapshot({ src: SECOND, imageUrl: SECOND }) }, { before_snapshot: snapshot({ src: THIRD, imageUrl: THIRD }) }];
    const wp = makeWp({ items: [mediaItem(42, '2024/10/dr-rao.jpg'), mediaItem(43, '2024/11/nurse.jpg'), mediaItem(44, '2024/12/lab.jpg')] });
    const w = { ...world({ wp, flagged, bridge: makeBridge(wp) }) };
    w.bridge = w.deps.bridge;
    return w;
  };
  const input = (src, alt) => ({ imageSrc: src, proposedAlt: alt });
  const applyOne = async (w, src, alt, over = {}) => applyAltFix(w.task, { ...input(src, alt), approved: true, expectedPlanFingerprint: (await getAltFixPreview(w.task, input(src, alt), w.deps)).plan.fingerprint, ...over }, w.deps);

  test('one image fails, one succeeds, one is untouched: each reports its own status, the task-level result is "partially applied", and only the failed one is retryable', async (t) => {
    if (skip(t)) return;
    const w = multi();
    await applyOne(w, SRC, 'Dr Rao examining a patient with a slit lamp');
    w.bridge.faults.push({ id: 43, mode: 'throw', error: new WordPressConnectionError('PERMISSION_DENIED', 'no', 403) });
    await assert.rejects(applyOne(w, SECOND, 'A nurse preparing the surgical instruments'), (e) => e.code === 'PERMISSION_DENIED');

    const { images, summary } = await listAltImagesWithSummary(w.task, w.deps);
    const by = Object.fromEntries(images.map((i) => [i.src, i]));
    assert.equal(by[SRC].targetStatus, 'applied_pending_verification');
    assert.equal(by[SECOND].targetStatus, 'failed');
    assert.equal(by[SECOND].retryable, true);
    assert.equal(by[THIRD].targetStatus, 'not_started');
    assert.equal(summary.overall, 'partially_applied');
    assert.deepEqual(summary.retryable, [SECOND]);
    assert.equal(summary.remainingOpenImages, 1);

    // Retrying the failed image writes ONLY that image; the one that succeeded is not touched again.
    const callsBefore = w.bridge.calls.filter((c) => c.id === 42).length;
    await applyOne(w, SECOND, 'A nurse preparing the surgical instruments');
    assert.equal(w.bridge.calls.filter((c) => c.id === 42).length, callsBefore);
    assert.equal(w.wp.lib.get(43).alt_text, 'A nurse preparing the surgical instruments');
  });

  test('an image whose finding closed after a recrawl stays listed (union with the ledger), and the task is never "verified" until every changed image is', async (t) => {
    if (skip(t)) return;
    const w = multi();
    await applyOne(w, SRC, 'Dr Rao examining a patient with a slit lamp');
    await applyOne(w, SECOND, 'A nurse preparing the surgical instruments');
    // the recrawl closes the first image's finding
    const stillOpen = [{ before_snapshot: snapshot({ src: SECOND, imageUrl: SECOND }) }, { before_snapshot: snapshot({ src: THIRD, imageUrl: THIRD }) }];
    w.deps.loadFlaggedImages = async () => stillOpen;
    let listed = await listAltImages(w.task, w.deps);
    const first = listed.find((i) => i.src === SRC);
    assert.ok(first, 'a fixed image does not vanish when its finding closes');
    assert.equal(first.inFindings, false);

    const crawl = (alts) => ({ scraped_at: new Date(Date.now() + 60000), images: alts });
    world.pageDoc = crawl([{ src: SRC, alt: 'Dr Rao examining a patient with a slit lamp', wp_attachment_id: 42 }]);
    await reverifyAltFix(w.task, { imageSrc: SRC }, w.deps);
    listed = await listAltImagesWithSummary(w.task, w.deps);
    assert.equal(listed.summary.overall, 'partially_verified', 'one verified + one still pending is not "verified"');
    world.pageDoc = crawl([{ src: SECOND, alt: 'A nurse preparing the surgical instruments', wp_attachment_id: 43 }]);
    await reverifyAltFix(w.task, { imageSrc: SECOND }, w.deps);
    listed = await listAltImagesWithSummary(w.task, w.deps);
    assert.equal(listed.summary.overall, 'verified_images_remaining', 'every changed image verified, but one flagged image was never touched');
    assert.equal(listed.summary.byStatus.verified, 2);
  });
});

describe('approval binding', () => {
  test('the fingerprint is bound to the project and the connection: the same image state elsewhere gives a different fingerprint, and its approval is refused', async (t) => {
    if (skip(t)) return;
    const a = world();
    const b = world();
    const fpA = (await preview(a)).plan.fingerprint;
    const fpB = (await preview(b)).plan.fingerprint;
    assert.notEqual(fpA, fpB);
    await assert.rejects(applyAltFix(b.task, { ...INPUT, approved: true, expectedPlanFingerprint: fpA }, b.deps), (e) => e.details?.reason === 'preview_stale');
    assert.equal(b.wp.writes.length, 0);
  });
});

describe('verification states — pending is not unverifiable is not failed', () => {
  test('the attempt count grows with each re-check, and a stale crawl never turns into a failure', async (t) => {
    if (skip(t)) return;
    const w = world();
    await apply(w);
    world.pageDoc = { scraped_at: new Date(Date.now() - 3600 * 1000), images: [] };
    let r = await reverifyAltFix(w.task, { imageSrc: SRC }, w.deps);
    assert.equal(r.fix.verification.rendered.attempts, 1);
    r = await reverifyAltFix(w.task, { imageSrc: SRC }, w.deps);
    assert.equal(r.fix.verification.rendered.attempts, 2);
    assert.equal(r.fix.verification.rendered.status, 'pending');
    world.pageDoc = { scraped_at: new Date(Date.now() + 60000), images: [{ src: `${UPLOADS}/2023/01/dr-rao.jpg`, alt: 'x' }] };
    r = await reverifyAltFix(w.task, { imageSrc: SRC }, w.deps);
    assert.equal(r.fix.verification.rendered.status, 'unverifiable');
    assert.equal(r.fix.verification.rendered.reasonCode, 'IMAGE_NOT_MATCHED');
    assert.equal(r.fix.status, 'applied');
  });
});

describe('resource kinds — only a media-library upload is ever a write target', () => {
  const FB = 'https://www.facebook.com/tr?id=1064713942451011&ev=PageView&noscript=1';
  const trackerSnap = () => snapshot({ src: FB, imageUrl: FB, altState: 'unknown' });

  test('STALE persisted tracker findings are left out of the list and counted, not shown as images; real images stay', async (t) => {
    if (skip(t)) return;
    const w = world({ flagged: [{ before_snapshot: trackerSnap() }, { before_snapshot: snapshot({ altState: 'missing' }) }] });
    const out = await listAltImagesWithSummary(w.task, w.deps);
    assert.deepEqual(out.images.map((i) => i.src), [SRC]);
    assert.deepEqual([out.images[0].resourceKind, out.images[0].mediaLibraryCandidate], ['wp_media', true]);
    assert.equal(out.ignored.trackingEndpoints, 1);
    assert.equal(out.summary.remainingOpenImages, 1, 'the tracker is not an open image');
  });

  test('a task whose ONLY finding is a tracker lists nothing and says why (count only — never the tracking id)', async (t) => {
    if (skip(t)) return;
    const w = world({ flagged: [{ before_snapshot: trackerSnap() }] });
    const out = await listAltImagesWithSummary(w.task, w.deps);
    assert.deepEqual(out.images, []);
    assert.equal(out.ignored.trackingEndpoints, 1);
    assert.ok(!JSON.stringify(out).includes('1064713942451011'));
  });

  test('theme, plugin, external and ordinary files are listed (still findings) but flagged as not media-library candidates', async (t) => {
    if (skip(t)) return;
    const mk = (src) => ({ before_snapshot: snapshot({ src, imageUrl: src }) });
    const w = world({ flagged: [mk(`${SITE}/wp-content/themes/x/hero.jpg`), mk(`${SITE}/wp-content/plugins/x/a.png`), mk('https://images.example.org/p.jpg'), mk(`${SITE}/images/plain.jpg`)] });
    const images = await listAltImages(w.task, w.deps);
    assert.deepEqual(images.map((i) => [i.resourceKind, i.mediaLibraryCandidate]), [['theme_asset', false], ['plugin_asset', false], ['external_image', false], ['content_image', false]]);
  });

  test('previewing a tracker: unsupported TRACKING_ENDPOINT, nothing to approve, WordPress never read or written, id never echoed', async (t) => {
    if (skip(t)) return;
    const w = world({ snap: trackerSnap() });
    const p = await preview(w, { imageSrc: FB });
    assert.deepEqual([p.identity.status, p.identity.code, p.plan.status, p.plan.code], ['unsupported', 'TRACKING_ENDPOINT', 'unsupported', 'TRACKING_ENDPOINT']);
    assert.equal(p.approvalStatus, 'not_available');
    assert.equal(w.wp.writes.length, 0);
    assert.equal(w.wp.reads, 0);
    assert.ok(!JSON.stringify([p.identity.message, p.plan.message]).includes('1064713942451011'));
  });

  test('APPLY on a tracker (even with approval and a fingerprint) is refused and writes nothing', async (t) => {
    if (skip(t)) return;
    const w = world({ snap: trackerSnap() });
    const input = { imageSrc: FB, proposedAlt: 'Facebook pixel' };
    const fp = (await preview(w, input)).plan.fingerprint;
    await assert.rejects(applyAltFix(w.task, { ...input, approved: true, expectedPlanFingerprint: fp, actorId: new mongoose.Types.ObjectId() }, w.deps));
    assert.equal(w.wp.writes.length, 0);
  });

  test('previewing a theme file, an external image and an inline data image each gives the specific reason and no write path', async (t) => {
    if (skip(t)) return;
    const codeFor = async (src) => {
      const w = world({ snap: snapshot({ src, imageUrl: null }) });
      const p = await preview(w, { imageSrc: src });
      assert.equal(p.plan.status, 'unsupported'); assert.equal(w.wp.writes.length, 0);
      return p.plan.code;
    };
    assert.equal(await codeFor(`${SITE}/wp-content/themes/x/hero.jpg`), 'THEME_ASSET');
    assert.equal(await codeFor('https://images.example.org/p.jpg'), 'EXTERNAL_IMAGE');
    assert.equal(await codeFor('data:image/gif;base64,R0lGODlhAQABAAAAACw='), 'DATA_URL_IMAGE');
  });

  test('the working path is unchanged: a real upload with a wp-image id still resolves and can be applied', async (t) => {
    if (skip(t)) return;
    const w = world({ snap: snapshot({ wpAttachmentId: 42 }) });
    assert.equal((await preview(w)).plan.status, 'ready');
    const r = await apply(w);
    assert.equal(w.wp.writes.length, 1);
    assert.ok(r);
  });
});

describe('reusing the AI recommendation per image — read-only until the person approves', () => {
  const AI = 'Dr Rao examining a patient with a slit lamp';
  const source = (proposals, over = {}) => ({ found: true, recommendationId: 'rec-1', generatedAt: new Date('2026-10-16T12:00:00Z'), proposals, legacyText: '', ...over });
  const withRec = (w, src) => { let loads = 0; w.deps.loadRecommendation = async () => { loads += 1; return src; }; return () => loads; };
  const applyText = async (w, text, actorId = new mongoose.Types.ObjectId()) => {
    const input = { imageSrc: SRC, proposedAlt: text };
    const fp = (await getAltFixPreview(w.task, input, w.deps)).plan.fingerprint;
    return applyAltFix(w.task, { ...input, approved: true, expectedPlanFingerprint: fp, actorId }, w.deps);
  };

  test('the preview carries the existing recommendation for THIS exact image, with server-computed evidence — and changes nothing', async (t) => {
    if (skip(t)) return;
    const w = world();
    const loads = withRec(w, source([{ src: SRC, alt: AI, basis: 'file name', rejected: null }]));
    const p = await preview(w, { imageSrc: SRC });
    assert.equal(p.recommendation.status, 'available');
    assert.equal(p.recommendation.alt, AI);
    assert.equal(p.recommendation.match, 'exact_src');
    assert.equal(p.recommendation.reviewStatus, 'needs_review');
    assert.equal(p.recommendation.recommendationId, 'rec-1');
    assert.ok(p.recommendation.evidence.some((e) => e.includes('dr-rao')), 'evidence comes from the crawl, not the model');
    assert.equal(p.plan.status, 'needs_input', 'a suggestion is not an approval: the plan still needs the text to be confirmed');
    assert.equal(p.proposed.alt, null);
    assert.equal(loads(), 1);
    assert.equal(w.wp.writes.length, 0);
  });

  test('SIX recommendations are resolved independently, one per image, in the list and in each preview', async (t) => {
    if (skip(t)) return;
    const names = ['logo', 'david', 'emily', 'michael', 'jane', 'sophia'];
    const items = names.map((n, i) => mediaItem(100 + i, `2025/12/${n}.webp`));
    const srcs = names.map((n) => `${UPLOADS}/2025/12/${n}.webp`);
    const w = world({ wp: makeWp({ items }), flagged: srcs.map((s, i) => ({ before_snapshot: snapshot({ src: s, imageUrl: s, wpAttachmentId: 100 + i }) })) });
    withRec(w, source(srcs.map((s, i) => ({ src: s, alt: `Description ${names[i]} for the agency`, basis: 'file name', rejected: null }))));
    const list = await listAltImages(w.task, w.deps);
    assert.deepEqual(list.map((i) => i.aiSuggestion), [true, true, true, true, true, true]);
    for (let i = 0; i < 6; i += 1) {
      const p = await getAltFixPreview(w.task, { imageSrc: srcs[i] }, w.deps);
      assert.equal(p.recommendation.alt, `Description ${names[i]} for the agency`);
      assert.equal(p.identity.attachmentId, 100 + i);
    }
  });

  test('approving the AI text applies EXACTLY it, reads it back, and records that it came from the recommendation', async (t) => {
    if (skip(t)) return;
    const w = world({ snap: snapshot({ wpAttachmentId: 42 }) });
    withRec(w, source([{ src: SRC, alt: AI, basis: 'file name', rejected: null }]));
    const r = await applyText(w, AI);
    assert.deepEqual(w.wp.writes, [{ id: 42, body: { alt_text: AI } }]);
    assert.equal(w.wp.lib.get(42).alt_text, AI);
    assert.equal(r.fix.verification.saved.status, 'verified', 'the value is read back before anything is called done');
    assert.equal(r.fix.verification.rendered.status, 'pending', 'and the live page is only confirmed by the next recrawl');
    const rec = await WordPressFixRecord.findOne({ taskId: w.task._id });
    assert.equal(rec.changes[0].source, 'ai_recommendation');
    assert.equal(rec.target.textSource, 'ai_recommendation');
    assert.equal(rec.target.recommendationId, 'rec-1');
  });

  test('an edited AI text is recorded as edited; a text the person wrote is recorded as theirs; the server decides, not the client', async (t) => {
    if (skip(t)) return;
    const a = world({ snap: snapshot({ wpAttachmentId: 42 }) });
    withRec(a, source([{ src: SRC, alt: AI, basis: '', rejected: null }]));
    await applyText(a, `${AI} in clinic`);
    const ra = await WordPressFixRecord.findOne({ taskId: a.task._id });
    assert.equal(ra.changes[0].source, 'ai_recommendation_edited');
    assert.equal(ra.target.recommendationId, 'rec-1');

    const b = world({ snap: snapshot({ wpAttachmentId: 42 }) });
    withRec(b, source([]));
    await applyText(b, 'Dr Rao at the front desk');
    const rb = await WordPressFixRecord.findOne({ taskId: b.task._id });
    assert.equal(rb.changes[0].source, 'human_input');
    assert.equal(rb.target.recommendationId, null);
  });

  test('NO redundant AI generation: reading the recommendation never calls the generator (nothing in this flow can)', async (t) => {
    const fs = await import('node:fs');
    for (const file of ['altRecommendation.js', 'altFixService.js']) {
      const code = fs.readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
      const executable = code.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
      assert.ok(!/claudeService|generateRecommendation|recommendationService/.test(executable), `${file} must not import or call a generator`);
    }
    if (skip(t)) return;
    const w = world();
    const loads = withRec(w, source([{ src: SRC, alt: AI, basis: '', rejected: null }]));
    await preview(w, { imageSrc: SRC }); await preview(w, { imageSrc: SRC });
    assert.equal(loads(), 2, 'one cheap read per preview, no generation');
  });

  test('a stale approval is still refused: the AI text was previewed, then a person edited the alt in WordPress', async (t) => {
    if (skip(t)) return;
    const w = world({ snap: snapshot({ wpAttachmentId: 42 }) });
    withRec(w, source([{ src: SRC, alt: AI, basis: '', rejected: null }]));
    const input = { imageSrc: SRC, proposedAlt: AI };
    const fp = (await getAltFixPreview(w.task, input, w.deps)).plan.fingerprint;
    w.wp.lib.get(42).alt_text = 'Someone else wrote this';
    await assert.rejects(applyAltFix(w.task, { ...input, approved: true, expectedPlanFingerprint: fp, actorId: new mongoose.Types.ObjectId() }, w.deps), (e) => e.code === 'CONFLICT');
    assert.equal(w.wp.writes.length, 0);
    assert.equal(w.wp.lib.get(42).alt_text, 'Someone else wrote this');
  });

  test('a write that does not land is never reported as fixed (the recommendation changes nothing about verification)', async (t) => {
    if (skip(t)) return;
    const w = world({ snap: snapshot({ wpAttachmentId: 42 }) });
    withRec(w, source([{ src: SRC, alt: AI, basis: '', rejected: null }]));
    w.wp.failWrite = new WordPressConnectionError('WRITE_FAILED', 'rejected', 400);
    await assert.rejects(applyText(w, AI));
    assert.equal(w.wp.lib.get(42).alt_text, '');
    assert.notEqual(w.task.status, 'implemented');
  });

  test('legacy text-only recommendation: ambiguous numbering maps nothing; unambiguous numbering is a suggestion to CONFIRM', async (t) => {
    if (skip(t)) return;
    const text = 'Image 1 (Hero): alt="Clinic reception area" | Image 2 (Doctor): alt="Dr Rao examining a patient"';
    const imgs = (n) => Array.from({ length: n }, (_, i) => ({ src: i === 1 ? SRC : `${UPLOADS}/2024/10/x${i}.jpg`, alt: '' }));

    const ambiguous = world();
    ambiguous.deps.loadRecommendation = async () => source(null, { legacyText: text });
    ambiguous.deps.loadPageDoc = async () => ({ images: imgs(3) });
    const pa = await preview(ambiguous, { imageSrc: SRC });
    assert.equal(pa.recommendation.status, 'ambiguous_legacy');
    assert.equal(pa.recommendation.alt, null);

    const ok = world();
    ok.deps.loadRecommendation = async () => source(null, { legacyText: text });
    ok.deps.loadPageDoc = async () => ({ images: imgs(2) });
    const po = await preview(ok, { imageSrc: SRC });
    assert.equal(po.recommendation.status, 'suggested_by_position');
    assert.equal(po.recommendation.needsConfirmation, true);
    assert.equal(po.recommendation.alt, 'Dr Rao examining a patient');
    assert.equal(po.plan.status, 'needs_input', 'never auto-applied or auto-planned');
  });

  test('ambiguous IMAGE identity: no recommendation is attached and nothing is offered to approve', async (t) => {
    if (skip(t)) return;
    const w = world({ wp: makeWp({ items: [mediaItem(42, '2024/10/dr-rao.jpg'), mediaItem(77, '2024/10/dr-rao.jpg')] }) });
    const loads = withRec(w, source([{ src: SRC, alt: AI, basis: '', rejected: null }]));
    const p = await preview(w, { imageSrc: SRC });
    assert.equal(p.plan.status, 'ambiguous_target');
    assert.equal(p.recommendation, null, 'a text is not offered for an image that cannot be identified');
    assert.equal(p.approvalStatus, 'not_available');
    assert.equal(loads(), 0);
  });

  test('a tracker never reaches the recommendation: unsupported, no recommendation, no recommendation read', async (t) => {
    if (skip(t)) return;
    const FB = 'https://www.facebook.com/tr?id=1064713942451011&ev=PageView&noscript=1';
    const w = world({ snap: snapshot({ src: FB, imageUrl: FB }) });
    const loads = withRec(w, source([{ src: FB, alt: 'Facebook pixel', basis: '', rejected: null }]));
    const p = await preview(w, { imageSrc: FB });
    assert.equal(p.plan.code, 'TRACKING_ENDPOINT');
    assert.equal(p.recommendation, null);
    assert.equal(loads(), 0);
  });

  test('an unreadable recommendation never breaks the preview: it is reported as unavailable and the person can still write the text', async (t) => {
    if (skip(t)) return;
    const w = world();
    w.deps.loadRecommendation = async () => { throw new Error('db down'); };
    const p = await preview(w, { imageSrc: SRC });
    assert.equal(p.recommendation.status, 'unavailable');
    assert.equal(p.plan.status, 'needs_input');
    assert.equal((await listAltImages(w.task, w.deps)).length, 1);
  });

  test('no recommendation yet: the person is told how to get one, and may still write the text', async (t) => {
    if (skip(t)) return;
    const w = world();
    withRec(w, { found: false });
    const p = await preview(w, { imageSrc: SRC });
    assert.equal(p.recommendation.status, 'none');
    assert.match(p.recommendation.message, /Generate it above/);
  });
});

describe('reconciling the rendered page with WordPress — the real Sapphire shapes, end to end through preview and apply', () => {
  const LIB_ALT = 'Dr Rao, senior surgeon';
  const lib = (alt = LIB_ALT) => makeWp({ items: [mediaItem(42, '2024/10/dr-rao.jpg', { alt_text: alt })] });
  const live = (status, instances = []) => { const calls = []; const fn = async (a) => { calls.push(a); return { status, instances }; }; fn.calls = calls; return fn; };

  test('Example A shape: Divi module names the file, library alt is meaningful, page renders alt="": rendered_mismatch with a manual, builder-named explanation — nothing writable', async (t) => {
    if (skip(t)) return;
    const raw = '[et_pb_section fb_built="1"][et_pb_fullwidth_header header_image_url="https://clinic.example/wp-content/uploads/2024/10/dr-rao.jpg"][/et_pb_fullwidth_header][/et_pb_section]';
    const wp = lib();
    wp.raw = raw; // the double's methods read this object, so set it here (a spread copy would not be seen)
    const w = world({ snap: snapshot({ altState: 'empty', wpAttachmentId: 42 }), wp });
    const p = await preview(w, { imageSrc: SRC });
    assert.equal(p.plan.status, 'rendered_mismatch');
    assert.equal(p.diagnosis.state, 'library_alt_overridden');
    assert.equal(p.diagnosis.source, 'page_builder_module');
    assert.equal(p.diagnosis.builder, 'Divi');
    assert.match(p.diagnosis.manual, /Divi/);
    assert.equal(p.diagnosis.libraryAlt, LIB_ALT);
    assert.equal(p.diagnosis.supported, false);
    assert.equal(p.approvalStatus, 'not_available');
    assert.equal(p.proposed.alt, null, 'an empty After is never a proposal');
    assert.equal(w.wp.writes.length, 0);
  });

  test('Example B shape: page content does not contain it (a template renders it), other occurrences carry the library alt: theme_template, with the occurrence evidence', async (t) => {
    if (skip(t)) return;
    const w = world({ snap: snapshot({ altState: 'empty', wpAttachmentId: 42, inLink: true }), wp: lib() });
    world.pageDoc = { images: [
      { src: SRC, alt: '', in_link: true, wp_attachment_id: 42 }, { src: SRC, alt: '', in_link: true, wp_attachment_id: 42 }, { src: SRC, alt: LIB_ALT, in_link: false, wp_attachment_id: 42 },
    ] };
    const p = await preview(w, { imageSrc: SRC });
    assert.equal(p.diagnosis.source, 'theme_template');
    assert.equal(p.diagnosis.instances.crawl, 3);
    assert.match(p.diagnosis.evidence.join(' '), /appears 3 times on the page; 1 of them render alt text and 2 render none/);
    assert.match(p.diagnosis.evidence.join(' '), /no accessible name/);
    assert.equal(p.plan.status, 'rendered_mismatch');
  });

  test('STALE finding: a fresh read of the live page shows alt everywhere — nothing to apply, reported honestly, no write, counts untouched', async (t) => {
    if (skip(t)) return;
    const w = world({ snap: snapshot({ altState: 'empty', wpAttachmentId: 42 }), wp: lib() });
    w.deps.checkLiveAlt = live('checked', [{ alt: LIB_ALT }]);
    const p = await preview(w, { imageSrc: SRC });
    assert.equal(p.plan.status, 'stale_finding');
    assert.equal(p.diagnosis.state, 'stale_finding');
    assert.equal(p.diagnosis.instances.live.status, 'checked');
    assert.equal(w.deps.checkLiveAlt.calls.length, 1);
    assert.deepEqual([w.deps.checkLiveAlt.calls[0].pageUrl, w.deps.checkLiveAlt.calls[0].attachmentId], [PAGE, 42]);
    await assert.rejects(applyAltFix(w.task, { ...INPUT, approved: true, expectedPlanFingerprint: p.plan.fingerprint, actorId: new mongoose.Types.ObjectId() }, w.deps), (e) => e.code === 'FIELD_NOT_WRITABLE' && e.details.planStatus === 'stale_finding');
    assert.equal(w.wp.writes.length, 0);
    assert.equal(w.transitions.length, 0, 'no task transition: nothing was fixed');
  });

  test('the live page is read ONLY when the library already holds meaningful alt text (the case a mismatch could be stale) — never for a plain missing alt', async (t) => {
    if (skip(t)) return;
    const missing = world({ snap: snapshot({ wpAttachmentId: 42 }) });
    missing.deps.checkLiveAlt = live('checked', []);
    await preview(missing, { imageSrc: SRC });
    assert.equal(missing.deps.checkLiveAlt.calls.length, 0);
    const junk = world({ snap: snapshot({ wpAttachmentId: 42 }), wp: lib('image') });
    junk.deps.checkLiveAlt = live('checked', []);
    await preview(junk, { imageSrc: SRC });
    assert.equal(junk.deps.checkLiveAlt.calls.length, 0, 'a non-meaningful library alt does not count');
  });

  test('a live page that cannot be read keeps the mismatch (it never invents "stale"), and a throwing check never breaks the preview', async (t) => {
    if (skip(t)) return;
    const a = world({ snap: snapshot({ altState: 'empty', wpAttachmentId: 42 }), wp: lib() });
    a.deps.checkLiveAlt = live('unavailable');
    assert.equal((await preview(a, { imageSrc: SRC })).plan.status, 'rendered_mismatch');
    const b = world({ snap: snapshot({ altState: 'empty', wpAttachmentId: 42 }), wp: lib() });
    b.deps.checkLiveAlt = async () => { throw new Error('boom'); };
    const p = await preview(b, { imageSrc: SRC });
    assert.equal(p.plan.status, 'rendered_mismatch');
    assert.equal(p.diagnosis.instances.live.status, 'unavailable');
  });

  test('the supported workflow is untouched: a truly missing alt on a library-rendered image is ready, applies, reads back, and the live page is not even consulted', async (t) => {
    if (skip(t)) return;
    const w = world({ snap: snapshot({ altState: 'missing', wpAttachmentId: 42 }) });
    w.deps.checkLiveAlt = live('checked', []);
    const p = await preview(w);
    assert.equal(p.diagnosis.state, 'missing');
    assert.equal(p.diagnosis.supported, true);
    assert.equal(p.diagnosis.fixMechanism, 'media_library');
    assert.equal(p.plan.status, 'ready');
    const r = await apply(w);
    assert.equal(r.fix.verification.saved.status, 'verified');
    assert.equal(w.wp.writes.length, 1);
    assert.equal(w.deps.checkLiveAlt.calls.length, 0);
  });

  test('an existing meaningful library alt is NEVER overwritten by an AI suggestion: the recommendation is shown, the plan is a mismatch, apply refuses', async (t) => {
    if (skip(t)) return;
    const w = world({ snap: snapshot({ altState: 'empty', wpAttachmentId: 42 }), wp: lib() });
    w.deps.loadRecommendation = async () => ({ found: true, recommendationId: 'rec-1', generatedAt: new Date(), proposals: [{ src: SRC, alt: 'A new AI description of the surgeon', basis: 'file name', rejected: null }], legacyText: '' });
    const p = await preview(w, { imageSrc: SRC });
    assert.equal(p.recommendation.alt, 'A new AI description of the surgeon');
    assert.equal(p.plan.status, 'rendered_mismatch');
    const withText = await preview(w, { imageSrc: SRC, proposedAlt: 'A new AI description of the surgeon' });
    await assert.rejects(applyAltFix(w.task, { imageSrc: SRC, proposedAlt: 'A new AI description of the surgeon', approved: true, expectedPlanFingerprint: withText.plan.fingerprint, actorId: new mongoose.Types.ObjectId() }, w.deps), (e) => e.code === 'FIELD_NOT_WRITABLE');
    assert.equal(w.wp.lib.get(42).alt_text, LIB_ALT);
    assert.equal(w.wp.writes.length, 0);
  });

  test('a previewed plan from the old planner version can no longer be applied (the fingerprint binds the planner version and the diagnosis)', async (t) => {
    if (skip(t)) return;
    const w = world({ snap: snapshot({ wpAttachmentId: 42 }) });
    await assert.rejects(applyAltFix(w.task, { ...INPUT, approved: true, expectedPlanFingerprint: 'a'.repeat(64), actorId: new mongoose.Types.ObjectId() }, w.deps), (e) => e.code === 'CONFLICT' && e.details.reason === 'preview_stale');
    assert.equal(w.wp.writes.length, 0);
  });
});

describe('findings are never resolved or excluded by the WordPress fix service — only a successful re-analysis of the page can do that', () => {
  const LIB = 'Dr Rao, senior surgeon';
  const insertFinding = async (w) => {
    const col = mongoose.connection.db.collection('seo_page_issues');
    const doc = { projectId: w.projectId, page_url: PAGE, rule_id: 'images_missing_alt_text', issue_code: 'images_missing_alt_text', status: 'open', detected_value: SRC, dedup_key: `nm-${w.projectId}`, fix_count: 0, regression_count: 0, last_verified_at: new Date('2026-10-16T13:13:43Z'), before_snapshot: snapshot({ altState: 'empty', wpAttachmentId: 42, occurrences: { total: 2, withAlt: 1, withoutAlt: 1 } }) };
    await col.insertOne(doc);
    w.deps.loadFlaggedImages = async () => col.find({ projectId: w.projectId, page_url: PAGE, rule_id: 'images_missing_alt_text', status: 'open' }).toArray();
    return { col, before: doc };
  };
  const assertUntouched = async (col, before) => {
    const after = await col.findOne({ _id: before._id });
    assert.equal(after.status, 'open');
    assert.equal(after.fix_count, 0);
    assert.equal(after.resolved_at, undefined);
    assert.equal(after.excluded_reason, undefined);
    assert.deepEqual(after.last_verified_at, before.last_verified_at);
  };

  test('the media library already has meaningful alt text: the finding stays OPEN (the library alone proves nothing about the page)', async (t) => {
    if (skip(t)) return;
    const w = world({ snap: snapshot({ altState: 'empty', wpAttachmentId: 42 }), wp: makeWp({ items: [mediaItem(42, '2024/10/dr-rao.jpg', { alt_text: LIB })] }) });
    const { col, before } = await insertFinding(w);
    const p = await preview(w, { imageSrc: SRC });
    await listAltImages(w.task, w.deps);
    assert.equal(p.plan.status, 'rendered_mismatch');
    await assertUntouched(col, before);
  });

  test('even a live read that shows alt everywhere only REPORTS a stale finding: the status changes only on the next successful analysis', async (t) => {
    if (skip(t)) return;
    const w = world({ snap: snapshot({ altState: 'empty', wpAttachmentId: 42 }), wp: makeWp({ items: [mediaItem(42, '2024/10/dr-rao.jpg', { alt_text: LIB })] }) });
    w.deps.checkLiveAlt = async () => ({ status: 'checked', instances: [{ alt: LIB }] });
    const { col, before } = await insertFinding(w);
    const p = await preview(w, { imageSrc: SRC });
    assert.equal(p.plan.status, 'stale_finding');
    await assertUntouched(col, before);
  });

  test('the finding\'s own occurrence counts explain a mixed case even when the crawl record is unavailable', async (t) => {
    if (skip(t)) return;
    const w = world({ snap: snapshot({ altState: 'empty', wpAttachmentId: 42, inLink: true, occurrences: { total: 2, withAlt: 1, withoutAlt: 1 } }), wp: makeWp({ items: [mediaItem(42, '2024/10/dr-rao.jpg', { alt_text: LIB })] }) });
    const p = await preview(w, { imageSrc: SRC });
    assert.match(p.diagnosis.evidence.join(' '), /used 2 times on the page; 1 of those uses render no alt text and 1 do/);
  });
});
