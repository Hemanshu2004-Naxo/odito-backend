import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SeoRankingCurrent from '../modules/app_user/model/SeoRankingCurrent.js';
import KeywordRankingHistory from '../modules/app_user/model/KeywordRankingHistory.js';
import { saveCanonicalRanking, mergeSingleKeywordRescan, addKeyword, deriveKeywordStatus } from './rankingHistoryService.js';

/**
 * Regression coverage for the "organic scan_error must not overwrite a
 * known rank with null" fix (wowinfotech.com / "best software company near
 * me" investigation). Root cause: DataForSeoService.post() only validated
 * the outer envelope's status_code, so a task-level failure (DataForSEO
 * account-pause, code 40201, tasks[0].result: null) was silently treated as
 * "the keyword genuinely has zero organic matches". buildKeywordUpdate now
 * receives an explicit scan_error signal (set by processKeyword in
 * seoOnboardingController.js only on a real request/parse failure, never on
 * a successful-but-empty result) and, when present, preserves every
 * rank-derived field from the existing document instead of deriving
 * current_rank from an empty ranking_urls array.
 *
 * Real MongoDB, real documents — same convention as
 * googleAccountConnectionService.test.js / onPageIssuesService.test.js —
 * auto-skip if unreachable.
 *
 * Run from odito_backend/:
 *   node --test src/services/rankingHistoryService.test.js
 */

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

describe('rankingHistoryService — scan_error preserves prior rank state', () => {
  let projectId, userId;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    projectId = new mongoose.Types.ObjectId();
    userId    = new mongoose.Types.ObjectId();
    await SeoRankingCurrent.deleteMany({ project_id: projectId });
    await KeywordRankingHistory.deleteMany({ project_id: projectId });
  });

  test('a failed rescan (scan_error set) does not overwrite an existing rank with null', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    // Seed a canonical doc as if a prior scan had genuinely found rank 15.
    await saveCanonicalRanking({
      projectId, userId,
      domain: 'https://www.example.com/',
      location: 'Nashik, Maharashtra, India',
      locationCode: 9040235,
      country: 'IN',
      language: 'en',
      seoScope: 'local',
      keywords: [{
        keyword: 'best software company near me',
        ranking_urls: [{ rank: 15, url: 'https://www.example.com/', type: 'homepage' }],
        maps_rank: 18,
        maps_listing: { title: 'Example Co', rating: 4.8, reviews: 195, address: 'Nashik' },
      }],
      scanSource: 'onboarding',
    });

    // A subsequent scan whose organic request/parse failed outright.
    const updated = await mergeSingleKeywordRescan({
      projectId, userId,
      domain: 'https://www.example.com/',
      keywordResult: {
        keyword: 'best software company near me',
        ranking_urls: [],
        maps_rank: 18,
        maps_listing: { title: 'Example Co', rating: 4.8, reviews: 195, address: 'Nashik' },
        scan_error: 'DataForSEO task error: unusual activity, account paused (code 40201)',
      },
      scanSource: 'manual_rescan',
    });

    const kw = updated.keywords.find(k => k.keyword === 'best software company near me');
    assert.equal(kw.current_rank, 15, 'current_rank must stay at its last known-good value');
    assert.equal(kw.best_rank, 15);
    assert.equal(kw.ranking_urls.length, 1, 'ranking_urls must be preserved, not cleared');
    assert.equal(kw.maps_rank, 18, 'maps_rank is independent of the organic scan_error');
    assert.equal(kw.last_scan_status, 'error');
    // Sanitized, customer-safe copy — never the raw vendor message. This
    // field is returned verbatim by getProjectRankings/rescanKeyword's JSON
    // responses, so it must never name DataForSEO, a support email, or an
    // internal account-status detail.
    assert.doesNotMatch(kw.last_scan_error, /unusual activity|dataforseo|support@/i);
    assert.match(kw.last_scan_error, /temporarily unavailable/i);
    assert.equal(deriveKeywordStatus(kw), 'scan_error', 'Section E: explicit status must reflect the scan failure, not the stale rank');
  });

  test('a scan_error on a keyword\'s very first scan leaves current_rank null but flags last_scan_status=error (not a confirmed "not ranked")', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const updated = await saveCanonicalRanking({
      projectId, userId,
      domain: 'https://www.example.com/',
      location: 'Nashik, Maharashtra, India',
      locationCode: 9040235,
      country: 'IN',
      language: 'en',
      seoScope: 'local',
      keywords: [{
        keyword: 'best software company near me',
        ranking_urls: [],
        maps_rank: 18,
        maps_listing: null,
        scan_error: 'DataForSEO task error: unusual activity, account paused (code 40201)',
      }],
      scanSource: 'onboarding',
    });

    const kw = updated.keywords.find(k => k.keyword === 'best software company near me');
    assert.equal(kw.current_rank, null, 'nothing to preserve on a first scan — stays null');
    assert.equal(kw.maps_rank, 18, 'maps_rank from this same run is still recorded');
    assert.equal(kw.last_scan_status, 'error', 'the null above must be distinguishable from a genuine "not ranked"');
  });

  test('a successful scan after a prior error clears last_scan_status/last_scan_error', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    await saveCanonicalRanking({
      projectId, userId,
      domain: 'https://www.example.com/',
      location: 'Nashik, Maharashtra, India',
      locationCode: 9040235,
      country: 'IN',
      language: 'en',
      seoScope: 'local',
      keywords: [{
        keyword: 'best software company near me',
        ranking_urls: [],
        maps_rank: null,
        maps_listing: null,
        scan_error: 'DataForSEO task error: unusual activity, account paused (code 40201)',
      }],
      scanSource: 'onboarding',
    });

    const updated = await mergeSingleKeywordRescan({
      projectId, userId,
      domain: 'https://www.example.com/',
      keywordResult: {
        keyword: 'best software company near me',
        ranking_urls: [{ rank: 12, url: 'https://www.example.com/services', type: 'internal_page' }],
        maps_rank: 18,
        maps_listing: null,
      },
      scanSource: 'manual_rescan',
    });

    const kw = updated.keywords.find(k => k.keyword === 'best software company near me');
    assert.equal(kw.current_rank, 12);
    assert.equal(kw.last_scan_status, 'ok');
    assert.equal(kw.last_scan_error, null);
  });

  test('a genuinely-not-found scan (no scan_error, empty ranking_urls) still correctly sets current_rank to null and status to ok', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const updated = await saveCanonicalRanking({
      projectId, userId,
      domain: 'https://www.example.com/',
      location: 'Nashik, Maharashtra, India',
      locationCode: 9040235,
      country: 'IN',
      language: 'en',
      seoScope: 'local',
      keywords: [{
        keyword: 'best software company near me',
        ranking_urls: [],
        maps_rank: null,
        maps_listing: null,
        // No scan_error — the request genuinely succeeded and found nothing.
      }],
      scanSource: 'onboarding',
    });

    const kw = updated.keywords.find(k => k.keyword === 'best software company near me');
    assert.equal(kw.current_rank, null);
    assert.equal(kw.last_scan_status, 'ok', 'a real "not found" result is NOT a scan error');
    assert.equal(deriveKeywordStatus(kw), 'not_ranked', 'distinct from scan_error — a real scan found nothing, not "we don\'t know"');
  });
});

