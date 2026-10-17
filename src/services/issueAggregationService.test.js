import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import { IssueAggregationService } from './issueAggregationService.js';
import { IssueCountsService } from '../modules/app_user/service/issueCounts.service.js';
import { ProjectIssuesService } from '../modules/app_user/service/projectIssues.service.js';
import { getOnPageIssues } from './onPageIssuesService.js';
import { getAccessibilityIssues } from './accessibilityIssuesService.js';

// Regression coverage for the "different Total Issues on every tab" bug:
// four independent Node aggregations over `seo_page_issues` (onPageIssuesService,
// the old IssueCountsService, ProjectIssuesService, accessibilityIssuesService)
// used different dedup keys / status filters and produced genuinely different
// totals for the same project. All four now derive from
// IssueAggregationService's canonical identity (`dedup_key`) and canonical
// status semantics (`open` vs `resolved` — not the never-used `fixed`).

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

describe('IssueAggregationService — canonical issue counting', () => {
  let projectId;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    projectId = new mongoose.Types.ObjectId();
    await mongoose.connection.db.collection('seo_page_issues').deleteMany({ projectId });
    await mongoose.connection.db.collection('seo_page_summary').deleteMany({ projectId });
  });

  test('a rule firing on two data_paths of the same page counts as two distinct issues, not one', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    // Same issue_code + same page_url, different data_path — the exact shape
    // documented in onPageIssuesService.js as legitimately two distinct findings
    // (e.g. OrganizationSchemaRule's "missing required field" vs "missing
    // recommended field"). The old IssueCountsService grouped by
    // (issue_code, page_url) only and would have collapsed these into one.
    await mongoose.connection.db.collection('seo_page_issues').insertMany([
      { projectId, issue_code: 'organization_schema', page_url: 'https://example.com/', data_path: 'structured_data.organization.missing_fields', severity: 'high', category: 'Schema', status: 'open', dedup_key: `a1-${projectId}` },
      { projectId, issue_code: 'organization_schema', page_url: 'https://example.com/', data_path: 'structured_data.organization.incomplete', severity: 'low', category: 'Schema', status: 'open', dedup_key: `a2-${projectId}` },
    ]);

    const summary = await IssueAggregationService.getIssueSummary(projectId);
    assert.equal(summary.totalIssues, 2);
  });

  test('resolved issues are excluded from the canonical total', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    await mongoose.connection.db.collection('seo_page_issues').insertMany([
      { projectId, issue_code: 'TITLE_MISSING', page_url: 'https://example.com/a', severity: 'high', category: 'Content', status: 'open', dedup_key: `b1-${projectId}` },
      { projectId, issue_code: 'META_DESCRIPTION_MISSING', page_url: 'https://example.com/b', severity: 'medium', category: 'Content', status: 'resolved', dedup_key: `b2-${projectId}` },
    ]);

    const summary = await IssueAggregationService.getIssueSummary(projectId);
    assert.equal(summary.totalIssues, 1);
    assert.equal(summary.resolved, 1);
  });

  test('a finding WITHDRAWN as not applicable (status excluded) is neither an open issue nor resolved progress, on every surface', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    await mongoose.connection.db.collection('seo_page_issues').insertMany([
      { projectId, issue_code: 'images_missing_alt_text', page_url: 'https://example.com/a', data_path: 'images.real.alt', severity: 'high', category: 'Images', status: 'open', dedup_key: `x1-${projectId}` },
      { projectId, issue_code: 'images_missing_alt_text', page_url: 'https://example.com/b', data_path: 'images.pixel.alt', severity: 'high', category: 'Images', status: 'excluded', excluded_reason: 'tracking_endpoint', dedup_key: `x2-${projectId}` },
      { projectId, issue_code: 'TITLE_MISSING', page_url: 'https://example.com/c', severity: 'high', category: 'Content', status: 'resolved', dedup_key: `x3-${projectId}` },
    ]);

    const summary = await IssueAggregationService.getIssueSummary(projectId);
    assert.equal(summary.totalIssues, 1, 'only the real open finding is outstanding');
    assert.equal(summary.resolved, 1, 'a withdrawn finding is NOT counted as a fix');

    const project = { _id: projectId, user_id: new mongoose.Types.ObjectId() };
    const byPage = await ProjectIssuesService.getProjectIssuesByPage(project);
    assert.equal(byPage.data.summary.totalIssues, 1);
    const listed = await ProjectIssuesService.getProjectIssues(project, {});
    assert.ok(!JSON.stringify(listed).includes('example.com/b'), 'the withdrawn finding is not listed against its page');
  });

  test('excludeCategories scopes the total (On-Page excludes Accessibility)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    await mongoose.connection.db.collection('seo_page_issues').insertMany([
      { projectId, issue_code: 'TITLE_MISSING', page_url: 'https://example.com/a', severity: 'high', category: 'Content', status: 'open', dedup_key: `c1-${projectId}` },
      { projectId, issue_code: 'form_labels_missing', page_url: 'https://example.com/a', severity: 'medium', category: 'Accessibility', status: 'open', dedup_key: `c2-${projectId}` },
    ]);

    const allCategories = await IssueAggregationService.getIssueSummary(projectId, { excludeCategories: [] });
    const onPageScope = await IssueAggregationService.getIssueSummary(projectId, { excludeCategories: ['Accessibility'] });

    assert.equal(allCategories.totalIssues, 2, 'Overview scope includes Accessibility');
    assert.equal(onPageScope.totalIssues, 1, 'On-Page scope excludes Accessibility');
  });

  test('Overview (IssueCountsService) and Issues-by-Page (ProjectIssuesService) totals always agree for the same project', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    await mongoose.connection.db.collection('seo_page_issues').insertMany([
      { projectId, issue_code: 'organization_schema', page_url: 'https://example.com/', data_path: 'a', severity: 'high', category: 'Schema', status: 'open', dedup_key: `d1-${projectId}` },
      { projectId, issue_code: 'organization_schema', page_url: 'https://example.com/', data_path: 'b', severity: 'low', category: 'Schema', status: 'open', dedup_key: `d2-${projectId}` },
      { projectId, issue_code: 'form_labels_missing', page_url: 'https://example.com/contact', severity: 'medium', category: 'Accessibility', status: 'open', dedup_key: `d3-${projectId}` },
      { projectId, issue_code: 'TITLE_MISSING', page_url: 'https://example.com/old', severity: 'high', category: 'Content', status: 'resolved', dedup_key: `d4-${projectId}` },
    ]);

    const overview = await IssueCountsService.getIssueCounts(projectId.toString());
    const project = { _id: projectId, user_id: new mongoose.Types.ObjectId() };
    const byPage = await ProjectIssuesService.getProjectIssuesByPage(project);

    // 3 open issues total (d1, d2, d3); d4 is resolved and must not count.
    assert.equal(overview.data.totalIssues, 3);
    assert.equal(byPage.data.summary.totalIssues, 3);
    assert.equal(overview.data.totalIssues, byPage.data.summary.totalIssues, 'Overview and Issues-by-Page must be mathematically identical for the same scope');
  });

  test('IssueCountsService throws instead of returning a fake all-zero success result on aggregation failure', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    // An invalid ObjectId string makes `new ObjectId(projectId)` throw inside
    // the aggregation path — simulating a real failure. Before this fix,
    // IssueCountsService.getIssueCounts caught this and returned
    // `{ success: true, data: { totalIssues: 0, ... } }`, indistinguishable
    // from a genuinely clean project.
    await assert.rejects(
      () => IssueCountsService.getIssueCounts('not-a-valid-object-id'),
      (err) => {
        assert.equal(err.statusCode, 503);
        return true;
      }
    );
  });

  test('accessibilityIssuesService counts distinct data_paths, not just distinct pages', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    await mongoose.connection.db.collection('seo_page_summary').insertOne({ projectId, page_url: 'https://example.com/' });
    await mongoose.connection.db.collection('seo_page_issues').insertMany([
      { projectId, issue_code: 'images_missing_alt_text', page_url: 'https://example.com/', data_path: 'images[0]', severity: 'medium', category: 'Accessibility', status: 'open', dedup_key: `e1-${projectId}` },
      { projectId, issue_code: 'images_missing_alt_text', page_url: 'https://example.com/', data_path: 'images[1]', severity: 'medium', category: 'Accessibility', status: 'open', dedup_key: `e2-${projectId}` },
    ]);

    const result = await getAccessibilityIssues(projectId);
    assert.equal(result.summary.total_issues_found, 2, 'two distinct alt-text findings on the same page must both count');
  });

  test('On-Page (excludes Accessibility) and Overview (all categories) legitimately differ by exactly the Accessibility count', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    await mongoose.connection.db.collection('seo_page_summary').insertOne({ projectId, page_url: 'https://example.com/' });
    await mongoose.connection.db.collection('seo_page_issues').insertMany([
      { projectId, issue_code: 'TITLE_MISSING', page_url: 'https://example.com/', severity: 'high', category: 'Content', status: 'open', dedup_key: `f1-${projectId}` },
      { projectId, issue_code: 'form_labels_missing', page_url: 'https://example.com/', severity: 'medium', category: 'Accessibility', status: 'open', dedup_key: `f2-${projectId}` },
    ]);

    const onPage = await getOnPageIssues(projectId);
    const overview = await IssueCountsService.getIssueCounts(projectId.toString());

    assert.equal(onPage.summary.total_issues_found, 1, 'On-Page excludes the Accessibility finding');
    assert.equal(overview.data.totalIssues, 2, 'Overview includes it');
    assert.equal(overview.data.totalIssues - onPage.summary.total_issues_found, 1, 'difference is exactly the Accessibility category, not a counting discrepancy');
  });
});
