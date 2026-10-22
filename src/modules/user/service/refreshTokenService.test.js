import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import 'dotenv/config';
import mongoose from 'mongoose';
import User from '../model/User.js';
import RefreshToken from '../model/RefreshToken.js';
import {
  generateOpaqueToken,
  hashRefreshToken,
  detectReuse,
  sanitizeDeviceLabel,
  issueRefreshToken,
  issueSessionBundle,
  rotateRefreshToken,
  revokeRefreshTokenForUser,
  revokeFamily,
  revokeUserRefreshTokens,
  ROTATION_GRACE_MS,
} from './refreshTokenService.js';
import { verifyAuthToken } from './tokenService.js';

let mongoAvailable = false;
let user;
let otherUser;

before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
  } catch { mongoAvailable = false; return; }
  user = await User.create({ firstName: 'Rt', lastName: 'One', email: `rt-one-${Date.now()}@example.com`, password: 'password123', roleId: 5, isActive: true, isEmailVerified: true });
  otherUser = await User.create({ firstName: 'Rt', lastName: 'Two', email: `rt-two-${Date.now()}@example.com`, password: 'password123', roleId: 5, isActive: true, isEmailVerified: true });
});

after(async () => {
  if (!mongoAvailable) return;
  await RefreshToken.deleteMany({ userId: { $in: [user?._id, otherUser?._id].filter(Boolean) } });
  await User.deleteMany({ _id: { $in: [user?._id, otherUser?._id].filter(Boolean) } });
  await mongoose.connection.close();
});

beforeEach(async () => {
  if (mongoAvailable) await RefreshToken.deleteMany({ userId: { $in: [user._id, otherUser._id] } });
});

// ── pure ────────────────────────────────────────────────────────────────
describe('refreshTokenService — token primitives', () => {
  test('generateOpaqueToken: 256-bit, URL-safe, unique', () => {
    const a = generateOpaqueToken();
    const b = generateOpaqueToken();
    assert.match(a, /^[A-Za-z0-9_-]+$/);
    assert.ok(Buffer.from(a, 'base64url').length >= 32);
    assert.notEqual(a, b);
  });

  test('hashRefreshToken: SHA-256 hex, deterministic, not the plaintext', () => {
    const t = generateOpaqueToken();
    assert.match(hashRefreshToken(t), /^[0-9a-f]{64}$/);
    assert.equal(hashRefreshToken(t), hashRefreshToken(t));
    assert.notEqual(hashRefreshToken(t), t);
  });

  test('detectReuse: true only for a rotation-revoked record', () => {
    assert.equal(detectReuse({ revokedAt: new Date(), revokedReason: 'rotation' }), true);
    assert.equal(detectReuse({ revokedAt: new Date(), revokedReason: 'logout' }), false);
    assert.equal(detectReuse({ revokedAt: null }), false);
    assert.equal(detectReuse(null), false);
  });

  test('sanitizeDeviceLabel: trims, length-bounds, empties to null', () => {
    assert.equal(sanitizeDeviceLabel('  Jane iPhone  '), 'Jane iPhone');
    assert.equal(sanitizeDeviceLabel(''), null);
    assert.equal(sanitizeDeviceLabel('   '), null);
    assert.equal(sanitizeDeviceLabel(123), null);
    assert.equal(sanitizeDeviceLabel('x'.repeat(300)).length, 120);
  });
});

// ── generation ──────────────────────────────────────────────────────────
describe('issueRefreshToken', () => {
  test('stores only the hash, sets familyId + expiry + metadata', async () => {
    if (!mongoAvailable) return;
    const { plaintext, record } = await issueRefreshToken({
      userId: user._id, rememberMe: true,
      deviceLabel: 'Jane Pixel 8', userAgent: 'okhttp/4', ipAddress: '203.0.113.9',
      tokenVersionAtIssue: 0,
    });
    assert.match(plaintext, /^[A-Za-z0-9_-]+$/);
    const row = await RefreshToken.findById(record._id).lean();
    assert.equal(row.tokenHash, hashRefreshToken(plaintext));
    assert.notEqual(row.tokenHash, plaintext);
    assert.ok(row.familyId);
    assert.equal(row.deviceLabel, 'Jane Pixel 8');
    assert.equal(row.userAgent, 'okhttp/4');
    assert.equal(row.ipAddress, '203.0.113.9');
    assert.equal(row.revokedAt, null);
    // rememberMe -> ~60d
    assert.ok(row.expiresAt.getTime() - Date.now() > 55 * 86400 * 1000);
  });

  test('rememberMe:false -> shorter (~7d) expiry', async () => {
    if (!mongoAvailable) return;
    const { record } = await issueRefreshToken({ userId: user._id, rememberMe: false });
    const row = await RefreshToken.findById(record._id).lean();
    const days = (row.expiresAt.getTime() - Date.now()) / 86400000;
    assert.ok(days > 6 && days < 8, `expected ~7d, got ${days.toFixed(1)}d`);
  });
});

