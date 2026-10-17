import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import taskVerificationService from './TaskVerificationService.js';
import Task from '../model/Task.js';
import { buildFaqPageJsonLd } from './faqSchema.js';

// Live Mongo, auto-skip if unreachable — same pattern as
// TaskVerificationService.test.js.
//
// The rule that matters for faq_schema: the FaqSchemaRule stops firing as soon
// as ANY FAQPage schema exists, so "the issue disappeared" alone must NOT mark
// the task fixed. It is verified only when the crawled FAQPage carries exactly
// the pairs the fix generated AND those pairs are still what the page shows.

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
    const db = mongoose.connection.db;
    await Task.deleteMany({ projectId: { $in: createdProjectIds } });
    for (const name of ['seo_page_data', 'seo_page_issues']) {
      await db.collection(name).deleteMany({ projectId: { $in: createdProjectIds } });
    }
    await mongoose.connection.close();
  }
});

const PAIRS = [
  { question: 'What is SEO?', answer: 'SEO is the practice of improving search visibility.' },
  { question: 'How long does it take?', answer: 'Usually three to six months.' },
];

async function createFaqTask(projectId, pageUrl, pairs = PAIRS) {
  return Task.create({
    projectId, issueKey: 'faq_schema', pageUrl, status: 'implemented', origin: 'wordpress_auto',
    fixHistory: [{
      attemptNumber: 1, attemptKind: 'fix_attempt', origin: 'wordpress_auto', status: 'pending_verification',
      before: { capturedAt: new Date(), source: 'unavailable', dataPath: null, value: null },
      fixApplied: {
        capturedAt: new Date(), recommendationId: null, recommendationVersion: null, snapshot: null,
        expectedAfterValue: { type: 'faq_schema', pairs },
      },
      implementedAt: new Date(),
      verification: { verifiedAt: null, method: null, result: null, matched: null, after: { source: 'unavailable', value: null }, triggerJobId: null },
    }],
  });
}

describe('TaskVerificationService — faq_schema value_diff', () => {
  let projectId;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    projectId = new mongoose.Types.ObjectId();
    createdProjectIds.push(projectId);
    await Task.deleteMany({ projectId });
    await mongoose.connection.db.collection('seo_page_data').deleteMany({ projectId });
    await mongoose.connection.db.collection('seo_page_issues').deleteMany({ projectId });
  });

  test('verified_fixed when the crawled FAQPage matches the generated pairs and the page still shows them', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const pageUrl = 'https://example.com/faq-fixed';
    await mongoose.connection.db.collection('seo_page_data').insertOne({
      projectId, url: pageUrl,
      structured_data: [buildFaqPageJsonLd(PAIRS)],
      faq_howto_signals: { faq_pairs: PAIRS.map((p) => ({ ...p, source: 'heading' })) },
    });
    const task = await createFaqTask(projectId, pageUrl);

    const result = await taskVerificationService.verifyImplementedTasks(projectId, 'FAQ-FIXED');
    assert.equal(result.verified, 1);

    const saved = await Task.findById(task._id);
    assert.equal(saved.status, 'verified_fixed');
    const latest = saved.fixHistory[saved.fixHistory.length - 1];
    assert.equal(latest.verification.method, 'value_diff');
    assert.equal(latest.verification.matched, true);
  });

  test('a FAQPage found inside @graph (how SEO plugins emit it) is recognised', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const pageUrl = 'https://example.com/faq-graph';
    await mongoose.connection.db.collection('seo_page_data').insertOne({
      projectId, url: pageUrl,
      structured_data: [{ '@context': 'https://schema.org', '@graph': [{ '@type': 'WebPage' }, buildFaqPageJsonLd(PAIRS)] }],
      faq_howto_signals: { faq_pairs: PAIRS },
    });
    const task = await createFaqTask(projectId, pageUrl);

    await taskVerificationService.verifyImplementedTasks(projectId, 'FAQ-GRAPH');
    assert.equal((await Task.findById(task._id)).status, 'verified_fixed');
  });

  test('DUPLICATE: the right pairs rendered by TWO FAQPage entities (e.g. a theme/plugin plus the Bridge) -> reopened, never verified', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const pageUrl = 'https://example.com/faq-duplicate';
    await mongoose.connection.db.collection('seo_page_data').insertOne({
      projectId, url: pageUrl,
      structured_data: [buildFaqPageJsonLd(PAIRS), { '@context': 'https://schema.org', '@graph': [{ '@type': 'WebPage' }, buildFaqPageJsonLd(PAIRS)] }],
      faq_howto_signals: { faq_pairs: PAIRS },
    });
    const task = await createFaqTask(projectId, pageUrl);

    const result = await taskVerificationService.verifyImplementedTasks(projectId, 'FAQ-DUPLICATE');
    assert.equal(result.reopened, 1);
    const saved = await Task.findById(task._id);
    assert.equal(saved.status, 'reopened');
    const latest = saved.fixHistory[saved.fixHistory.length - 1];
    assert.equal(latest.verification.matched, false);
    assert.equal(latest.verification.after?.value?.faqEntityCount, 2, 'the diagnostic says why');
  });

  test('issue gone but the schema does NOT match the generated pairs (an answer differs) -> reopened, matched:false', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const pageUrl = 'https://example.com/faq-wrong-answer';
    await mongoose.connection.db.collection('seo_page_data').insertOne({
      projectId, url: pageUrl,
      structured_data: [buildFaqPageJsonLd([PAIRS[0], { ...PAIRS[1], answer: 'Something else entirely.' }])],
      faq_howto_signals: { faq_pairs: PAIRS },
    });
    const task = await createFaqTask(projectId, pageUrl);

    const result = await taskVerificationService.verifyImplementedTasks(projectId, 'FAQ-WRONG');
    assert.equal(result.reopened, 1);

    const saved = await Task.findById(task._id);
    assert.equal(saved.status, 'reopened');
    const latest = saved.fixHistory[saved.fixHistory.length - 1];
    assert.equal(latest.verification.method, 'value_diff');
    assert.equal(latest.verification.matched, false);
  });

  test('issue gone but the schema has a pair the page does not visibly show -> reopened (never verifies invented FAQ content)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const pageUrl = 'https://example.com/faq-invented';
    await mongoose.connection.db.collection('seo_page_data').insertOne({
      projectId, url: pageUrl,
      structured_data: [buildFaqPageJsonLd(PAIRS)],
      // The visible FAQ has since lost its second question.
      faq_howto_signals: { faq_pairs: [PAIRS[0]] },
    });
    const task = await createFaqTask(projectId, pageUrl);

    await taskVerificationService.verifyImplementedTasks(projectId, 'FAQ-INVENTED');
    assert.equal((await Task.findById(task._id)).status, 'reopened');
  });

  test('a crawl with no FAQPage at all: issue open -> reopened', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const pageUrl = 'https://example.com/faq-not-applied';
    await mongoose.connection.db.collection('seo_page_data').insertOne({
      projectId, url: pageUrl, structured_data: [], faq_howto_signals: { faq_pairs: PAIRS },
    });
    await mongoose.connection.db.collection('seo_page_issues').insertOne({
      projectId, issue_code: 'faq_schema', page_url: pageUrl, status: 'open',
      dedup_key: `test-dedup-faq-not-applied-${projectId}`,
    });
    const task = await createFaqTask(projectId, pageUrl);

    const result = await taskVerificationService.verifyImplementedTasks(projectId, 'FAQ-NOT-APPLIED');
    assert.equal(result.reopened, 1);
    assert.equal((await Task.findById(task._id)).status, 'reopened');
  });
});
