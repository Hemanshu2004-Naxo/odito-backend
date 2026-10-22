import { describe, test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';

dotenv.config();

import SeoProject from '../model/SeoProject.js';
import User from '../../user/model/User.js';
import HomepageAudit from '../../external/model/HomepageAudit.js';
import { createSeoProject } from './seoProjectController.js';

/**
 * POST /api/app_user/projects (used by onboarding, including the manual
 * website path). Models are mocked - NO database. Covers what the manual
 * fallback relies on: URL validation, no duplicate project / no second credit
 * on a retry, the manually entered business name being stored (separately from
 * verified_business), and the existing credit/subscription gates untouched.
 */

const USER_ID = '64b7f3a2c9e77a0012345678';

const mockRes = () => ({
  statusCode: 200, body: null,
  status(c) { this.statusCode = c; return this; },
  json(p) { this.body = p; return this; }
});

let ctx; // recorded side effects

const makeReq = (bodyOver = {}, userOver = {}) => ({
  user: { _id: USER_ID, subscription: { status: 'active', credits: { limit: 5, used: 1 } }, ...userOver },
  body: {
    project_name: 'Naxonify-Com',
    main_url: 'https://naxonify.com',
    keywords: ['seo nashik', 'digital agency nashik'],
    seo_scope: 'local',
    location: 'Nashik',
    onboarding_mode: 'website_manual',
    discovery_source: 'manual_entry',
    source: 'website_manual',
    ...bodyOver
  }
});

const create = async (bodyOver, userOver) => {
  const res = mockRes();
  await createSeoProject(makeReq(bodyOver, userOver), res);
  return res;
};

beforeEach(() => {
  ctx = { findOne: [], deducted: 0, refunded: 0, saved: [], existingRecent: null, existingByName: null };

  mock.method(SeoProject, 'findOne', async (query) => {
    ctx.findOne.push(query);
    // the idempotency lookup is the one that filters on created_at
    return query.created_at ? ctx.existingRecent : ctx.existingByName;
  });
  mock.method(User, 'findOneAndUpdate', async () => { ctx.deducted++; return { _id: USER_ID }; });
  mock.method(User, 'findByIdAndUpdate', async () => { ctx.refunded++; return { _id: USER_ID }; });
  mock.method(SeoProject.prototype, 'save', async function save() { ctx.saved.push(this); return this; });
  mock.method(HomepageAudit, 'findOne', () => ({ sort: () => ({ lean: async () => null }) }));
  for (const level of ['log', 'warn', 'error']) mock.method(console, level, () => {});
});

afterEach(() => mock.restoreAll());

describe('createSeoProject - manual website onboarding payload', () => {
  test('creates the project from website + manually entered details and spends exactly one credit', async () => {
    const res = await create({ business_name: '  Naxonify  ' });
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.success, true);
    assert.equal(ctx.deducted, 1);
    assert.equal(ctx.saved.length, 1);

    const doc = ctx.saved[0];
    assert.equal(doc.main_url, 'https://naxonify.com');
    assert.equal(doc.seo_scope, 'local');
    assert.equal(doc.location, 'Nashik');
    assert.equal(doc.business_name, 'Naxonify');
    assert.equal(doc.onboarding_mode, 'website_manual');
    assert.equal(doc.discovery_source, 'manual_entry');
  });

  test('no Google data is invented: verified_business stays empty when none was sent', async () => {
    await create({ business_name: 'Naxonify' });
    const vb = ctx.saved[0].verified_business;
    assert.ok(!vb?.placeId);
    assert.ok(!vb?.verifiedAt);
    assert.ok(!vb?.name, 'the typed name must not be stored as a verified (Google) name');
  });

  test('business_name is optional, ignored when blank / not a string, and the schema field is additive', async () => {
    await create({});
    assert.equal(ctx.saved[0].business_name ?? null, null);
    await create({ business_name: '   ' });
    assert.equal(ctx.saved[1].business_name ?? null, null);
    await create({ business_name: { $ne: '' } });
    assert.equal(ctx.saved[2].business_name ?? null, null);
    assert.equal(SeoProject.schema.path('business_name').options.default, null);
    assert.ok(!SeoProject.schema.path('business_name').isRequired);
  });

  test('both SEO scopes persist', async () => {
    await create({ seo_scope: 'national', country: 'in', project_name: 'Nat-One' });
    assert.equal(ctx.saved[0].seo_scope, 'national');
    assert.equal(ctx.saved[0].country, 'IN');
  });
});

