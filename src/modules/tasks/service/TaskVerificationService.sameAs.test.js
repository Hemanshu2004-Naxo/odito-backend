import { describe, test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import taskVerificationService from './TaskVerificationService.js';
import taskHistoryService from './TaskHistoryService.js';
import Recommendation from '../../recommendations/model/Recommendation.js';
import Task from '../model/Task.js';

/**
 * How a sameAs fix is confirmed: the crawler's copy of the page must show the
 * URLs the site owner added in the RENDERED Organization JSON-LD. Pure logic —
 * no Mongo (the Mongo-backed end-to-end cases live in TaskVerificationService.test.js).
 */

const LI = 'https://www.linkedin.com/company/naxonify';
const YT = 'https://www.youtube.com/@naxonify';
const FB = 'https://www.facebook.com/naxonify';

const expected = (urls) => ({ type: 'same_as', urls });
const rendered = (structured_data) => taskVerificationService._resolveAfterValue({ structured_data }, 'same_as');
const matches = (exp, structured_data) => taskVerificationService._valuesMatch(exp, rendered(structured_data));

describe('_resolveAfterValue(same_as) — reading the rendered Organization JSON-LD', () => {
  test('18. a top-level Organization node', () => {
    assert.deepEqual(rendered([{ '@type': 'Organization', sameAs: [FB, LI] }]).sameAs, [FB, LI]);
  });

  test('18. Rank Math\'s real shape: the Organization lives inside "@graph"', () => {
    const graph = [{
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'WebSite', '@id': 'https://naxonify.com/#website' },
        { '@type': 'Organization', '@id': 'https://naxonify.com/#organization', name: 'Naxonify', sameAs: [FB, LI] },
        { '@type': 'WebPage', '@id': 'https://naxonify.com/contact-us/#webpage' },
      ],
    }];
    assert.deepEqual(rendered(graph).sameAs, [FB, LI]);
  });

  test('18. @graph as the top-level object (not wrapped in an array)', () => {
    assert.deepEqual(rendered({ '@graph': [{ '@type': 'Organization', sameAs: [LI] }] }).sameAs, [LI]);
  });

  test('a multi-typed node (["Organization","LocalBusiness"]) and a single-string sameAs are both understood', () => {
    assert.deepEqual(rendered([{ '@type': ['Organization', 'LocalBusiness'], sameAs: LI }]).sameAs, [LI]);
  });

  test('the sameAs of every Organization/LocalBusiness node is combined', () => {
    const data = [{ '@type': 'Organization', sameAs: [LI] }, { '@type': 'LocalBusiness', sameAs: [YT] }];
    assert.deepEqual(rendered(data).sameAs, [LI, YT]);
  });

  test('a Person or WebSite node\'s sameAs is NOT mistaken for the organization\'s', () => {
    assert.deepEqual(rendered([{ '@type': 'Person', sameAs: [LI] }, { '@type': 'WebSite', sameAs: [YT] }]).sameAs, []);
  });

  test('no structured data / no Organization -> an empty list, never a throw', () => {
    for (const data of [undefined, null, [], {}, 'nonsense', [{ '@type': 'WebSite' }]]) {
      assert.deepEqual(rendered(data).sameAs, []);
    }
  });
});

describe('_valuesMatch(same_as) — "verified" only if every URL the owner added is rendered', () => {
  const org = (sameAs) => [{ '@graph': [{ '@type': 'Organization', sameAs }] }];

  test('18. one added URL present in the rendered schema', () => {
    assert.equal(matches(expected([LI]), org([FB, LI])), true);
  });

  test('18. several added URLs — ALL must be present', () => {
    assert.equal(matches(expected([LI, YT]), org([LI, YT])), true);
    assert.equal(matches(expected([LI, YT]), org([LI])), false, 'one missing -> not verified');
  });

  test('18. the URL is absent from the rendered output (WordPress saved it but the theme/plugin does not print it) -> NOT verified', () => {
    assert.equal(matches(expected([LI]), org([FB])), false);
    assert.equal(matches(expected([LI]), org([])), false);
    assert.equal(matches(expected([LI]), [{ '@type': 'WebSite' }]), false);
    assert.equal(matches(expected([LI]), undefined), false);
  });

  test('extra profiles the owner added elsewhere do not cause a false reopen (membership, not equality)', () => {
    assert.equal(matches(expected([LI]), org([FB, YT, LI, 'https://x.com/other'])), true);
  });

  test('a trailing slash or http/https difference introduced on the way to the page does not cause a false reopen', () => {
    assert.equal(matches(expected([LI]), org(['http://www.linkedin.com/company/naxonify/'])), true);
  });

  test('a different profile path is not accepted as a match', () => {
    assert.equal(matches(expected([LI]), org(['https://www.linkedin.com/company/other'])), false);
  });

  test('junk entries in the rendered sameAs are ignored, not fatal', () => {
    assert.equal(matches(expected([LI]), org([null, 42, '', 'javascript:x', LI])), true);
  });

  test('an empty expectation never verifies (nothing was asked for)', () => {
    assert.equal(matches(expected([]), org([LI])), false);
    assert.equal(matches({ type: 'same_as' }, org([LI])), false);
  });

  test('legacy attempts recorded with a single `url` still verify', () => {
    assert.equal(matches({ type: 'same_as', url: LI }, org([LI])), true);
    assert.equal(matches({ type: 'same_as', url: LI }, org([FB])), false);
  });
});

