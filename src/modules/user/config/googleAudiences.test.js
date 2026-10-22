import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildGoogleAudiences } from './googleAudiences.js';

const KEYS = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_NEXTAUTH_CLIENT_ID',
  'GOOGLE_ANDROID_CLIENT_ID',
  'GOOGLE_IOS_CLIENT_ID',
  'GOOGLE_OAUTH_AUDIENCES',
];

let saved;
beforeEach(() => {
  saved = {};
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('buildGoogleAudiences — accepted Google ID-token audiences (H5 fix)', () => {
  test('returns the web client IDs when only those are set (existing behaviour preserved)', () => {
    process.env.GOOGLE_CLIENT_ID = 'web-backend';
    process.env.GOOGLE_NEXTAUTH_CLIENT_ID = 'web-nextauth';
    assert.deepEqual(buildGoogleAudiences().sort(), ['web-backend', 'web-nextauth'].sort());
  });

  test('includes Android + iOS client IDs when configured (the mobile fix)', () => {
    process.env.GOOGLE_CLIENT_ID = 'web-backend';
    process.env.GOOGLE_ANDROID_CLIENT_ID = 'android-1';
    process.env.GOOGLE_IOS_CLIENT_ID = 'ios-1';
    const aud = buildGoogleAudiences();
    assert.ok(aud.includes('android-1'));
    assert.ok(aud.includes('ios-1'));
    assert.ok(aud.includes('web-backend'));
  });

  test('supports an extra comma-separated GOOGLE_OAUTH_AUDIENCES list', () => {
    process.env.GOOGLE_CLIENT_ID = 'web-backend';
    process.env.GOOGLE_OAUTH_AUDIENCES = ' extra-a , extra-b ,,';
    const aud = buildGoogleAudiences();
    assert.ok(aud.includes('extra-a'));
    assert.ok(aud.includes('extra-b'));
  });

  test('filters out unset / blank slots and de-duplicates', () => {
    process.env.GOOGLE_CLIENT_ID = 'shared';
    process.env.GOOGLE_NEXTAUTH_CLIENT_ID = '';
    process.env.GOOGLE_ANDROID_CLIENT_ID = '   ';
    process.env.GOOGLE_OAUTH_AUDIENCES = 'shared,shared';
    assert.deepEqual(buildGoogleAudiences(), ['shared']);
  });

  test('returns [] when nothing is configured (never throws)', () => {
    assert.deepEqual(buildGoogleAudiences(), []);
  });
});
