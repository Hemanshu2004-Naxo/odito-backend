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
import { serializeAggregateRatingJsonLd } from '../../tasks/service/aggregateRatingSchema.js';

/**
 * Apply-via-WordPress for the aggregate_rating_schema issue. Live Mongo
 * (auto-skip if unreachable), Bridge/WordPress HTTP fully mocked.
 */

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
    await Task.deleteMany({ projectId: { $in: createdProjectIds } });
    await Recommendation.deleteMany({ projectId: { $in: createdProjectIds } });
    await mongoose.connection.db.collection('seo_page_data').deleteMany({ projectId: { $in: createdProjectIds } });
    await mongoose.connection.close();
  }
});

const PAGE_URL = 'https://example.com/seo-service';
const TARGET = { type: 'Service', id: 'https://example.com/seo-service/#service', name: 'SEO Service' };
const RATING = { ratingValue: 4.8, bestRating: 5, reviewCount: 127 };
const CANDIDATE = { ...RATING, worstRating: null, source: 'text', evidence: 'Rated 4.8/5 based on 127 reviews' };
const JSON_LD = serializeAggregateRatingJsonLd({ target: TARGET, rating: RATING });

const bridgeStatus = (over = {}) => ({
  installed: true, provider: 'rank_math', providers: ['rank_math'], bridgeVersion: '1.3.0',
  siteSchemaSupported: true, faqSchemaSupported: true, ratingSchemaSupported: true, ...over,
});

async function setup(projectId, { candidates = [CANDIDATE], structured = [{ '@type': 'Service', '@id': TARGET.id, name: TARGET.name }], jsonLd = JSON_LD } = {}) {
  await mongoose.connection.db.collection('seo_page_data').insertOne({
    projectId, url: PAGE_URL, structured_data: structured, rating_signals: { rating_extracted: true, rating_candidates: candidates },
  });
  const rec = await Recommendation.create({
    projectId, fingerprint: `fp-rating-${new mongoose.Types.ObjectId()}`, recommendationHash: `h-${new mongoose.Types.ObjectId()}`,
    ruleId: 'aggregate_rating_schema', category: 'on_page',
    sections: { whyThisMatters: 't', recommendedFix: 't', implementationExample: { type: 'html', content: 't' }, recommendedVersion: jsonLd },
  });
  return Task.create({ projectId, issueKey: 'aggregate_rating_schema', pageUrl: PAGE_URL, status: 'task_created', recommendationId: rec._id });
}

