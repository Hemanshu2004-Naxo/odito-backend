import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import taskVerificationService from './TaskVerificationService.js';
import Task from '../model/Task.js';

// Live Mongo, auto-skip if unreachable. The aggregate_rating_schema rule only
// checks that SOME aggregateRating key exists, so a task is verified only when
// the re-crawled page carries a VALID AggregateRating on the targeted entity
// with exactly the generated figures.

let mongoAvailable = false;
before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
  } catch { mongoAvailable = false; }
});

const createdProjectIds = [];
after(async () => {
  if (mongoAvailable) {
    const db = mongoose.connection.db;
    await Task.deleteMany({ projectId: { $in: createdProjectIds } });
    for (const name of ['seo_page_data', 'seo_page_issues']) await db.collection(name).deleteMany({ projectId: { $in: createdProjectIds } });
    await mongoose.connection.close();
  }
});

const TARGET = { type: 'Service', id: 'https://example.com/svc/#service', name: 'SEO Service' };
const RATING = { ratingValue: 4.8, bestRating: 5, reviewCount: 127 };
const node = (ar, id = TARGET.id) => ({ '@type': 'Service', '@id': id, name: TARGET.name, aggregateRating: ar });
const AR = { '@type': 'AggregateRating', ratingValue: '4.8', reviewCount: '127', bestRating: '5' };

function createTask(projectId, pageUrl) {
  return Task.create({
    projectId, issueKey: 'aggregate_rating_schema', pageUrl, status: 'implemented', origin: 'wordpress_auto',
    fixHistory: [{
      attemptNumber: 1, attemptKind: 'fix_attempt', origin: 'wordpress_auto', status: 'pending_verification',
      before: { capturedAt: new Date(), source: 'unavailable', dataPath: null, value: null },
      fixApplied: { capturedAt: new Date(), recommendationId: null, recommendationVersion: null, snapshot: null, expectedAfterValue: { type: 'aggregate_rating', target: TARGET, rating: RATING } },
      implementedAt: new Date(),
      verification: { verifiedAt: null, method: null, result: null, matched: null, after: { source: 'unavailable', value: null }, triggerJobId: null },
    }],
  });
}

describe('TaskVerificationService — aggregate_rating value_diff', () => {
  let projectId;
  beforeEach(async () => {
    if (!mongoAvailable) return;
    projectId = new mongoose.Types.ObjectId();
    createdProjectIds.push(projectId);
  });

  async function run(t, structured, name) {
    const pageUrl = `https://example.com/rating-${name}`;
    await mongoose.connection.db.collection('seo_page_data').insertOne({ projectId, url: pageUrl, structured_data: structured });
    const task = await createTask(projectId, pageUrl);
    const result = await taskVerificationService.verifyImplementedTasks(projectId, `RATING-${name}`);
    return { result, saved: await Task.findById(task._id) };
  }

  test('verified_fixed: a valid AggregateRating with the generated figures on the targeted entity', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { result, saved } = await run(t, [node(AR)], 'ok');
    assert.equal(result.verified, 1);
    assert.equal(saved.status, 'verified_fixed');
    const latest = saved.fixHistory.at(-1);
    assert.equal(latest.verification.method, 'value_diff');
    assert.equal(latest.verification.matched, true);
  });

  test('found inside @graph merged into the SEO plugin\'s own entity (same @id) is recognised', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    // Crawler flattens @graph, but the helper is graph-aware regardless.
    const { saved } = await run(t, [{ '@graph': [{ '@type': 'WebPage' }, node(AR)] }], 'graph');
    assert.equal(saved.status, 'verified_fixed');
  });

  test('rule would pass (aggregateRating key present) but the rating is INVALID (no count) -> reopened', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { result, saved } = await run(t, [node({ '@type': 'AggregateRating', ratingValue: '4.8' })], 'invalid');
    assert.equal(result.reopened, 1);
    assert.equal(saved.status, 'reopened');
    assert.equal(saved.fixHistory.at(-1).verification.matched, false);
  });

  test('a different value than generated -> reopened', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { saved } = await run(t, [node({ ...AR, ratingValue: '4.1' })], 'value');
    assert.equal(saved.status, 'reopened');
  });

  test('a rating on a DIFFERENT entity than the one targeted -> reopened', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { saved } = await run(t, [node(AR, 'https://example.com/other/#service')], 'entity');
    assert.equal(saved.status, 'reopened');
  });

  test('no AggregateRating at all in the crawl -> reopened when the issue is still open', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const pageUrl = 'https://example.com/rating-none';
    await mongoose.connection.db.collection('seo_page_data').insertOne({ projectId, url: pageUrl, structured_data: [{ '@type': 'Service', '@id': TARGET.id, name: TARGET.name }] });
    await mongoose.connection.db.collection('seo_page_issues').insertOne({ projectId, issue_code: 'aggregate_rating_schema', page_url: pageUrl, status: 'open', dedup_key: `dedup-rating-none-${projectId}` });
    const task = await createTask(projectId, pageUrl);
    await taskVerificationService.verifyImplementedTasks(projectId, 'RATING-NONE');
    assert.equal((await Task.findById(task._id)).status, 'reopened');
  });
});