describe('issueSessionBundle (login)', () => {
  test('returns exactly {accessToken, refreshToken, tokenType, expiresIn} — no DB fields', async () => {
    if (!mongoAvailable) return;
    const bundle = await issueSessionBundle(user, { rememberMe: true, deviceLabel: 'Jane iPhone 15' });
    assert.deepEqual(Object.keys(bundle).sort(), ['accessToken', 'expiresIn', 'refreshToken', 'tokenType'].sort());
    assert.equal(bundle.tokenType, 'Bearer');
    assert.equal(bundle.expiresIn, 30 * 60);
    const decoded = verifyAuthToken(bundle.accessToken);
    assert.equal(decoded.type, 'access');
    assert.equal(String(decoded.id), String(user._id));
    // refresh token persisted, hashed, for this user
    const row = await RefreshToken.findOne({ userId: user._id }).lean();
    assert.equal(row.tokenHash, hashRefreshToken(bundle.refreshToken));
    assert.equal(row.deviceLabel, 'Jane iPhone 15');
  });
});

// ── rotation ────────────────────────────────────────────────────────────
describe('rotateRefreshToken', () => {
  test('valid token -> new access + new refresh; old revoked (rotation) + replacedBy linked; familyId + absolute expiry preserved', async () => {
    if (!mongoAvailable) return;
    const bundle = await issueSessionBundle(user, { rememberMe: true });
    const old = await RefreshToken.findOne({ userId: user._id });

    const rotated = await rotateRefreshToken({ presentedToken: bundle.refreshToken });
    assert.ok(rotated.accessToken && rotated.refreshToken);
    assert.notEqual(rotated.refreshToken, bundle.refreshToken);

    const oldAfter = await RefreshToken.findById(old._id).lean();
    assert.ok(oldAfter.revokedAt);
    assert.equal(oldAfter.revokedReason, 'rotation');
    assert.ok(oldAfter.replacedBy);

    const next = await RefreshToken.findById(oldAfter.replacedBy).lean();
    assert.equal(next.familyId, old.familyId, 'familyId preserved across rotation');
    assert.equal(next.expiresAt.getTime(), old.expiresAt.getTime(), 'absolute family expiry carried forward (no sliding)');
    assert.equal(next.revokedAt, null);
  });

  test('unknown token -> REFRESH_TOKEN_INVALID (401)', async () => {
    if (!mongoAvailable) return;
    await assert.rejects(
      rotateRefreshToken({ presentedToken: generateOpaqueToken() }),
      (e) => e.code === 'REFRESH_TOKEN_INVALID' && e.httpStatus === 401,
    );
  });

  test('expired token -> REFRESH_TOKEN_EXPIRED (401)', async () => {
    if (!mongoAvailable) return;
    const { plaintext, record } = await issueRefreshToken({ userId: user._id });
    await RefreshToken.updateOne({ _id: record._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    await assert.rejects(
      rotateRefreshToken({ presentedToken: plaintext }),
      (e) => e.code === 'REFRESH_TOKEN_EXPIRED' && e.httpStatus === 401,
    );
  });

  test('explicitly revoked token (logout) -> REFRESH_TOKEN_REVOKED (401)', async () => {
    if (!mongoAvailable) return;
    const { plaintext, record } = await issueRefreshToken({ userId: user._id });
    await RefreshToken.updateOne({ _id: record._id }, { $set: { revokedAt: new Date(), revokedReason: 'logout' } });
    await assert.rejects(
      rotateRefreshToken({ presentedToken: plaintext }),
      (e) => e.code === 'REFRESH_TOKEN_REVOKED',
    );
  });

  test('suspended user cannot refresh -> ACCOUNT_SUSPENDED (403) and the family is revoked', async () => {
    if (!mongoAvailable) return;
    const bundle = await issueSessionBundle(user, {});
    await User.updateOne({ _id: user._id }, { $set: { isActive: false } });
    try {
      await assert.rejects(
        rotateRefreshToken({ presentedToken: bundle.refreshToken }),
        (e) => e.code === 'ACCOUNT_SUSPENDED' && e.httpStatus === 403,
      );
      const active = await RefreshToken.countDocuments({ userId: user._id, revokedAt: null });
      assert.equal(active, 0);
    } finally {
      await User.updateOne({ _id: user._id }, { $set: { isActive: true } });
    }
  });

  test('tokenVersion moved on since issue -> REFRESH_TOKEN_REVOKED + family revoked', async () => {
    if (!mongoAvailable) return;
    const { plaintext, record } = await issueRefreshToken({ userId: user._id, tokenVersionAtIssue: 0 });
    await User.updateOne({ _id: user._id }, { $set: { tokenVersion: 5 } });
    try {
      await assert.rejects(
        rotateRefreshToken({ presentedToken: plaintext }),
        (e) => e.code === 'REFRESH_TOKEN_REVOKED',
      );
      const row = await RefreshToken.findById(record._id).lean();
      assert.ok(row.revokedAt);
    } finally {
      await User.updateOne({ _id: user._id }, { $set: { tokenVersion: 0 } });
    }
  });
});

// ── reuse detection ─────────────────────────────────────────────────────
describe('refresh-token REUSE detection', () => {
  test('A -> B, then replay A (past the grace window) -> REFRESH_TOKEN_REUSE and the WHOLE family is revoked', async () => {
    if (!mongoAvailable) return;
    const bundle = await issueSessionBundle(user, { rememberMe: true });
    const A = await RefreshToken.findOne({ userId: user._id });
    const rotated = await rotateRefreshToken({ presentedToken: bundle.refreshToken }); // -> B
    const B = await RefreshToken.findOne({ userId: user._id, revokedAt: null });
    assert.ok(B);

    // simulate the replay happening well after rotation
    await RefreshToken.updateOne({ _id: A._id }, { $set: { revokedAt: new Date(Date.now() - ROTATION_GRACE_MS - 5000) } });

    await assert.rejects(
      rotateRefreshToken({ presentedToken: bundle.refreshToken }),
      (e) => e.code === 'REFRESH_TOKEN_REUSE' && e.httpStatus === 401,
    );

    const familyActive = await RefreshToken.countDocuments({ familyId: A.familyId, revokedAt: null });
    assert.equal(familyActive, 0, 'entire family revoked on reuse');
    const bAfter = await RefreshToken.findById(B._id).lean();
    assert.equal(bAfter.revokedReason, 'reuse_detected');

    // and the "good" descendant no longer works
    await assert.rejects(rotateRefreshToken({ presentedToken: rotated.refreshToken }));
  });

  test('A -> B -> C, then replay A -> the whole family (B and C) is revoked', async () => {
    if (!mongoAvailable) return;
    const bundle = await issueSessionBundle(user, { rememberMe: true });
    const A = await RefreshToken.findOne({ userId: user._id });
    const r1 = await rotateRefreshToken({ presentedToken: bundle.refreshToken }); // B
    const r2 = await rotateRefreshToken({ presentedToken: r1.refreshToken });     // C
    assert.ok(r2.refreshToken);

    await RefreshToken.updateOne({ _id: A._id }, { $set: { revokedAt: new Date(Date.now() - ROTATION_GRACE_MS - 5000) } });
    await assert.rejects(
      rotateRefreshToken({ presentedToken: bundle.refreshToken }),
      (e) => e.code === 'REFRESH_TOKEN_REUSE',
    );
    assert.equal(await RefreshToken.countDocuments({ familyId: A.familyId, revokedAt: null }), 0);
    await assert.rejects(rotateRefreshToken({ presentedToken: r2.refreshToken }), 'C is dead too');
  });

  test('a replay INSIDE the grace window is a benign race: 401 INVALID, family NOT revoked', async () => {
    if (!mongoAvailable) return;
    const bundle = await issueSessionBundle(user, { rememberMe: true });
    const A = await RefreshToken.findOne({ userId: user._id });
    const rotated = await rotateRefreshToken({ presentedToken: bundle.refreshToken }); // -> B, just now

    await assert.rejects(
      rotateRefreshToken({ presentedToken: bundle.refreshToken }),
      (e) => e.code === 'REFRESH_TOKEN_INVALID',
    );
    // B (the winner's token) is still usable
    const familyActive = await RefreshToken.countDocuments({ familyId: A.familyId, revokedAt: null });
    assert.equal(familyActive, 1);
    const r2 = await rotateRefreshToken({ presentedToken: rotated.refreshToken });
    assert.ok(r2.accessToken);
  });
});

// ── concurrency ─────────────────────────────────────────────────────────
describe('concurrent refresh with the SAME token', () => {
  test('exactly one rotation succeeds; the other does not get a session', async () => {
    if (!mongoAvailable) return;
    const bundle = await issueSessionBundle(user, { rememberMe: true });

    const results = await Promise.allSettled([
      rotateRefreshToken({ presentedToken: bundle.refreshToken }),
      rotateRefreshToken({ presentedToken: bundle.refreshToken }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'exactly one rotation succeeded');
    assert.equal(rejected.length, 1);
    assert.ok(['REFRESH_TOKEN_INVALID', 'REFRESH_TOKEN_REUSE'].includes(rejected[0].reason.code));
  });
});

// ── revocation helpers ──────────────────────────────────────────────────
describe('revocation', () => {
  test('revokeUserRefreshTokens revokes only that user\'s ACTIVE tokens and returns the count', async () => {
    if (!mongoAvailable) return;
    await issueRefreshToken({ userId: user._id });
    await issueRefreshToken({ userId: user._id });
    await issueRefreshToken({ userId: otherUser._id });

    const n = await revokeUserRefreshTokens(user._id, 'logout_all');
    assert.equal(n, 2);
    assert.equal(await RefreshToken.countDocuments({ userId: user._id, revokedAt: null }), 0);
    assert.equal(await RefreshToken.countDocuments({ userId: otherUser._id, revokedAt: null }), 1);
    const row = await RefreshToken.findOne({ userId: user._id });
    assert.equal(row.revokedReason, 'logout_all');
  });

  test('revokeFamily revokes every active token in one family', async () => {
    if (!mongoAvailable) return;
    const { record } = await issueRefreshToken({ userId: user._id });
    await issueRefreshToken({ userId: user._id, familyId: record.familyId });
    const n = await revokeFamily(record.familyId, 'reuse_detected');
    assert.equal(n, 2);
  });

  test('revokeRefreshTokenForUser: only the owner can revoke; someone else\'s token -> REFRESH_TOKEN_MISMATCH (403)', async () => {
    if (!mongoAvailable) return;
    const { plaintext } = await issueRefreshToken({ userId: user._id });

    await assert.rejects(
      revokeRefreshTokenForUser({ presentedToken: plaintext, userId: otherUser._id }),
      (e) => e.code === 'REFRESH_TOKEN_MISMATCH' && e.httpStatus === 403,
    );
    // still active (the mismatch attempt did not revoke it)
    assert.equal(await RefreshToken.countDocuments({ tokenHash: hashRefreshToken(plaintext), revokedAt: null }), 1);

    const res = await revokeRefreshTokenForUser({ presentedToken: plaintext, userId: user._id });
    assert.equal(res.revoked, true);
    assert.equal(await RefreshToken.countDocuments({ tokenHash: hashRefreshToken(plaintext), revokedAt: null }), 0);
  });

  test('revokeRefreshTokenForUser with an unknown token is a no-op (idempotent, no enumeration)', async () => {
    if (!mongoAvailable) return;
    const res = await revokeRefreshTokenForUser({ presentedToken: generateOpaqueToken(), userId: user._id });
    assert.deepEqual(res, { revoked: false, reason: 'not_found' });
  });
});

// ── user isolation ──────────────────────────────────────────────────────
describe('user isolation', () => {
  test('user A\'s refresh token rotates into a session for A, never B', async () => {
    if (!mongoAvailable) return;
    const a = await issueSessionBundle(user, {});
    const rotated = await rotateRefreshToken({ presentedToken: a.refreshToken });
    const decoded = verifyAuthToken(rotated.accessToken);
    assert.equal(String(decoded.id), String(user._id));
    assert.notEqual(String(decoded.id), String(otherUser._id));
  });
});
