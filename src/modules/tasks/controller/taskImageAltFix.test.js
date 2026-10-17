import { describe, test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import { applyImageAltFix, listImageAltImages, previewImageAltFix, reverifyImageAltFix, rollbackImageAltFix } from './taskImageAltFix.js';
import { applyWordPressFix } from './taskController.js';
import altFixService from '../../external_integration/mediaFix/altFixService.js';
import wordPressSeoFixService from '../../external_integration/service/wordPressSeoFixService.js';
import { WordPressConnectionError } from '../../external_integration/service/wordPressService.js';
import Task from '../model/Task.js';
import { AuthUtil } from '../../../utils/AuthUtil.js';

/**
 * HTTP rules for the image alt fix: project ownership first, shape validation, and — the important one — the client can name an
 * image, text, approval and a fingerprint, and nothing else (no attachment id, field, path or site).
 */

const taskId = new mongoose.Types.ObjectId().toString();
const res = () => { const r = { statusCode: null, body: null, status(c) { r.statusCode = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
const req = (body = {}) => ({ params: { taskId }, body, user: { _id: 'u1' } });
const SRC = 'https://clinic.example/wp-content/uploads/2024/10/dr-rao.jpg';
const FP = 'a'.repeat(64);

let seen; let taskDoc;
beforeEach(() => {
  mock.restoreAll();
  seen = { list: 0, preview: [], apply: [], reverify: [], rollback: [], legacy: 0 };
  taskDoc = { _id: taskId, projectId: 'p1', issueKey: 'images_missing_alt_text', pageUrl: 'https://clinic.example/doctors', status: 'task_created' };
  mock.method(AuthUtil, 'validateProjectAccess', async () => true);
  mock.method(Task, 'findById', async () => taskDoc);
  mock.method(altFixService, 'listAltImagesWithSummary', async () => { seen.list += 1; return { images: [{ src: SRC }], summary: { overall: 'not_started' } }; });
  mock.method(altFixService, 'getAltFixPreview', async (_t, input) => { seen.preview.push(input); return { fixType: 'image_alt' }; });
  mock.method(altFixService, 'applyAltFix', async (_t, input) => { seen.apply.push(input); return { task: taskDoc, fix: { status: 'applied' }, alreadyApplied: false, immediateVerification: 'success' }; });
  mock.method(altFixService, 'reverifyAltFix', async (_t, input) => { seen.reverify.push(input); return { fix: {} }; });
  mock.method(altFixService, 'rollbackAltFix', async (_t, input) => { seen.rollback.push(input); return { fix: {}, message: 'ok' }; });
  mock.method(wordPressSeoFixService, 'applyFix', async () => { seen.legacy += 1; return {}; });
});

const handlers = { preview: previewImageAltFix, apply: applyImageAltFix, reverify: reverifyImageAltFix, rollback: rollbackImageAltFix };

describe('ownership comes first', () => {
  test('a user without access to the task\'s project is refused (403) on every route — no service is called', async () => {
    AuthUtil.validateProjectAccess.mock.mockImplementation(async () => { const e = new Error('no'); e.type = 'ACCESS_DENIED'; throw e; });
    for (const fn of [listImageAltImages, previewImageAltFix, applyImageAltFix, reverifyImageAltFix, rollbackImageAltFix]) {
      const r = res(); await fn(req({ imageSrc: SRC, proposedAlt: 'x y', approved: true, expectedPlanFingerprint: FP }), r);
      assert.equal(r.statusCode, 403, fn.name);
    }
    assert.equal(seen.list + seen.preview.length + seen.apply.length + seen.reverify.length + seen.rollback.length, 0);
  });
  test('unknown task 404, bad id 400, soft-deleted 404, another issue type 422', async () => {
    Task.findById.mock.mockImplementation(async () => null);
    const a = res(); await previewImageAltFix(req({ imageSrc: SRC }), a); assert.equal(a.statusCode, 404);
    const b = res(); await previewImageAltFix({ params: { taskId: 'zzz' }, body: {}, user: { _id: 'u1' } }, b); assert.equal(b.statusCode, 400);
    Task.findById.mock.mockImplementation(async () => ({ ...taskDoc, isDeleted: true }));
    const c = res(); await previewImageAltFix(req({ imageSrc: SRC }), c); assert.equal(c.statusCode, 404);
    Task.findById.mock.mockImplementation(async () => ({ ...taskDoc, issueKey: 'title_missing' }));
    const d = res(); await previewImageAltFix(req({ imageSrc: SRC }), d); assert.equal(d.statusCode, 422);
    assert.equal(seen.preview.length, 0);
  });
});

describe('shape validation', () => {
  test('imageSrc, proposedAlt, informative, approved and the fingerprint are validated before the service runs', async () => {
    const cases = [
      [previewImageAltFix, {}], [previewImageAltFix, { imageSrc: 5 }], [previewImageAltFix, { imageSrc: 'x'.repeat(2049) }],
      [previewImageAltFix, { imageSrc: SRC, proposedAlt: 7 }], [previewImageAltFix, { imageSrc: SRC, proposedAlt: 'a'.repeat(1001) }], [previewImageAltFix, { imageSrc: SRC, informative: 'yes' }],
      [applyImageAltFix, { imageSrc: SRC, approved: true }], [applyImageAltFix, { imageSrc: SRC, proposedAlt: 'a b', approved: 'yes' }],
      [applyImageAltFix, { imageSrc: SRC, proposedAlt: 'a b', approved: true, expectedPlanFingerprint: 'short' }],
    ];
    for (const [fn, body] of cases) { const r = res(); await fn(req(body), r); assert.equal(r.statusCode, 400, JSON.stringify(body).slice(0, 60)); assert.equal(r.body.code, 'INVALID_INPUT'); }
    assert.equal(seen.preview.length + seen.apply.length, 0);
  });
});

describe('what the client can and cannot send', () => {
  test('preview forwards ONLY image, text and the informative flag — never an attachment id, field name, path or site', async () => {
    const r = res();
    await previewImageAltFix(req({ imageSrc: SRC, proposedAlt: 'A surgeon', informative: true, attachmentId: 99, field: 'caption', path: '/wp-json/wp/v2/users', siteUrl: 'https://evil.example', provider: 'yoast' }), r);
    assert.equal(r.statusCode, 200);
    assert.deepEqual(Object.keys(seen.preview[0]).sort(), ['approved', 'expectedPlanFingerprint', 'imageSrc', 'informative', 'proposedAlt']);
    assert.equal(seen.preview[0].imageSrc, SRC);
    assert.equal(JSON.stringify(seen.preview[0]).includes('99'), false);
    assert.equal(JSON.stringify(seen.preview[0]).includes('evil'), false);
  });
  test('apply forwards the approval, the fingerprint and the actor', async () => {
    const r = res();
    await applyImageAltFix(req({ imageSrc: SRC, proposedAlt: 'A surgeon at work', approved: true, expectedPlanFingerprint: FP, attachmentId: 99 }), r);
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.data.field, 'alt_text');
    assert.equal(r.body.data.fix.status, 'applied');
    assert.deepEqual(seen.apply[0], { imageSrc: SRC, proposedAlt: 'A surgeon at work', informative: false, approved: true, expectedPlanFingerprint: FP, actorId: 'u1' });
  });
  test('a client can NEVER name the page, the Divi module, its attribute, the content or the write target: they are all derived server-side', async () => {
    const forged = { postId: 6, postType: 'pages', module: 'et_pb_fullwidth_header', altAttr: 'image_alt_text', moduleIdentity: { ordinal: 0 }, content: '[et_pb_section]', target: { kind: 'divi_page_module', postId: 7 }, sourceKind: 'divi_page_module', pageFingerprint: 'x' };
    await previewImageAltFix(req({ imageSrc: SRC, proposedAlt: 'A surgeon', ...forged }), res());
    await applyImageAltFix(req({ imageSrc: SRC, proposedAlt: 'A surgeon', approved: true, expectedPlanFingerprint: FP, ...forged }), res());
    for (const sent of [seen.preview[0], seen.apply[0]]) {
      const text = JSON.stringify(sent);
      for (const leaked of ['et_pb', 'image_alt_text', 'moduleIdentity', 'divi_page_module', 'postType', '[et_pb_section]']) assert.equal(text.includes(leaked), false, leaked);
    }
    assert.deepEqual(Object.keys(seen.apply[0]).sort(), ['actorId', 'approved', 'expectedPlanFingerprint', 'imageSrc', 'informative', 'proposedAlt']);
  });
  test('the apply response names the field that really changed: a Divi module write is not reported as a media-library alt_text change', async () => {
    altFixService.applyAltFix.mock.restore();
    mock.method(altFixService, 'applyAltFix', async () => ({ task: taskDoc, fix: { status: 'verified', target: { sourceKind: 'divi_page_module' } }, alreadyApplied: false, immediateVerification: 'success' }));
    const r = res();
    await applyImageAltFix(req({ imageSrc: SRC, proposedAlt: 'A surgeon at work', approved: true, expectedPlanFingerprint: FP }), r);
    assert.equal(r.body.data.field, 'divi_module_alt');
  });
  test('reverify and rollback forward only the image (and the actor for rollback)', async () => {
    await reverifyImageAltFix(req({ imageSrc: SRC, attachmentId: 5 }), res());
    await rollbackImageAltFix(req({ imageSrc: SRC, attachmentId: 5 }), res());
    assert.deepEqual(seen.reverify, [{ imageSrc: SRC }]);
    assert.deepEqual(seen.rollback, [{ imageSrc: SRC, actorId: 'u1' }]);
  });
});

describe('errors', () => {
  test('typed errors are relayed with code, status and details; unexpected errors never leak their message', async () => {
    altFixService.applyAltFix.mock.mockImplementation(async () => { const e = new WordPressConnectionError('CONFLICT', 'stale', 409); e.details = { reason: 'preview_stale' }; throw e; });
    const a = res(); await applyImageAltFix(req({ imageSrc: SRC, proposedAlt: 'A b', approved: true, expectedPlanFingerprint: FP }), a);
    assert.equal(a.statusCode, 409); assert.equal(a.body.details.reason, 'preview_stale');
    altFixService.applyAltFix.mock.mockImplementation(async () => { throw new Error('secret-token in message'); });
    const b = res(); await applyImageAltFix(req({ imageSrc: SRC, proposedAlt: 'A b', approved: true, expectedPlanFingerprint: FP }), b);
    assert.equal(b.statusCode, 500);
    assert.doesNotMatch(JSON.stringify(b.body), /secret-token/);
  });
});

describe('the generic single-value apply path still refuses ALT', () => {
  test('POST /apply-wordpress for an ALT task is NOT routed to the alt fix (it keeps its existing FIELD_NOT_WRITABLE behavior)', async () => {
    wordPressSeoFixService.applyFix.mock.mockImplementation(async () => { seen.legacy += 1; throw new WordPressConnectionError('FIELD_NOT_WRITABLE', 'This issue type cannot be applied via WordPress yet.', 422); });
    const r = res();
    await applyWordPressFix({ params: { taskId }, body: { approved: true }, user: { _id: 'u1' } }, r);
    assert.equal(r.statusCode, 422);
    assert.equal(seen.legacy, 1);
    assert.equal(seen.apply.length, 0);
  });
});
