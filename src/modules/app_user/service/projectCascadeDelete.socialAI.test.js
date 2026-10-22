import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SeoProject from '../model/SeoProject.js';
import SocialBusinessProfile from '../../social_meta/model/SocialBusinessProfile.js';
import SocialAIStrategy from '../../social_meta/model/SocialAIStrategy.js';
import SocialContentGeneration from '../../social_meta/model/SocialContentGeneration.js';
import SocialDesignGeneration from '../../social_meta/model/SocialDesignGeneration.js';
import { deleteProjectCascade } from './projectCascadeDeleteService.js';

/**
 * Regression: permanently deleting a project must purge the Social Media AI
 * documents that hang off it (user-entered business profile + AI strategies),
 * and only that project's.
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

describe('deleteProjectCascade — Social Media AI documents', () => {
  let userId;
  const created = [];
  beforeEach(() => { userId = new mongoose.Types.ObjectId(); });

  const project = async () => {
    const p = await SeoProject.create({ user_id: userId, project_name: `Cascade Social ${Date.now()} ${Math.random().toString(36).slice(2, 8)}`, main_url: 'https://example.com', seo_scope: 'local', keywords: ['k'] });
    created.push(p._id);
    return p;
  };

  test('removes the project\'s SocialBusinessProfile and AI strategies, and leaves other projects\' alone', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const doomed = await project();
    const kept = await project();
    for (const p of [doomed, kept]) {
      await SocialBusinessProfile.create({ project_id: p._id, goals: ['x'] });
      await SocialAIStrategy.create({ project_id: p._id, version: 1, status: 'ready', strategy: { summary: 's' } });
      await SocialContentGeneration.create({ project_id: p._id, status: 'ready', request: { platform: 'facebook', contentPillar: 'x', objective: 'educational' }, strategy: { id: new mongoose.Types.ObjectId(), version: 1 }, social_account_id: new mongoose.Types.ObjectId() });
      await SocialDesignGeneration.create({ project_id: p._id, publication_id: new mongoose.Types.ObjectId(), status: 'ready', active: false, platform: 'facebook', contentVersion: 1, baseDesignVersion: 1, baseApprovalState: 'content_approved' });
    }

    const summary = await deleteProjectCascade(doomed._id.toString());
    assert.equal(summary.projectDeleted, true);
    assert.equal(summary.failures.length, 0);
    assert.equal(summary.collectionCounts.socialbusinessprofiles, 1);
    assert.equal(summary.collectionCounts.social_ai_strategies, 1);
    assert.equal(summary.collectionCounts.social_content_generations, 1);
    assert.equal(summary.collectionCounts.social_design_generations, 1);
    assert.equal(await SocialDesignGeneration.countDocuments({ project_id: doomed._id }), 0);
    assert.equal(await SocialDesignGeneration.countDocuments({ project_id: kept._id }), 1);
    assert.equal(await SocialContentGeneration.countDocuments({ project_id: doomed._id }), 0);
    assert.equal(await SocialContentGeneration.countDocuments({ project_id: kept._id }), 1);
    assert.equal(await SocialBusinessProfile.countDocuments({ project_id: doomed._id }), 0);
    assert.equal(await SocialAIStrategy.countDocuments({ project_id: doomed._id }), 0);
    assert.equal(await SocialBusinessProfile.countDocuments({ project_id: kept._id }), 1);
    assert.equal(await SocialAIStrategy.countDocuments({ project_id: kept._id }), 1);

    await deleteProjectCascade(kept._id.toString());
    assert.equal(await SocialBusinessProfile.countDocuments({ project_id: kept._id }), 0);
  });

  test('is idempotent: purging again deletes nothing and does not fail', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await project();
    await SocialBusinessProfile.create({ project_id: p._id });
    await deleteProjectCascade(p._id.toString());
    const again = await deleteProjectCascade(p._id.toString());
    assert.equal(again.failures.length, 0);
    assert.equal(again.collectionCounts.socialbusinessprofiles, 0);
  });
});
