import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import metaApiService from './metaApiService.js';
import { discoverAdditionalPages } from './metaPageService.js';
import SeoProject from '../../app_user/model/SeoProject.js';
import SocialAccount from '../model/SocialAccount.js';
import PendingMetaConnection from '../model/PendingMetaConnection.js';
import { getMetaPages } from '../controller/metaOAuthController.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * Extended Facebook Page discovery — live finding (Nov 2026): the user token
 * was granted 17 Pages (debug_token granular_scopes pages_show_list), but
 * /me/accounts listed 14; the other 3 load by ID with a Page token. And two
 * Pages owned by granted Business Portfolios were not shared with the app at
 * all, so they just vanished from the picker. Meta is fully mocked here — a
 * scripted Graph "world" keyed by path; no real Meta call is ever made.
 */

const USER_TOKEN = 'USER-TOKEN-NEVER-LOGGED';

/** A fake Graph API. `world` maps a path to a response body, or a function returning a full result. */
function installGraph(world) {
  const original = { request: metaApiService.request, requestAbsolute: metaApiService.requestAbsolute };
  const calls = [];
  const answer = (key, opts) => {
    calls.push(key);
    const hit = world[key];
    if (hit === undefined) return { success: false, status: 400, data: { error: { code: 100, message: `unknown ${key}` } } };
    if (typeof hit === 'function') return hit(opts);
    if (hit && hit.__error) return { success: false, status: hit.status || 400, data: { error: { code: hit.code } } };
    return { success: true, status: 200, data: hit };
  };
  metaApiService.request = async (opts) => answer(opts.path, opts);
  metaApiService.requestAbsolute = async (opts) => answer(opts.url, opts);
  const restore = () => { metaApiService.request = original.request; metaApiService.requestAbsolute = original.requestAbsolute; };
  restore.calls = calls;
  return restore;
}

const debugToken = (pageIds) => ({ data: { type: 'USER', is_valid: true, app_id: process.env.META_APP_ID, granular_scopes: [{ scope: 'pages_show_list', target_ids: pageIds }, { scope: 'business_management', target_ids: ['biz_1'] }] } });
const pageNode = (id, name, token = `tok_${id}`) => ({ id, name, category: 'Business', picture: { data: { url: `https://cdn.example/${id}.jpg` } }, ...(token ? { access_token: token } : {}) });
const accounts = (...ids) => ({ data: ids.map((id) => ({ id, name: `Listed ${id}`, category: 'Business', access_token: `tok_${id}`, tasks: ['MANAGE'] })), paging: {} });

