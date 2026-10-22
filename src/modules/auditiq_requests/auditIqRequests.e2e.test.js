import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import express from 'express';
import React from 'react';
import { render } from '@react-email/render';

dotenv.config();
// Hard guarantees for this file: no real email can leave (blank key => provider throws => sendMail returns false;
// no recipient => the notification step is skipped), and the booking URL starts unconfigured.
process.env.RESEND_API_KEY = '';
delete process.env.SALES_NOTIFICATION_EMAIL;
delete process.env.AUDITIQ_BOOKING_URL;

import User from '../user/model/User.js';
import SeoProject from '../app_user/model/SeoProject.js';
import { signAuthToken } from '../user/service/tokenService.js';
import AuditIqServiceRequest from './model/AuditIqServiceRequest.js';
import auditIqRoutes from './routes/auditIqRoutes.js';
import { validateCreateRequestInput } from './validator/auditIqRequestValidation.js';
import { getStrategyCallAvailability, getMaintenanceAvailability } from './service/auditIqRequestService.js';
import { AuditIqRequestAdminNotification } from '../mail/templates/sales/AuditIqRequestAdminNotification.js';

const MARK = `auditiq-e2e-${Date.now()}`;

// ── Pure validation ─────────────────────────────────────────────────────────
describe('validateCreateRequestInput (pure)', () => {
  const base = { requestType: 'express_fix', issueKey: 'title_missing', issueTitle: 'Missing title', affectedPageCount: 4 };

  test('accepts a minimal Express Fix request and normalizes it', () => {
    const out = validateCreateRequestInput({ ...base, issueKey: '  title_missing  ' });
    assert.equal(out.requestType, 'express_fix');
    assert.equal(out.issueKey, 'title_missing');
    assert.equal(out.affectedPageCount, 4);
    assert.equal(out.message, null);
    assert.equal(out.pageUrl, null);
  });

  test('ignores fields it does not own (userId / status / isOpen cannot be injected)', () => {
    const out = validateCreateRequestInput({ ...base, userId: 'someone-else', status: 'completed', isOpen: false });
    assert.deepEqual(Object.keys(out).sort(), ['affectedPageCount', 'issueCategory', 'issueKey', 'issueTitle', 'message', 'pageUrl', 'requestType']);
  });

  test('rejects an unknown request type', () => {
    assert.throws(() => validateCreateRequestInput({ ...base, requestType: 'monthly_maintenance' }), (e) => e.code === 'VALIDATION_ERROR' && e.field === 'requestType');
  });

  test('requires an issue key', () => {
    assert.throws(() => validateCreateRequestInput({ ...base, issueKey: '   ' }), (e) => e.field === 'issueKey');
    assert.throws(() => validateCreateRequestInput({ ...base, issueKey: 'x'.repeat(201) }), (e) => e.field === 'issueKey');
  });

  test('expert_fix requires a description of at least 10 characters; the others do not', () => {
    assert.throws(() => validateCreateRequestInput({ ...base, requestType: 'expert_fix' }), (e) => e.field === 'message');
    assert.throws(() => validateCreateRequestInput({ ...base, requestType: 'expert_fix', message: 'too short' }), (e) => e.field === 'message');
    assert.equal(validateCreateRequestInput({ ...base, requestType: 'expert_fix', message: 'Please fix titles on all pages' }).message, 'Please fix titles on all pages');
    assert.doesNotThrow(() => validateCreateRequestInput({ ...base, requestType: 'technical_audit_fix' }));
  });

  test('message is capped at 2000 characters and stripped of control characters', () => {
    assert.throws(() => validateCreateRequestInput({ ...base, message: 'a'.repeat(2001) }), (e) => e.field === 'message');
    assert.throws(() => validateCreateRequestInput({ ...base, message: { $gt: '' } }), (e) => e.field === 'message');
    const out = validateCreateRequestInput({ ...base, message: 'line one\nline two\u0000\u0007' });
    assert.equal(out.message, 'line one\nline two');
  });

  test('affectedPageCount must be a non-negative whole number', () => {
    for (const bad of [-1, 1.5, '4', NaN, 1000001]) {
      assert.throws(() => validateCreateRequestInput({ ...base, affectedPageCount: bad }), (e) => e.field === 'affectedPageCount', String(bad));
    }
    assert.equal(validateCreateRequestInput({ ...base, affectedPageCount: undefined }).affectedPageCount, null);
    assert.equal(validateCreateRequestInput({ ...base, affectedPageCount: 0 }).affectedPageCount, 0);
  });

  test('pageUrl must be http(s)', () => {
    assert.equal(validateCreateRequestInput({ ...base, pageUrl: 'https://example.com/a' }).pageUrl, 'https://example.com/a');
    for (const bad of ['javascript:alert(1)', 'ftp://x.com', 'not a url']) {
      assert.throws(() => validateCreateRequestInput({ ...base, pageUrl: bad }), (e) => e.field === 'pageUrl', bad);
    }
  });

  test('tolerates a non-object body', () => {
    assert.throws(() => validateCreateRequestInput(null), (e) => e.field === 'requestType');
    assert.throws(() => validateCreateRequestInput('x'), (e) => e.field === 'requestType');
  });
});

