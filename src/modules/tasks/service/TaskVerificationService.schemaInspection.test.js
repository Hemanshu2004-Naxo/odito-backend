import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import taskVerificationService from './TaskVerificationService.js';
import Task from '../model/Task.js';
import SchemaBreadcrumbEvidence from '../../schema-evidence/SchemaBreadcrumbEvidence.js';
import { saveUserBreadcrumbEvidence } from '../../schema-evidence/breadcrumbEvidenceStore.js';
import {
  ABOUT_CANONICAL, HOME, ORIGIN, aboutPageData, graphWithOrganization, organization,
} from '../../schema-evidence/__fixtures__/clinicSite.js';

/**
 * Schema tasks are no longer verified just because the audit finding disappeared.
 *
 * Live local Mongo (auto-skip if unreachable, same as every other TaskVerificationService
 * suite). No network: the pages below declare no logo/image (so nothing is fetched), or declare
 * one the image client refuses without a request (localhost).
 */

let mongoAvailable = false;
before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
  } catch { mongoAvailable = false; }
});

const createdProjectIds = [];
after(async () => {
  if (mongoAvailable) {
    const db = mongoose.connection.db;
    await Task.deleteMany({ projectId: { $in: createdProjectIds } });
    await SchemaBreadcrumbEvidence.deleteMany({ projectId: { $in: createdProjectIds } });
    for (const name of ['seo_page_data', 'seo_page_issues']) await db.collection(name).deleteMany({ projectId: { $in: createdProjectIds } });
    await mongoose.connection.close();
  }
});

const IMPLEMENTED_AT = new Date('2026-10-01T10:00:00Z');
const CRAWLED_AFTER = new Date('2026-10-02T10:00:00Z').toISOString();
const CRAWLED_BEFORE = new Date('2026-09-30T10:00:00Z').toISOString();

function createTask(projectId, issueKey, pageUrl, origin = 'manual') {
  return Task.create({
    projectId, issueKey, pageUrl, status: 'implemented', origin, implementedAt: IMPLEMENTED_AT,
    fixHistory: [{
      attemptNumber: 1, attemptKind: 'fix_attempt', origin, status: 'pending_verification',
      before: { capturedAt: IMPLEMENTED_AT, source: 'unavailable', dataPath: null, value: null },
      fixApplied: { capturedAt: IMPLEMENTED_AT, recommendationId: null, recommendationVersion: null, snapshot: null, expectedAfterValue: null },
      implementedAt: IMPLEMENTED_AT,
      verification: { verifiedAt: null, method: null, result: null, matched: null, after: { source: 'unavailable', value: null }, triggerJobId: null },
    }],
  });
}

