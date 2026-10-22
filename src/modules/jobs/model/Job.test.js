import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import Job from './Job.js';

// P1-001: Job model extension for URL Verification.
//
// Schema/validation tests need no DB connection (Mongoose .validate() is
// pure in-memory). Unique-index tests need a real MongoDB (partial filter
// expressions and duplicate-key semantics can't be faithfully faked) — same
// live-Mongo-with-auto-skip pattern established in the Python P0-005 suite.

const PROJECT_A = new mongoose.Types.ObjectId();
const PROJECT_B = new mongoose.Types.ObjectId();

function verificationJob(overrides = {}) {
  return new Job({
    jobType: 'PAGE_SCRAPING',
    project_id: PROJECT_A,
    entityType: 'project',
    input_data: {
      mode: 'url_verification',
      target_url: 'https://example.com/pricing',
    },
    status: 'pending',
    ...overrides,
  });
}

describe('Job schema — input_data.mode / target_url (P1-001)', () => {
  test('accepts mode: "url_verification" with a valid target_url', async () => {
    const job = verificationJob();
    await assert.doesNotReject(() => job.validate());
  });

  test('stores target_url exactly as provided', async () => {
    const job = verificationJob({
      input_data: { mode: 'url_verification', target_url: 'https://example.com/a/b?x=1' },
    });
    await job.validate();
    assert.equal(job.input_data.target_url, 'https://example.com/a/b?x=1');
  });

  test('existing mode "verification" (legacy project-wide) still validates unchanged', async () => {
    const job = new Job({
      jobType: 'PAGE_SCRAPING',
      project_id: PROJECT_A,
      input_data: { mode: 'verification', canonical_urls: ['https://example.com/'] },
      status: 'pending',
    });
    await assert.doesNotReject(() => job.validate());
  });

  test('Full Audit jobs (no mode field at all) still validate unchanged', async () => {
    const job = new Job({
      jobType: 'PAGE_SCRAPING',
      project_id: PROJECT_A,
      input_data: { canonical_urls: ['https://example.com/'] },
      status: 'pending',
    });
    await assert.doesNotReject(() => job.validate());
    assert.equal(job.input_data.mode, undefined);
  });

  test('other job types with no mode field (e.g. HOMEPAGE_VIDEO_GENERATION) are unaffected', async () => {
    const job = new Job({
      jobType: 'HOMEPAGE_VIDEO_GENERATION',
      entityType: 'homepage_audit',
      input_data: { auditId: new mongoose.Types.ObjectId().toString() },
      status: 'pending',
    });
    await assert.doesNotReject(() => job.validate());
  });

  // ── Failure cases ──

  test('rejects an invalid mode value', async () => {
    const job = new Job({
      jobType: 'PAGE_SCRAPING',
      project_id: PROJECT_A,
      input_data: { mode: 'not_a_real_mode' },
      status: 'pending',
    });
    await assert.rejects(() => job.validate(), /Invalid input_data\.mode/);
  });

  test('rejects url_verification mode with a missing target_url', async () => {
    const job = new Job({
      jobType: 'PAGE_SCRAPING',
      project_id: PROJECT_A,
      input_data: { mode: 'url_verification' },
      status: 'pending',
    });
    await assert.rejects(() => job.validate(), /target_url is required/);
  });

  test('rejects url_verification mode with an empty-string target_url', async () => {
    const job = verificationJob({ input_data: { mode: 'url_verification', target_url: '   ' } });
    await assert.rejects(() => job.validate(), /target_url is required/);
  });

  test('rejects a malformed target_url (not a parseable URL)', async () => {
    const job = verificationJob({ input_data: { mode: 'url_verification', target_url: 'not a url' } });
    await assert.rejects(() => job.validate(), /not a valid URL/);
  });

  test('rejects a target_url with a non-http(s) protocol', async () => {
    const job = verificationJob({ input_data: { mode: 'url_verification', target_url: 'ftp://example.com/file' } });
    await assert.rejects(() => job.validate(), /must be an http\(s\) URL/);
  });
});

// ── Live-Mongo tests: partial unique index behavior ──
// Auto-skip if MongoDB is unreachable, rather than failing the whole suite —
// matches the established cross-language convention for this kind of test.

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
  if (mongoAvailable) {
    await mongoose.connection.close();
  }
});

afterEach(async () => {
  if (mongoAvailable) {
    // Clean only what this suite creates — scoped to the two synthetic
    // project ids, never a broad collection wipe.
    await Job.deleteMany({ project_id: { $in: [PROJECT_A, PROJECT_B] } });
  }
});