describe('TaskHistoryService — the frozen after-state carries the owner\'s URLs', () => {
  beforeEach(() => mock.restoreAll());

  test('expectedAfterValueOverride replaces the recommendation-derived value ("not provided in context" yields none)', async () => {
    // A recommendation for sameas_array that supplied no URL — what the AI is told to say.
    mock.method(Recommendation, 'findById', () => ({
      lean: async () => ({ _id: 'rec-1', sections: { recommendedVersion: 'not provided in context — the site owner must supply their own real, verified social profile URLs before this field can be populated' } }),
    }));

    const without = await taskHistoryService.buildFixAttempt({ projectId: 'p', issueKey: 'sameas_array', pageUrl: 'https://naxonify.com/', origin: 'wordpress_auto', recommendationId: 'rec-1', attemptNumber: 1 });
    assert.equal(without.fixApplied.expectedAfterValue, null, 'the recommendation alone can never produce a value to verify');

    const override = { type: 'same_as', urls: [LI], additionalProfiles: [YT, LI] };
    const withOverride = await taskHistoryService.buildFixAttempt({ projectId: 'p', issueKey: 'sameas_array', pageUrl: 'https://naxonify.com/', origin: 'wordpress_auto', recommendationId: 'rec-1', attemptNumber: 1, expectedAfterValueOverride: override });
    assert.deepEqual(withOverride.fixApplied.expectedAfterValue, override);
    assert.equal(withOverride.status, 'pending_verification');
  });

  test('applyImplementedTransition passes the override and externalWrite through onto the fixHistory entry', async () => {
    mock.method(Recommendation, 'findById', () => ({ lean: async () => ({ _id: 'rec-1', sections: {} }) }));
    const task = { projectId: 'p', issueKey: 'sameas_array', pageUrl: 'https://naxonify.com/', fixHistory: [] };
    const externalWrite = { system: 'wordpress', provider: 'rank_math', field: 'same_as', scope: 'site', profilesBefore: [], profilesAfter: [LI] };

    await taskHistoryService.applyImplementedTransition(task, {
      origin: 'wordpress_auto', recommendationId: 'rec-1', externalWrite,
      expectedAfterValueOverride: { type: 'same_as', urls: [LI], additionalProfiles: [LI] },
    });

    assert.equal(task.status, 'implemented');
    const attempt = task.fixHistory[0];
    assert.deepEqual(attempt.fixApplied.expectedAfterValue.urls, [LI]);
    assert.deepEqual(attempt.fixApplied.externalWrite, externalWrite);
    assert.equal(attempt.origin, 'wordpress_auto');
  });

  test('without an override, every other fix type still derives its value from the recommendation (unchanged)', async () => {
    mock.method(Recommendation, 'findById', () => ({ lean: async () => ({ _id: 'rec-1', sections: { recommendedVersion: 'A better title' } }) }));
    const attempt = await taskHistoryService.buildFixAttempt({ projectId: 'p', issueKey: 'title_too_short', pageUrl: 'https://naxonify.com/', origin: 'wordpress_auto', recommendationId: 'rec-1', attemptNumber: 1 });
    assert.deepEqual(attempt.fixApplied.expectedAfterValue, { type: 'title', title: 'A better title' });
  });
});


// ── End to end through verifyImplementedTasks (live Mongo, auto-skips) ─────────

let mongoAvailable = false;
const createdProjectIds = [];

before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
  } catch {
    mongoAvailable = false;
  }
});

