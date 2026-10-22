import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import IssueContextEngine from './IssueContextEngine.js';
import { storeHeadlessReport } from '../../jobs/service/headlessReportService.js';

/**
 * The screenshot bug: /app/accessibility?issue=form_labels showed
 *   "Not detected — No form_labels was found on this page"
 *   "Expected: Unknown issue type"
 *   "Some context signals are missing: issueId not in registry"
 * for a page where the analyzer HAD found a form-label problem. Real Mongo; real axe data
 * captured from naxonify.com. Auto-skips without Mongo.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fx = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, '../__fixtures__', name), 'utf8'));
const live = fx('naxonify-form-label-live.json');
const stored = fx('naxonify-form-label-violations.json');

const projectId = new mongoose.Types.ObjectId();
const jobId = new mongoose.Types.ObjectId();
const HOME = 'https://naxonify.com/';
const BLOG = 'https://naxonify.com/blog/ai-visibility/chatgpt-seo';

let mongoAvailable = false;
before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
  } catch { mongoAvailable = false; }
});
after(async () => {
  if (!mongoAvailable) return;
  for (const c of ['seo_headless_data', 'seo_page_data', 'seo_page_issues']) await mongoose.connection.db.collection(c).deleteMany({ projectId });
  await mongoose.connection.close();
});

const db = () => mongoose.connection.db;
const store = (url, axeViolations) => storeHeadlessReport({ projectId, seo_jobId: jobId, results: [{ url, render_status: 'success', statusCode: 200, axeViolations, keyboard_analysis: null }] });
const resolve = (issueId, url) => IssueContextEngine.resolve(projectId.toString(), issueId, url);

describe('form_labels through IssueContextEngine', () => {
  test('is a known issue: no "Unknown issue type", no "issueId not in registry"', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await db().collection('seo_page_data').insertOne({ projectId, url: HOME });
    await store(HOME, live[HOME]);
    const ctx = await resolve('form_labels', HOME);

    assert.equal(ctx.identity.issueType, 'on_page');
    assert.notEqual(ctx.expectedState.description, 'Unknown issue type');
    assert.doesNotMatch(JSON.stringify(ctx.metadata.missingSignals), /not in registry/);
    assert.match(ctx.expectedState.description, /label/i);
  });

  test('REAL homepage: shows the exact select that has no accessible name (not "Not detected")', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const ctx = await resolve('form_labels', HOME);
    assert.equal(ctx.currentState.displayType, 'table');
    assert.equal(ctx.currentState.isAbsent, false);
    assert.equal(ctx.currentState.affectedItems[0]['Input Element'], '#et_pb_contact_budget_range_0');
    assert.equal(ctx.formLabelAudit.detailsCaptured, true);
  });

  test('REAL blog page: the comment form\'s inputs', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await store(BLOG, live[BLOG]);
    const ctx = await resolve('form_labels', BLOG);
    assert.ok(ctx.currentState.affectedItems.length >= 3);
    assert.ok(ctx.currentState.affectedItems.some((r) => r['Input Element'] === '#comment'));
  });

  test('the legacy scan actually stored today (counts only) is reported honestly, not as "Not detected"', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const legacyUrl = 'https://naxonify.com/legacy-scan';
    await store(legacyUrl, stored.home.label.map(({ hasNodeDetails, ...v }) => v));
    const ctx = await resolve('form_labels', legacyUrl);
    assert.equal(ctx.currentState.isAbsent, false);
    assert.match(ctx.currentState.affectedItems[0]['Input Element'], /exact elements not captured/);
    assert.equal(ctx.formLabelAudit.detailsCaptured, false);
  });

  test('the old registered name resolves the same page identically', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const a = await resolve('form_inputs_labels', HOME);
    const b = await resolve('form_labels', HOME);
    assert.deepEqual(a.currentState.affectedItems, b.currentState.affectedItems);
  });
});

describe('an unregistered issue shows what was actually stored', () => {
  test('about_page (no resolver yet): the stored finding, not a red "Not detected"', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await db().collection('seo_page_issues').insertOne({
      projectId, issue_code: 'about_page', page_url: HOME, category: 'EEAT', severity: 'high', dedup_key: `orphan-${projectId}`,
      issue_message: 'About page is too thin: 120 words', detected_value: 'Word count: 120', expected_value: 'A detailed About page of at least 500 words',
    });
    const ctx = await resolve('about_page', HOME);

    assert.equal(ctx.currentState.isAbsent, false);
    assert.equal(ctx.currentState.displayType, 'list');
    assert.deepEqual(ctx.currentState.affectedItems, ['About page is too thin: 120 words', 'Word count: 120']);
    assert.equal(ctx.expectedState.description, 'A detailed About page of at least 500 words');
    assert.equal(ctx.identity.category, 'EEAT');
    assert.match(ctx.metadata.warnings[0], /No detailed resolver exists for this issue type yet/);
    assert.equal(ctx.recommendationReady, false);
  });

  test('a genuinely unknown id with nothing stored keeps the plain absent state, without throwing', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const ctx = await resolve('totally_made_up_issue', HOME);
    assert.equal(ctx.currentState.isAbsent, true);
    assert.equal(ctx.identity.issueType, 'unknown');
  });

  test('a page-level read failure never breaks the response', async () => {
    const ctx = await IssueContextEngine._unknownContext('not-an-object-id', 'x', HOME, Date.now());
    assert.equal(ctx.currentState.isAbsent, true);
  });
});
