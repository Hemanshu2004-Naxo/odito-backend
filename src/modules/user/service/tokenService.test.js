import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import 'dotenv/config';
import jwt from 'jsonwebtoken';
import {
  signAuthToken,
  verifyAuthToken,
  resolveTokenVersion,
  resolveUserTokenVersion,
  SHORT_SESSION_EXPIRY,
  LONG_SESSION_EXPIRY,
} from './tokenService.js';

const user = { _id: '65f0000000000000000000aa', roleId: 5, tokenVersion: 3 };

describe('tokenService — the single auth-JWT signer (JWT consistency, §12)', () => {
  test('signs a payload with id (string), roleId and tokenVersion', () => {
    const decoded = verifyAuthToken(signAuthToken(user));
    assert.equal(decoded.id, String(user._id));
    assert.equal(decoded.roleId, 5);
    assert.equal(decoded.tokenVersion, 3);
  });

  test('lifetime is unchanged from before: 1d normally, 7d with rememberMe', () => {
    const short = verifyAuthToken(signAuthToken(user, { rememberMe: false }));
    const long = verifyAuthToken(signAuthToken(user, { rememberMe: true }));
    assert.equal(short.exp - short.iat, 24 * 60 * 60, 'default = 1 day');
    assert.equal(long.exp - long.iat, 7 * 24 * 60 * 60, 'rememberMe = 7 days');
    assert.equal(SHORT_SESSION_EXPIRY, '1d');
    assert.equal(LONG_SESSION_EXPIRY, process.env.JWT_EXPIRY || '7d');
  });

  test('verifyAuthToken throws on a bad signature and on a malformed token', () => {
    assert.throws(() => verifyAuthToken(signAuthToken(user) + 'x'));
    assert.throws(() => verifyAuthToken('not-a-jwt'));
  });

  test('accepts a plain object with { id } (not only a Mongoose doc)', () => {
    const decoded = verifyAuthToken(signAuthToken({ id: 'abc', roleId: 3 }));
    assert.equal(decoded.id, 'abc');
    assert.equal(decoded.roleId, 3);
    assert.equal(decoded.tokenVersion, 0);
  });

  test('throws if given no id', () => {
    assert.throws(() => signAuthToken({ roleId: 5 }), /id is required/);
  });

  describe('backward compatibility — "no tokenVersion" === version 0', () => {
    test('resolveTokenVersion: legacy token with no claim resolves to 0', () => {
      // A token minted by the OLD code path: { id } only, signed with the
      // same secret. It must still authenticate after this deploy.
      const legacy = jwt.sign({ id: 'legacy-user' }, process.env.JWT_SECRET, { expiresIn: '7d' });
      const decoded = verifyAuthToken(legacy);
      assert.equal(resolveTokenVersion(decoded), 0);
    });

    test('resolveUserTokenVersion: a user document created before the field existed resolves to 0', () => {
      assert.equal(resolveUserTokenVersion({}), 0);
      assert.equal(resolveUserTokenVersion({ tokenVersion: undefined }), 0);
      assert.equal(resolveUserTokenVersion({ tokenVersion: 4 }), 4);
    });

    test('legacy token (v0) matches a never-changed-password user (v0) — no forced logout', () => {
      const legacy = jwt.sign({ id: 'u1', roleId: 5 }, process.env.JWT_SECRET, { expiresIn: '7d' });
      const decoded = verifyAuthToken(legacy);
      assert.equal(resolveTokenVersion(decoded), resolveUserTokenVersion({ /* no field yet */ }));
    });
  });
});
