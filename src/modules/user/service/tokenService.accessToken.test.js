import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import 'dotenv/config';
import jwt from 'jsonwebtoken';
import {
  signAccessToken,
  signAuthToken,
  verifyAuthToken,
  parseDurationToMs,
  ACCESS_TOKEN_TYPE,
  TOKEN_ISSUER,
  TOKEN_AUDIENCE_MOBILE,
  ACCESS_TOKEN_TTL_SECONDS,
} from './tokenService.js';

const user = { _id: '65f0000000000000000000aa', roleId: 5, tokenVersion: 2 };

describe('signAccessToken — short-lived mobile access token (Phase 2)', () => {
  test('carries id + sub + roleId + tokenVersion + type/iss/aud/jti, and nothing sensitive', () => {
    const decoded = verifyAuthToken(signAccessToken(user));
    assert.equal(decoded.id, String(user._id));
    assert.equal(decoded.sub, String(user._id));
    assert.equal(decoded.roleId, 5);
    assert.equal(decoded.tokenVersion, 2);
    assert.equal(decoded.type, ACCESS_TOKEN_TYPE);
    assert.equal(decoded.iss, TOKEN_ISSUER);
    assert.equal(decoded.aud, TOKEN_AUDIENCE_MOBILE);
    assert.equal(typeof decoded.jti, 'string');
    assert.ok(decoded.jti.length >= 10);
    for (const leaky of ['password', 'email', 'phone', 'subscription', 'refreshToken']) {
      assert.equal(decoded[leaky], undefined, `access token must not carry "${leaky}"`);
    }
  });

  test('is short-lived (ACCESS_TOKEN_EXPIRES_IN, default 30m) and each call has a fresh jti', () => {
    const a = verifyAuthToken(signAccessToken(user));
    const b = verifyAuthToken(signAccessToken(user));
    assert.equal(a.exp - a.iat, ACCESS_TOKEN_TTL_SECONDS);
    assert.equal(ACCESS_TOKEN_TTL_SECONDS, 30 * 60); // default
    assert.notEqual(a.jti, b.jti);
  });

  test('throws without an id', () => {
    assert.throws(() => signAccessToken({ roleId: 5 }), /id is required/);
  });

  test('accepts a plain object (not only a Mongoose doc) and defaults tokenVersion to 0', () => {
    const d = verifyAuthToken(signAccessToken({ id: 'abc', roleId: 3 }));
    assert.equal(d.id, 'abc');
    assert.equal(d.tokenVersion, 0);
  });
});

describe('signAuthToken — LEGACY web token is UNCHANGED by Phase 2', () => {
  test('still { id, roleId, tokenVersion } with 1d / 7d lifetime and NO type/iss/aud', () => {
    const short = verifyAuthToken(signAuthToken(user, { rememberMe: false }));
    const long = verifyAuthToken(signAuthToken(user, { rememberMe: true }));
    assert.equal(short.exp - short.iat, 24 * 3600);
    assert.equal(long.exp - long.iat, 7 * 24 * 3600);
    assert.equal(short.type, undefined);
    assert.equal(short.iss, undefined);
    assert.equal(short.aud, undefined);
    assert.equal(short.jti, undefined);
    assert.equal(short.sub, undefined);
  });
});

describe('parseDurationToMs', () => {
  test('parses common unit strings', () => {
    assert.equal(parseDurationToMs('30m', 0), 30 * 60_000);
    assert.equal(parseDurationToMs('60d', 0), 60 * 86_400_000);
    assert.equal(parseDurationToMs('1800s', 0), 1_800_000);
    assert.equal(parseDurationToMs('2h', 0), 7_200_000);
    assert.equal(parseDurationToMs('12w', 0), 12 * 604_800_000);
  });
  test('bare number is treated as seconds', () => {
    assert.equal(parseDurationToMs(1800, 0), 1_800_000);
  });
  test('nullish / blank returns the fallback silently', () => {
    assert.equal(parseDurationToMs(undefined, 999), 999);
    assert.equal(parseDurationToMs('', 999), 999);
    assert.equal(parseDurationToMs(null, 999), 999);
  });
  test('garbage returns the fallback', () => {
    assert.equal(parseDurationToMs('abc', 42), 42);
    assert.equal(parseDurationToMs('-5m', 42), 42);
  });
});

describe('verifyAuthToken accepts a legacy token minted before Phase 2', () => {
  test('a bare { id } token still verifies (no iss/aud asserted here)', () => {
    const legacy = jwt.sign({ id: 'legacy-user', roleId: 5 }, process.env.JWT_SECRET, { expiresIn: '7d' });
    const d = verifyAuthToken(legacy);
    assert.equal(d.id, 'legacy-user');
  });
});
