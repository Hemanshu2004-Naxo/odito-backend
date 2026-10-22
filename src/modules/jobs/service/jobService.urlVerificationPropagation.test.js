import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import Job from '../model/Job.js';
import { JobService } from './jobService.js';

// P3-003: proves createAndDispatchPageAnalysisJob/createAndDispatchSeoScoringJob/
// createAndDispatchAiVisibilityJob propagate mode/target_url/urls when their
// source job carries mode:'url_verification', and are byte-identical to
// their pre-P3-003 behavior (no mode/target_url/urls field at all) for
// Full Audit / legacy verification source jobs — backward compatibility.
//
// Live-Mongo, auto-skip pattern (createJob persists a real Job document).

const jobService = new JobService();
const PROJECT = new mongoose.Types.ObjectId();
const USER = new mongoose.Types.ObjectId();

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
    await Job.deleteMany({ project_id: PROJECT });
  }
});

function fakeSourceJob(overrides = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    user_id: USER,
    project_id: PROJECT,
    run_id: new mongoose.Types.ObjectId(),
    input_data: {},
    ...overrides,
  };
}

describe('createAndDispatchPageAnalysisJob — url_verification propagation (live Mongo, auto-skip)', () => {
  test('propagates mode/target_url/urls when the source PAGE_SCRAPING job is url_verification', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const source = fakeSourceJob({
      input_data: { mode: 'url_verification', target_url: 'https://example.com/pricing' },
    });

    const job = await jobService.createAndDispatchPageAnalysisJob(source);

    assert.equal(job.input_data.mode, 'url_verification');
    assert.equal(job.input_data.target_url, 'https://example.com/pricing');
    assert.deepEqual(job.input_data.urls, ['https://example.com/pricing']);
    assert.equal(job.input_data.source_job_id, source._id.toString());
  });

  test('Full Audit source job (no mode) produces byte-identical input_data to before P3-003', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const source = fakeSourceJob({ input_data: {} });
    const job = await jobService.createAndDispatchPageAnalysisJob(source);

    assert.deepEqual(Object.keys(job.input_data.toObject ? job.input_data.toObject() : job.input_data).sort(), ['source_job_id']);
  });

  test('legacy verification mode (canonical_urls, mode:"verification") is unaffected', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const source = fakeSourceJob({
      input_data: { mode: 'verification', canonical_urls: ['https://example.com/a', 'https://example.com/b'] },
    });
    const job = await jobService.createAndDispatchPageAnalysisJob(source);

    assert.equal(job.input_data.mode, undefined);
    assert.equal(job.input_data.urls, undefined);
  });

  test('F4-016: propagates batchId when the source PAGE_SCRAPING job carries one', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const source = fakeSourceJob({
      input_data: { mode: 'url_verification', target_url: 'https://example.com/pricing', batchId: 'batch-123' },
    });
    const job = await jobService.createAndDispatchPageAnalysisJob(source);

    assert.equal(job.input_data.batchId, 'batch-123');
  });

  test('F4-016: a url_verification source job with NO batchId produces no batchId field (non-batched single-URL unaffected)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const source = fakeSourceJob({
      input_data: { mode: 'url_verification', target_url: 'https://example.com/pricing' },
    });
    const job = await jobService.createAndDispatchPageAnalysisJob(source);

    assert.equal(job.input_data.batchId, undefined);
  });
});

describe('createAndDispatchSeoScoringJob — url_verification propagation (live Mongo, auto-skip)', () => {
  test('propagates mode/target_url/urls from its PAGE_ANALYSIS source', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const source = fakeSourceJob({
      input_data: { mode: 'url_verification', target_url: 'https://example.com/pricing', urls: ['https://example.com/pricing'] },
    });

    const job = await jobService.createAndDispatchSeoScoringJob(source);

    assert.equal(job.input_data.mode, 'url_verification');
    assert.equal(job.input_data.target_url, 'https://example.com/pricing');
    assert.deepEqual(job.input_data.urls, ['https://example.com/pricing']);
  });

  test('Full Audit source job produces byte-identical input_data to before P3-003', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const source = fakeSourceJob({ input_data: {} });
    const job = await jobService.createAndDispatchSeoScoringJob(source);

    assert.deepEqual(Object.keys(job.input_data.toObject ? job.input_data.toObject() : job.input_data).sort(), ['source_job_id']);
  });

  test('F4-016: propagates batchId from its PAGE_ANALYSIS source', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const source = fakeSourceJob({
      input_data: { mode: 'url_verification', target_url: 'https://example.com/pricing', batchId: 'batch-456' },
    });
    const job = await jobService.createAndDispatchSeoScoringJob(source);

    assert.equal(job.input_data.batchId, 'batch-456');
  });
});

describe('createAndDispatchAiVisibilityJob — url_verification propagation (live Mongo, auto-skip)', () => {
  test('propagates mode/target_url/urls from its PAGE_SCRAPING source, alongside unchanged canonical_urls', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const source = fakeSourceJob({
      input_data: {
        mode: 'url_verification',
        target_url: 'https://example.com/pricing',
        canonical_urls: ['https://example.com/pricing'],
      },
    });

    const job = await jobService.createAndDispatchAiVisibilityJob(source);

    assert.equal(job.input_data.mode, 'url_verification');
    assert.equal(job.input_data.target_url, 'https://example.com/pricing');
    assert.deepEqual(job.input_data.urls, ['https://example.com/pricing']);
    assert.deepEqual(job.input_data.canonical_urls, ['https://example.com/pricing']);
  });

  test('Full Audit source job (no mode) keeps canonical_urls but adds no mode/target_url/urls', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const source = fakeSourceJob({ _canonicalUrls: ['https://example.com/a', 'https://example.com/b'] });
    const job = await jobService.createAndDispatchAiVisibilityJob(source);

    assert.deepEqual(job.input_data.canonical_urls, ['https://example.com/a', 'https://example.com/b']);
    assert.equal(job.input_data.mode, undefined);
    assert.equal(job.input_data.urls, undefined);
  });

  test('F4-016: propagates batchId from its PAGE_SCRAPING source', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const source = fakeSourceJob({
      input_data: { mode: 'url_verification', target_url: 'https://example.com/pricing', batchId: 'batch-789' },
    });
    const job = await jobService.createAndDispatchAiVisibilityJob(source);

    assert.equal(job.input_data.batchId, 'batch-789');
  });
});
