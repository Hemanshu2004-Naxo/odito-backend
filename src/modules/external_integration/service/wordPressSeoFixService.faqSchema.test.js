import { describe, test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import wordPressSeoFixService from './wordPressSeoFixService.js';
import wordPressService, { WordPressConnectionError } from './wordPressService.js';
import oditoSeoBridgeService from './oditoSeoBridgeService.js';
import Task from '../../tasks/model/Task.js';
import Recommendation from '../../recommendations/model/Recommendation.js';
import { serializeFaqPageJsonLd } from '../../tasks/service/faqSchema.js';

/**
 * Apply-via-WordPress for the faq_schema issue. Live Mongo (auto-skip if
 * unreachable), WordPress/Bridge HTTP fully mocked — same approach as
 * wordPressSeoFixService.integration.test.js.
 */

let mongoAvailable = false;

before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
  } catch {
    mongoAvailable = false;
  }
});

const createdProjectIds = [];

after(async () => {
  if (mongoAvailable) {
    // Leave no test data behind in the dev database.
    await Task.deleteMany({ projectId: { $in: createdProjectIds } });
    await Recommendation.deleteMany({ projectId: { $in: createdProjectIds } });
    await mongoose.connection.db.collection('seo_page_data').deleteMany({ projectId: { $in: createdProjectIds } });
    await mongoose.connection.close();
  }
});

const PAGE_URL = 'https://example.com/faq-page';
const PAIRS = [
  { question: 'What is SEO?', answer: 'SEO is the practice of improving search visibility.' },
  { question: 'How long does it take?', answer: 'Usually three to six months.' },
];

const fakeConnection = (projectId) => ({
  project_id: projectId, detected_seo_provider: 'none', site_url: 'https://example.com',
  username: 'admin', application_password: 'not-a-real-password', status: 'connected',
});

const bridgeStatus = (overrides = {}) => ({
  installed: true, provider: 'rank_math', providers: ['rank_math'], bridgeVersion: '1.2.0',
  siteSchemaSupported: true, faqSchemaSupported: true, ...overrides,
});

async function createFaqRecommendation(projectId, jsonLd) {
  return Recommendation.create({
    projectId,
    fingerprint: `fp-faq-${new mongoose.Types.ObjectId()}`,
    recommendationHash: `hash-${new mongoose.Types.ObjectId()}`,
    ruleId: 'faq_schema',
    category: 'on_page',
    sections: {
      whyThisMatters: 'test',
      recommendedFix: 'test',
      implementationExample: { type: 'html', content: 'test' },
      recommendedVersion: jsonLd,
    },
  });
}

async function setup(projectId, { crawledPairs = PAIRS, jsonLd = serializeFaqPageJsonLd(PAIRS) } = {}) {
  await mongoose.connection.db.collection('seo_page_data').insertOne({
    projectId, url: PAGE_URL, faq_howto_signals: { faq_pairs: crawledPairs },
  });
  const rec = await createFaqRecommendation(projectId, jsonLd);
  return Task.create({
    projectId, issueKey: 'faq_schema', pageUrl: PAGE_URL, status: 'task_created', recommendationId: rec._id,
  });
}

