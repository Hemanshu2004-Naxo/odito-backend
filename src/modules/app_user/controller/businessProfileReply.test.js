import { describe, test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

import SeoProject from '../model/SeoProject.js';
import GoogleConnection from '../model/GoogleConnection.js';
import BusinessProfileReview from '../model/BusinessProfileReview.js';
import { replyToBusinessProfileReviewController } from './businessProfileController.js';

/**
 * Review-reply endpoint: authorization chain, validation, duplicate protection,
 * error mapping and "a failed write never touches connection status".
 * Models and the Google HTTP client are mocked - NO database, NO request to Google.
 */

const USER = 'u1';
const PROJECT = '6ac4bf78867ae9b647ec8478';
const REVIEW_ID = 'AbFvOqReview_1-x';
const SECRET = 'ya29.SECRET_ACCESS_TOKEN';

const mockRes = () => ({
  statusCode: 200, body: null,
  status(c) { this.statusCode = c; return this; },
  json(p) { this.body = p; return this; },
});

let calls;      // recorded google + db side effects
let review;
let connection;
let project;
let putImpl;
let getImpl;

function makeReview(over = {}) {
  const r = {
    google_review_id: REVIEW_ID, business_account_id: 'A1', business_location_id: 'L1',
    reply: { comment: null, update_time: null, state: null }, saves: 0,
    async save() { this.saves++; },
    toObject() { return { google_review_id: this.google_review_id, reply: this.reply }; },
    ...over,
  };
  return r;
}

beforeEach(() => {
  calls = { get: 0, put: [], connectionWrites: 0 };
  project = { user_id: USER };
  connection = {
    _id: 'c1', status: 'active', business_account_id: 'A1', business_location_id: 'L1',
    refresh_token: 'r', access_token: SECRET, token_expires_at: new Date(Date.now() + 3600e3),
  };
  review = makeReview();
  getImpl = async () => ({ data: { name: `accounts/A1/locations/L1/reviews/${REVIEW_ID}` } });
  putImpl = async (_p, body) => ({ status: 200, data: { comment: body.comment, updateTime: '2026-10-06T12:00:00Z', reviewReplyState: 'APPROVED' } });

  mock.method(SeoProject, 'findById', async () => project);
  mock.method(GoogleConnection, 'findActiveConnection', async () => connection);
  mock.method(BusinessProfileReview, 'findOne', async () => review);
  // Any connection-state write is a failure.
  for (const m of ['updateOne', 'findByIdAndUpdate', 'updateMany', 'findOneAndUpdate']) {
    mock.method(GoogleConnection, m, async () => { calls.connectionWrites++; });
  }
  mock.method(axios, 'create', () => ({
    get: async (p) => { calls.get++; return getImpl(p); },
    put: async (p, body) => { calls.put.push({ p, body }); return putImpl(p, body); },
  }));
});
afterEach(() => mock.restoreAll());

const call = async (body, params = {}) => {
  const res = mockRes();
  await replyToBusinessProfileReviewController(
    { params: { projectId: PROJECT, reviewId: REVIEW_ID, ...params }, body, user: { _id: USER } }, res);
  return res;
};
const googleError = (status, data) => Object.assign(new Error('x'), { response: { status, data } });

describe('review reply - validation (nothing reaches Google)', () => {
  for (const [name, reply] of [['empty', ''], ['whitespace', '  \n\t '], ['missing', undefined], ['non-string', 42]]) {
    test(`rejects ${name} reply`, async () => {
      const res = await call({ reply });
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.code, 'INVALID_REPLY');
      assert.equal(calls.get + calls.put.length, 0);
    });
  }
  test('rejects replies over 4096 BYTES (multi-byte chars count)', async () => {
    const res = await call({ reply: '€'.repeat(1400) }); // 1400 chars = 4200 bytes
    assert.equal(res.statusCode, 400);
    assert.equal(calls.put.length, 0);
  });
  test('accepts exactly 4096 bytes', async () => {
    const res = await call({ reply: 'a'.repeat(4096) });
    assert.equal(res.statusCode, 200);
  });
  test('rejects control characters', async () => {
    const res = await call({ reply: 'hello\u0000world' });
    assert.equal(res.statusCode, 400);
  });
  test('rejects malformed review id and project id', async () => {
    assert.equal((await call({ reply: 'hi' }, { reviewId: '../../x' })).statusCode, 400);
    assert.equal((await call({ reply: 'hi' }, { projectId: 'nope' })).statusCode, 404);
    assert.equal(calls.put.length, 0);
  });
});

describe('review reply - authorization chain', () => {
  test("another user's project -> 403, connection never loaded", async () => {
    project = { user_id: 'someone-else' };
    const res = await call({ reply: 'Thanks!' });
    assert.equal(res.statusCode, 403);
    assert.equal(GoogleConnection.findActiveConnection.mock.callCount(), 0);
    assert.equal(calls.put.length, 0);
  });
  test('no active Business Profile connection -> 400', async () => {
    connection = null;
    const res = await call({ reply: 'Thanks!' });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, 'NOT_CONNECTED');
  });
  test('review from a different location than the connected one -> 404, no Google call', async () => {
    review = makeReview({ business_location_id: 'OTHER' });
    const res = await call({ reply: 'Thanks!' });
    assert.equal(res.statusCode, 404);
    assert.equal(calls.get + calls.put.length, 0);
  });
  test('review not in this project -> 404', async () => {
    review = null;
    const res = await call({ reply: 'Thanks!' });
    assert.equal(res.statusCode, 404);
    assert.equal(calls.put.length, 0);
  });
  test('the review lookup is scoped to the project (never by reviewId alone)', async () => {
    await call({ reply: 'Thanks!' });
    const filter = BusinessProfileReview.findOne.mock.calls[0].arguments[0];
    assert.equal(filter.project_id, PROJECT);
    assert.equal(filter.google_review_id, REVIEW_ID);
  });
});

