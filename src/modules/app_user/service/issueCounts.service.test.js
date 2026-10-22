import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import { IssueCountsService } from './issueCounts.service.js';

// P3-002 Part 5: dashboard issue counts must ignore resolved issues.

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

describe('IssueCountsService.getIssueCounts — ignores resolved issues (P3-002)', () => {
  let projectId;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    projectId = new mongoose.Types.ObjectId();
    await mongoose.connection.db.collection('seo_page_issues').deleteMany({ projectId });
  });

  test('only open issues are counted', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    await mongoose.connection.db.collection('seo_page_issues').insertMany([
      { projectId, issue_code: 'TITLE_MISSING', page_url: 'https://example.com/a', severity: 'high', status: 'open', dedup_key: `c1-${projectId}` },
      { projectId, issue_code: 'META_DESCRIPTION_MISSING', page_url: 'https://example.com/b', severity: 'medium', status: 'resolved', dedup_key: `c2-${projectId}` },
    ]);

    const result = await IssueCountsService.getIssueCounts(projectId.toString());

    assert.equal(result.data.totalIssues, 1);
    assert.equal(result.data.critical, 1);
    assert.equal(result.data.warnings, 0);
  });
});