describe('discoverAdditionalPages (mocked Meta)', () => {
  test('1: granted Pages that /me/accounts did not list are found by ID, with their Page token', async () => {
    const restore = installGraph({
      '/debug_token': debugToken(['p1', 'p2', 'p_hidden']),
      '/p_hidden': pageNode('p_hidden', 'Skyline Internet'),
      '/me/businesses': { data: [] },
    });
    try {
      const out = await discoverAdditionalPages(USER_TOKEN, { knownPageIds: ['p1', 'p2'] });
      assert.deepEqual(out.pages.map((p) => [p.id, p.name, p.source, !!p.accessToken]), [['p_hidden', 'Skyline Internet', 'granted', true]]);
      assert.equal(out.diagnostics.grantedTargets, 3);
      assert.equal(out.diagnostics.grantedAdded, 1);
      assert.ok(!restore.calls.includes('/p1'), 'Pages already listed are never looked up again');
    } finally { restore(); }
  });

  test('2: a Business Portfolio Page Meta refuses is reported as not shared (name + portfolio), never silently dropped', async () => {
    const restore = installGraph({
      '/debug_token': debugToken(['p1']),
      '/me/businesses': { data: [{ id: 'biz_1', name: 'Sapphire Digital Agency', owned_pages: { data: [{ id: 'p1', name: 'Listed p1' }, { id: 'p_locked', name: 'Sapphire Digital Agency' }] }, client_pages: { data: [] } }] },
      '/p_locked': { __error: true, code: 10 },
    });
    try {
      const out = await discoverAdditionalPages(USER_TOKEN, { knownPageIds: ['p1'] });
      assert.ok(!restore.calls.includes('/p_locked'), 'outside a restricted grant: reported without a lookup call');
      assert.equal(out.diagnostics.businessCalls, 'expanded');
      assert.equal(out.pages.length, 0);
      assert.deepEqual(out.unsharedPages, [{ id: 'p_locked', name: 'Sapphire Digital Agency', picture: null, businessId: 'biz_1', businessName: 'Sapphire Digital Agency', reason: 'NOT_SHARED_WITH_APP' }]);
      assert.deepEqual(out.excluded, [{ id: 'p_locked', reason: 'NOT_SHARED_WITH_APP' }]);
    } finally { restore(); }
  });

  test('3: a portfolio Page the app CAN load (unrestricted grant) is added as connectable, source "business"', async () => {
    const restore = installGraph({
      '/debug_token': { data: { type: 'USER', is_valid: true, granular_scopes: [{ scope: 'pages_show_list' }] } }, // no target_ids = unrestricted
      '/me/businesses': { data: [{ id: 'biz_1', name: 'Agency', owned_pages: { data: [] }, client_pages: { data: [{ id: 'p_client', name: 'Client Page' }] } }] },
      '/p_client': pageNode('p_client', 'Client Page'),
    });
    try {
      const out = await discoverAdditionalPages(USER_TOKEN, { knownPageIds: [] });
      assert.equal(out.diagnostics.grantedTargets, 'unrestricted');
      assert.deepEqual(out.pages.map((p) => [p.id, p.source]), [['p_client', 'business']]);
      assert.equal(out.unsharedPages.length, 0);
    } finally { restore(); }
  });

  test('4: duplicates across sources collapse to one Page (granted AND portfolio-owned)', async () => {
    const restore = installGraph({
      '/debug_token': debugToken(['p_dup']),
      '/p_dup': pageNode('p_dup', 'Dup'),
      '/me/businesses': { data: [{ id: 'biz_1', name: 'A', owned_pages: { data: [{ id: 'p_dup', name: 'Dup' }] }, client_pages: { data: [] } }, { id: 'biz_2', name: 'B', owned_pages: { data: [] }, client_pages: { data: [{ id: 'p_dup', name: 'Dup' }] } }] },
    });
    try {
      const out = await discoverAdditionalPages(USER_TOKEN, { knownPageIds: [] });
      assert.equal(out.pages.length, 1);
      assert.equal(restore.calls.filter((c) => c === '/p_dup').length, 1, 'looked up once');
    } finally { restore(); }
  });

  test('5: a granted Page Meta returns WITHOUT a Page token is kept (flagged), not hidden', async () => {
    const restore = installGraph({ '/debug_token': debugToken(['p_notoken']), '/p_notoken': pageNode('p_notoken', 'No Token', null), '/me/businesses': { data: [] } });
    try {
      const out = await discoverAdditionalPages(USER_TOKEN);
      assert.equal(out.pages.length, 1);
      assert.equal(out.pages[0].accessToken, null);
      assert.deepEqual(out.excluded, [{ id: 'p_notoken', reason: 'NO_PAGE_TOKEN' }]);
    } finally { restore(); }
  });

  test('6: if Meta rejects the one-call form, it falls back to per-portfolio edges (paginated)', async () => {
    const next = 'https://graph.facebook.com/v21.0/biz_1/owned_pages?after=X';
    const restore = installGraph({
      '/debug_token': { data: { type: 'USER', is_valid: true, granular_scopes: [{ scope: 'pages_show_list' }] } },
      '/me/businesses': (opts) => (String(opts.params?.fields).includes('owned_pages')
        ? { success: false, status: 400, data: { error: { code: 100 } } }
        : { success: true, status: 200, data: { data: [{ id: 'biz_1', name: 'A' }] } }),
      '/biz_1/owned_pages': { data: [{ id: 'pa', name: 'A1' }], paging: { next } },
      [next]: { data: [{ id: 'pb', name: 'B1' }], paging: {} },
      '/biz_1/client_pages': { data: [] },
      '/pa': pageNode('pa', 'A1'),
      '/pb': pageNode('pb', 'B1'),
    });
    try {
      const out = await discoverAdditionalPages(USER_TOKEN);
      assert.deepEqual(out.pages.map((p) => p.id), ['pa', 'pb']);
      assert.equal(out.diagnostics.businessCalls, 'per_edge');
    } finally { restore(); }
  });

  test('7: one source failing (debug_token 5xx, a portfolio edge rate-limited) never loses the others', async () => {
    const restore = installGraph({
      '/debug_token': { __error: true, status: 503, code: 2 },
      '/me/businesses': { data: [{ id: 'biz_2', name: 'B', owned_pages: { data: [{ id: 'p_ok', name: 'OK' }] }, client_pages: { data: [] } }] },
      '/p_ok': pageNode('p_ok', 'OK'),
    });
    try {
      const out = await discoverAdditionalPages(USER_TOKEN);
      assert.deepEqual(out.pages.map((p) => p.id), ['p_ok']);
      assert.deepEqual(out.diagnostics.errors.map((e) => e.step), ['granted_targets']);
    } finally { restore(); }
  });

  test('7b: the first rate-limit answer (code 4 as HTTP 403) stops all remaining calls, and nothing is wrongly reported as not shared', async () => {
    const restore = installGraph({
      '/debug_token': debugToken(['g1', 'g2', 'g3']),
      '/g1': { __error: true, status: 403, code: 4 },
      '/me/businesses': { data: [{ id: 'biz_1', name: 'A', owned_pages: { data: [{ id: 'g2', name: 'G2' }] }, client_pages: { data: [] } }] },
    });
    try {
      const out = await discoverAdditionalPages(USER_TOKEN);
      assert.equal(out.diagnostics.rateLimited, true);
      assert.deepEqual(restore.calls, ['/debug_token', '/g1'], 'no call after the rate limit');
      assert.deepEqual(out.unsharedPages, []);
      assert.deepEqual(out.excluded, [{ id: 'g1', reason: 'RATE_LIMITED' }]);
    } finally { restore(); }
  });

  test('7c: call budget for the live case: 1 debug_token + 3 lookups + 1 portfolio call', async () => {
    const listed = Array.from({ length: 14 }, (_, i) => 'p' + (i + 1));
    const portfolios = listed.map((id, i) => ({ id: 'b' + i, name: 'B' + i, owned_pages: { data: [{ id, name: 'x' }] } }));
    portfolios.push({ id: 'b_locked', name: 'L', owned_pages: { data: [{ id: 'p_locked', name: 'Locked' }] } });
    const restore = installGraph({
      '/debug_token': debugToken([...listed, 'g1', 'g2', 'g3']),
      '/g1': pageNode('g1', 'G1'), '/g2': pageNode('g2', 'G2'), '/g3': pageNode('g3', 'G3'),
      '/me/businesses': { data: portfolios },
    });
    try {
      const out = await discoverAdditionalPages(USER_TOKEN, { knownPageIds: listed });
      assert.equal(restore.calls.length, 5);
      assert.equal(out.pages.length, 3);
      assert.deepEqual(out.unsharedPages.map((u) => u.id), ['p_locked']);
    } finally { restore(); }
  });

  test('8: META_EXTENDED_PAGE_DISCOVERY=off makes no Meta call', async () => {
    const restore = installGraph({});
    process.env.META_EXTENDED_PAGE_DISCOVERY = 'off';
    try {
      const out = await discoverAdditionalPages(USER_TOKEN);
      assert.equal(out.pages.length, 0);
      assert.equal(restore.calls.length, 0);
    } finally { delete process.env.META_EXTENDED_PAGE_DISCOVERY; restore(); }
  });
});