describe('wordPressSeoFixService — faq_schema', () => {
  let projectId;
  let stored;     // what the fake Bridge currently holds for post 42
  let writes;

  beforeEach(async () => {
    mock.restoreAll();
    if (!mongoAvailable) return;
    projectId = new mongoose.Types.ObjectId();
    createdProjectIds.push(projectId);
    await Task.deleteMany({ projectId });
    await Recommendation.deleteMany({ projectId });
    await mongoose.connection.db.collection('seo_page_data').deleteMany({ projectId });

    stored = null;
    writes = [];
    mock.method(wordPressService, 'getHydratedConnectionOrThrow', async () => fakeConnection(projectId));
    mock.method(wordPressService, 'resolvePostIdFromUrl', async () => ({ postId: 42, postType: 'pages' }));
    mock.method(oditoSeoBridgeService, 'getBridgeStatus', async () => bridgeStatus());
    mock.method(oditoSeoBridgeService, 'readFaqSchema', async () => ({ pairs: stored }));
    mock.method(oditoSeoBridgeService, 'writeFaqSchema', async (_c, postId, schema) => {
      writes.push({ postId, schema });
      stored = schema.mainEntity.map((e) => ({ question: e.name, answer: e.acceptedAnswer.text }));
      return { pairs: stored };
    });
  });

  test('happy path: sends a spec-shaped FAQPage built from the detected pairs, then reads back, and moves the task to implemented (never verified_fixed)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const task = await setup(projectId);

    const result = await wordPressSeoFixService.applyFix(task, { approved: true });

    assert.equal(writes.length, 1);
    assert.equal(writes[0].postId, 42);
    assert.deepEqual(writes[0].schema, {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: PAIRS.map((p) => ({ '@type': 'Question', name: p.question, acceptedAnswer: { '@type': 'Answer', text: p.answer } })),
    });
    assert.equal(result.field, 'faq_schema');
    assert.equal(result.alreadyApplied, false);
    assert.equal(result.immediateVerification, 'success');

    const saved = await Task.findById(task._id);
    assert.equal(saved.status, 'implemented');
    const attempt = saved.fixHistory[saved.fixHistory.length - 1];
    assert.equal(attempt.origin, 'wordpress_auto');
    assert.equal(attempt.fixApplied.externalWrite.field, 'faq_schema');
    assert.equal(attempt.fixApplied.externalWrite.provider, 'none');
    assert.equal(attempt.fixApplied.externalWrite.wordpressPostId, 42);
    assert.deepEqual(attempt.fixApplied.expectedAfterValue, { type: 'faq_schema', pairs: PAIRS });
  });

  test('works when several SEO plugins are active — FAQ schema does not depend on the SEO provider', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    mock.method(oditoSeoBridgeService, 'getBridgeStatus', async () => bridgeStatus({ provider: 'multiple', providers: ['rank_math', 'yoast'] }));
    const task = await setup(projectId);

    const result = await wordPressSeoFixService.applyFix(task, { approved: true });
    assert.equal(result.provider, 'none');
    assert.equal(writes.length, 1);
  });

  test('idempotent: identical schema already stored -> no write, still recorded as implemented', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    stored = PAIRS.map((p) => ({ ...p }));
    const task = await setup(projectId);

    const result = await wordPressSeoFixService.applyFix(task, { approved: true });
    assert.equal(result.alreadyApplied, true);
    assert.equal(writes.length, 0);
    assert.equal((await Task.findById(task._id)).status, 'implemented');
  });

  test('refuses schema for FAQs that are not visible on the page (stale recommendation) with FAQ_CONTENT_CHANGED, no write', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    // The page now only shows the first question.
    const task = await setup(projectId, { crawledPairs: [PAIRS[0]] });

    await assert.rejects(
      () => wordPressSeoFixService.applyFix(task, { approved: true }),
      (e) => e instanceof WordPressConnectionError && e.code === 'FAQ_CONTENT_CHANGED' && e.statusCode === 409 && e.details.regenerateRequired === true
    );
    assert.equal(writes.length, 0);
    assert.equal((await Task.findById(task._id)).status, 'task_created');
  });

  test('refuses when the page has no extracted FAQ pairs at all (e.g. crawl predates extraction)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const task = await setup(projectId, { crawledPairs: [] });

    await assert.rejects(() => wordPressSeoFixService.applyFix(task, { approved: true }), (e) => e.code === 'FAQ_CONTENT_CHANGED');
    assert.equal(writes.length, 0);
  });

  test('a recommendation whose JSON-LD is not a well-formed FAQPage yields no usable value — refused, nothing written', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const task = await setup(projectId, { jsonLd: 'Add FAQPage schema markup to your FAQ content.' });

    await assert.rejects(() => wordPressSeoFixService.applyFix(task, { approved: true }), (e) => e.code === 'WRITE_FAILED');
    assert.equal(writes.length, 0);
  });

  test('a Bridge without FAQ support is refused with a specific update-required message before any write', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    mock.method(oditoSeoBridgeService, 'getBridgeStatus', async () => bridgeStatus({ faqSchemaSupported: false }));
    const task = await setup(projectId);

    await assert.rejects(
      () => wordPressSeoFixService.applyFix(task, { approved: true }),
      (e) => e.code === 'FIELD_NOT_WRITABLE' && /newer version of the Odito SEO Bridge/.test(e.message)
    );
    assert.equal(writes.length, 0);
  });

  test('no Bridge installed at all: refused (there is no legacy-adapter way to publish FAQ schema)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    mock.method(oditoSeoBridgeService, 'getBridgeStatus', async () => ({ installed: false, provider: 'none', providers: [], bridgeVersion: null, siteSchemaSupported: false, faqSchemaSupported: false }));
    const task = await setup(projectId);

    await assert.rejects(() => wordPressSeoFixService.applyFix(task, { approved: true }), (e) => e.code === 'FIELD_NOT_WRITABLE');
  });

  test('a write that the Bridge stored differently than sent is reported as immediateVerification "failed", never as success', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    mock.method(oditoSeoBridgeService, 'writeFaqSchema', async () => ({ pairs: null }));
    const task = await setup(projectId);

    const result = await wordPressSeoFixService.applyFix(task, { approved: true });
    assert.equal(result.immediateVerification, 'failed');
    assert.equal((await Task.findById(task._id)).status, 'implemented');
  });
});