describe('createSeoProject - server-side URL validation', () => {
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'ftp://example.com', 'http://localhost:5000', 'http://127.0.0.1', 'http://10.0.0.5', 'http://169.254.169.254/latest', 'http://[::1]/', 'http://svc.internal', 'https://u:p@example.com', 'naxonify.com']) {
    test(`rejects main_url ${bad}`, async () => {
      const res = await create({ main_url: bad });
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.code, 'INVALID_MAIN_URL');
      assert.equal(ctx.deducted, 0, 'no credit may be spent for a rejected URL');
      assert.equal(ctx.saved.length, 0);
    });
  }

  test('still accepts what existing users have: a custom port on a public host', async () => {
    const res = await create({ main_url: 'https://staging.example.com:8443', project_name: 'Staging-Example' });
    assert.equal(res.statusCode, 201);
  });
});

describe('createSeoProject - repeated submission never creates a duplicate project', () => {
  const existing = { _id: '64b7f3a2c9e77a00aaaaaaaa', project_name: 'Naxonify-Com', main_url: 'https://naxonify.com' };

  test('a retry of the same name+URL shortly after creation returns the existing project and spends NO credit', async () => {
    ctx.existingRecent = existing;
    const res = await create();
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.idempotent, true);
    assert.equal(res.body.data.projectId, existing._id);
    assert.equal(ctx.deducted, 0);
    assert.equal(ctx.saved.length, 0);
  });

  test('the replay works even when that creation used the LAST credit and the subscription gate would now fail', async () => {
    ctx.existingRecent = existing;
    const res = await create({}, { subscription: { status: 'active', credits: { limit: 1, used: 1 } } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.idempotent, true);
  });

  test('the idempotency lookup is scoped to this user, name, URL, undeleted, and a recent window', async () => {
    await create();
    const q = ctx.findOne.find((x) => x.created_at);
    assert.equal(q.user_id, USER_ID);
    assert.equal(q.project_name, 'Naxonify-Com');
    assert.equal(q.main_url, 'https://naxonify.com');
    assert.deepEqual(q.is_deleted, { $ne: true });
    const windowMs = Date.now() - q.created_at.$gte.getTime();
    assert.ok(windowMs > 0 && windowMs <= 11 * 60 * 1000, `window was ${windowMs}ms`);
  });

  test('an OLD project with the same name still gets the existing "name already exists" error (behaviour unchanged)', async () => {
    ctx.existingByName = existing;
    const res = await create();
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /already exists/i);
    assert.equal(ctx.deducted, 0);
  });
});

describe('createSeoProject - existing gates are unchanged', () => {
  test('no credits -> 403 INSUFFICIENT_CREDITS', async () => {
    const res = await create({}, { subscription: { status: 'active', credits: { limit: 1, used: 1 } } });
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'INSUFFICIENT_CREDITS');
  });

  test('inactive subscription -> 403 SUBSCRIPTION_NOT_ACTIVE', async () => {
    const res = await create({}, { subscription: { status: 'past_due', credits: { limit: 5, used: 0 } } });
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'SUBSCRIPTION_NOT_ACTIVE');
  });

  test('missing keywords -> 400', async () => {
    assert.equal((await create({ keywords: [] })).statusCode, 400);
  });

  test('a failed save refunds the credit', async () => {
    SeoProject.prototype.save.mock.mockImplementation(async () => { throw new Error('mongo down'); });
    const res = await create();
    assert.equal(res.statusCode, 500);
    assert.equal(ctx.deducted, 1);
    assert.equal(ctx.refunded, 1);
  });
});
