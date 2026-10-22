import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import 'dotenv/config';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import auth from './auth.js';
import User from '../model/User.js';
import { signAuthToken } from '../service/tokenService.js';

/**
 * Real `auth` middleware, mock req/res (repo convention — "no supertest/HTTP
 * layer exists anywhere in this repo"). Real MongoDB for the user lookup;
 * DB-dependent cases early-return (no-op pass) when Mongo is unreachable.
 *
 * Invoke the real async `auth` middleware and resolve as soon as it either
 * calls next() (pass) or sends a response (reject path). 5s safety timeout.
 */
const call = (req) => new Promise((resolve) => {
  let done = false;
  const finish = (payload) => { if (!done) { done = true; resolve(payload); } };
  const res = {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; finish({ res, nextCalled: false, req }); return this; },
  };
  auth(req, res, () => finish({ res, nextCalled: true, req }));
  setTimeout(() => finish({ res, nextCalled: false, req, timedOut: true }), 5000);
});

let mongoAvailable = false;
let activeUser;
let suspendedUser;

before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
  } catch { mongoAvailable = false; return; }

  activeUser = await User.create({
    firstName: 'Mw', lastName: 'Active',
    email: `mw-active-${Date.now()}@example.com`,
    password: 'password123', roleId: 5, isActive: true, isEmailVerified: true,
  });
  suspendedUser = await User.create({
    firstName: 'Mw', lastName: 'Susp',
    email: `mw-susp-${Date.now()}@example.com`,
    password: 'password123', roleId: 5, isActive: false, isEmailVerified: true,
  });
});

after(async () => {
  if (!mongoAvailable) return;
  await User.deleteMany({ _id: { $in: [activeUser?._id, suspendedUser?._id].filter(Boolean) } });
  await mongoose.connection.close();
});

describe('auth middleware — hardening (M1 / §9 / L1 / tokenVersion)', () => {
  test('no Authorization header -> 401', async () => {
    const { res, nextCalled } = await call({ headers: {} });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.match(res.body.message, /no token/i);
  });

  test('malformed / bad-signature token -> 401 "Invalid token."', async () => {
    const { res } = await call({ headers: { authorization: 'Bearer not.a.jwt' } });
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.message, 'Invalid token.');
  });

  test('expired token -> 401', async () => {
    const expired = jwt.sign({ id: '65f0000000000000000000aa' }, process.env.JWT_SECRET, { expiresIn: '-1s' });
    const { res } = await call({ headers: { authorization: `Bearer ${expired}` } });
    assert.equal(res.statusCode, 401);
  });

  test('valid token -> next(), req.user attached WITHOUT the password hash (M1)', async () => {
    if (!mongoAvailable) return;
    const token = signAuthToken(activeUser);
    const { nextCalled, req } = await call({ headers: { authorization: `Bearer ${token}` } });
    assert.equal(nextCalled, true);
    assert.equal(String(req.user._id), String(activeUser._id));
    assert.equal(req.user.password, undefined, 'password hash must never reach req.user');
    // Defensive: the serialized user must not carry it either.
    assert.ok(!('password' in JSON.parse(JSON.stringify(req.user))));
  });

  test('valid token but the user no longer exists -> 401 (was 404), code AUTH_USER_NOT_FOUND', async () => {
    if (!mongoAvailable) return;
    const ghost = signAuthToken({ _id: new mongoose.Types.ObjectId(), roleId: 5, tokenVersion: 0 });
    const { res } = await call({ headers: { authorization: `Bearer ${ghost}` } });
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.code, 'AUTH_USER_NOT_FOUND');
  });

  test('suspended user -> 403 (existing token stops working immediately)', async () => {
    if (!mongoAvailable) return;
    const token = signAuthToken(suspendedUser);
    const { res } = await call({ headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.statusCode, 403);
    assert.match(res.body.message, /suspended/i);
  });

  test('token minted before a password change (stale tokenVersion) -> 401 TOKEN_REVOKED', async () => {
    if (!mongoAvailable) return;
    const staleToken = signAuthToken(activeUser); // carries current tokenVersion (0)
    await User.updateOne({ _id: activeUser._id }, { $inc: { tokenVersion: 1 } }); // simulate change-password
    const { res } = await call({ headers: { authorization: `Bearer ${staleToken}` } });
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.code, 'TOKEN_REVOKED');
    // reset for any other test
    await User.updateOne({ _id: activeUser._id }, { $set: { tokenVersion: 0 } });
  });

  test('legacy token with NO tokenVersion claim still authenticates a v0 user (no forced logout on deploy)', async () => {
    if (!mongoAvailable) return;
    const legacy = jwt.sign({ id: String(activeUser._id) }, process.env.JWT_SECRET, { expiresIn: '7d' });
    const { nextCalled, res } = await call({ headers: { authorization: `Bearer ${legacy}` } });
    assert.equal(nextCalled, true, `expected pass-through, got ${res.statusCode} ${JSON.stringify(res.body)}`);
  });
});