// ── Availability of the non-request actions ────────────────────────────────
describe('service availability (pure)', () => {
  test('Monthly Maintenance is never reported as available (no such service exists)', () => {
    assert.deepEqual(getMaintenanceAvailability(), { available: false, reason: 'NOT_OFFERED' });
  });

  test('strategy call: unset / blank => not configured', () => {
    assert.deepEqual(getStrategyCallAvailability({}), { available: false, reason: 'NOT_CONFIGURED', url: null });
    assert.equal(getStrategyCallAvailability({ AUDITIQ_BOOKING_URL: '   ' }).available, false);
  });

  test('strategy call: only a plain https URL is accepted', () => {
    const ok = getStrategyCallAvailability({ AUDITIQ_BOOKING_URL: 'https://cal.example.com/odito/strategy' });
    assert.equal(ok.available, true);
    assert.equal(ok.url, 'https://cal.example.com/odito/strategy');
    for (const bad of ['http://cal.example.com/x', 'javascript:alert(1)', 'https://user:pw@cal.example.com/x', 'cal.example.com/x', 'ftp://cal.example.com']) {
      assert.equal(getStrategyCallAvailability({ AUDITIQ_BOOKING_URL: bad }).available, false, bad);
    }
  });
});

describe('AuditIqRequestAdminNotification template', () => {
  test('renders request details and escapes user-written text', async () => {
    const html = await render(React.createElement(AuditIqRequestAdminNotification, {
      requestType: 'expert_fix', issueTitle: 'Missing <b>title</b>', issueKey: 'title_missing', affectedPageCount: 7,
      projectName: 'Acme', projectUrl: 'https://acme.test', contactEmail: 'a@acme.test', requestId: 'abc123',
      message: '<script>alert(1)</script> please help',
    }));
    assert.match(html, /Expert Fix/);
    assert.match(html, /abc123/);
    assert.ok(!html.includes('<script>alert(1)</script>'), 'raw script tag must not appear');
    assert.ok(!html.includes('Missing <b>title</b>'), 'raw markup in the issue title must not appear');
  });
});

// ── HTTP-level: the real router, real auth, real access checks, live Mongo ──
let mongoAvailable = false;
let server;
let baseUrl;
let userA; let userB; let tokenA; let tokenB; let projectA; let projectB;

