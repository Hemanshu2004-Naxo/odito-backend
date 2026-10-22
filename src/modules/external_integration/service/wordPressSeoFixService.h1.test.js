import { describe, test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import axios from 'axios';

import wordPressSeoFixService from './wordPressSeoFixService.js';
import wordPressService, { WordPressConnectionError } from './wordPressService.js';
import oditoSeoBridgeService from './oditoSeoBridgeService.js';
import taskHistoryService from '../../tasks/service/TaskHistoryService.js';
import Recommendation from '../../recommendations/model/Recommendation.js';
import { parseTags, attrValue, decodeAttrValue, decodeDynamicContent } from '../content/diviShortcodes.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const REAL = fs.readFileSync(path.join(here, '..', 'content', '__fixtures__', 'seo_reseller_divi_content.txt'), 'utf8');

/**
 * Apply-via-WordPress for h1_missing — the PAGE-CONTENT channel. WordPress is an in-memory fake of
 * core REST plus the public page rendered from the stored Divi content (see the content service
 * tests); the task lifecycle is captured, not persisted. The Bridge is made to throw if touched:
 * an H1 fix must not depend on any SEO plugin.
 */
const PAGE_URL = 'https://naxonify.com/seo-reseller';
const RECOMMENDED = '<h1>\n  SEO Reseller Services by Naxonify\n</h1>';
const VALUE = 'SEO Reseller Services by Naxonify';

let wp;
let requests;
let captured;
let recommendation;

const render = () => parseTags(wp.content)
  .filter((t) => t.name === 'et_pb_heading' && !t.closing)
  .map((t) => {
    const raw = attrValue(t, 'title') || '';
    const text = decodeDynamicContent(raw) ? wp.title : decodeAttrValue(raw);
    const level = attrValue(t, 'title_level') || 'h2';
    return `<${level}>${text}</${level}>`;
  }).join('');

function makeTask(overrides = {}) {
  const task = {
    _id: 'task-1', projectId: 'project-1', pageUrl: PAGE_URL, issueKey: 'h1_missing', status: 'task_created',
    recommendationId: 'rec-1', saved: 0,
    async save() { task.saved += 1; },
    ...overrides,
  };
  return task;
}

beforeEach(() => {
  mock.restoreAll();
  requests = [];
  captured = [];
  recommendation = { projectId: 'project-1', h1Text: RECOMMENDED };
  wp = { id: 4721, status: 'publish', title: 'SEO Reseller', content: REAL, revision: 0 };

  mock.method(Recommendation, 'findById', () => ({ select: () => ({ lean: async () => recommendation && { projectId: recommendation.projectId } }) }));
  mock.method(wordPressService, 'getHydratedConnectionOrThrow', async () => ({ site_url: 'https://naxonify.com' }));
  mock.method(oditoSeoBridgeService, 'getBridgeStatus', async () => { throw new Error('the H1 fix must not consult the SEO Bridge'); });
  mock.method(oditoSeoBridgeService, 'writeSeoField', async () => { throw new Error('the H1 fix must not write an SEO field'); });
  mock.method(wordPressService, 'resolvePostIdFromUrl', async () => ({ postId: wp.id, postType: 'pages' }));
  mock.method(wordPressService, 'wpRequest', async (_c, { method, path: p, data }) => {
    requests.push({ method, path: p, data });
    if (method === 'GET') {
      return { data: { id: wp.id, type: 'page', status: wp.status, link: PAGE_URL, slug: 'seo-reseller', title: { raw: wp.title }, content: { raw: wp.content }, meta: {}, modified_gmt: `t${wp.revision}` } };
    }
    if (p !== `/wp-json/wp/v2/pages/${wp.id}`) throw new Error(`unexpected write path ${p}`);
    wp.content = data.content;
    wp.revision += 1;
    return { data: { id: wp.id } };
  });
  mock.method(axios, 'get', async () => ({ status: 200, data: `<html><body>${wp.themeExtra || ''}${render()}</body></html>` }));

  mock.method(taskHistoryService, 'resolveExpectedValue', async () => ({
    snapshot: null,
    expectedAfterValue: recommendation?.h1Text == null ? null : taskHistoryService._deriveExpectedAfterValue({ sections: { contentRewrite: { optimized: recommendation.h1Text } } }, 'h1_missing'),
  }));
  mock.method(taskHistoryService, 'applyImplementedTransition', async (task, args) => {
    captured.push(args);
    task.status = 'implemented';
    return { attemptNumber: 1 };
  });
});

const writes = () => requests.filter((r) => r.method === 'POST');
const fingerprint = async () => (await wordPressSeoFixService.readH1Context({ projectId: 'project-1', pageUrl: PAGE_URL })).fingerprint;
const apply = (task, input = {}) => wordPressSeoFixService.applyFix(task, { approved: true, ...input });
const reject = async (promise, code, status) => assert.rejects(promise, (e) => {
  assert.ok(e instanceof WordPressConnectionError, `${e?.constructor?.name}: ${e?.message}`);
  assert.equal(e.code, code);
  if (status) assert.equal(e.statusCode, status);
  return true;
});

describe('h1_missing via WordPress — happy path', () => {
  test('applies the recommendation as plain text, records the write, task -> implemented (never verified_fixed)', async () => {
    const task = makeTask();
    const result = await apply(task, { expectedContentFingerprint: await fingerprint() });

    assert.equal(result.field, 'h1');
    assert.equal(result.provider, 'none');
    assert.equal(result.alreadyApplied, false);
    assert.equal(result.immediateVerification, 'success');
    assert.equal(result.desiredValue, VALUE);
    assert.equal(result.content.builder.name, 'divi');
    assert.deepEqual(result.content.rendered.h1Texts, [VALUE]);

    assert.equal(writes().length, 1);
    assert.equal(/<h1/i.test(wp.content), false, 'the AI markup never reaches the page');

    assert.equal(task.status, 'implemented');
    assert.equal(task.saved, 1);
    const { externalWrite, expectedAfterValueOverride, origin } = captured[0];
    assert.equal(origin, 'wordpress_auto');
    assert.equal(externalWrite.system, 'wordpress');
    assert.equal(externalWrite.provider, 'none');
    assert.equal(externalWrite.field, 'h1');
    assert.equal(externalWrite.scope, 'post');
    assert.equal(externalWrite.wordpressPostId, 4721);
    assert.equal(externalWrite.contentAdapter, 'divi');
    assert.match(externalWrite.contentFingerprintBefore, /^[a-f0-9]{64}$/);
    assert.match(externalWrite.contentFingerprintAfter, /^[a-f0-9]{64}$/);
    assert.notEqual(externalWrite.contentFingerprintBefore, externalWrite.contentFingerprintAfter);
    // What TaskVerificationService must later find on the recrawled page.
    assert.deepEqual(expectedAfterValueOverride, { type: 'h1', h1Text: VALUE, h1Count: 1 });
  });

  test('the client can only supply the fingerprint: extra content / post / value fields are ignored', async () => {
    const task = makeTask();
    await apply(task, {
      expectedContentFingerprint: await fingerprint(),
      content: '<h1>Attacker</h1>', postId: 1, value: 'Attacker', h1Text: 'Attacker', metaKey: 'x', post_content: 'y',
    });
    assert.equal(writes().length, 1);
    assert.equal(writes()[0].path, '/wp-json/wp/v2/pages/4721');
    assert.ok(!wp.content.includes('Attacker'));
    assert.ok(wp.content.includes(`title="${VALUE}"`));
  });
});

describe('h1 apply — refusals leave the task and the page untouched', () => {
  const untouched = (task) => {
    assert.equal(writes().length, 0);
    assert.equal(wp.content, REAL);
    assert.equal(captured.length, 0);
    assert.equal(task.status, 'task_created');
    assert.equal(task.saved, 0);
  };

  test('multiple_h1_tags is never auto-fixed, even though it shares the h1 snapshot type', async () => {
    const task = makeTask({ issueKey: 'multiple_h1_tags' });
    await reject(apply(task, { expectedContentFingerprint: 'a'.repeat(64) }), 'FIELD_NOT_WRITABLE', 422);
    untouched(task);
  });

  test('requires explicit approval', async () => {
    const task = makeTask();
    await reject(wordPressSeoFixService.applyFix(task, { approved: false, expectedContentFingerprint: await fingerprint() }), 'WRITE_FAILED', 400);
    untouched(task);
  });

  test('requires the reviewed page state', async () => {
    const task = makeTask();
    await reject(apply(task), 'EXPECTED_STATE_REQUIRED', 400);
    untouched(task);
  });

  test('stale page: edited in WordPress after review -> CONFLICT stale_current_value, nothing written', async () => {
    const task = makeTask();
    const reviewed = await fingerprint();
    wp.content += '<!-- edit -->';
    wp.revision += 1;
    const edited = wp.content;
    await assert.rejects(apply(task, { expectedContentFingerprint: reviewed }), (e) => {
      assert.equal(e.code, 'CONFLICT');
      assert.equal(e.details.reason, 'stale_current_value');
      return true;
    });
    assert.equal(wp.content, edited);
    assert.equal(writes().length, 0);
    assert.equal(captured.length, 0);
    assert.equal(task.status, 'task_created');
  });

  test('a recommendation that is not a valid plain-text H1 is refused (script)', async () => {
    recommendation.h1Text = '<h1><script>alert(1)</script>Title</h1>';
    const task = makeTask();
    await reject(apply(task, { expectedContentFingerprint: await fingerprint() }), 'INVALID_H1', 422);
    untouched(task);
  });

  test('a recommendation with no usable value is refused', async () => {
    recommendation.h1Text = null;
    const task = makeTask();
    await reject(apply(task, { expectedContentFingerprint: await fingerprint() }), 'WRITE_FAILED', 422);
    untouched(task);
  });

  test('no linked recommendation -> RECOMMENDATION_REQUIRED', async () => {
    const task = makeTask({ recommendationId: null });
    await reject(apply(task, { expectedContentFingerprint: 'a'.repeat(64) }), 'RECOMMENDATION_REQUIRED', 422);
    untouched(task);
  });

  test('a recommendation from another project is refused', async () => {
    recommendation.projectId = 'someone-elses-project';
    const task = makeTask();
    await reject(apply(task, { expectedContentFingerprint: 'a'.repeat(64) }), 'RECOMMENDATION_REQUIRED', 422);
    untouched(task);
  });

  test('a task whose status cannot move to implemented is refused', async () => {
    const task = makeTask({ status: 'verified_fixed' });
    await reject(apply(task, { expectedContentFingerprint: 'a'.repeat(64) }), 'CONFLICT', 409);
    assert.equal(writes().length, 0);
  });

  test('an unsupported builder (Gutenberg) is refused', async () => {
    wp.content = '<!-- wp:paragraph --><p>Hi</p><!-- /wp:paragraph -->';
    const task = makeTask();
    await reject(apply(task, { expectedContentFingerprint: await fingerprint() }), 'FIELD_NOT_WRITABLE', 422);
    assert.equal(writes().length, 0);
    assert.equal(captured.length, 0);
  });

  test('a page on another site than the connection is refused (cross-site)', async () => {
    const task = makeTask({ pageUrl: 'https://evil.example/seo-reseller' });
    await reject(apply(task, { expectedContentFingerprint: 'a'.repeat(64) }), 'FIELD_NOT_WRITABLE', 422);
    assert.equal(writes().length, 0);
  });
});

describe('h1 apply — recording the write', () => {
  test('a lost task-version race after a successful write is reported as a CONFLICT that says the write succeeded', async () => {
    const task = makeTask({ async save() { const e = new Error('v'); e.name = 'VersionError'; throw e; } });
    await assert.rejects(apply(task, { expectedContentFingerprint: await fingerprint() }), (e) => {
      assert.equal(e.code, 'CONFLICT');
      assert.equal(e.details.wordpressWriteSucceeded, true);
      return true;
    });
    assert.equal(writes().length, 1);
  });

  test('when the live page is left with the wrong content the task is not marked applied (rollback path)', async () => {
    // WordPress silently stores something else; the content service restores and throws.
    mock.method(wordPressService, 'wpRequest', async (_c, { method, data }) => {
      requests.push({ method, data });
      if (method === 'GET') return { data: { id: wp.id, type: 'page', status: 'publish', link: PAGE_URL, slug: 's', title: { raw: wp.title }, content: { raw: wp.content }, meta: {}, modified_gmt: `t${wp.revision}` } };
      wp.content = data.content === REAL ? REAL : `${data.content}!`;
      wp.revision += 1;
      return { data: {} };
    });
    const task = makeTask();
    await assert.rejects(apply(task, { expectedContentFingerprint: await fingerprint() }), (e) => e.code === 'WRITE_FAILED' && e.details.rolledBack === true);
    assert.equal(wp.content, REAL);
    assert.equal(captured.length, 0);
    assert.equal(task.status, 'task_created');
  });
});

describe('readH1Context — what the dialog is built from', () => {
  test('previews the recommendation as plain text without writing anything', async () => {
    const ctx = await wordPressSeoFixService.readH1Context({ projectId: 'project-1', pageUrl: PAGE_URL, recommended: RECOMMENDED });
    assert.equal(ctx.supported, true);
    assert.deepEqual(ctx.recommended, { ok: true, text: VALUE });
    assert.equal(ctx.builder.label, 'Divi');
    assert.equal(writes().length, 0);
  });

  test('flags a recommendation that cannot be applied so the UI does not offer it', async () => {
    const ctx = await wordPressSeoFixService.readH1Context({ projectId: 'project-1', pageUrl: PAGE_URL, recommended: '<h1 onclick="x">A</h1>' });
    assert.equal(ctx.recommended.ok, false);
    assert.equal(ctx.recommended.code, 'ATTRIBUTES');
  });

  test('no recommendation supplied -> no preview', async () => {
    const ctx = await wordPressSeoFixService.readH1Context({ projectId: 'project-1', pageUrl: PAGE_URL });
    assert.equal(ctx.recommended, null);
  });
});
