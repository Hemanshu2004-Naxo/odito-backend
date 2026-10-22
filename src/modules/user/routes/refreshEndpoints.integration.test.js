import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import 'dotenv/config';
import mongoose from 'mongoose';
import express from 'express';
import apiRoutes from '../../../routes/index.js';
import User from '../model/User.js';
import RefreshToken from '../model/RefreshToken.js';
import { signAccessToken } from '../service/tokenService.js';

/**
 * Real Express app mounting the real /api router (so the real middleware
 * chain, validators and limiters run), real MongoDB, Node's built-in fetch.
 * Every case early-returns as a no-op pass if Mongo is unreachable.
 */
let server;
let base;
let mongoAvailable = false;
let userA;
let userB;

before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
  } catch { mongoAvailable = false; }

  const app = express();
  app.use(express.json());
  app.use('/api', apiRoutes);
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;

  if (mongoAvailable) {
    userA = await User.create({ firstName: 'Ep', lastName: 'A', email: `ep-a-${Date.now()}@example.com`, password: 'password123', roleId: 5, isActive: true, isEmailVerified: true });
    userB = await User.create({ firstName: 'Ep', lastName: 'B', email: `ep-b-${Date.now()}@example.com`, password: 'password123', roleId: 5, isActive: true, isEmailVerified: true });
  }
});

after(async () => {
  server?.close();
  if (!mongoAvailable) return;
  await RefreshToken.deleteMany({ userId: { $in: [userA?._id, userB?._id].filter(Boolean) } });
  await User.deleteMany({ _id: { $in: [userA?._id, userB?._id].filter(Boolean) } });
  await mongoose.connection.close();
});

beforeEach(async () => {
  delete process.env.AUTH_RATE_LIMIT_ENABLED;
  if (mongoAvailable) await RefreshToken.deleteMany({ userId: { $in: [userA._id, userB._id] } });
});

const post = (path, body, headers) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(headers || {}) }, body: JSON.stringify(body || {}) });
const get = (path, headers) => fetch(base + path, { headers: headers || {} });

async function loginAs(u, extra = {}) {
  const r = await post('/api/auth/login', { email: u.email, password: 'password123', ...extra });
  assert.equal(r.status, 200, `login failed: ${r.status}`);
  return (await r.json()).data;
}

// ── login response ──────────────────────────────────────────────────────
describe('POST /api/auth/login — issues BOTH the legacy token and the mobile bundle', () => {
  test('data.token (legacy) AND data.tokens {accessToken, refreshToken, tokenType, expiresIn}; user block preserved', async () => {
    if (!mongoAvailable) return;
    const data = await loginAs(userA, { rememberMe: true, deviceLabel: 'Jane iPhone 15' });

    assert.equal(typeof data.token, 'string', 'legacy data.token preserved for the web');
    assert.deepEqual(Object.keys(data.tokens).sort(), ['accessToken', 'expiresIn', 'refreshToken', 'tokenType'].sort());
    assert.equal(data.tokens.tokenType, 'Bearer');
    assert.equal(data.tokens.expiresIn, 1800);
    assert.notEqual(data.tokens.accessToken, data.token, 'mobile access token is a DIFFERENT token from the legacy one');
    // existing user fields still there
    for (const k of ['id', 'email', 'roleId', 'subscription', 'hasProjects', 'redirectTo', 'isEmailVerified']) {
      assert.ok(k in data.user, `data.user.${k} missing`);
    }
    // refresh token persisted, hashed, with device metadata
    const rows = await RefreshToken.find({ userId: userA._id }).lean();
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].tokenHash, data.tokens.refreshToken);
    assert.equal(rows[0].deviceLabel, 'Jane iPhone 15');
    assert.ok(rows[0].userAgent === null || typeof rows[0].userAgent === 'string');
  });
});