describe('wordPressSeoFixService — aggregate_rating', () => {
  let projectId; let stored; let writes;

  beforeEach(async () => {
    mock.restoreAll();
    if (!mongoAvailable) return;
    projectId = new mongoose.Types.ObjectId();
    createdProjectIds.push(projectId);
    stored = null; writes = [];
    mock.method(wordPressService, 'getHydratedConnectionOrThrow', async () => ({ project_id: projectId, detected_seo_provider: 'none', site_url: 'https://example.com', username: 'a', application_password: 'x', status: 'connected' }));
    mock.method(wordPressService, 'resolvePostIdFromUrl', async () => ({ postId: 42, postType: 'pages' }));
    mock.method(oditoSeoBridgeService, 'getBridgeStatus', async () => bridgeStatus());
    mock.method(oditoSeoBridgeService, 'readRatingSchema', async () => ({ value: stored }));
    mock.method(oditoSeoBridgeService, 'writeRatingSchema', async (_c, postId, node) => {
      writes.push({ postId, node });
      stored = { target: { type: node['@type'], id: node['@id'], name: node.name }, rating: { ratingValue: Number(node.aggregateRating.ratingValue), bestRating: Number(node.aggregateRating.bestRating), reviewCount: Number(node.aggregateRating.reviewCount) } };
      return { value: stored };
    });
  });

  test('happy path: sends a spec-shaped node (existing @id/name/type + verified figures), reads back, task -> implemented (never verified_fixed)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const task = await setup(projectId);

    const result = await wordPressSeoFixService.applyFix(task, { approved: true });

    assert.equal(writes.length, 1);
    assert.equal(writes[0].postId, 42);
    assert.deepEqual(writes[0].node, {
      '@context': 'https://schema.org',
      '@type': 'Service',
      '@id': TARGET.id,
      name: 'SEO Service',
      aggregateRating: { '@type': 'AggregateRating', ratingValue: '4.8', reviewCount: '127', bestRating: '5' },
    });
    assert.equal(result.field, 'aggregate_rating');
    assert.equal(result.immediateVerification, 'success');

    const saved = await Task.findById(task._id);
    assert.equal(saved.status, 'implemented');
    const attempt = saved.fixHistory[saved.fixHistory.length - 1];
    assert.equal(attempt.fixApplied.externalWrite.field, 'aggregate_rating');
    assert.equal(attempt.fixApplied.externalWrite.provider, 'none');
    assert.equal(attempt.fixApplied.expectedAfterValue.type, 'aggregate_rating');
    assert.equal(attempt.fixApplied.expectedAfterValue.target.id, TARGET.id);
    assert.deepEqual(attempt.fixApplied.expectedAfterValue.rating, RATING);
  });

  test('independent of the SEO provider (several SEO plugins active is fine)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    mock.method(oditoSeoBridgeService, 'getBridgeStatus', async () => bridgeStatus({ provider: 'multiple', providers: ['rank_math', 'yoast'] }));
    const result = await wordPressSeoFixService.applyFix(await setup(projectId), { approved: true });
    assert.equal(result.provider, 'none');
    assert.equal(writes.length, 1);
  });

  test('idempotent: identical rating already stored -> no write, still implemented', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    stored = { target: TARGET, rating: RATING };
    const task = await setup(projectId);
    const result = await wordPressSeoFixService.applyFix(task, { approved: true });
    assert.equal(result.alreadyApplied, true);
    assert.equal(writes.length, 0);
  });

  test('refuses when the displayed rating changed since generation (RATING_CONTENT_CHANGED, regenerateRequired), no write', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const task = await setup(projectId, { candidates: [{ ...CANDIDATE, reviewCount: 200 }] });
    await assert.rejects(
      () => wordPressSeoFixService.applyFix(task, { approved: true }),
      (e) => e instanceof WordPressConnectionError && e.code === 'RATING_CONTENT_CHANGED' && e.statusCode === 409 && e.details.regenerateRequired === true
    );
    assert.equal(writes.length, 0);
    assert.equal((await Task.findById(task._id)).status, 'task_created');
  });

  test('refuses when the page no longer shows any rating (e.g. crawl predates extraction)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const task = await setup(projectId, { candidates: [] });
    await assert.rejects(() => wordPressSeoFixService.applyFix(task, { approved: true }), (e) => e.code === 'RATING_CONTENT_CHANGED');
    assert.equal(writes.length, 0);
  });

  test('refuses when the target entity is no longer in the page schema — never attaches a rating to a vanished entity', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const task = await setup(projectId, { structured: [{ '@type': 'WebPage', '@id': 'https://example.com/#w' }] });
    await assert.rejects(() => wordPressSeoFixService.applyFix(task, { approved: true }), (e) => e.code === 'RATING_CONTENT_CHANGED');
    assert.equal(writes.length, 0);
  });

  test('a recommendation that is not a well-formed rating node yields no usable value — nothing written', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const task = await setup(projectId, { jsonLd: 'Add AggregateRating schema with ratingValue and reviewCount.' });
    await assert.rejects(() => wordPressSeoFixService.applyFix(task, { approved: true }), (e) => e.code === 'WRITE_FAILED');
    assert.equal(writes.length, 0);
  });

  test('a Bridge older than rating support is refused with an update-required message; no Bridge at all is refused too', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    mock.method(oditoSeoBridgeService, 'getBridgeStatus', async () => bridgeStatus({ ratingSchemaSupported: false }));
    await assert.rejects(async () => wordPressSeoFixService.applyFix(await setup(projectId), { approved: true }), (e) => e.code === 'FIELD_NOT_WRITABLE' && /AggregateRating schema requires a newer version/.test(e.message));
    mock.method(oditoSeoBridgeService, 'getBridgeStatus', async () => ({ installed: false, provider: 'none', providers: [], bridgeVersion: null, siteSchemaSupported: false, faqSchemaSupported: false, ratingSchemaSupported: false }));
    const second = new mongoose.Types.ObjectId(); createdProjectIds.push(second);
    projectId = second;
    await assert.rejects(async () => wordPressSeoFixService.applyFix(await setup(second), { approved: true }), (e) => e.code === 'FIELD_NOT_WRITABLE' && /requires the Odito SEO Bridge plugin/.test(e.message));
    assert.equal(writes.length, 0);
  });

  test('a write the Bridge stored differently is immediateVerification "failed", never success', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    mock.method(oditoSeoBridgeService, 'writeRatingSchema', async () => ({ value: null }));
    const result = await wordPressSeoFixService.applyFix(await setup(projectId), { approved: true });
    assert.equal(result.immediateVerification, 'failed');
  });
});