describe('review reply - success path', () => {
  test('PUTs the trimmed text to the reviews/{id}/reply endpoint once and stores Google\'s response', async () => {
    const res = await call({ reply: '  Thank you for your feedback!  ' });
    assert.equal(res.statusCode, 200);
    assert.equal(calls.put.length, 1);
    assert.equal(calls.put[0].p, `accounts/A1/locations/L1/reviews/${REVIEW_ID}/reply`);
    assert.deepEqual(calls.put[0].body, { comment: 'Thank you for your feedback!' });
    assert.equal(review.reply.comment, 'Thank you for your feedback!');
    assert.equal(review.reply.state, 'APPROVED');
    assert.equal(review.saves, 1);
    assert.equal(res.body.data.google.status, 200);
    assert.equal(res.body.data.google.replyState, 'APPROVED');
  });
  test('never leaks the access token in the response', async () => {
    const res = await call({ reply: 'Thanks!' });
    assert.ok(!JSON.stringify(res.body).includes(SECRET));
  });
  test('Google REJECTED state is not stored as a reply and is reported as a failure', async () => {
    putImpl = async () => ({ status: 200, data: { comment: 'x', reviewReplyState: 'REJECTED' } });
    const res = await call({ reply: 'Thanks!' });
    assert.equal(res.statusCode, 422);
    assert.equal(res.body.code, 'REPLY_REJECTED');
    assert.equal(review.saves, 0);
  });
});

describe('review reply - duplicates', () => {
  test('already replied locally -> 409, nothing sent', async () => {
    review = makeReview({ reply: { comment: 'Existing', update_time: null, state: null } });
    const res = await call({ reply: 'Thanks!' });
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'ALREADY_REPLIED');
    assert.equal(calls.get + calls.put.length, 0);
  });
  test('replied directly on Google since last sync -> 409, NOT overwritten, local copy synced', async () => {
    getImpl = async () => ({ data: { reviewReply: { comment: 'Replied on google.com', updateTime: '2026-10-05T00:00:00Z', reviewReplyState: 'APPROVED' } } });
    const res = await call({ reply: 'Thanks!' });
    assert.equal(res.statusCode, 409);
    assert.equal(calls.put.length, 0);
    assert.equal(review.reply.comment, 'Replied on google.com');
  });
  test('double-click: concurrent second request -> 409 REPLY_IN_PROGRESS, exactly one Google write', async () => {
    let release;
    putImpl = (_p, body) => new Promise((r) => { release = () => r({ status: 200, data: { comment: body.comment, reviewReplyState: 'APPROVED' } }); });
    const first = call({ reply: 'Thanks!' });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const second = await call({ reply: 'Thanks!' });
    assert.equal(second.statusCode, 409);
    assert.equal(second.body.code, 'REPLY_IN_PROGRESS');
    release();
    assert.equal((await first).statusCode, 200);
    assert.equal(calls.put.length, 1);
  });
  test('lock is released after a failure so the user can retry', async () => {
    putImpl = async () => { throw googleError(503, {}); };
    assert.equal((await call({ reply: 'Thanks!' })).statusCode, 503);
    putImpl = async (_p, body) => ({ status: 200, data: { comment: body.comment, reviewReplyState: 'APPROVED' } });
    assert.equal((await call({ reply: 'Thanks!' })).statusCode, 200);
  });
});

describe('review reply - Google failures map to safe errors and never change connection status', () => {
  const cases = [
    [401, 'GOOGLE_AUTH_FAILED', 502, false],
    [403, 'GOOGLE_PERMISSION_DENIED', 502, false],
    [404, 'REVIEW_NOT_FOUND', 404, false],
    [429, 'GOOGLE_RATE_LIMITED', 429, true],
    [500, 'GOOGLE_UNAVAILABLE', 503, true],
    [400, 'GOOGLE_REJECTED', 422, false],
  ];
  for (const [gStatus, code, http, retryable] of cases) {
    test(`Google ${gStatus} -> ${code}`, async () => {
      putImpl = async () => { throw googleError(gStatus, { error: { status: 'RAW_GOOGLE_STATUS', message: `raw ${SECRET}` } }); };
      const res = await call({ reply: 'Thanks!' });
      assert.equal(res.statusCode, http);
      assert.equal(res.body.code, code);
      assert.equal(!!res.body.retryable, retryable);
      assert.equal(review.saves, 0, 'no local reply is stored for a failed write');
      assert.equal(calls.connectionWrites, 0, 'connection status/tokens untouched');
      const body = JSON.stringify(res.body);
      assert.ok(!body.includes('RAW_GOOGLE_STATUS') && !body.includes(SECRET), 'raw Google error not exposed');
    });
  }
  test('network failure / timeout (no response) -> retryable 503', async () => {
    putImpl = async () => { throw Object.assign(new Error('timeout of 20000ms exceeded'), { code: 'ECONNABORTED' }); };
    const res = await call({ reply: 'Thanks!' });
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.retryable, true);
    assert.equal(calls.connectionWrites, 0);
  });
  test('preflight GET failure (review gone on Google) -> 404 and no PUT', async () => {
    getImpl = async () => { throw googleError(404, {}); };
    const res = await call({ reply: 'Thanks!' });
    assert.equal(res.statusCode, 404);
    assert.equal(calls.put.length, 0);
  });
});
