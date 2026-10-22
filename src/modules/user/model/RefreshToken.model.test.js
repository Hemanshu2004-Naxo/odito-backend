import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import RefreshToken, { REFRESH_TOKEN_REVOKED_REASONS } from './RefreshToken.js';

const schema = RefreshToken.schema;

describe('RefreshToken schema', () => {
  test('has every required field with the right type', () => {
    assert.equal(schema.path('userId').instance, 'ObjectId');
    assert.equal(schema.path('userId').isRequired, true);
    assert.equal(schema.path('tokenHash').instance, 'String');
    assert.equal(schema.path('tokenHash').isRequired, true);
    assert.equal(schema.path('tokenHash').options.unique, true);
    assert.equal(schema.path('familyId').instance, 'String');
    assert.equal(schema.path('familyId').isRequired, true);
    assert.equal(schema.path('expiresAt').instance, 'Date');
    assert.equal(schema.path('expiresAt').isRequired, true);
    assert.equal(schema.path('revokedAt').instance, 'Date');
    assert.equal(schema.path('replacedBy').instance, 'ObjectId');
    assert.equal(schema.path('tokenVersionAtIssue').instance, 'Number');
  });

  test('optional metadata fields are length-bounded and default null', () => {
    assert.equal(schema.path('deviceLabel').options.maxlength, 120);
    assert.equal(schema.path('deviceLabel').options.default, null);
    assert.equal(schema.path('userAgent').options.maxlength, 400);
    assert.equal(schema.path('ipAddress').options.maxlength, 64);
  });

  test('revokedReason is an enum that includes null and every documented reason', () => {
    const enumValues = schema.path('revokedReason').enumValues;
    for (const reason of REFRESH_TOKEN_REVOKED_REASONS) {
      assert.ok(enumValues.includes(reason), `enum missing "${reason}"`);
    }
    assert.ok(enumValues.includes(null), 'enum must allow null (unrevoked)');
    for (const critical of ['rotation', 'reuse_detected', 'logout', 'logout_all', 'password_changed', 'password_reset', 'account_suspended']) {
      assert.ok(REFRESH_TOKEN_REVOKED_REASONS.includes(critical));
    }
  });

  test('indexes: unique tokenHash, {userId,revokedAt}, familyId, and a TTL on expiresAt', () => {
    const idx = schema.indexes();
    const find = (keyObj) => idx.filter(([keys]) =>
      JSON.stringify(keys) === JSON.stringify(keyObj));

    assert.ok(find({ tokenHash: 1 }).some(([, opts]) => opts.unique), 'tokenHash unique index');
    assert.ok(find({ userId: 1, revokedAt: 1 }).length === 1, '{userId,revokedAt} compound index');
    assert.ok(find({ familyId: 1 }).length === 1, 'familyId index (reuse detection)');

    const ttl = idx.find(([keys, opts]) =>
      JSON.stringify(keys) === JSON.stringify({ expiresAt: 1 }) && opts.expireAfterSeconds === 0);
    assert.ok(ttl, 'TTL index on expiresAt with expireAfterSeconds: 0');
  });

  test('timestamps (createdAt / updatedAt) are enabled', () => {
    assert.ok(schema.path('createdAt'));
    assert.ok(schema.path('updatedAt'));
  });

  test('collection name is "refreshtokens" (matches the account-deletion cascade)', () => {
    assert.equal(RefreshToken.collection.collectionName, 'refreshtokens');
  });
});
