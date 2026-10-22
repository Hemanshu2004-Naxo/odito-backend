import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import express from 'express';

dotenv.config();

import SeoProject from '../../app_user/model/SeoProject.js';
import Recommendation from '../model/Recommendation.js';
import { validateProjectAccess } from '../../../middleware/auth.middleware.js';
import { getRecommendationById } from '../controller/recommendationController.js';

/**
 * Real-dispatch regression test for a bug introduced (and caught) while
 * building GET /recommendations/:recommendationId: validateProjectAccess()
 * reads `req.params.id` BEFORE `req.query.projectId` (see
 * auth.middleware.js) — it exists to support routes where `:id` IS the
 * project's own id. The route was originally written as `/:id`, which
 * collided with that check: it made the middleware try to validate
 * project access using the RECOMMENDATION's id as if it were a project
 * id, failing with a Mongoose cast error before the controller — which
 * does the REAL ownership check — was ever reached. A controller-level
 * test calling getRecommendationById() directly (see
 * getRecommendationById.e2e.test.js) can never catch this class of bug,
 * because it never goes through the route/middleware layer at all — this
 * test exists specifically to exercise that real dispatch path.
 *
 * No supertest dependency (none exists elsewhere in this repo) — a real,
 * minimal Express app on an ephemeral port, real middleware, real
 * controller, real Mongo, plain fetch.
 */

let mongoAvailable = false;
let server;
let baseUrl;

before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
  } catch {
    mongoAvailable = false;
    return;
  }

  const app = express();
  app.use(express.json());
  // Stands in for the real JWT `auth` middleware (recommendationRoutes.js's
  // own router.use(auth)) — this test is about validateProjectAccess() +
  // the controller, not JWT verification, which is already covered
  // elsewhere.
  app.use((req, res, next) => {
    // Mirrors the real auth middleware's req.user = <Mongoose User doc>,
    // where .id is a virtual string alias for ._id — validateProjectAccess()
    // reads req.user?.id specifically (auth.middleware.js line 18).
    const uid = req.headers['x-test-user-id'];
    req.user = { _id: uid, id: uid };
    next();
  });
  // The EXACT route definition style now in recommendationRoutes.js —
  // kept inline (not importing the real router) so this test still fails
  // loudly if the route is ever renamed back to the colliding `/:id`.
  app.get('/recommendations/:recommendationId', validateProjectAccess(), getRecommendationById);

  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (mongoAvailable) await mongoose.connection.close();
});

describe('GET /recommendations/:recommendationId — real route dispatch (validateProjectAccess + controller)', () => {
  let userId, project, rec;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    userId = new mongoose.Types.ObjectId();
    project = await SeoProject.create({
      user_id: userId, project_name: `Route Wiring Test ${Date.now()}`,
      main_url: 'https://route-wiring-test.example.com', seo_scope: 'local', keywords: ['x'],
    });
    rec = await Recommendation.create({
      projectId: project._id,
      fingerprint: `fp-wiring-${new mongoose.Types.ObjectId()}`,
      recommendationHash: `hash-wiring-${new mongoose.Types.ObjectId()}`,
      ruleId: 'meta_description_missing',
      category: 'on_page',
      sections: {
        whyThisMatters: 'test', recommendedFix: 'test',
        implementationExample: { type: 'text', content: 'test' },
        contentRewrite: { optimized: 'Real content via real route dispatch.' },
      },
    });
  });

  afterEach(async () => {
    if (!mongoAvailable) return;
    await Recommendation.deleteMany({ _id: rec._id });
    await SeoProject.deleteOne({ _id: project._id });
  });

  test('a real HTTP request with the correct projectId in the query reaches the controller and returns the recommendation', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const res = await fetch(`${baseUrl}/recommendations/${rec._id}?projectId=${project._id}`, {
      headers: { 'x-test-user-id': userId.toString() },
    });
    const body = await res.json();

    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(body)}`);
    assert.equal(body.success, true);
    assert.equal(body.data.sections.contentRewrite.optimized, 'Real content via real route dispatch.');
  });

  test('the project owner can fetch it; a different user cannot (real ownership check via the real middleware)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const otherUserId = new mongoose.Types.ObjectId();
    const res = await fetch(`${baseUrl}/recommendations/${rec._id}?projectId=${project._id}`, {
      headers: { 'x-test-user-id': otherUserId.toString() },
    });

    assert.notEqual(res.status, 200);
  });
});
