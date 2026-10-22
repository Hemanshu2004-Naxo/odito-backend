import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import { buildHeadlessDocument, storeHeadlessReport } from './headlessReportService.js';
import HeadlessData from '../model/HeadlessData.js';

/**
 * Persistence of the keyboard/focus audit. The bug this pins: HeadlessData's schema
 * declared only a handful of keyboard_analysis fields (and no axe nodeDetails), so
 * Mongoose strict mode silently dropped everything else from the worker's upsert —
 * the exact elements were collected by the worker and lost before they were stored.
 *
 * Uses a REAL audit captured from https://naxonify.com/ (see __fixtures__).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(__dirname, '../../issue-context/__fixtures__/naxonify-home-keyboard-audit.json');
const audit = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

const projectId = new mongoose.Types.ObjectId();
const jobId = new mongoose.Types.ObjectId();
const URL = 'https://naxonify.com/';

let mongoAvailable = false;
before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
  } catch { mongoAvailable = false; }
});
after(async () => {
  if (mongoAvailable) {
    await mongoose.connection.db.collection('seo_headless_data').deleteMany({ projectId });
    await mongoose.connection.close();
  }
});

const workerResult = () => ({
  url: URL, render_status: 'success', statusCode: 200,
  axeViolations: [{
    id: 'color-contrast', impact: 'serious', description: 'x', helpUrl: 'https://dequeuniversity.com/x', nodes: 46, tags: ['wcag2aa'],
    nodeDetails: [
      { target: ['.et_pb_button_0'], html: '<a class="et_pb_button_0">Book</a>' },
      { target: ['#menu-main-menu > li:nth-of-type(1) > a'], html: '<a href="/">Home</a>' },
    ],
  }],
  axeViolationCount: 1, axePassedCount: 10, domMetrics: { totalElements: 100 },
  keyboard_analysis: audit, scannedAt: new Date().toISOString(),
});

describe('the fixture is a real v2 audit', () => {
  test('carries the exact elements, not just counters', () => {
    assert.equal(audit.audit_version, 2);
    assert.equal(audit.affected_elements.missing_focus_indicator.length, audit.missing_focus_outline);
    assert.ok(audit.affected_elements.missing_focus_indicator[0].selector);
    assert.ok(audit.affected_elements.missing_focus_indicator[0].accessibleName);
  });
});

describe('HeadlessData schema declares every field the v2 worker sends', () => {
  const paths = HeadlessData.schema.path.bind(HeadlessData.schema);
  test('keyboard_analysis v2 fields exist as schema paths (else strict mode drops them)', () => {
    for (const field of [
      'audit_version', 'audit_method', 'tested_at', 'focusable_total', 'focusable_visible', 'tab_stops_visited', 'traversal',
      'affected_elements', 'element_results', 'focus_sequence', 'trap_details', 'technology', 'small_click_targets_list',
      'detected_focusable_elements', 'css_rules_unavailable', 'transitions_disabled_for_audit',
    ]) {
      assert.ok(paths(`keyboard_analysis.${field}`), `keyboard_analysis.${field} is not in the schema`);
    }
  });

  test('every top-level key of a real audit result is either declared or deliberately a legacy key', () => {
    const undeclared = Object.keys(audit).filter((k) => !paths(`keyboard_analysis.${k}`));
    assert.deepEqual(undeclared, [], `undeclared keyboard_analysis keys would be silently dropped: ${undeclared}`);
  });

  test('axe nodeDetails is declared', () => {
    assert.ok(HeadlessData.schema.path('axeViolations').schema.path('nodeDetails'));
  });
});

describe('storeHeadlessReport — the production write path keeps the elements', () => {
  test('buildHeadlessDocument passes keyboard_analysis and axe details through unchanged', () => {
    const doc = buildHeadlessDocument(projectId, jobId, workerResult());
    assert.equal(doc.keyboard_analysis, audit);
    assert.equal(doc.axeViolations[0].nodeDetails.length, 2);
  });

  test('real audit -> upsert -> raw read-back has all 40 elements, the sequence, the technology and the trap analysis', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    await storeHeadlessReport({ projectId, seo_jobId: jobId, results: [workerResult()] });
    const stored = await mongoose.connection.db.collection('seo_headless_data').findOne({ projectId, url: URL });
    const k = stored.keyboard_analysis;

    assert.equal(k.audit_version, 2);
    assert.equal(k.affected_elements.missing_focus_indicator.length, 40);
    assert.equal(k.affected_elements.missing_focus_indicator_total, 40);
    assert.equal(k.element_results.length, 44);
    assert.equal(k.focus_sequence.length, audit.focus_sequence.length);
    assert.equal(k.trap_details.verdict, 'none');
    assert.equal(k.technology.builder, 'Divi');
    assert.equal(k.technology.theme, 'divi-child');
    assert.equal(k.traversal.completed, true);
    assert.equal(k.small_click_targets_list.length, audit.small_click_targets_list.length);
    assert.equal(k.detected_focusable_elements, 79);

    const first = k.affected_elements.missing_focus_indicator[0];
    assert.equal(first.selector, audit.affected_elements.missing_focus_indicator[0].selector);
    assert.equal(first.focusIndicator.status, 'missing');
    assert.equal(first.focusIndicator.suppressingRule.stylesheet, 'inline <style>');

    assert.equal(stored.axeViolations[0].nodeDetails.length, 2, 'axe node selectors survive too');
    assert.deepEqual(stored.axeViolations[0].nodeDetails[0].target, ['.et_pb_button_0']);
  });

  test('re-storing the same (project, url) updates in place — one document per page', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await storeHeadlessReport({ projectId, seo_jobId: jobId, results: [workerResult()] });
    assert.equal(await mongoose.connection.db.collection('seo_headless_data').countDocuments({ projectId, url: URL }), 1);
  });

  test('a v1-shaped result (counters only) still stores', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const legacyUrl = 'https://naxonify.com/legacy';
    await storeHeadlessReport({
      projectId, seo_jobId: jobId,
      results: [{ url: legacyUrl, render_status: 'success', keyboard_analysis: { keyboard_navigation_checked: true, focus_trap_detected: false, missing_focus_outline: 3, total_tab_presses: 10, focus_order: [{ tag: 'a', id: '', selector: 'a' }] } }],
    });
    const stored = await mongoose.connection.db.collection('seo_headless_data').findOne({ projectId, url: legacyUrl });
    assert.equal(stored.keyboard_analysis.missing_focus_outline, 3);
    assert.equal(stored.keyboard_analysis.audit_version, undefined);
  });
});