describe('rankingHistoryService — deriveKeywordStatus (Section E explicit response status)', () => {
  test('ranked: current_rank present', () => {
    assert.equal(deriveKeywordStatus({ current_rank: 5, last_scan_status: 'ok' }), 'ranked');
  });
  test('not_ranked: successful scan, no match', () => {
    assert.equal(deriveKeywordStatus({ current_rank: null, last_scan_status: 'ok' }), 'not_ranked');
  });
  test('scan_error: takes priority over current_rank even if a stale rank is present', () => {
    assert.equal(deriveKeywordStatus({ current_rank: 15, last_scan_status: 'error' }), 'scan_error');
  });
  test('scan_error: also correct when there is no stale rank to preserve (first-ever scan failed)', () => {
    assert.equal(deriveKeywordStatus({ current_rank: null, last_scan_status: 'error' }), 'scan_error');
  });
  test('null input returns null rather than throwing', () => {
    assert.equal(deriveKeywordStatus(null), null);
    assert.equal(deriveKeywordStatus(undefined), null);
  });
});

describe('rankingHistoryService — addKeyword() with a failing initial scan (Add Keyword flow, Task C)', () => {
  let projectId, userId;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    projectId = new mongoose.Types.ObjectId();
    userId    = new mongoose.Types.ObjectId();
    await SeoRankingCurrent.deleteMany({ project_id: projectId });
    await KeywordRankingHistory.deleteMany({ project_id: projectId });
    // addKeyword() requires a pre-existing canonical doc for the project
    // (matches addKeywordController's own real-world precondition — the
    // project must have gone through onboarding first).
    await SeoRankingCurrent.create({
      project_id: projectId, user_id: userId,
      domain: 'https://www.example.com/', location: 'Nashik, Maharashtra, India',
      location_code: 9040235, country: 'IN', language: 'en', seo_scope: 'local',
      keywords: [],
    });
  });

  test('a keyword whose initial scan fails is still added (not dropped, not silently rejected) and marked scan_error', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const updated = await addKeyword({
      projectId, userId,
      domain: 'https://www.example.com/',
      keywordResult: {
        keyword: 'best software company near me',
        ranking_urls: [],
        maps_rank: 18,
        maps_listing: { title: 'Example Co', rating: 4.8, reviews: 195, address: 'Nashik' },
        scan_error: 'DataForSEO task error: unusual activity, account paused (code 40201)',
      },
      planId: 'starter',
    });

    assert.equal(updated.keywords.length, 1, 'the keyword must be added, not dropped, on a scan failure');
    const kw = updated.keywords[0];
    assert.equal(kw.keyword, 'best software company near me');
    assert.equal(kw.current_rank, null, 'nothing to preserve on a brand-new keyword\'s first scan');
    assert.equal(kw.maps_rank, 18, 'maps_rank from this same run is still recorded');
    assert.equal(kw.last_scan_status, 'error');
    assert.equal(deriveKeywordStatus(kw), 'scan_error', 'the row must render "Scan Error", never "Not ranked"');
  });
});