describe('TaskVerificationService — schema tasks are verified by inspecting the deployed markup', () => {
  let projectId;
  beforeEach(() => {
    if (!mongoAvailable) return;
    projectId = new mongoose.Types.ObjectId();
    createdProjectIds.push(projectId);
  });

  async function run(t, { issueKey, page, issueStillOpen = false, origin = 'manual' }) {
    const pageUrl = page ? page.url : `${ORIGIN}/missing-${new mongoose.Types.ObjectId()}`;
    const db = mongoose.connection.db;
    if (page) await db.collection('seo_page_data').insertOne({ projectId, ...page });
    if (issueStillOpen) await db.collection('seo_page_issues').insertOne({ projectId, issue_code: issueKey, page_url: pageUrl, status: 'open', dedup_key: `d-${new mongoose.Types.ObjectId()}` });
    const task = await createTask(projectId, issueKey, pageUrl, origin);
    const result = await taskVerificationService.verifyImplementedTasks(projectId, `SCHEMA-${issueKey}`);
    return { result, saved: await Task.findById(task._id) };
  }

  const orgPage = (over = {}) => aboutPageData({ scraped_at: CRAWLED_AFTER, structured_data: graphWithOrganization({ logo: undefined }), ...over });

  test('REGRESSION: the audit finding is gone, but the deployed page has no Organization -> reopened with the reason recorded (not verified_fixed)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { result, saved } = await run(t, { issueKey: 'organization_schema', page: orgPage({ structured_data: [{ '@type': 'WebSite', name: 'X' }] }) });
    assert.equal(result.reopened, 1);
    assert.equal(result.verified, 0);
    assert.equal(saved.status, 'reopened');
    const v = saved.fixHistory.at(-1).verification;
    assert.equal(v.result, 'reopened');
    assert.equal(v.matched, false);
    assert.equal(v.after.value.type, 'schema_inspection');
    assert.match(v.after.value.reasons.join(' '), /No Organization entity/);
  });

  test('a duplicate organization entity is reopened even though the audit finding is gone', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const dup = [...graphWithOrganization({ logo: undefined }), organization({ logo: undefined, '@id': `${ORIGIN}/#second`, '@type': 'Organization' })];
    const { saved } = await run(t, { issueKey: 'organization_schema', page: orgPage({ structured_data: dup }) });
    assert.equal(saved.status, 'reopened');
    assert.match(saved.fixHistory.at(-1).verification.after.value.reasons.join(' '), /more than once/);
  });

  test('a correct fix observed on recrawl -> verified_fixed, with the checks recorded', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { result, saved } = await run(t, { issueKey: 'organization_schema', page: orgPage() });
    assert.equal(result.verified, 1);
    assert.equal(saved.status, 'verified_fixed');
    const v = saved.fixHistory.at(-1).verification;
    assert.equal(v.method, 'value_diff');
    assert.equal(v.matched, true);
    assert.equal(v.after.value.passed, true);
    assert.ok(v.after.value.checks.some((c) => c.id === 'organization_present' && c.ok));
  });

  test('the page was not re-crawled since the fix -> the task stays pending (implemented), never verified', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { result, saved } = await run(t, { issueKey: 'organization_schema', page: orgPage({ scraped_at: CRAWLED_BEFORE }) });
    assert.equal(result.skipped, 1);
    assert.equal(result.verified, 0);
    assert.equal(saved.status, 'implemented');
    assert.equal(saved.fixHistory.at(-1).verification.result, null);
  });

  test('the page is missing from the crawl (site unavailable) -> pending, never verified', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { result, saved } = await run(t, { issueKey: 'organization_schema', page: null });
    assert.equal(result.skipped, 1);
    assert.equal(saved.status, 'implemented');
  });

  test('a declared logo that cannot be fetched (blocked destination) -> pending, not success and not failure', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const page = orgPage({ structured_data: graphWithOrganization({ logo: 'http://localhost/logo.png' }) });
    const { result, saved } = await run(t, { issueKey: 'organization_schema', page });
    assert.equal(result.skipped, 1);
    assert.equal(saved.status, 'implemented');
  });

  test('the audit finding is still open -> reopened by presence, exactly as before (the schema gate only ever blocks a would-be success)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { saved } = await run(t, { issueKey: 'organization_schema', page: orgPage(), issueStillOpen: true });
    assert.equal(saved.status, 'reopened');
    assert.equal(saved.fixHistory.at(-1).verification.method, 'presence_fallback');
  });

  test('breadcrumbs: a trail whose last item is not the page -> reopened; a correct trail -> verified', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const li = (position, name, item) => ({ '@type': 'ListItem', position, name, item });
    const trail = (items) => ({ '@type': 'BreadcrumbList', itemListElement: items });
    const bad = await run(t, { issueKey: 'breadcrumblist_schema', page: orgPage({ structured_data: [...graphWithOrganization({ logo: undefined }), trail([li(1, 'Home', HOME), li(2, 'Other', `${ORIGIN}/other/`)])] }) });
    assert.equal(bad.saved.status, 'reopened');
    const good = await run(t, { issueKey: 'breadcrumblist_schema', page: orgPage({ url: `${ORIGIN}/about-us-2`, canonical: `${ORIGIN}/about-us-2/`, structured_data: [trail([li(1, 'Home', HOME), li(2, 'About', `${ORIGIN}/about-us-2/`)])] }) });
    assert.equal(good.saved.status, 'verified_fixed');
  });

  test('article: a page with no Article markup is reopened even though the finding is gone', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const page = orgPage({ url: `${ORIGIN}/blog/five-tips`, canonical: `${ORIGIN}/blog/five-tips/`, structured_data: [], word_count: 900, meta_tags: { 'og:type': ['article'] } });
    const { saved } = await run(t, { issueKey: 'article_schema', page });
    assert.equal(saved.status, 'reopened');
  });

  test('issue types without schema inspection keep their existing verification untouched', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { result, saved } = await run(t, { issueKey: 'sameas_array', page: orgPage() });
    assert.equal(result.verified, 1);
    assert.equal(saved.status, 'verified_fixed');
    assert.equal(saved.fixHistory.at(-1).verification.method, 'presence_fallback');
  });
});