// ── refresh ─────────────────────────────────────────────────────────────
describe('POST /api/auth/refresh', () => {
  test('missing token -> 400 REFRESH_TOKEN_REQUIRED', async () => {
    if (!mongoAvailable) return;
    const r = await post('/api/auth/refresh', {});
    assert.equal(r.status, 400);
    assert.equal((await r.json()).code, 'REFRESH_TOKEN_REQUIRED');
  });

  test('valid -> 200 with a fresh pair; old token then rejected; response exposes no DB fields', async () => {
    if (!mongoAvailable) return;
    const { tokens } = await loginAs(userA);
    const r = await post('/api/auth/refresh', { refreshToken: tokens.refreshToken });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.deepEqual(Object.keys(body).sort(), ['data', 'success'].sort());
    assert.deepEqual(Object.keys(body.data).sort(), ['accessToken', 'expiresIn', 'refreshToken', 'tokenType'].sort());
    assert.notEqual(body.data.refreshToken, tokens.refreshToken);

    const reuse = await post('/api/auth/refresh', { refreshToken: tokens.refreshToken });
    assert.equal(reuse.status, 401);
  });

  test('garbage / unknown token -> 401 REFRESH_TOKEN_INVALID', async () => {
    if (!mongoAvailable) return;
    const r = await post('/api/auth/refresh', { refreshToken: 'not-a-real-token' });
    assert.equal(r.status, 401);
    assert.equal((await r.json()).code, 'REFRESH_TOKEN_INVALID');
  });

  test('reuse of a rotated token (past grace) -> 401 REFRESH_TOKEN_REUSE + whole family dead', async () => {
    if (!mongoAvailable) return;
    const { tokens } = await loginAs(userA);
    const r1 = await post('/api/auth/refresh', { refreshToken: tokens.refreshToken });
    const next = (await r1.json()).data.refreshToken;

    const A = await RefreshToken.findOne({ userId: userA._id, revokedReason: 'rotation' });
    await RefreshToken.updateOne({ _id: A._id }, { $set: { revokedAt: new Date(Date.now() - 60_000) } });

    const reuse = await post('/api/auth/refresh', { refreshToken: tokens.refreshToken });
    assert.equal(reuse.status, 401);
    assert.equal((await reuse.json()).code, 'REFRESH_TOKEN_REUSE');

    const afterFamilyKill = await post('/api/auth/refresh', { refreshToken: next });
    assert.equal(afterFamilyKill.status, 401, 'the good descendant is revoked too');
  });

  test('suspended user cannot refresh -> 403 ACCOUNT_SUSPENDED', async () => {
    if (!mongoAvailable) return;
    const { tokens } = await loginAs(userA);
    await User.updateOne({ _id: userA._id }, { $set: { isActive: false } });
    try {
      const r = await post('/api/auth/refresh', { refreshToken: tokens.refreshToken });
      assert.equal(r.status, 403);
      assert.equal((await r.json()).code, 'ACCOUNT_SUSPENDED');
    } finally {
      await User.updateOne({ _id: userA._id }, { $set: { isActive: true } });
    }
  });

  test('a refresh token is NOT accepted as a Bearer access token', async () => {
    if (!mongoAvailable) return;
    const { tokens } = await loginAs(userA);
    const r = await get('/api/auth/profile', { authorization: `Bearer ${tokens.refreshToken}` });
    assert.equal(r.status, 401);
  });

  test('the mobile access token IS accepted on a protected route', async () => {
    if (!mongoAvailable) return;
    const { tokens } = await loginAs(userA);
    const r = await get('/api/auth/profile', { authorization: `Bearer ${tokens.accessToken}` });
    assert.equal(r.status, 200);
  });

  test('rate limited: many refreshes with the same token -> 429 + Retry-After + code RATE_LIMITED', async () => {
    if (!mongoAvailable) return;
    const { tokens } = await loginAs(userA);
    // Default AUTH_REFRESH_MAX = 30; reuse the SAME (now invalid) token so
    // every call is counted and keyed identically.
    let blocked;
    for (let i = 0; i < 40; i++) {
      // eslint-disable-next-line no-await-in-loop
      const r = await post('/api/auth/refresh', { refreshToken: tokens.refreshToken });
      if (r.status === 429) { blocked = r; break; }
    }
    assert.ok(blocked, 'expected a 429 within 40 attempts');
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    assert.equal((await blocked.json()).code, 'RATE_LIMITED');
  });
});

// ── logout ──────────────────────────────────────────────────────────────
describe('POST /api/auth/logout', () => {
  test('revokes the presented refresh token (a later refresh 401s); still HTTP 200 with a JSON body', async () => {
    if (!mongoAvailable) return;
    const { tokens } = await loginAs(userA);
    const r = await post('/api/auth/logout', { refreshToken: tokens.refreshToken }, { authorization: `Bearer ${tokens.accessToken}` });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).success, true);

    const refresh = await post('/api/auth/refresh', { refreshToken: tokens.refreshToken });
    assert.equal(refresh.status, 401);
    assert.equal((await refresh.json()).code, 'REFRESH_TOKEN_REVOKED');
  });

  test('no refreshToken in the body (the web case) -> 200, nothing revoked', async () => {
    if (!mongoAvailable) return;
    const { tokens } = await loginAs(userA);
    const r = await post('/api/auth/logout', {}, { authorization: `Bearer ${tokens.accessToken}` });
    assert.equal(r.status, 200);
    // the session is untouched
    const still = await post('/api/auth/refresh', { refreshToken: tokens.refreshToken });
    assert.equal(still.status, 200);
  });

  test('no access token -> 401 (Bearer auth now required)', async () => {
    if (!mongoAvailable) return;
    const r = await post('/api/auth/logout', {});
    assert.equal(r.status, 401);
  });

  test('user B\'s access token + user A\'s refresh token -> 403 REFRESH_TOKEN_MISMATCH; A\'s token NOT revoked', async () => {
    if (!mongoAvailable) return;
    const a = await loginAs(userA);
    const b = await loginAs(userB);
    const r = await post('/api/auth/logout', { refreshToken: a.tokens.refreshToken }, { authorization: `Bearer ${b.tokens.accessToken}` });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).code, 'REFRESH_TOKEN_MISMATCH');
    // A can still refresh
    const still = await post('/api/auth/refresh', { refreshToken: a.tokens.refreshToken });
    assert.equal(still.status, 200);
  });
});

