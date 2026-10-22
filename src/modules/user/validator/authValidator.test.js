import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { registerValidator, loginValidator } from './authValidator.js';
import { validate } from '../../../middleware/validate.js';

/**
 * Runs an express-validator chain against a mock request, then the shared
 * `validate` terminator — exactly the middleware order the routes use.
 * Returns { passed, status, body, req } so a test can assert either the
 * 400 shape or that the request was allowed through (and sanitized).
 */
async function run(chain, body) {
  const req = { body: { ...body } };
  for (const mw of chain) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve, reject) => mw(req, {}, (e) => (e ? reject(e) : resolve())));
  }
  let passed = false;
  const res = {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  validate(req, res, () => { passed = true; });
  return { passed, status: res.statusCode, body: res.body, req };
}

const validRegister = {
  firstName: 'Jane', lastName: 'Doe',
  email: 'jane@example.com', password: 'password123', termsAccepted: true,
};

describe('registerValidator + validate — POST /api/auth/register (H2 fix)', () => {
  test('accepts a well-formed body and normalizes the email in place', async () => {
    const r = await run(registerValidator, { ...validRegister, email: '  Jane.Doe+news@GMAIL.com ' });
    assert.equal(r.passed, true);
    assert.equal(r.req.body.email, 'jane.doe+news@gmail.com'); // trim+lowercase only — dots/+tag kept
  });

  test('rejects a missing email with a stable 400 shape', async () => {
    const r = await run(registerValidator, { ...validRegister, email: undefined });
    assert.equal(r.passed, false);
    assert.equal(r.status, 400);
    assert.equal(r.body.success, false);
    assert.match(r.body.message, /email is required/i);
    assert.ok(Array.isArray(r.body.errors));
  });

  test('rejects an invalid email', async () => {
    const r = await run(registerValidator, { ...validRegister, email: 'not-an-email' });
    assert.equal(r.status, 400);
    assert.match(r.body.message, /valid email/i);
  });

  test('rejects a missing password', async () => {
    const r = await run(registerValidator, { ...validRegister, password: undefined });
    assert.equal(r.status, 400);
    assert.match(r.body.message, /password is required/i);
  });

  test('rejects a password under 8 characters', async () => {
    const r = await run(registerValidator, { ...validRegister, password: 'short1' });
    assert.equal(r.status, 400);
    assert.match(r.body.message, /at least 8 characters/i);
  });

  test('rejects a password longer than 72 bytes instead of silently truncating it', async () => {
    const r = await run(registerValidator, { ...validRegister, password: 'a'.repeat(73) });
    assert.equal(r.status, 400);
    assert.match(r.body.message, /at most 72 bytes/i);
  });

  test('accepts a password of exactly 72 bytes', async () => {
    const r = await run(registerValidator, { ...validRegister, password: 'a'.repeat(72) });
    assert.equal(r.passed, true);
  });

  test('counts bytes, not characters, for the 72 limit (multibyte)', async () => {
    // 40 emoji = 160 bytes > 72
    const r = await run(registerValidator, { ...validRegister, password: '😀'.repeat(40) });
    assert.equal(r.status, 400);
    assert.match(r.body.message, /72 bytes/i);
  });

  test('rejects termsAccepted !== true (false, missing, or the string "true")', async () => {
    for (const termsAccepted of [false, undefined, 'true', 1, null]) {
      // eslint-disable-next-line no-await-in-loop
      const r = await run(registerValidator, { ...validRegister, termsAccepted });
      assert.equal(r.status, 400, `termsAccepted=${JSON.stringify(termsAccepted)}`);
      assert.match(r.body.message, /Terms of Service/i);
    }
  });

  test('rejects a blank or over-long first name', async () => {
    assert.equal((await run(registerValidator, { ...validRegister, firstName: '   ' })).status, 400);
    assert.equal((await run(registerValidator, { ...validRegister, firstName: 'x'.repeat(101) })).status, 400);
  });

  test('never lets a malformed body reach the service (no raw "toLowerCase of undefined")', async () => {
    const r = await run(registerValidator, {});
    assert.equal(r.passed, false);
    assert.equal(r.status, 400);
  });
});

describe('loginValidator + validate — POST /api/auth/login (H4 fix)', () => {
  test('accepts a well-formed body and normalizes the email with the same canonical form', async () => {
    const r = await run(loginValidator, { email: '  User@Example.COM ', password: 'whatever' });
    assert.equal(r.passed, true);
    assert.equal(r.req.body.email, 'user@example.com');
  });

  test('rejects missing email / invalid email / missing password', async () => {
    assert.equal((await run(loginValidator, { password: 'x' })).status, 400);
    assert.equal((await run(loginValidator, { email: 'nope', password: 'x' })).status, 400);
    assert.equal((await run(loginValidator, { email: 'a@b.com' })).status, 400);
  });

  test('does NOT enforce a password length on login (legacy sub-8 passwords still usable; policy not advertised)', async () => {
    const r = await run(loginValidator, { email: 'a@b.com', password: 'abc' });
    assert.equal(r.passed, true);
  });

  test('rememberMe: optional, but must be boolean-ish when present', async () => {
    assert.equal((await run(loginValidator, { email: 'a@b.com', password: 'x' })).passed, true);
    assert.equal((await run(loginValidator, { email: 'a@b.com', password: 'x', rememberMe: true })).passed, true);
    assert.equal((await run(loginValidator, { email: 'a@b.com', password: 'x', rememberMe: false })).passed, true);
    assert.equal((await run(loginValidator, { email: 'a@b.com', password: 'x', rememberMe: 'yes' })).status, 400);
  });
});
