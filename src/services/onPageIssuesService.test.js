import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import { getOnPageIssues, getIssueUrls } from './onPageIssuesService.js';

// P3-002 Part 5: On-Page Issues (dashboard) must ignore resolved issues —
// live Mongo, auto-skip if unreachable, same pattern used across this task.

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

describe('onPageIssuesService — ignores resolved issues (P3-002)', () => {
  let projectId;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    projectId = new mongoose.Types.ObjectId();
    await mongoose.connection.db.collection('seo_page_issues').deleteMany({ projectId });
    await mongoose.connection.db.collection('seo_page_summary').deleteMany({ projectId });
  });

  test('getOnPageIssues excludes resolved issue documents from counts', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    await mongoose.connection.db.collection('seo_page_issues').insertMany([
      { projectId, issue_code: 'TITLE_MISSING', page_url: 'https://example.com/a', severity: 'high', category: 'Content', status: 'open', dedup_key: `t1-${projectId}` },
      { projectId, issue_code: 'META_DESCRIPTION_MISSING', page_url: 'https://example.com/a', severity: 'medium', category: 'Content', status: 'resolved', dedup_key: `t2-${projectId}` },
    ]);

    const result = await getOnPageIssues(projectId);

    const codes = result.issues.map((i) => i.issue_code);
    assert.ok(codes.includes('TITLE_MISSING'));
    assert.ok(!codes.includes('META_DESCRIPTION_MISSING'));
    assert.equal(result.summary.total_issues_found, 1);
  });

  test('getIssueUrls excludes URLs whose issue for that code is resolved', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    await mongoose.connection.db.collection('seo_page_issues').insertMany([
      { projectId, issue_code: 'TITLE_MISSING', page_url: 'https://example.com/still-open', status: 'open', dedup_key: `t3-${projectId}` },
      { projectId, issue_code: 'TITLE_MISSING', page_url: 'https://example.com/fixed', status: 'resolved', dedup_key: `t4-${projectId}` },
    ]);

    const urls = await getIssueUrls(projectId, 'TITLE_MISSING');

    assert.deepEqual(urls.map((u) => u.url), ['https://example.com/still-open']);
  });

  test('getIssueUrls returns each URL\'s own issue_message and severity, not a shared one', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    await mongoose.connection.db.collection('seo_page_issues').insertMany([
      {
        projectId, issue_code: 'organization_schema', page_url: 'https://example.com/',
        issue_message: 'Organization schema incomplete - missing recommended fields: address',
        severity: 'low', data_path: 'structured_data.organization.incomplete',
        status: 'open', dedup_key: `t5-${projectId}`,
      },
      {
        projectId, issue_code: 'organization_schema', page_url: 'https://example.com/contact',
        issue_message: 'Missing Organization or LocalBusiness schema',
        severity: 'high', data_path: 'structured_data.localbusiness',
        status: 'open', dedup_key: `t6-${projectId}`,
      },
    ]);

    const urls = await getIssueUrls(projectId, 'organization_schema');
    const byUrl = Object.fromEntries(urls.map((u) => [u.url, u]));

    assert.equal(byUrl['https://example.com/'].severity, 'low');
    assert.match(byUrl['https://example.com/'].issue_message, /missing recommended fields: address/);
    assert.equal(byUrl['https://example.com/contact'].severity, 'high');
    assert.match(byUrl['https://example.com/contact'].issue_message, /Missing Organization/);
  });

  test('getIssueUrls keeps the most severe finding when a page has two documents under one issue_code', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    await mongoose.connection.db.collection('seo_page_issues').insertMany([
      {
        projectId, issue_code: 'organization_schema', page_url: 'https://example.com/',
        issue_message: 'Organization schema incomplete - missing recommended fields: address',
        severity: 'low', data_path: 'structured_data.organization.incomplete',
        status: 'open', dedup_key: `t7-${projectId}`,
      },
      {
        projectId, issue_code: 'organization_schema', page_url: 'https://example.com/',
        issue_message: 'Organization schema missing required fields: name',
        severity: 'high', data_path: 'structured_data.organization.missing_fields',
        status: 'open', dedup_key: `t8-${projectId}`,
      },
    ]);

    const urls = await getIssueUrls(projectId, 'organization_schema');

    assert.equal(urls.length, 1);
    assert.equal(urls[0].severity, 'high');
    assert.match(urls[0].issue_message, /missing required fields/);
  });

  test('getOnPageIssues splits one rule into per-data_path rows with correct title/severity', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    await mongoose.connection.db.collection('seo_page_summary').insertMany([
      { projectId, page_url: 'https://example.com/' },
      { projectId, page_url: 'https://example.com/contact' },
    ]);
    await mongoose.connection.db.collection('seo_page_issues').insertMany([
      {
        projectId, issue_code: 'organization_schema', page_url: 'https://example.com/',
        issue_message: 'Organization schema incomplete - missing recommended fields: address',
        severity: 'low', category: 'Schema', data_path: 'structured_data.organization.incomplete',
        status: 'open', dedup_key: `t9-${projectId}`,
      },
      {
        projectId, issue_code: 'organization_schema', page_url: 'https://example.com/contact',
        issue_message: 'Missing Organization or LocalBusiness schema',
        severity: 'high', category: 'Schema', data_path: 'structured_data.localbusiness',
        status: 'open', dedup_key: `t10-${projectId}`,
      },
    ]);

    const result = await getOnPageIssues(projectId);
    const rows = result.issues.filter((i) => i.issue_code === 'organization_schema');

    assert.equal(rows.length, 2, 'one row per data_path, not one blended row');

    const soft = rows.find((r) => r.data_path === 'structured_data.organization.incomplete');
    assert.equal(soft.severity, 'low');
    assert.equal(soft.title, 'Organization Schema Recommendations');
    assert.equal(soft.difficulty, 'easy');
    assert.doesNotMatch(soft.title, /Missing Organization/);

    const hard = rows.find((r) => r.data_path === 'structured_data.localbusiness');
    assert.equal(hard.severity, 'high');
    assert.equal(hard.title, 'Missing Organization or LocalBusiness Schema');
    assert.equal(hard.difficulty, 'hard');
  });
});