describe('breadcrumb tasks are verified against the hierarchy the OWNER confirmed', () => {
  let projectId;
  beforeEach(() => {
    if (!mongoAvailable) return;
    projectId = new mongoose.Types.ObjectId();
    createdProjectIds.push(projectId);
  });

  const li = (position, name, item) => ({ '@type': 'ListItem', position, name, item });
  const BLOG_KEY = `${ORIGIN}/blog`;
  const BLOG_CANON = `${ORIGIN}/blog/`;
  const INTENDED = [{ position: 1, name: 'Home', url: HOME }, { position: 2, name: 'Blog', url: BLOG_CANON }];

  async function run(deployedItems) {
    const db = mongoose.connection.db;
    await db.collection('seo_page_data').insertOne({
      projectId, url: BLOG_KEY, canonical: BLOG_CANON, title: 'Blog', scraped_at: CRAWLED_AFTER, meta_tags: {}, word_count: 100,
      structured_data: deployedItems ? [{ '@type': 'BreadcrumbList', itemListElement: deployedItems }] : [],
    });
    await saveUserBreadcrumbEvidence({ projectId, pageUrl: BLOG_KEY, items: INTENDED, canonicalUrl: BLOG_CANON, canonicalSource: 'canonical_tag' });
    const task = await createTask(projectId, 'breadcrumblist_schema', BLOG_KEY, 'manual');
    const result = await taskVerificationService.verifyImplementedTasks(projectId, 'BC-INTENT');
    return { result, saved: await Task.findById(task._id) };
  }

  test('generating the recommendation / saving the evidence does not by itself verify anything: no deployed trail -> reopened, never verified_fixed', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { saved } = await run(null);
    assert.equal(saved.status, 'reopened');
  });

  test('the deployed trail is exactly the confirmed one -> verified_fixed', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { result, saved } = await run([li(1, 'Home', HOME), li(2, 'Blog', BLOG_CANON)]);
    assert.equal(result.verified, 1);
    assert.equal(saved.status, 'verified_fixed');
    assert.ok(saved.fixHistory.at(-1).verification.after.value.checks.some((c) => c.id === 'breadcrumb_matches_intended' && c.ok));
  });

  test('a structurally valid trail that is NOT the confirmed hierarchy -> reopened, with expected vs found recorded', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { saved } = await run([li(1, 'Home', HOME), li(2, 'News', `${ORIGIN}/news/`), li(3, 'Blog', BLOG_CANON)]);
    assert.equal(saved.status, 'reopened');
    assert.match(saved.fixHistory.at(-1).verification.after.value.reasons.join(' '), /differs from the hierarchy you confirmed/);
  });
});

describe('canonical URL used for verification', () => {
  test('the crawl key and the canonical differ only by a slash — no false mismatch', () => {
    assert.equal(aboutPageData().canonical, ABOUT_CANONICAL);
    assert.notEqual(aboutPageData().url, ABOUT_CANONICAL);
  });
});
