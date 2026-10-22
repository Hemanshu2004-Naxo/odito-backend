import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {
  loginLimiter,
  registerIpLimiter,
  otpRequestLimiter,
} from './authRateLimiters.js';

/**
 * Real Express app + real HTTP (Node's built-in fetch) — no supertest in
 * this repo. Each limiter keeps in-process MemoryStore state, so tests use
 * a distinct email per case to stay isolated.
 */
let server;
let base;

before(async () => {
  const app = express();
  app.use(express.json());
  // loginLimiter only counts FAILED responses (skipSuccessfulRequests) —
  // this handler always 401s, like a wrong-password login.
  app.post('/login', loginLimiter, (req, res) =>
    res.status(401).json({ success: false, message: 'Invalid email or password.' }));
  app.post('/register', registerIpLimiter, (req, res) =>
    res.status(201).json({ success: true }));
  app.post('/otp', otpRequestLimiter, (req, res) =>
    res.status(200).json({ success: true }));

  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server?.close(); });

beforeEach(() => { delete process.env.AUTH_RATE_LIMIT_ENABLED; });

const post = (path, body) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });

describe('auth rate limiting (C1 fix) — 429 + Retry-After + stable code', () => {
  test('login: allowed up to the limit, then 429 with Retry-After and code RATE_LIMITED', async () => {
    const email = `burst-${Date.now()}@example.com`;
    // Default AUTH_LOGIN_MAX = 10.
    for (let i = 0; i < 10; i++) {
      // eslint-disable-next-line no-await-in-loop
      const r = await post('/login', { email, password: 'x' });
      assert.equal(r.status, 401, `attempt ${i + 1} should still be allowed through`);
    }
    const blocked = await post('/login', { email, password: 'x' });
    assert.equal(blocked.status, 429);
    const retryAfter = blocked.headers.get('retry-after');
    assert.ok(retryAfter && Number(retryAfter) > 0, 'Retry-After header present and positive');
    const body = await blocked.json();
    assert.equal(body.success, false);
    assert.equal(body.code, 'RATE_LIMITED');
    assert.ok(!/password|email/i.test(JSON.stringify(body)), 'body leaks no credential material');
  });

  test('login: the key is IP + email — a different email is unaffected by another email being blocked', async () => {
    const hot = `hot-${Date.now()}@example.com`;
    for (let i = 0; i < 11; i++) {
      // eslint-disable-next-line no-await-in-loop
      await post('/login', { email: hot, password: 'x' });
    }
    assert.equal((await post('/login', { email: hot, password: 'x' })).status, 429);

    const cold = `cold-${Date.now()}@example.com`;
    assert.equal((await post('/login', { email: cold, password: 'x' })).status, 401,
      'a different account must not be locked out');
  });

  test('AUTH_RATE_LIMIT_ENABLED=false disables limiting entirely (kill switch)', async () => {
    process.env.AUTH_RATE_LIMIT_ENABLED = 'false';
    const email = `killswitch-${Date.now()}@example.com`;
    for (let i = 0; i < 25; i++) {
      // eslint-disable-next-line no-await-in-loop
      const r = await post('/login', { email, password: 'x' });
      assert.equal(r.status, 401, 'never 429 while disabled');
    }
  });

  test('otp-request limiter (tighter, default 5): blocks after the 5th, counts every request', async () => {
    const email = `otp-${Date.now()}@example.com`;
    for (let i = 0; i < 5; i++) {
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await post('/otp', { email })).status, 200);
    }
    assert.equal((await post('/otp', { email })).status, 429);
  });

  test('register limiter is IP-keyed (no email needed) and eventually 429s a burst', async () => {
    // Default AUTH_REGISTER_MAX = 20; all these requests share the test's IP.
    let saw429 = false;
    for (let i = 0; i < 22; i++) {
      // eslint-disable-next-line no-await-in-loop
      const r = await post('/register', { email: `reg-${i}-${Date.now()}@example.com` });
      if (r.status === 429) { saw429 = true; break; }
    }
    assert.ok(saw429, 'a 22-request burst from one IP must hit the register cap');
  });
});
