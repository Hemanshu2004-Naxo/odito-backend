import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import taskVerificationService from './TaskVerificationService.js';
import Task from '../model/Task.js';

/**
 * A TYPED sameAs fix (preview -> approve -> apply, ledger record) is judged only by a crawl taken AFTER the WordPress write, and only
 * by the approved URLs being in the crawled page's Organization sameAs. The older owner-typed sameAs write keeps its behaviour
 * (TaskVerificationService.sameAs.test.js). Live Mongo, auto-skip if unreachable.
 */

let mongoAvailable = false;
before(async () => {
  try { await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 }); mongoAvailable = true; } catch { mongoAvailable = false; }
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

const LI = 'https://www.linkedin.com/company/acme-typed';
const FB = 'https://www.facebook.com/acmetyped';
const writtenAt = new Date('2026-10-15T10:00:00Z');
const before_ = new Date('2026-10-15T09:00:00Z');
const after_ = new Date('2026-10-15T11:00:00Z');
const graph = (sameAs) => [{ '@context': 'https://schema.org', '@graph': [{ '@type': 'Organization', '@id': 'https://acme-typed.example/#organization', name: 'Acme', url: 'https://acme-typed.example/', ...(sameAs ? { sameAs } : {}) }] }];

describe('TaskVerificationService — typed organization_same_as needs a post-write crawl', () => {
  let projectId;
  beforeEach(async () => {
    if (!mongoAvailable) return;
    projectId = new mongoose.Types.ObjectId();
    createdProjectIds.push(projectId);
    const db = mongoose.connection.db;
    await db.collection('seo_page_data').deleteMany({ projectId });
    await db.collection('seo_page_issues').deleteMany({ projectId });
  });

  const typedTask = (url, field = 'organization_same_as') => Task.create({
    projectId, issueKey: 'sameas_array', pageUrl: url, status: 'implemented', origin: 'wordpress_auto',
    fixHistory: [{
      attemptNumber: 1, attemptKind: 'fix_attempt', origin: 'wordpress_auto', status: 'pending_verification',
      before: { capturedAt: new Date(), source: 'unavailable', dataPath: null, value: null },
      fixApplied: {
        capturedAt: new Date(), recommendationId: null, recommendationVersion: null, snapshot: null,
        expectedAfterValue: { type: 'same_as', urls: [LI, FB], additionalProfiles: [] },
        externalWrite: { system: 'wordpress', provider: 'rank_math', field, wordpressPostId: null, httpStatus: 200, writtenAt, scope: 'site' },
      },
      implementedAt: writtenAt,
      verification: { verifiedAt: null, method: null, result: null, matched: null, after: { source: 'unavailable', value: null }, triggerJobId: null },
    }],
  });
  const page = (url, scraped_at, structured_data) => mongoose.connection.db.collection('seo_page_data').insertOne({ projectId, url, scraped_at, structured_data });
  const openIssue = (url) => mongoose.connection.db.collection('seo_page_issues').insertOne({ projectId, page_url: url, rule_id: 'sameas_array', status: 'open', dedup_key: `sameas-${projectId}-${url}` });
  const run = async (id) => { await taskVerificationService.verifyImplementedTasks(projectId, id); };

  test('a crawl OLDER than the write does not reopen the task and does not verify it; it stays pending', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const url = 'https://acme-typed.example/stale';
    await page(url, before_, graph());
    await openIssue(url);
    const task = await typedTask(url);
    await run('SAMEAS-1');
    assert.equal((await Task.findById(task._id)).status, 'implemented');
  });

  test('a page missing from the crawl is pending, never "the finding is gone so it is fixed"', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const task = await typedTask('https://acme-typed.example/not-crawled');
    await run('SAMEAS-2');
    assert.equal((await Task.findById(task._id)).status, 'implemented');
  });

  test('a crawl AFTER the write showing every approved URL on the Organization verifies the task', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const url = 'https://acme-typed.example/ok';
    await page(url, after_, graph([LI, FB]));
    const task = await typedTask(url);
    await run('SAMEAS-3');
    assert.equal((await Task.findById(task._id)).status, 'verified_fixed');
  });

  test('a crawl AFTER the write where the finding disappeared but one approved URL is not rendered is reopened (value check wins)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const url = 'https://acme-typed.example/partial';
    await page(url, after_, graph([LI]));
    const task = await typedTask(url);
    await run('SAMEAS-4');
    assert.equal((await Task.findById(task._id)).status, 'reopened');
  });

  test('a crawl AFTER the write that still reports the finding is reopened', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const url = 'https://acme-typed.example/still-open';
    await page(url, after_, graph());
    await openIssue(url);
    const task = await typedTask(url);
    await run('SAMEAS-5');
    assert.equal((await Task.findById(task._id)).status, 'reopened');
  });
});
