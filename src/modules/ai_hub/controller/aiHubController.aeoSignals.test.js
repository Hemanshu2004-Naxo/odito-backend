import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import { getAEOHubData } from './aiHubController.js';

// Regression coverage for the AEO "Answer Readiness Center" score-inflation
// bug: buildSignal() used to divide pages_failing by `pagesScored` (every
// page on the project), but several signal rules (AEO-046/047/048/055) are
// page-type-gated (page_type_matrix.py) and never even run on most page
// types — those pages get no `ai_issues` document at all, so the old
// formula silently counted them as "passing". Confirmed on a real project:
// FAQ Schema (AEO-048) genuinely failed on 6/6 of the pages it applies to
// (100% fail — the whole site's FAQ schema has zero matching visible
// content) while the dashboard showed "78% pass" because 21/27 pages were
// the wrong type for the rule and got folded into the denominator as if
// they'd passed.
//
// The fix reads `ai_scores.hubs.aeo.cards.*.rules.<rule_id>.result`
// (PASS/FAIL/SKIPPED), written by the same Python registry.evaluate_page()
// call that produces ai_issues — so it can't disagree with Python's own
// applicability determination the way an independent Node-side page-type
// reimplementation could (that was the GEO-S1..S5 bug).

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

function mockRes() {
  const res = { body: null };
  res.status = () => res;
  res.json = (b) => { res.body = b; return res; };
  return res;
}

function aeoScoreDoc({ projectId, url, rules }) {
  // `rules` is { rule_id: 'PASS' | 'FAIL' | 'SKIPPED' }. Every rule here is
  // placed under a single synthetic card — buildSignal() scans all cards'
  // `rules` blocks for a matching rule_id, so the card name doesn't matter
  // for this test.
  const ruleBlocks = {};
  for (const [ruleId, result] of Object.entries(rules)) {
    ruleBlocks[ruleId] = { result, evidence: {} };
  }
  return {
    project_id: projectId,
    url,
    version: 'v2',
    hubs: { aeo: { score: 0, cards: { test_card: { score: 0, passed: 0, total: 0, skipped: 0, rules: ruleBlocks } } } },
  };
}

describe('getAEOHubData — Answer Readiness signal scores use the correct (applicable-page) denominator', () => {
  let projectId, jobId;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    projectId = new mongoose.Types.ObjectId();
    jobId = new mongoose.Types.ObjectId();
    const db = mongoose.connection.db;
    await Promise.all([
      db.collection('ai_projects').deleteMany({ project_id: projectId }),
      db.collection('ai_scores').deleteMany({ project_id: projectId }),
      db.collection('ai_issues').deleteMany({ project_id: projectId }),
      db.collection('ai_pages').deleteMany({ project_id: projectId }),
    ]);
  });

  test('a rule SKIPPED on most pages scores against applicable pages only, not every page (the core bug)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const db = mongoose.connection.db;

    await db.collection('ai_projects').insertOne({
      project_id: projectId, job_id: jobId, computed_at: new Date(), pages_scored: 10,
      hubs: { aeo: { score: 0, cards: {} } },
    });

    // 10 pages total. AEO-048 is SKIPPED on 7 (wrong page type) and FAILS on
    // all 3 pages it actually applies to. Old formula: (10-3)/10 = 70% pass.
    // Correct formula: (3 applicable - 3 failing)/3 applicable = 0% pass.
    const docs = [];
    for (let i = 0; i < 7; i++) docs.push(aeoScoreDoc({ projectId, url: `https://x.com/skip-${i}`, rules: { 'AEO-048': 'SKIPPED' } }));
    for (let i = 0; i < 3; i++) docs.push(aeoScoreDoc({ projectId, url: `https://x.com/fail-${i}`, rules: { 'AEO-048': 'FAIL' } }));
    await db.collection('ai_scores').insertMany(docs);
    await db.collection('ai_pages').insertMany([{ project_id: projectId, job_id: jobId, url: 'https://x.com/1' }]);

    const res = mockRes();
    await getAEOHubData({ params: { projectId: projectId.toString() } }, res);

    const faqSignal = res.body.data.signals.faq_schema;
    assert.equal(faqSignal.applicable_pages, 3, 'must count only the non-SKIPPED pages');
    assert.equal(faqSignal.pages_failing, 3);
    assert.equal(faqSignal.score, 0, 'must NOT be 70% — that used total pages (10) as the denominator');
    assert.equal(faqSignal.status, 'fail');
  });

  test('FAQ schema present with matching visible content passes and counts correctly', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const db = mongoose.connection.db;

    await db.collection('ai_projects').insertOne({
      project_id: projectId, job_id: jobId, computed_at: new Date(), pages_scored: 4,
      hubs: { aeo: { score: 0, cards: {} } },
    });
    const docs = [
      aeoScoreDoc({ projectId, url: 'https://x.com/pass-1', rules: { 'AEO-048': 'PASS' } }),
      aeoScoreDoc({ projectId, url: 'https://x.com/pass-2', rules: { 'AEO-048': 'PASS' } }),
      aeoScoreDoc({ projectId, url: 'https://x.com/skip-1', rules: { 'AEO-048': 'SKIPPED' } }),
      aeoScoreDoc({ projectId, url: 'https://x.com/skip-2', rules: { 'AEO-048': 'SKIPPED' } }),
    ];
    await db.collection('ai_scores').insertMany(docs);
    await db.collection('ai_pages').insertMany([{ project_id: projectId, job_id: jobId, url: 'https://x.com/1' }]);

    const res = mockRes();
    await getAEOHubData({ params: { projectId: projectId.toString() } }, res);

    const faqSignal = res.body.data.signals.faq_schema;
    assert.equal(faqSignal.applicable_pages, 2);
    assert.equal(faqSignal.pages_failing, 0);
    assert.equal(faqSignal.score, 100);
    assert.equal(faqSignal.status, 'pass');
  });

  test('zero applicable pages reports an explicit not_applicable status, never a fake 0%', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const db = mongoose.connection.db;

    await db.collection('ai_projects').insertOne({
      project_id: projectId, job_id: jobId, computed_at: new Date(), pages_scored: 3,
      hubs: { aeo: { score: 0, cards: {} } },
    });
    const docs = [0, 1, 2].map(i => aeoScoreDoc({ projectId, url: `https://x.com/${i}`, rules: { 'AEO-048': 'SKIPPED' } }));
    await db.collection('ai_scores').insertMany(docs);
    await db.collection('ai_pages').insertMany([{ project_id: projectId, job_id: jobId, url: 'https://x.com/1' }]);

    const res = mockRes();
    await getAEOHubData({ params: { projectId: projectId.toString() } }, res);

    const faqSignal = res.body.data.signals.faq_schema;
    assert.equal(faqSignal.applicable_pages, 0);
    assert.equal(faqSignal.status, 'not_applicable', 'must be distinguishable from a genuine 0% fail — see AnswerReadinessCenter.jsx');
  });

  test('no audit data for the project returns an explicit empty state, not zeros', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const res = mockRes();
    await getAEOHubData({ params: { projectId: new mongoose.Types.ObjectId().toString() } }, res);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data, null, 'a project with no ai_projects doc must return data:null, not a zeroed-out score');
  });
});