// ── logout-all ──────────────────────────────────────────────────────────
describe('POST /api/auth/logout-all', () => {
  test('revokes EVERY active refresh session for the caller (not other users)', async () => {
    if (!mongoAvailable) return;
    const s1 = await loginAs(userA, { deviceLabel: 'phone' });
    const s2 = await loginAs(userA, { deviceLabel: 'tablet' });
    const bOther = await loginAs(userB);

    const r = await post('/api/auth/logout-all', {}, { authorization: `Bearer ${s1.tokens.accessToken}` });
    assert.equal(r.status, 200);
    assert.ok((await r.json()).data.revokedCount >= 2);

    assert.equal((await post('/api/auth/refresh', { refreshToken: s1.tokens.refreshToken })).status, 401);
    assert.equal((await post('/api/auth/refresh', { refreshToken: s2.tokens.refreshToken })).status, 401);
    assert.equal((await post('/api/auth/refresh', { refreshToken: bOther.tokens.refreshToken })).status, 200, 'user B unaffected');
  });

  test('no access token -> 401', async () => {
    if (!mongoAvailable) return;
    assert.equal((await post('/api/auth/logout-all', {})).status, 401);
  });
});

// ── password change / reset revoke refresh sessions ─────────────────────
describe('password change / reset revoke refresh sessions (§18)', () => {
  test('change-password revokes the user\'s refresh tokens', async () => {
    if (!mongoAvailable) return;
    // fresh user so the password change here doesn't disturb the shared fixtures
    const u = await User.create({ firstName: 'Pw', lastName: 'C', email: `pw-c-${Date.now()}@example.com`, password: 'password123', roleId: 5, isActive: true, isEmailVerified: true });
    try {
      const login = await post('/api/auth/login', { email: u.email, password: 'password123' });
      const { tokens } = (await login.json()).data;

      const chg = await post('/api/auth/change-password',
        { currentPassword: 'password123', newPassword: 'newpassword456', confirmPassword: 'newpassword456' },
        { authorization: `Bearer ${tokens.accessToken}` });
      assert.equal(chg.status, 200);

      const refresh = await post('/api/auth/refresh', { refreshToken: tokens.refreshToken });
      assert.equal(refresh.status, 401, 'refresh token no longer valid after password change');
      const row = await RefreshToken.findOne({ userId: u._id });
      assert.equal(row.revokedReason, 'password_changed');
    } finally {
      await RefreshToken.deleteMany({ userId: u._id });
      await User.deleteOne({ _id: u._id });
    }
  });
});

// ── middleware token-type / issuer / audience guards ────────────────────
describe('auth middleware — token shape guards (via GET /api/auth/profile)', () => {
  test('legacy web token (data.token, no type/iss/aud) is accepted', async () => {
    if (!mongoAvailable) return;
    const data = await loginAs(userA);
    const r = await get('/api/auth/profile', { authorization: `Bearer ${data.token}` });
    assert.equal(r.status, 200);
  });

  test('mobile access token (type:access, iss, aud) is accepted', async () => {
    if (!mongoAvailable) return;
    const r = await get('/api/auth/profile', { authorization: `Bearer ${signAccessToken(userA)}` });
    assert.equal(r.status, 200);
  });

  test('a JWT that declares type:"refresh" is rejected', async () => {
    if (!mongoAvailable) return;
    const jwt = (await import('jsonwebtoken')).default;
    const bad = jwt.sign({ id: String(userA._id), roleId: 5, tokenVersion: 0, type: 'refresh' }, process.env.JWT_SECRET, { expiresIn: '5m' });
    const r = await get('/api/auth/profile', { authorization: `Bearer ${bad}` });
    assert.equal(r.status, 401);
    assert.equal((await r.json()).code, 'INVALID_TOKEN_TYPE');
  });

  test('a JWT with the wrong issuer / audience is rejected', async () => {
    if (!mongoAvailable) return;
    const jwt = (await import('jsonwebtoken')).default;
    const wrongIss = jwt.sign({ id: String(userA._id), roleId: 5, tokenVersion: 0, type: 'access' }, process.env.JWT_SECRET, { expiresIn: '5m', issuer: 'evil', audience: 'odito-mobile' });
    const wrongAud = jwt.sign({ id: String(userA._id), roleId: 5, tokenVersion: 0, type: 'access' }, process.env.JWT_SECRET, { expiresIn: '5m', issuer: 'odito', audience: 'somewhere-else' });
    assert.equal((await get('/api/auth/profile', { authorization: `Bearer ${wrongIss}` })).status, 401);
    assert.equal((await get('/api/auth/profile', { authorization: `Bearer ${wrongAud}` })).status, 401);
  });
});
