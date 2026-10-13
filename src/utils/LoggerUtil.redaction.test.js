import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { LoggerUtil, redactForLog, redactString } from './LoggerUtil.js';

/** Pure tests: credentials never reach a log line, and ordinary data (including token COUNTS) is not damaged. */

let lines; let originals;
beforeEach(() => {
  lines = [];
  originals = { log: console.log, warn: console.warn, error: console.error };
  for (const level of ['log', 'warn', 'error']) console[level] = (text) => lines.push(JSON.parse(text));
});
afterEach(() => Object.assign(console, originals));

describe('LoggerUtil redaction', () => {
  test('1: values under secret-looking keys are replaced, at any depth and in arrays - whatever the case or separator', () => {
    LoggerUtil.info('event', {
      accessToken: 'live-1', access_token: 'live-2', refresh_token: 'live-3', Authorization: 'Bearer abc', cookie: 'sid=1', 'set-cookie': ['a=b'], password: 'p', clientSecret: 'c', app_secret: 's', apiKey: 'k', 'x-api-key': 'k2', pageToken: 'pt',
      nested: { deeper: [{ token: 'abc', fine: 'kept' }], META_APP_SECRET: 'x' },
    });
    const text = JSON.stringify(lines[0]);
    for (const secret of ['live-1', 'live-2', 'live-3', 'sid=1', 'a=b', 'abc', 'k2']) assert.ok(!text.includes(`"${secret}"`), secret);
    assert.equal(lines[0].accessToken, '[REDACTED]');
    assert.equal(lines[0].nested.deeper[0].token, '[REDACTED]');
    assert.equal(lines[0].nested.deeper[0].fine, 'kept');
    assert.equal(lines[0].nested.META_APP_SECRET, '[REDACTED]');
  });

  test('2: counters and ordinary fields that merely contain the word "token" are NOT redacted', () => {
    LoggerUtil.info('usage', { inputTokens: 1200, outputTokens: 30, tokenCount: 5, maxTokens: 8000, tokens: 12, tokenType: 'bearer', savedPosts: 4, note: 'ok' });
    assert.deepEqual(lines[0].inputTokens, 1200);
    assert.deepEqual([lines[0].outputTokens, lines[0].tokenCount, lines[0].maxTokens, lines[0].tokens, lines[0].tokenType, lines[0].savedPosts, lines[0].note], [30, 5, 8000, 12, 'bearer', 4, 'ok']);
  });

  test('2b: a boolean presence flag under a secret-looking key is kept (hasAccessToken: true), a value never is', () => {
    LoggerUtil.info('discovery', { hasAccessToken: true, hasRefreshToken: false, accessToken: 'EAAG-live' });
    assert.deepEqual([lines[0].hasAccessToken, lines[0].hasRefreshToken, lines[0].accessToken], [true, false, '[REDACTED]']);
  });

  test('3: secret shapes inside ANY string are masked - messages, error messages and stacks included', () => {
    const err = new Error('request failed: Authorization: Bearer abcdefghijklmnop12345 for mongodb://admin:hunter2@db.internal:27017/odito');
    LoggerUtil.error('Meta call failed access_token=EAAB123456789012345678901234567 &x=1', err, { url: 'https://graph.example/me?access_token=EAAG123456789012345678901234567&fields=id', anthropic: 'key sk-ant-api03-abcdefghijklmnop', openai: 'sk-abcdefghijklmnopqrstuvwxyz123456' });
    const text = JSON.stringify(lines[0]);
    for (const leaked of ['abcdefghijklmnop12345', 'hunter2', 'admin:', 'EAAB1234', 'EAAG1234', 'sk-ant-api03', 'sk-abcdefghijklmnopqrstuvwxyz']) assert.ok(!text.includes(leaked), `leaked: ${leaked}`);
    assert.match(lines[0].error.message, /mongodb:\/\/\[REDACTED\]@db\.internal:27017\/odito/);
    assert.match(lines[0].message, /access_token=\[REDACTED\] &x=1/);
    assert.match(lines[0].url, /fields=id/, 'the rest of a URL survives');
  });

  test('4: an HTTP-client error body that echoes a token is cleaned before it is written', () => {
    const error = Object.assign(new Error('Request failed'), { response: { status: 400, data: { error: { message: 'Invalid OAuth access token.', access_token: 'EAAG-live', headers: { authorization: 'Bearer zzzzzzzzzzzz' } } } } });
    LoggerUtil.error('Graph error', error);
    const text = JSON.stringify(lines[0]);
    assert.ok(!text.includes('EAAG-live') && !text.includes('zzzzzzzzzzzz'));
    assert.equal(lines[0].error.responseStatus, 400);
    assert.match(lines[0].error.responseData.error.message, /Invalid OAuth access token/);
  });

  test('5: Dates, ObjectIds and other values with toJSON are kept; cycles and very deep objects cannot hang or crash logging', () => {
    const when = new Date('2026-10-13T00:00:00Z');
    const circular = { name: 'loop' }; circular.self = circular;
    const deep = {}; let cursor = deep; for (let i = 0; i < 30; i += 1) { cursor.next = {}; cursor = cursor.next; }
    const asJson = { toJSON: () => 'custom-id' };
    assert.doesNotThrow(() => redactForLog({ when, asJson, deep }));
    assert.equal(redactForLog({ when }).when, when);
    assert.equal(redactForLog({ asJson }).asJson, asJson);
    assert.match(JSON.stringify(redactForLog({ deep })), /\[TRUNCATED\]/);
    assert.doesNotThrow(() => redactForLog({ circular }), 'a cycle is cut off by the depth limit');
  });

  test('6: nothing else about the line changes: timestamp, level, message and plain context keep their shape', () => {
    LoggerUtil.warn('[SOCIAL_CALENDAR] Heartbeat failed', { message: 'blip' }, undefined);
    LoggerUtil.info('plain', { projectId: '6acdc368dfdd3468860b6348', n: 3, ok: true, nothing: null });
    assert.deepEqual(Object.keys(lines[1]).sort(), ['level', 'message', 'n', 'nothing', 'ok', 'projectId', 'timestamp']);
    assert.equal(lines[1].projectId, '6acdc368dfdd3468860b6348');
    assert.equal(lines[1].level, 'INFO');
    assert.equal(redactString('nothing to hide'), 'nothing to hide');
  });
});