after(async () => {
  if (!mongoAvailable) return;
  await Task.deleteMany({ projectId: { $in: createdProjectIds } });
  await mongoose.connection.db.collection('seo_page_data').deleteMany({ projectId: { $in: createdProjectIds } });
  await mongoose.connection.db.collection('seo_page_issues').deleteMany({ projectId: { $in: createdProjectIds } });
  await mongoose.connection.close();
});

describe('verifyImplementedTasks — a WordPress-applied sameAs fix is verified from the rendered Organization JSON-LD', () => {
  let projectId;
  beforeEach(() => {
    projectId = new mongoose.Types.ObjectId();
    createdProjectIds.push(projectId);
  });

  async function setup({ urls, rendered, issueStillOpen = false }) {
    const pageUrl = `https://naxonify.com/sameas-${new mongoose.Types.ObjectId()}`;
    await mongoose.connection.db.collection('seo_page_data').insertOne({
      projectId, url: pageUrl,
      structured_data: [{ '@context': 'https://schema.org', '@graph': [{ '@type': 'WebSite' }, { '@type': 'Organization', name: 'Naxonify', sameAs: rendered }] }],
    });
    if (issueStillOpen) {
      await mongoose.connection.db.collection('seo_page_issues').insertOne({
        projectId, issue_code: 'sameas_array', page_url: pageUrl, status: 'open', dedup_key: `dedup-${projectId}-${pageUrl}`,
      });
    }
    const task = await Task.create({
      projectId, issueKey: 'sameas_array', pageUrl, status: 'implemented', origin: 'wordpress_auto',
      fixHistory: [{
        attemptNumber: 1, attemptKind: 'fix_attempt', origin: 'wordpress_auto', status: 'pending_verification',
        before: { capturedAt: new Date(), source: 'unavailable', dataPath: null, value: null },
        fixApplied: {
          capturedAt: new Date(), recommendationId: null, recommendationVersion: null, snapshot: null,
          expectedAfterValue: { type: 'same_as', urls, additionalProfiles: urls },
          externalWrite: { system: 'wordpress', provider: 'rank_math', field: 'same_as', scope: 'site', profilesBefore: [], profilesAfter: urls },
        },
        implementedAt: new Date(),
        verification: { verifiedAt: null, method: null, result: null, matched: null, after: { source: 'unavailable', value: null }, triggerJobId: null },
      }],
    });
    return task;
  }

  test('the owner URLs are in the rendered @graph Organization (the sameas_array issue is gone) -> verified_fixed via value_diff', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const task = await setup({ urls: [LI, YT], rendered: [FB, LI, YT] });

    const result = await taskVerificationService.verifyImplementedTasks(projectId, 'SAMEAS-OK');
    assert.equal(result.verified, 1);
    const saved = await Task.findById(task._id);
    assert.equal(saved.status, 'verified_fixed');
    const latest = saved.fixHistory[saved.fixHistory.length - 1];
    assert.equal(latest.verification.method, 'value_diff');
    assert.equal(latest.verification.matched, true);
    assert.deepEqual(latest.fixApplied.externalWrite.profilesAfter, [LI, YT]);
    assert.equal(latest.fixApplied.externalWrite.scope, 'site');
  });

  test('THE ISSUE HAS DISAPPEARED (Rank Math prints a Facebook sameAs) but the owner URL is NOT rendered -> reopened, never verified_fixed', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const task = await setup({ urls: [LI], rendered: [FB], issueStillOpen: false });

    const result = await taskVerificationService.verifyImplementedTasks(projectId, 'SAMEAS-MISSING');
    assert.equal(result.reopened, 1);
    assert.equal(result.verified, 0);
    const saved = await Task.findById(task._id);
    assert.equal(saved.status, 'reopened');
    const latest = saved.fixHistory[saved.fixHistory.length - 1];
    assert.equal(latest.verification.matched, false);
    assert.equal(latest.verification.method, 'value_diff');
  });

  test('several URLs: one missing from the rendered output is enough to reopen', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const task = await setup({ urls: [LI, YT], rendered: [FB, LI] });

    await taskVerificationService.verifyImplementedTasks(projectId, 'SAMEAS-PARTIAL');
    assert.equal((await Task.findById(task._id)).status, 'reopened');
  });

  test('the issue still open on the page stays reopened even when the URL is rendered (presence wins)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const task = await setup({ urls: [LI], rendered: [LI], issueStillOpen: true });

    await taskVerificationService.verifyImplementedTasks(projectId, 'SAMEAS-STILL-OPEN');
    assert.equal((await Task.findById(task._id)).status, 'reopened');
  });
});
