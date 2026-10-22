import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import { PDFAggregationService } from './pdfAggregationService.js';

// P3-002 Part 5: PDF report issue sections must ignore resolved issues.

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

describe('PDFAggregationService — ignores resolved issues (P3-002)', () => {
  let projectId;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    projectId = new mongoose.Types.ObjectId();
    await mongoose.connection.db.collection('seo_page_issues').deleteMany({ projectId });
  });

  test('fetchPageIssuesData counts only open issues', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    await mongoose.connection.db.collection('seo_page_issues').insertMany([
      { projectId, issue_code: 'TITLE_MISSING', issue_type: 'title', page_url: 'https://example.com/a', severity: 'critical', status: 'open', dedup_key: `p1-${projectId}` },
      { projectId, issue_code: 'META_DESCRIPTION_MISSING', issue_type: 'meta', page_url: 'https://example.com/b', severity: 'high', status: 'resolved', dedup_key: `p2-${projectId}` },
    ]);

    const result = await PDFAggregationService.fetchPageIssuesData(mongoose.connection.db, projectId);

    assert.equal(result.summary.totalIssues, 1);
  });

  test('fetchOnpageIssuesData counts only open issues', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    await mongoose.connection.db.collection('seo_page_issues').insertMany([
      { projectId, issue_code: 'TITLE_MISSING', page_url: 'https://example.com/a', severity: 'high', status: 'open', dedup_key: `p3-${projectId}` },
      { projectId, issue_code: 'META_DESCRIPTION_MISSING', page_url: 'https://example.com/b', severity: 'high', status: 'resolved', dedup_key: `p4-${projectId}` },
    ]);

    const result = await PDFAggregationService.fetchOnpageIssuesData(mongoose.connection.db, projectId);

    assert.equal(result.critical, 1);
  });
});