describe('Job unique_url_verification_target index (live Mongo, auto-skip)', () => {
  test('index exists with the expected keys and partial filter', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    await Job.syncIndexes();
    const indexes = await Job.collection.indexes();
    const target = indexes.find((i) => i.name === 'unique_url_verification_target');

    assert.ok(target, 'index unique_url_verification_target must exist');
    assert.equal(target.unique, true);
    assert.deepEqual(target.key, { project_id: 1, jobType: 1, 'input_data.target_url': 1 });
    assert.deepEqual(target.partialFilterExpression, {
      jobType: 'PAGE_SCRAPING',
      'input_data.mode': 'url_verification',
      status: { $in: ['pending', 'processing'] },
    });
  });

  test('repeated initialization is safe (syncIndexes twice does not throw or duplicate)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    await Job.syncIndexes();
    await Job.syncIndexes();
    const indexes = await Job.collection.indexes();
    const matches = indexes.filter((i) => i.name === 'unique_url_verification_target');
    assert.equal(matches.length, 1);
  });

  test('duplicate pending verification job for the same {project, target_url} is rejected', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await Job.syncIndexes();

    await verificationJob().save();
    await assert.rejects(
      () => verificationJob().save(),
      (err) => err.code === 11000
    );
  });

  test('a different target_url for the same project is allowed', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await Job.syncIndexes();

    await verificationJob().save();
    await assert.doesNotReject(() =>
      verificationJob({ input_data: { mode: 'url_verification', target_url: 'https://example.com/other-page' } }).save()
    );
  });

  test('the same target_url in a different project is allowed', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await Job.syncIndexes();

    await verificationJob().save();
    await assert.doesNotReject(() => verificationJob({ project_id: PROJECT_B }).save());
  });

  test('a completed verification job does not block a new one for the same target_url', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await Job.syncIndexes();

    const first = await verificationJob({ status: 'completed' }).save();
    assert.equal(first.status, 'completed');
    await assert.doesNotReject(() => verificationJob().save());
  });

  test('a failed verification job does not block a new one for the same target_url', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await Job.syncIndexes();

    await verificationJob({ status: 'failed' }).save();
    await assert.doesNotReject(() => verificationJob().save());
  });

  test('a Full Audit PAGE_SCRAPING job (no mode) never collides with the verification index', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await Job.syncIndexes();

    await verificationJob().save();
    const fullAudit = new Job({
      jobType: 'PAGE_SCRAPING',
      project_id: PROJECT_A,
      input_data: { canonical_urls: ['https://example.com/pricing'] }, // same URL, different mode
      status: 'pending',
    });
    await assert.doesNotReject(() => fullAudit.save());
  });

  test('a different jobType with mode: url_verification and the same target_url is unaffected (index is PAGE_SCRAPING-scoped)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await Job.syncIndexes();

    await verificationJob().save();
    const headless = new Job({
      jobType: 'HEADLESS_ACCESSIBILITY',
      project_id: PROJECT_A,
      input_data: { mode: 'url_verification', target_url: 'https://example.com/pricing' },
      status: 'pending',
    });
    await assert.doesNotReject(() => headless.save());
  });

  test('index creation fails loudly (not silently) when pre-existing duplicates violate the partial filter', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const PROJECT_C = new mongoose.Types.ObjectId();
    try {
      // Ensure the index exists, then drop it so we can rebuild against a
      // dataset that already violates uniqueness — mirrors a stale/legacy
      // dataset scenario, not a hypothetical.
      await Job.syncIndexes();
      await Job.collection.dropIndex('unique_url_verification_target');

      // Raw-driver insert bypasses the Mongoose validate hook entirely —
      // the only way to seed a duplicate the index itself would otherwise
      // prevent.
      const rawDoc = {
        project_id: PROJECT_C,
        jobType: 'PAGE_SCRAPING',
        status: 'pending',
        entityType: 'project',
        priority: 1,
        attempts: 0,
        max_attempts: 3,
        input_data: { mode: 'url_verification', target_url: 'https://example.com/dup' },
      };
      await Job.collection.insertMany([rawDoc, { ...rawDoc }]);

      await assert.rejects(
        () =>
          Job.collection.createIndex(
            { project_id: 1, jobType: 1, 'input_data.target_url': 1 },
            {
              unique: true,
              partialFilterExpression: {
                jobType: 'PAGE_SCRAPING',
                'input_data.mode': 'url_verification',
                status: { $in: ['pending', 'processing'] },
              },
              name: 'unique_url_verification_target',
            }
          ),
        (err) => err.code === 11000
      );
    } finally {
      await Job.collection.deleteMany({ project_id: PROJECT_C });
      // Restore the index for every subsequent test in this file/suite.
      await Job.syncIndexes();
    }
  });
});