describe('getMetaPages — merged list, not-shared Pages, no token leaks (real MongoDB)', () => {
  let mongoAvailable = false;
  let userId, project;
  before(async () => {
    try { await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 }); mongoAvailable = true; } catch { mongoAvailable = false; }
  });
  after(async () => { if (mongoAvailable) await mongoose.connection.close(); });
  beforeEach(async () => {
    if (!mongoAvailable) return;
    userId = new mongoose.Types.ObjectId();
    project = await SeoProject.create({ user_id: userId, project_name: `Discovery ${Date.now()}`, main_url: 'https://example.com', seo_scope: 'local', keywords: ['d'] });
    await PendingMetaConnection.create({ user_id: userId, project_id: project._id, userAccessToken: USER_TOKEN, scopes: ['pages_show_list'], pages: [], expiresAt: new Date(Date.now() + 600000) });
  });
  afterEach(async () => {
    if (!mongoAvailable) return;
    await SeoProject.deleteOne({ _id: project._id });
    await PendingMetaConnection.deleteMany({ project_id: project._id });
    await SocialAccount.deleteMany({ project_id: project._id });
  });

  const mockRes = () => ({ statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; return this; } });
  const fourteen = Array.from({ length: 14 }, (_, i) => `p${i + 1}`);

  test('9: 14 listed + 3 granted-but-unlisted = 17 Pages in the picker, plus the not-shared portfolio Page', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const restore = installGraph({
      '/me/accounts': accounts(...fourteen),
      '/debug_token': debugToken([...fourteen, 'g1', 'g2', 'g3']),
      '/g1': pageNode('g1', 'Ekdanta Digital Network'),
      '/g2': pageNode('g2', 'Skyline Internet'),
      '/g3': pageNode('g3', 'Prabhjeet Network', null),
      '/me/businesses': { data: [{ id: 'biz_1', name: 'Sapphire Digital Agency', owned_pages: { data: [{ id: 'p_locked', name: 'Sapphire Digital Agency' }] }, client_pages: { data: [] } }] },
    });
    const logs = [];
    const origInfo = LoggerUtil.info;
    LoggerUtil.info = (msg, data) => { logs.push(JSON.stringify([msg, data])); return origInfo.call(LoggerUtil, msg, data); };
    try {
      const res = mockRes();
      await getMetaPages({ user: { _id: userId }, projectId: project._id.toString() }, res);
      assert.equal(res.statusCode, null, JSON.stringify(res.body));
      const { pages, unsharedPages } = res.body.data;
      assert.equal(pages.length, 17, 'more than 14 Pages reach the picker');
      assert.deepEqual(pages.filter((p) => p.source === 'granted').map((p) => p.name), ['Ekdanta Digital Network', 'Skyline Internet', 'Prabhjeet Network']);
      assert.equal(pages.find((p) => p.id === 'g3').canConnect, false, 'no Page token: shown but not connectable');
      assert.equal(pages.find((p) => p.id === 'g1').canConnect, true);
      assert.deepEqual(unsharedPages.map((u) => [u.name, u.businessName]), [['Sapphire Digital Agency', 'Sapphire Digital Agency']]);

      const body = JSON.stringify(res.body);
      assert.ok(!body.includes('tok_') && !body.includes(USER_TOKEN), 'no token in the response');
      const logText = logs.join('\n');
      assert.ok(logText.includes('META_PAGE_DISCOVERY_COMPLETE'));
      assert.ok(!logText.includes('tok_') && !logText.includes(USER_TOKEN), 'no token in the logs');

      // cached: a second load makes no further Meta calls
      const before = restore.calls.length;
      await getMetaPages({ user: { _id: userId }, projectId: project._id.toString() }, mockRes());
      assert.equal(restore.calls.length, before);
    } finally { LoggerUtil.info = origInfo; restore(); }
  });

  test('10: extended discovery failing entirely still returns the /me/accounts Pages', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const restore = installGraph({ '/me/accounts': accounts('p1', 'p2'), '/debug_token': { __error: true, status: 500 }, '/me/businesses': { __error: true, status: 500 } });
    try {
      const res = mockRes();
      await getMetaPages({ user: { _id: userId }, projectId: project._id.toString() }, res);
      assert.deepEqual(res.body.data.pages.map((p) => p.id), ['p1', 'p2']);
      assert.deepEqual(res.body.data.unsharedPages, []);
    } finally { restore(); }
  });

  test('10b: Meta rate-limiting /me/accounts returns 429 with a try-again message, never "invalid or expired"', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const restore = installGraph({ '/me/permissions': { data: [] }, '/me/accounts': { __error: true, status: 403, code: 4 } });
    try {
      const res = mockRes();
      await getMetaPages({ user: { _id: userId }, projectId: project._id.toString() }, res);
      assert.equal(res.statusCode, 429);
      const body = JSON.stringify(res.body);
      assert.match(body, /META_RATE_LIMITED/);
      assert.match(body, /limiting requests/);
      assert.doesNotMatch(body, /invalid or expired/);
      assert.ok(await PendingMetaConnection.exists({ project_id: project._id }), 'pending connection kept so Try again works');
    } finally { restore(); }
  });

  test('10c: permissions missed at callback (empty) are re-read when the Page list loads', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await PendingMetaConnection.updateOne({ project_id: project._id }, { $set: { scopes: [] } });
    const restore = installGraph({
      '/me/permissions': { data: [{ permission: 'pages_show_list', status: 'granted' }, { permission: 'pages_manage_posts', status: 'granted' }, { permission: 'instagram_basic', status: 'declined' }] },
      '/me/accounts': accounts('p1'),
      '/debug_token': debugToken(['p1']),
      '/me/businesses': { data: [] },
    });
    try {
      await getMetaPages({ user: { _id: userId }, projectId: project._id.toString() }, mockRes());
      const pending = await PendingMetaConnection.findOne({ project_id: project._id });
      assert.deepEqual([...pending.scopes], ['pages_show_list', 'pages_manage_posts']);
    } finally { restore(); }
  });

  test('11: another project never sees this pending connection\'s Pages', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const other = await SeoProject.create({ user_id: userId, project_name: `Other ${Date.now()}`, main_url: 'https://example.org', seo_scope: 'local', keywords: ['o'] });
    try {
      const res = mockRes();
      await getMetaPages({ user: { _id: userId }, projectId: other._id.toString() }, res);
      assert.equal(res.statusCode, 409);
    } finally { await SeoProject.deleteOne({ _id: other._id }); }
  });
});