before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
  } catch {
    mongoAvailable = false;
    return;
  }
  const app = express();
  app.use(express.json());
  app.use('/api/auditiq', auditIqRoutes);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/auditiq`;
});

after(async () => {
  if (mongoAvailable) {
    await AuditIqServiceRequest.deleteMany({ projectName: new RegExp(MARK) });
    await SeoProject.deleteMany({ project_name: new RegExp(MARK) });
    await User.deleteMany({ email: new RegExp(MARK) });
    await mongoose.connection.close();
  }
  if (server) await new Promise((resolve) => server.close(resolve));
});

let seq = 0;
// Fresh users/projects per test: the rate limiter is keyed per user, so tests must not share one.
beforeEach(async () => {
  if (!mongoAvailable) return;
  seq += 1;
  userA = await User.create({ firstName: 'Ann', lastName: 'Owner', email: `a${seq}-${MARK}@example.com`, password: 'Passw0rd!long', roleId: 5 });
  userB = await User.create({ firstName: 'Bob', lastName: 'Other', email: `b${seq}-${MARK}@example.com`, password: 'Passw0rd!long', roleId: 5 });
  tokenA = signAuthToken(userA);
  tokenB = signAuthToken(userB);
  projectA = await SeoProject.create({ user_id: userA._id, project_name: `${MARK}-A${seq}`, main_url: 'https://a.example.com', seo_scope: 'local', keywords: ['k'] });
  projectB = await SeoProject.create({ user_id: userB._id, project_name: `${MARK}-B${seq}`, main_url: 'https://b.example.com', seo_scope: 'local', keywords: ['k'] });
});

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json };
}

const goodBody = (extra = {}) => ({
  projectId: String(projectA._id), requestType: 'express_fix', issueKey: 'title_missing', issueTitle: 'Missing title',
  issueCategory: 'On-Page', affectedPageCount: 4, ...extra,
});

describe('AuditIQ service-request API (real router + live Mongo)', () => {
  test('rejects unauthenticated reads and writes with 401', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    assert.equal((await call('GET', `/service-requests?projectId=${projectA._id}&issueKey=x`)).status, 401);
    assert.equal((await call('POST', '/service-requests', { body: goodBody() })).status, 401);
  });

  test("another user cannot read or create requests on someone else's project (403), nothing is written", async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const read = await call('GET', `/service-requests?projectId=${projectA._id}&issueKey=title_missing`, { token: tokenB });
    assert.equal(read.status, 403);
    const write = await call('POST', '/service-requests', { token: tokenB, body: goodBody() });
    assert.equal(write.status, 403);
    assert.equal(await AuditIqServiceRequest.countDocuments({ projectId: projectA._id }), 0);
  });

  test('malformed or missing projectId is a clean 400, not a 500', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const bad = await call('POST', '/service-requests', { token: tokenA, body: goodBody({ projectId: 'not-an-id' }) });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.field, 'projectId');
    const objectInjection = await call('POST', '/service-requests', { token: tokenA, body: goodBody({ projectId: { $ne: null } }) });
    assert.equal(objectInjection.status, 400);
    const missing = await call('GET', '/service-requests?issueKey=x', { token: tokenA });
    assert.equal(missing.status, 400);
  });

  test('GET before any request: no requests, maintenance unavailable, booking not configured', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const { status, json } = await call('GET', `/service-requests?projectId=${projectA._id}&issueKey=title_missing`, { token: tokenA });
    assert.equal(status, 200);
    assert.deepEqual(json.data.requests, { express_fix: null, technical_audit_fix: null, expert_fix: null });
    assert.deepEqual(json.data.services.maintenance, { available: false, reason: 'NOT_OFFERED' });
    assert.deepEqual(json.data.services.strategyCall, { available: false, reason: 'NOT_CONFIGURED', url: null });
  });

  test('GET requires an issueKey', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const { status, json } = await call('GET', `/service-requests?projectId=${projectA._id}`, { token: tokenA });
    assert.equal(status, 400);
    assert.equal(json.field, 'issueKey');
  });

  test('creates a request: 201, persisted as "submitted", owner/contact come from the account', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const { status, json } = await call('POST', '/service-requests', { token: tokenA, body: goodBody() });
    assert.equal(status, 201);
    assert.equal(json.success, true);
    assert.equal(json.data.status, 'submitted');
    assert.equal(json.data.isOpen, true);
    assert.equal(json.data.affectedPageCount, 4);
    // Customer payload never carries owner/contact/internal fields.
    for (const leaked of ['userId', 'contactEmail', 'contactName', 'staffNotified', 'projectId']) {
      assert.equal(leaked in json.data, false, `${leaked} must not be returned`);
    }
    const doc = await AuditIqServiceRequest.findById(json.data.id).lean();
    assert.equal(String(doc.userId), String(userA._id));
    assert.equal(String(doc.projectId), String(projectA._id));
    assert.equal(doc.contactEmail, userA.email);
    assert.equal(doc.contactName, 'Ann Owner');
    assert.equal(doc.projectName, projectA.project_name);
    assert.equal(doc.staffNotified, false); // no recipient configured in this test run
  });

  test('client cannot inject ownership or lifecycle fields', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const { status, json } = await call('POST', '/service-requests', {
      token: tokenA, body: goodBody({ userId: String(userB._id), status: 'completed', isOpen: false, staffNotified: true }),
    });
    assert.equal(status, 201);
    const doc = await AuditIqServiceRequest.findById(json.data.id).lean();
    assert.equal(String(doc.userId), String(userA._id));
    assert.equal(doc.status, 'submitted');
    assert.equal(doc.isOpen, true);
    assert.equal(doc.staffNotified, false);
  });

  test('duplicate open request of the same type is a 409 that returns the existing one; one row only', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const first = await call('POST', '/service-requests', { token: tokenA, body: goodBody() });
    const second = await call('POST', '/service-requests', { token: tokenA, body: goodBody() });
    assert.equal(first.status, 201);
    assert.equal(second.status, 409);
    assert.equal(second.json.code, 'DUPLICATE_OPEN_REQUEST');
    assert.equal(second.json.data.id, first.json.data.id);
    assert.equal(await AuditIqServiceRequest.countDocuments({ projectId: projectA._id }), 1);
  });

  test('simultaneous submissions create exactly one request (unique index, not just a pre-check)', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    await AuditIqServiceRequest.syncIndexes();
    const results = await Promise.all(Array.from({ length: 6 }, () => call('POST', '/service-requests', { token: tokenA, body: goodBody({ requestType: 'technical_audit_fix' }) })));
    const statuses = results.map((r) => r.status).sort();
    assert.equal(statuses.filter((s) => s === 201).length, 1, JSON.stringify(statuses));
    assert.equal(statuses.filter((s) => s === 409).length, 5, JSON.stringify(statuses));
    assert.equal(await AuditIqServiceRequest.countDocuments({ projectId: projectA._id, requestType: 'technical_audit_fix' }), 1);
  });

  test('different request types and different issues do not block each other', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const a = await call('POST', '/service-requests', { token: tokenA, body: goodBody({ requestType: 'express_fix' }) });
    const b = await call('POST', '/service-requests', { token: tokenA, body: goodBody({ requestType: 'technical_audit_fix' }) });
    const c = await call('POST', '/service-requests', { token: tokenA, body: goodBody({ requestType: 'expert_fix', message: 'Please help with this one' }) });
    const d = await call('POST', '/service-requests', { token: tokenA, body: goodBody({ issueKey: 'h1_missing' }) });
    assert.deepEqual([a.status, b.status, c.status, d.status], [201, 201, 201, 201]);
  });

  test('a completed request no longer blocks a new one, and GET reports the true status', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const first = await call('POST', '/service-requests', { token: tokenA, body: goodBody() });
    // Staff-side transition (no customer endpoint can do this). Use save() so the isOpen hook runs.
    const doc = await AuditIqServiceRequest.findById(first.json.data.id);
    doc.status = 'in_progress';
    await doc.save();
    let state = await call('GET', `/service-requests?projectId=${projectA._id}&issueKey=title_missing`, { token: tokenA });
    assert.equal(state.json.data.requests.express_fix.status, 'in_progress');
    assert.equal(state.json.data.requests.express_fix.isOpen, true);
    assert.equal((await call('POST', '/service-requests', { token: tokenA, body: goodBody() })).status, 409);

    doc.status = 'completed';
    await doc.save();
    assert.equal(doc.isOpen, false);
    state = await call('GET', `/service-requests?projectId=${projectA._id}&issueKey=title_missing`, { token: tokenA });
    assert.equal(state.json.data.requests.express_fix.status, 'completed');
    assert.equal(state.json.data.requests.express_fix.isOpen, false);

    const again = await call('POST', '/service-requests', { token: tokenA, body: goodBody() });
    assert.equal(again.status, 201);
    state = await call('GET', `/service-requests?projectId=${projectA._id}&issueKey=title_missing`, { token: tokenA });
    assert.equal(state.json.data.requests.express_fix.id, again.json.data.id, 'newest request is the one reported');
  });

  test('expert_fix validation errors are structured 400s and write nothing', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const noMessage = await call('POST', '/service-requests', { token: tokenA, body: goodBody({ requestType: 'expert_fix' }) });
    assert.equal(noMessage.status, 400);
    assert.equal(noMessage.json.code, 'VALIDATION_ERROR');
    assert.equal(noMessage.json.field, 'message');
    const badType = await call('POST', '/service-requests', { token: tokenA, body: goodBody({ requestType: 'monthly_maintenance' }) });
    assert.equal(badType.status, 400);
    assert.equal(await AuditIqServiceRequest.countDocuments({ projectId: projectA._id }), 0);
  });

  test('requests are scoped per project: B reading its own project sees nothing of A', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    await call('POST', '/service-requests', { token: tokenA, body: goodBody() });
    const { json } = await call('GET', `/service-requests?projectId=${projectB._id}&issueKey=title_missing`, { token: tokenB });
    assert.equal(json.data.requests.express_fix, null);
  });

  test('a configured booking URL is returned; a bad one is not', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    process.env.AUDITIQ_BOOKING_URL = 'https://cal.example.com/odito/strategy';
    try {
      const ok = await call('GET', `/service-requests?projectId=${projectA._id}&issueKey=x`, { token: tokenA });
      assert.deepEqual(ok.json.data.services.strategyCall, { available: true, reason: null, url: 'https://cal.example.com/odito/strategy' });
      process.env.AUDITIQ_BOOKING_URL = 'http://insecure.example.com';
      const bad = await call('GET', `/service-requests?projectId=${projectA._id}&issueKey=x`, { token: tokenA });
      assert.equal(bad.json.data.services.strategyCall.available, false);
    } finally {
      delete process.env.AUDITIQ_BOOKING_URL;
    }
  });

  test('writes are rate limited per user (429 with a structured body); another user is unaffected', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const statuses = [];
    for (let i = 0; i < 32; i += 1) {
      // validation failures still count toward the limit, and write nothing
      statuses.push((await call('POST', '/service-requests', { token: tokenA, body: goodBody({ requestType: 'nope' }) })).status);
    }
    assert.equal(statuses.filter((s) => s === 400).length, 30);
    assert.equal(statuses.filter((s) => s === 429).length, 2);
    const limited = await call('POST', '/service-requests', { token: tokenA, body: goodBody() });
    assert.equal(limited.status, 429);
    assert.equal(limited.json.code, 'RATE_LIMITED');
    const other = await call('POST', '/service-requests', { token: tokenB, body: goodBody({ projectId: String(projectB._id) }) });
    assert.equal(other.status, 201);
  });

  test('responses never include stack traces or internal error text', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const { json } = await call('POST', '/service-requests', { token: tokenA, body: goodBody({ requestType: 'expert_fix', message: 'x' }) });
    const text = JSON.stringify(json);
    assert.ok(!/stack|mongoose|MongoServerError|at \w+ \(/i.test(text), text);
  });
});
