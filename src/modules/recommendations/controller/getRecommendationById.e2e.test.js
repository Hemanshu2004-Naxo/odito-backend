import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import Recommendation from '../model/Recommendation.js';
import { getRecommendationById } from './recommendationController.js';

/**
 * getRecommendationById() — added alongside linkTaskRecommendation() so the
 * WordPress apply-fix confirmation dialog can show the EXACT recommendation
 * content a Task is linked to (fetched by Task.recommendationId), instead
 * of trusting whatever the recommendation-generation mutation's own local,
 * ephemeral UI state happens to hold. Ownership is checked at the route
 * level (validateProjectAccess()) — these tests exercise the controller's
 * OWN cross-project defense directly, the same "belongs to this project"
 * double-check wordPressSeoFixService.validateFix() applies server-side.
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

after(async () => {
  if (mongoAvailable) await mongoose.connection.close();
});

function mockRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

describe('getRecommendationById()', () => {
  let projectId, otherProjectId, rec;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    projectId = new mongoose.Types.ObjectId();
    otherProjectId = new mongoose.Types.ObjectId();
    rec = await Recommendation.create({
      projectId,
      fingerprint: `fp-getbyid-${new mongoose.Types.ObjectId()}`,
      recommendationHash: `hash-getbyid-${new mongoose.Types.ObjectId()}`,
      ruleId: 'meta_description_missing',
      category: 'on_page',
      sections: {
        whyThisMatters: 'test', recommendedFix: 'test',
        implementationExample: { type: 'text', content: 'test' },
        contentRewrite: { optimized: 'Real recommended meta description content.' },
      },
    });
  });

  afterEach(async () => {
    if (!mongoAvailable) return;
    await Recommendation.deleteMany({ _id: rec._id });
  });

  test('returns the recommendation when projectId matches', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const req = { params: { recommendationId: rec._id.toString() }, query: { projectId: projectId.toString() } };
    const res = mockRes();
    await getRecommendationById(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.sections.contentRewrite.optimized, 'Real recommended meta description content.');
  });

  test('returns 404 when the recommendation belongs to a different project — never leaks cross-project content', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const req = { params: { recommendationId: rec._id.toString() }, query: { projectId: otherProjectId.toString() } };
    const res = mockRes();
    await getRecommendationById(req, res);

    assert.equal(res.statusCode, 404);
    assert.equal(res.body.data, undefined);
  });

  test('returns 404 for a nonexistent recommendation id', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const req = { params: { recommendationId: new mongoose.Types.ObjectId().toString() }, query: { projectId: projectId.toString() } };
    const res = mockRes();
    await getRecommendationById(req, res);

    assert.equal(res.statusCode, 404);
  });

  test('returns 400 when projectId is missing from the query', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const req = { params: { recommendationId: rec._id.toString() }, query: {} };
    const res = mockRes();
    await getRecommendationById(req, res);

    assert.equal(res.statusCode, 400);
  });
});
