import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SeoProject from '../../app_user/model/SeoProject.js';
import SocialAccount from '../model/SocialAccount.js';
import SocialPublication from '../model/SocialPublication.js';
import { createPublication, createBulkPublications } from './socialPublishingService.js';

/**
 * Bulk Upload — Phase 3. Regression coverage for the ONLY change to
 * socialPublishingService: createPublication() now accepts OPTIONAL
 * `importBatchId` / `importRowNumber`. Existing callers (single-post
 * create, the legacy POST /social/publishing/bulk) must be byte-for-byte
 * unaffected when they don't pass them.
 */

let mongoAvailable = false;

before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    await SocialPublication.syncIndexes();
    mongoAvailable = true;
  } catch {
    mongoAvailable = false;
  }
});

after(async () => {
  if (mongoAvailable) await mongoose.connection.close();
});

describe('createPublication — import metadata is optional and inert when absent', () => {
  let project, userId, account;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    userId = new mongoose.Types.ObjectId();
    project = await SeoProject.create({
      user_id: userId, project_name: `P3 Meta ${suffix}`, main_url: 'https://example.com', seo_scope: 'local', keywords: ['x'],
    });
    account = await SocialAccount.create({
      user_id: userId, project_id: project._id, platform: 'facebook', platformAccountId: `pg_meta_${suffix}`,
      platformAccountName: 'Meta Page', accountType: 'page', pageId: 'pg_meta', accessToken: 'real-token',
      status: 'active', isActive: true, scopes: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'],
    });
  });

  afterEach(async () => {
    if (!mongoAvailable) return;
    await SocialPublication.deleteMany({ project_id: project._id });
    await SocialAccount.deleteMany({ project_id: project._id });
    await SeoProject.deleteOne({ _id: project._id });
  });

  test('a normal single-post create leaves importBatchId / importRowNumber null', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const r = await createPublication(project._id.toString(), userId, {
      platform: 'facebook', socialAccountId: account._id.toString(), content: 'Hello',
    });
    assert.equal(r.success, true);
    const doc = await SocialPublication.findById(r.publication.id);
    assert.equal(doc.importBatchId, null);
    assert.equal(doc.importRowNumber, null);
    assert.equal(doc.status, 'draft');
  });

  test('createBulkPublications (legacy POST /bulk) still creates drafts with null import metadata', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const res = await createBulkPublications(project._id.toString(), userId, [
      { platform: 'facebook', socialAccountId: account._id.toString(), content: 'Row 1' },
    ]);
    assert.equal(res.success, true);
    assert.equal(res.created, 1);
    const [doc] = await SocialPublication.find({ project_id: project._id });
    assert.equal(doc.status, 'draft');
    assert.equal(doc.importBatchId, null);
    assert.equal(doc.importRowNumber, null);
  });

  test('when import metadata IS passed it is stamped, and the partial unique index blocks a duplicate for the same row', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const batchId = new mongoose.Types.ObjectId();
    const first = await createPublication(project._id.toString(), userId, {
      platform: 'facebook', socialAccountId: account._id.toString(), content: 'row 5',
      importBatchId: batchId, importRowNumber: 5,
    });
    assert.equal(first.success, true);
    const doc = await SocialPublication.findById(first.publication.id);
    assert.equal(doc.importBatchId.toString(), batchId.toString());
    assert.equal(doc.importRowNumber, 5);

    await assert.rejects(
      () => createPublication(project._id.toString(), userId, {
        platform: 'facebook', socialAccountId: account._id.toString(), content: 'row 5 again',
        importBatchId: batchId, importRowNumber: 5,
      }),
      (err) => err.code === 11000,
      'one import row -> at most one publication',
    );
  });

  test('a different row number under the same batch is allowed', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const batchId = new mongoose.Types.ObjectId();
    const a = await createPublication(project._id.toString(), userId, {
      platform: 'facebook', socialAccountId: account._id.toString(), content: 'r1', importBatchId: batchId, importRowNumber: 1,
    });
    const b = await createPublication(project._id.toString(), userId, {
      platform: 'facebook', socialAccountId: account._id.toString(), content: 'r2', importBatchId: batchId, importRowNumber: 2,
    });
    assert.equal(a.success, true);
    assert.equal(b.success, true);
  });
});
