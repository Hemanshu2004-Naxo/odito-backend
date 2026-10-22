import { describe, test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import wordPressSeoFixService from './wordPressSeoFixService.js';
import wordPressService, { WordPressConnectionError } from './wordPressService.js';
import oditoSeoBridgeService from './oditoSeoBridgeService.js';
import taskHistoryService from '../../tasks/service/TaskHistoryService.js';
import taskVerificationService from '../../tasks/service/TaskVerificationService.js';
import Recommendation from '../../recommendations/model/Recommendation.js';

/**
 * Apply-via-WordPress for sameas_array with SITE-OWNER-ENTERED profile URLs.
 *
 * No Mongo, no HTTP: WordPress is an in-memory fake of Rank Math's Organization
 * storage that follows RankMathProvider.php exactly (a newline-delimited
 * social_additional_profiles bucket that add/remove touches; Facebook and
 * Twitter-derived profiles that nothing here can touch; add is idempotent
 * against the FULL computed list; remove refuses a URL that is not in the
 * additional bucket). Task lifecycle is captured, not persisted.
 */

const FB = 'https://www.facebook.com/naxonify';
const TW = 'https://twitter.com/naxonify';
const LI = 'https://www.linkedin.com/company/naxonify';
const YT = 'https://www.youtube.com/@naxonify';
const IG = 'https://www.instagram.com/naxonify';
const PAGE_URL = 'https://naxonify.com/contact-us';

let site;          // { name, description, url, logo, facebook, twitter, additional: [] }
let calls;         // ordered log of every Bridge write: { op, url }
let captured;      // args passed to applyImplementedTransition
let stub;          // per-test overrides

function siteSchema() {
  const protectedSameAs = [site.facebook, site.twitter].filter(Boolean);
  return {
    provider: 'rank_math',
    organization: {
      name: site.name, description: site.description, url: site.url, logo: site.logo,
      sameAs: [...protectedSameAs, ...site.additional],
      protectedSameAs,
      additionalSameAs: [...site.additional],
    },
    breadcrumbs: { enabled: true },
  };
}

function makeTask(overrides = {}) {
  const task = {
    _id: 'task-1', projectId: 'project-1', pageUrl: PAGE_URL, issueKey: 'sameas_array', status: 'task_created',
    recommendationId: 'rec-1', saved: 0,
    async save() { task.saved += 1; },
    ...overrides,
  };
  return task;
}

beforeEach(() => {
  mock.restoreAll();
  stub = {};
  calls = [];
  captured = [];
  site = { name: 'Naxonify', description: 'Agency', url: 'https://naxonify.com', logo: 'https://naxonify.com/logo.png', facebook: null, twitter: null, additional: [] };

  mock.method(Recommendation, 'findById', () => ({ select: () => ({ lean: async () => ({ projectId: 'project-1' }) }) }));
  mock.method(wordPressService, 'getHydratedConnectionOrThrow', async () => ({ site_url: 'https://naxonify.com' }));
  mock.method(oditoSeoBridgeService, 'getBridgeStatus', async () => ({
    installed: true, provider: 'rank_math', providers: ['rank_math'], bridgeVersion: '1.3.1', siteSchemaSupported: true, ...(stub.bridgeStatus || {}),
  }));
  mock.method(oditoSeoBridgeService, 'getSiteSchema', async () => {
    if (stub.readFails) throw new Error('read failed');
    return siteSchema();
  });
  mock.method(oditoSeoBridgeService, 'updateSiteSchemaField', async (_conn, entity, field, value, op) => {
    calls.push({ entity, field, value, op });
    if (stub.writeFailsAt !== undefined && calls.length - 1 === stub.writeFailsAt) {
      throw new WordPressConnectionError('WRITE_FAILED', 'Bridge said no', 502);
    }
    if (entity !== 'organization' || field !== 'sameAs') throw new Error('unexpected target');
    if (stub.silentlyDropWrites) return siteSchema();
    // RankMathProvider::update_same_as
    const all = [site.facebook, site.twitter, ...site.additional].filter(Boolean);
    if (op === 'add') {
      if (!all.includes(value)) site.additional.push(value);
    } else if (op === 'remove') {
      const i = site.additional.indexOf(value);
      if (i === -1) throw new WordPressConnectionError('WRITE_FAILED', 'This URL is not one Odito can remove', 422);
      site.additional.splice(i, 1);
    } else {
      throw new Error('sameAs requires op');
    }
    return siteSchema();
  });
  // Task lifecycle: capture instead of hitting Mongo.
  mock.method(taskHistoryService, 'applyImplementedTransition', async (task, args) => {
    captured.push(args);
    task.status = 'implemented';
    return { attemptNumber: 1 };
  });
  // The recommendation's content must never matter for sameAs.
  mock.method(taskHistoryService, 'resolveExpectedValue', async () => { throw new Error('sameAs must not read the recommendation value'); });
});

const apply = (task, input = {}) => wordPressSeoFixService.applyFix(task, { approved: true, ...input });
const writtenUrls = () => calls.map((c) => `${c.op}:${c.value}`);

describe('sameAs apply — adding the site owner\'s profiles', () => {
  test('1. adds ONE URL to social_additional_profiles, reads back, task -> implemented (never verified_fixed)', async () => {
    const task = makeTask();
    const result = await apply(task, { additionalProfiles: [LI] });

    assert.deepEqual(site.additional, [LI]);
    assert.deepEqual(writtenUrls(), [`add:${LI}`]);
    assert.equal(result.field, 'same_as');
    assert.equal(result.provider, 'rank_math');
    assert.equal(result.alreadyApplied, false);
    assert.equal(result.immediateVerification, 'success');
    assert.deepEqual(result.sameAs.added, [LI]);
    assert.equal(task.status, 'implemented');
    assert.equal(task.saved, 1);
  });

  test('2. adds SEVERAL URLs in one apply, in the order given', async () => {
    const result = await apply(makeTask(), { additionalProfiles: [LI, IG, YT] });
    assert.deepEqual(site.additional, [LI, IG, YT]);
    assert.deepEqual(writtenUrls(), [`add:${LI}`, `add:${IG}`, `add:${YT}`]);
    assert.deepEqual(result.sameAs.added, [LI, IG, YT]);
    assert.equal(result.immediateVerification, 'success');
  });

  test('3+13. adding while additional profiles already exist MERGES — the existing one is preserved, never replaced', async () => {
    site.additional = [YT];
    const result = await apply(makeTask(), { additionalProfiles: [LI] });

    assert.deepEqual(site.additional, [YT, LI]);
    assert.deepEqual(writtenUrls(), [`add:${LI}`], 'the existing profile is neither re-written nor removed');
    assert.deepEqual(result.sameAs.additionalProfiles, [YT, LI]);
    assert.equal(result.immediateVerification, 'success');
  });

  test('a URL already in the additional list is skipped (idempotent) — no write, reported as already present', async () => {
    site.additional = [LI];
    const task = makeTask();
    const result = await apply(task, { additionalProfiles: [LI] });

    assert.equal(calls.length, 0);
    assert.equal(result.alreadyApplied, true);
    assert.deepEqual(result.sameAs.alreadyPresent, [LI]);
    assert.equal(result.immediateVerification, 'success');
    assert.equal(task.status, 'implemented', 'still recorded, so the crawler can verify the rendered output');
  });

  test('a URL already present with a trailing slash / other scheme is recognised as the same profile', async () => {
    site.additional = ['http://www.linkedin.com/company/naxonify/'];
    const result = await apply(makeTask(), { additionalProfiles: [LI] });
    assert.equal(calls.length, 0);
    assert.equal(result.alreadyApplied, true);
  });

  test('a mix of new and already-present URLs writes only the new one', async () => {
    site.additional = [YT];
    const result = await apply(makeTask(), { additionalProfiles: [YT, LI] });
    assert.deepEqual(writtenUrls(), [`add:${LI}`]);
    assert.deepEqual(result.sameAs.alreadyPresent, [YT]);
    assert.deepEqual(site.additional, [YT, LI]);
  });

  test('URLs are written NORMALIZED (trimmed, host lower-cased, trailing slash and fragment dropped)', async () => {
    await apply(makeTask(), { additionalProfiles: ['  HTTPS://WWW.LinkedIn.com/company/naxonify/#about  '] });
    assert.deepEqual(site.additional, ['https://www.linkedin.com/company/naxonify']);
  });

  test('10. leading/trailing whitespace is trimmed; whitespace INSIDE a URL is refused', async () => {
    await apply(makeTask(), { additionalProfiles: [`\n  ${LI}\t `] });
    assert.deepEqual(site.additional, [LI]);

    await assert.rejects(
      () => apply(makeTask(), { additionalProfiles: ['https://www.linkedin.com/company/na xonify'] }),
      (e) => e.code === 'INVALID_PROFILES' && e.statusCode === 400
    );
  });
});

describe('sameAs apply — Facebook/Twitter profiles are protected', () => {
  test('11+12. they are never written to: a normal add leaves both untouched, and only add/remove calls on sameAs are ever made', async () => {
    site.facebook = FB; site.twitter = TW;
    const result = await apply(makeTask(), { additionalProfiles: [LI] });

    assert.equal(site.facebook, FB);
    assert.equal(site.twitter, TW);
    assert.deepEqual(site.additional, [LI]);
    assert.deepEqual(result.sameAs.protectedProfiles, [FB, TW]);
    assert.ok(calls.every((c) => c.entity === 'organization' && c.field === 'sameAs' && ['add', 'remove'].includes(c.op)));
  });

  test('adding a URL that already comes from the Facebook/Twitter fields is a no-op — it is NOT duplicated into the additional bucket', async () => {
    site.facebook = FB; site.twitter = TW;
    const result = await apply(makeTask(), { additionalProfiles: [FB, TW] });
    assert.equal(calls.length, 0);
    assert.deepEqual(site.additional, []);
    assert.deepEqual(result.sameAs.alreadyPresent, [FB, TW]);
  });

  test('15. removing the Facebook-derived profile is refused (422 PROFILE_PROTECTED) and nothing is written', async () => {
    site.facebook = FB; site.additional = [YT];
    await assert.rejects(
      () => apply(makeTask(), { additionalProfiles: [LI], removeProfiles: [FB] }),
      (e) => e.code === 'PROFILE_PROTECTED' && e.statusCode === 422
    );
    assert.equal(calls.length, 0);
    assert.equal(site.facebook, FB);
  });

  test('15. ...and so is the Twitter-derived one, even written with a different scheme/trailing slash', async () => {
    site.twitter = TW; site.additional = [];
    await assert.rejects(
      () => apply(makeTask(), { additionalProfiles: [LI], removeProfiles: ['http://twitter.com/naxonify/'] }),
      (e) => e.code === 'PROFILE_PROTECTED'
    );
    assert.equal(calls.length, 0);
  });
});

describe('sameAs apply — removing additional profiles', () => {
  test('14. removes only the profile asked for; the rest are preserved; adds happen before removes', async () => {
    site.additional = [YT, IG];
    const result = await apply(makeTask(), { additionalProfiles: [LI], removeProfiles: [IG] });

    assert.deepEqual(site.additional, [YT, LI]);
    assert.deepEqual(writtenUrls(), [`add:${LI}`, `remove:${IG}`]);
    assert.deepEqual(result.sameAs.removed, [IG]);
    assert.equal(result.immediateVerification, 'success');
  });

  test('removal sends the profile exactly as STORED (so it matches RankMathProvider\'s exact-string lookup), even if the request spelled it differently', async () => {
    site.additional = ['https://www.youtube.com/@naxonify/', IG];
    await apply(makeTask(), { additionalProfiles: [LI], removeProfiles: ['https://www.youtube.com/@naxonify'] });
    assert.deepEqual(writtenUrls(), [`add:${LI}`, 'remove:https://www.youtube.com/@naxonify/']);
    assert.deepEqual(site.additional, [IG, LI]);
  });

  test('a profile to remove that is no longer in the list is a 409 CONFLICT (site changed under the user), nothing written', async () => {
    site.additional = [YT];
    await assert.rejects(
      () => apply(makeTask(), { additionalProfiles: [LI], removeProfiles: [IG] }),
      (e) => e.code === 'CONFLICT' && e.statusCode === 409
    );
    assert.equal(calls.length, 0);
  });

  test('adding and removing the same profile in one request is refused', async () => {
    site.additional = [YT];
    await assert.rejects(
      () => apply(makeTask(), { additionalProfiles: [YT], removeProfiles: [`${YT}/`] }),
      (e) => e.code === 'INVALID_PROFILES'
    );
    assert.equal(calls.length, 0);
  });
});

describe('sameAs apply — backend validation (the frontend is never trusted)', () => {
  const rejectsBeforeAnyWordPressCall = async (input, expectCode = 'INVALID_PROFILES') => {
    const connection = wordPressService.getHydratedConnectionOrThrow;
    await assert.rejects(
      () => apply(makeTask(), input),
      (e) => e instanceof WordPressConnectionError && e.code === expectCode && e.statusCode === 400
    );
    assert.equal(connection.mock.callCount(), 0, 'validation runs before WordPress is contacted');
    assert.equal(calls.length, 0);
  };

  test('5. an invalid URL', () => rejectsBeforeAnyWordPressCall({ additionalProfiles: ['not a url'] }));
  test('6. a javascript: URL', () => rejectsBeforeAnyWordPressCall({ additionalProfiles: ['javascript:alert(1)'] }));
  test('7. a data: URL', () => rejectsBeforeAnyWordPressCall({ additionalProfiles: ['data:text/html;base64,PHNjcmlwdD4='] }));
  test('8. a relative URL', () => rejectsBeforeAnyWordPressCall({ additionalProfiles: ['/company/naxonify'] }));
  test('8. a protocol-relative URL', () => rejectsBeforeAnyWordPressCall({ additionalProfiles: ['//www.linkedin.com/company/naxonify'] }));
  test('9. an empty URL', () => rejectsBeforeAnyWordPressCall({ additionalProfiles: [''] }));
  test('9. an empty list', () => rejectsBeforeAnyWordPressCall({ additionalProfiles: [] }));
  test('9. a missing additionalProfiles', () => rejectsBeforeAnyWordPressCall({}));
  test('HTML in a URL', () => rejectsBeforeAnyWordPressCall({ additionalProfiles: ['https://x.com/a"><script>alert(1)</script>'] }));
  test('a line break in a URL (would inject a second stored profile)', () => rejectsBeforeAnyWordPressCall({ additionalProfiles: [`${LI}\nhttps://evil.example.com`] }));
  test('credentials in a URL', () => rejectsBeforeAnyWordPressCall({ additionalProfiles: ['https://user:pw@www.linkedin.com/company/x'] }));
  test('4. a duplicate within the request', () => rejectsBeforeAnyWordPressCall({ additionalProfiles: [LI, `${LI}/`] }));
  test('a non-string entry', () => rejectsBeforeAnyWordPressCall({ additionalProfiles: [LI, 42] }));
  test('a non-array', () => rejectsBeforeAnyWordPressCall({ additionalProfiles: LI }));
  test('too many profiles at once', () => rejectsBeforeAnyWordPressCall({ additionalProfiles: Array.from({ length: 11 }, (_, i) => `https://example.com/p${i}`) }));
  test('a malformed removeProfiles', () => rejectsBeforeAnyWordPressCall({ additionalProfiles: [LI], removeProfiles: ['nope'] }));

  test('the error names each offending entry so the UI can point at it', async () => {
    await assert.rejects(
      () => apply(makeTask(), { additionalProfiles: [LI, 'javascript:x', '', LI] }),
      (e) => {
        assert.deepEqual(e.details.errors.map((x) => [x.list, x.index, x.code]), [
          ['additionalProfiles', 1, 'NOT_HTTP'], ['additionalProfiles', 2, 'EMPTY'], ['additionalProfiles', 3, 'DUPLICATE'],
        ]);
        return true;
      }
    );
  });

  test('a client cannot choose the storage location: unknown fields (option name, meta key, Rank Math field, schema JSON) are never forwarded', async () => {
    await apply(makeTask(), {
      additionalProfiles: [LI],
      optionName: 'rank-math-options-titles', metaKey: 'rank_math_title', field: 'knowledgegraph_name',
      entity: 'breadcrumbs', schema: { '@type': 'Organization' }, value: 'https://evil.example.com',
    });
    assert.deepEqual(calls, [{ entity: 'organization', field: 'sameAs', value: LI, op: 'add' }]);
    assert.equal(site.name, 'Naxonify');
    assert.deepEqual(site.additional, [LI]);
  });

  test('profile fields are refused for any other issue type rather than silently ignored', async () => {
    await assert.rejects(
      () => apply(makeTask({ issueKey: 'title_missing' }), { additionalProfiles: [LI] }),
      (e) => e.code === 'INVALID_PROFILES' && e.statusCode === 400
    );
  });

  test('approval is still required', async () => {
    await assert.rejects(
      () => wordPressSeoFixService.applyFix(makeTask(), { approved: false, additionalProfiles: [LI] }),
      (e) => e.statusCode === 400
    );
    assert.equal(calls.length, 0);
  });
});

describe('sameAs apply — independence from the AI recommendation', () => {
  test('the recommendation\'s content is never read, so a "not provided in context" recommendation works', async () => {
    await apply(makeTask(), { additionalProfiles: [LI] });
    assert.equal(taskHistoryService.resolveExpectedValue.mock.callCount(), 0);
  });

  test('a task with no linked recommendation is still refused (existing structural gate), before any write', async () => {
    await assert.rejects(
      () => apply(makeTask({ recommendationId: null }), { additionalProfiles: [LI] }),
      (e) => e.code === 'RECOMMENDATION_REQUIRED'
    );
    assert.equal(calls.length, 0);
  });
});

describe('sameAs apply — stale-value protection', () => {
  test('19. the additional profiles shown to the user still match the live list -> proceeds', async () => {
    site.additional = [YT];
    await apply(makeTask(), { additionalProfiles: [LI], expectedAdditionalProfiles: [`${YT}/`] });
    assert.deepEqual(site.additional, [YT, LI]);
  });

  test('19. the live list changed since the dialog opened (someone added one in Rank Math) -> 409 CONFLICT, nothing written', async () => {
    site.additional = [YT, IG];
    await assert.rejects(
      () => apply(makeTask(), { additionalProfiles: [LI], expectedAdditionalProfiles: [YT] }),
      (e) => {
        assert.equal(e.code, 'CONFLICT');
        assert.equal(e.statusCode, 409);
        assert.deepEqual(e.details.actualCurrentValue, [YT, IG]);
        return true;
      }
    );
    assert.equal(calls.length, 0);
  });

  test('19. ...also when a profile was removed in Rank Math meanwhile', async () => {
    site.additional = [];
    await assert.rejects(
      () => apply(makeTask(), { additionalProfiles: [LI], expectedAdditionalProfiles: [YT] }),
      (e) => e.code === 'CONFLICT'
    );
  });

  test('order does not matter for the staleness comparison', async () => {
    site.additional = [YT, IG];
    await apply(makeTask(), { additionalProfiles: [LI], expectedAdditionalProfiles: [IG, YT] });
    assert.deepEqual(site.additional, [YT, IG, LI]);
  });
});

describe('sameAs apply — read-back verification', () => {
  test('17. success requires: added present, others preserved, Facebook/Twitter and name/url/logo/description unchanged', async () => {
    site.facebook = FB; site.additional = [YT];
    const result = await apply(makeTask(), { additionalProfiles: [LI] });
    assert.equal(result.immediateVerification, 'success');
  });

  test('17. WordPress accepted the write but the value is not there on read-back -> "failed" (never a plain success)', async () => {
    stub.silentlyDropWrites = true;
    const task = makeTask();
    const result = await apply(task, { additionalProfiles: [LI] });
    assert.equal(result.immediateVerification, 'failed');
    assert.equal(task.status, 'implemented', 'the write was attempted and is recorded; the crawler stays the authority');
    assert.notEqual(task.status, 'verified_fixed');
  });

  test('17. the read-back itself fails -> "unknown", and the fix is still recorded', async () => {
    let reads = 0;
    mock.method(oditoSeoBridgeService, 'getSiteSchema', async () => {
      reads += 1;
      if (reads >= 2) throw new Error('read-back failed');
      return siteSchema();
    });
    const result = await apply(makeTask(), { additionalProfiles: [LI] });
    assert.equal(result.immediateVerification, 'unknown');
  });

  test('17. a change to a protected profile or the organization identity during the write is detected as "failed"', async () => {
    let reads = 0;
    mock.method(oditoSeoBridgeService, 'getSiteSchema', async () => {
      reads += 1;
      const schema = siteSchema();
      if (reads >= 2) schema.organization.name = 'Something Else';
      return schema;
    });
    const result = await apply(makeTask(), { additionalProfiles: [LI] });
    assert.equal(result.immediateVerification, 'failed');
  });
});

describe('sameAs apply — failures', () => {
  test('20. a WordPress write failure surfaces as a typed error, the task is NOT transitioned or saved', async () => {
    stub.writeFailsAt = 0;
    const task = makeTask();
    await assert.rejects(
      () => apply(task, { additionalProfiles: [LI] }),
      (e) => e instanceof WordPressConnectionError && e.code === 'WRITE_FAILED' && e.statusCode === 502
    );
    assert.equal(task.status, 'task_created');
    assert.equal(task.saved, 0);
    assert.equal(captured.length, 0);
  });

  test('20. an unexpected (non-typed) error is wrapped as WRITE_FAILED — no internals leak', async () => {
    mock.method(oditoSeoBridgeService, 'updateSiteSchemaField', async () => { throw new Error('ECONNRESET at 10.0.0.5'); });
    await assert.rejects(
      () => apply(makeTask(), { additionalProfiles: [LI] }),
      (e) => e.code === 'WRITE_FAILED' && !/10\.0\.0\.5/.test(e.message)
    );
  });

  test('20. a failure part-way through several URLs reports the partial write and does not transition the task', async () => {
    stub.writeFailsAt = 1; // second write
    const task = makeTask();
    await assert.rejects(
      () => apply(task, { additionalProfiles: [LI, IG, YT] }),
      (e) => e.code === 'WRITE_FAILED' && e.details.partialWrite === true && e.details.profilesWritten === 1
    );
    assert.deepEqual(site.additional, [LI], 'the first was saved before the failure');
    assert.equal(task.status, 'task_created');
  });

  test('a failure while removing (after adds succeeded) never leaves the site with fewer profiles than it started with', async () => {
    site.additional = [YT];
    stub.writeFailsAt = 1; // the remove, after the add
    await assert.rejects(() => apply(makeTask(), { additionalProfiles: [LI], removeProfiles: [YT] }), (e) => e.details.partialWrite === true);
    assert.deepEqual(site.additional, [YT, LI]);
  });

  test('a failed read of the current profiles is a hard stop — nothing is written blind', async () => {
    stub.readFails = true;
    await assert.rejects(() => apply(makeTask(), { additionalProfiles: [LI] }));
    assert.equal(calls.length, 0);
  });

  test('a task whose status cannot transition to implemented is refused before anything else (existing gate)', async () => {
    await assert.rejects(
      () => apply(makeTask({ status: 'verified_fixed' }), { additionalProfiles: [LI] }),
      (e) => e.code === 'CONFLICT' && e.statusCode === 409
    );
    assert.equal(calls.length, 0);
  });

  test('a concurrent Task update after a successful write is a CONFLICT that says the WordPress write succeeded', async () => {
    const task = makeTask({ async save() { const e = new Error('version'); e.name = 'VersionError'; throw e; } });
    await assert.rejects(
      () => apply(task, { additionalProfiles: [LI] }),
      (e) => e.code === 'CONFLICT' && e.details.wordpressWriteSucceeded === true
    );
    assert.deepEqual(site.additional, [LI]);
  });
});

describe('sameAs apply — Bridge / provider capability', () => {
  test('21. Bridge not installed -> FIELD_NOT_WRITABLE, nothing written', async () => {
    stub.bridgeStatus = { installed: false, provider: 'none', providers: [], bridgeVersion: null, siteSchemaSupported: false };
    await assert.rejects(
      () => apply(makeTask(), { additionalProfiles: [LI] }),
      (e) => e.code === 'FIELD_NOT_WRITABLE' && /requires the Odito SEO Bridge/.test(e.message)
    );
    assert.equal(calls.length, 0);
  });

  test('21. a Bridge too old to have site-level schema -> FIELD_NOT_WRITABLE asking for an update, nothing written', async () => {
    stub.bridgeStatus = { bridgeVersion: '1.0.0', siteSchemaSupported: false };
    await assert.rejects(
      () => apply(makeTask(), { additionalProfiles: [LI] }),
      (e) => e.code === 'FIELD_NOT_WRITABLE' && /newer version of the Odito SEO Bridge/.test(e.message) && e.statusCode === 422
    );
    assert.equal(calls.length, 0);
  });

  test('several active SEO plugins -> PLUGIN_NOT_SUPPORTED (409), nothing written', async () => {
    stub.bridgeStatus = { provider: 'multiple', providers: ['rank_math', 'yoast'] };
    await assert.rejects(() => apply(makeTask(), { additionalProfiles: [LI] }), (e) => e.code === 'PLUGIN_NOT_SUPPORTED' && e.statusCode === 409);
    assert.equal(calls.length, 0);
  });

  test('a provider other than Rank Math is refused — the storage mapping is Rank Math-specific', async () => {
    stub.bridgeStatus = { provider: 'yoast', providers: ['yoast'] };
    await assert.rejects(() => apply(makeTask(), { additionalProfiles: [LI] }), (e) => e.code === 'FIELD_NOT_WRITABLE' && /Rank Math/.test(e.message));
    assert.equal(calls.length, 0);
  });
});

describe('sameAs apply — what the Task records', () => {
  test('externalWrite: wordpress / rank_math / same_as / scope site, with the before/after additional profiles', async () => {
    site.additional = [YT];
    await apply(makeTask(), { additionalProfiles: [LI] });

    const { externalWrite, origin } = captured[0];
    assert.equal(origin, 'wordpress_auto');
    assert.equal(externalWrite.system, 'wordpress');
    assert.equal(externalWrite.provider, 'rank_math');
    assert.equal(externalWrite.field, 'same_as');
    assert.equal(externalWrite.scope, 'site');
    assert.equal(externalWrite.wordpressPostId, null);
    assert.equal(externalWrite.httpStatus, 200);
    assert.deepEqual(externalWrite.profilesBefore, [YT]);
    assert.deepEqual(externalWrite.profilesAfter, [YT, LI]);
  });

  test('the frozen after-state is what the site owner asked for (normalized), so TaskVerificationService looks for THOSE urls in the rendered JSON-LD', async () => {
    site.facebook = FB; site.additional = [YT];
    await apply(makeTask(), { additionalProfiles: [LI + '/', FB] });

    assert.deepEqual(captured[0].expectedAfterValueOverride, {
      type: 'same_as',
      urls: [LI, FB],
      additionalProfiles: [YT, LI],
    });
  });

  test('an already-applied re-run has no write timestamp status and records no httpStatus', async () => {
    site.additional = [LI];
    await apply(makeTask(), { additionalProfiles: [LI] });
    assert.equal(captured[0].externalWrite.httpStatus, null);
  });

  test('a removal is reflected in profilesAfter', async () => {
    site.additional = [YT, IG];
    await apply(makeTask(), { additionalProfiles: [LI], removeProfiles: [YT] });
    assert.deepEqual(captured[0].externalWrite.profilesAfter, [IG, LI]);
  });
});

const TT = 'https://www.tiktok.com/@naxonify';
const PI = 'https://www.pinterest.com/naxonify';
const XX = 'https://x.com/naxonify';
const BE = 'https://www.behance.net/naxonify';

// What Rank Math prints into the page: one Organization node whose sameAs is
// Facebook + Twitter (native fields) followed by the additional profiles —
// the same order RankMathProvider::compute_same_as() mirrors.
const renderedOrganizationJsonLd = () => [{
  '@context': 'https://schema.org',
  '@graph': [{ '@type': 'WebSite' }, { '@type': 'Organization', name: site.name, sameAs: siteSchema().organization.sameAs }],
}];

describe('sameAs apply — several profiles from the multi-platform form reach Rank Math and the rendered Organization JSON-LD', () => {
  for (const [count, urls] of [[2, [IG, LI]], [3, [FB, IG, LI]], [5, [FB, IG, LI, XX, YT]]]) {
    test(`${count} profiles entered at once: every one is written to social_additional_profiles, in order`, async () => {
      const result = await apply(makeTask(), { additionalProfiles: urls });
      assert.deepEqual(site.additional, urls);
      assert.deepEqual(writtenUrls(), urls.map((u) => `add:${u}`));
      assert.deepEqual(result.sameAs.added, urls);
      assert.equal(result.immediateVerification, 'success');
    });
  }

  test('all seven platforms plus a custom profile (8): everything is written', async () => {
    const urls = [FB, IG, LI, XX, YT, TT, PI, BE];
    await apply(makeTask(), { additionalProfiles: urls });
    assert.deepEqual(site.additional, urls);
  });

  test('the spec example: existing [YouTube] + Instagram + LinkedIn => [YouTube, Instagram, LinkedIn] — existing preserved, nothing replaced', async () => {
    site.additional = [YT];
    await apply(makeTask(), { additionalProfiles: [IG, LI] });
    assert.deepEqual(site.additional, [YT, IG, LI]);
    assert.deepEqual(writtenUrls(), [`add:${IG}`, `add:${LI}`], 'YouTube is neither re-written nor removed');
  });

  test('merging removes duplicates: a URL that is already saved is not added twice', async () => {
    site.additional = [YT, IG];
    await apply(makeTask(), { additionalProfiles: [IG, LI, YT] });
    assert.deepEqual(site.additional, [YT, IG, LI]);
  });

  test('a custom (Other) profile on an unlisted network is accepted like any other valid URL', async () => {
    await apply(makeTask(), { additionalProfiles: [BE, 'https://mastodon.social/@naxonify'] });
    assert.deepEqual(site.additional, [BE, 'https://mastodon.social/@naxonify']);
  });

  test('a blank entry among valid ones is refused by the backend (the frontend never sends blanks; the backend does not trust that)', async () => {
    await assert.rejects(
      () => apply(makeTask(), { additionalProfiles: [LI, '', IG] }),
      (e) => e.code === 'INVALID_PROFILES' && e.details.errors[0].code === 'EMPTY' && e.details.errors[0].index === 1
    );
    assert.equal(calls.length, 0);
  });

  test('a platform "mismatch" is not something the backend cares about: an Instagram URL is stored as given', async () => {
    await apply(makeTask(), { additionalProfiles: [IG] });
    assert.deepEqual(site.additional, [IG]);
  });

  test('protected Facebook/Twitter stay untouched while five others are added', async () => {
    site.facebook = FB; site.twitter = TW;
    await apply(makeTask(), { additionalProfiles: [IG, LI, YT, TT, PI] });
    assert.equal(site.facebook, FB);
    assert.equal(site.twitter, TW);
    assert.deepEqual(site.additional, [IG, LI, YT, TT, PI]);
  });

  test('CHAIN: what the crawler will see in the rendered Organization JSON-LD contains ALL the added URLs -> TaskVerificationService accepts it', async () => {
    site.facebook = FB; site.twitter = TW; site.additional = [YT];
    const urls = [IG, LI, XX, TT, PI];
    await apply(makeTask(), { additionalProfiles: urls });

    const expected = captured[0].expectedAfterValueOverride;
    assert.deepEqual(expected.urls, urls);
    const rendered = taskVerificationService._resolveAfterValue({ structured_data: renderedOrganizationJsonLd() }, 'same_as');
    assert.deepEqual(rendered.sameAs, [FB, TW, YT, ...urls], 'Rank Math prints native + additional profiles, in that order');
    assert.equal(taskVerificationService._valuesMatch(expected, rendered), true);
  });

  test('CHAIN: if the site renders only some of them, verification does NOT accept it', async () => {
    const urls = [IG, LI, XX];
    await apply(makeTask(), { additionalProfiles: urls });
    const expected = captured[0].expectedAfterValueOverride;

    const partial = taskVerificationService._resolveAfterValue(
      { structured_data: [{ '@graph': [{ '@type': 'Organization', sameAs: [IG, XX] }] }] },
      'same_as'
    );
    assert.equal(taskVerificationService._valuesMatch(expected, partial), false, 'LinkedIn missing from the rendered output');
  });
});
