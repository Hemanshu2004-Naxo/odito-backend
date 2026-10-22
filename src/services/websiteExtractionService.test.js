import { describe, test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';

import { validateUrl, extractBusinessData } from './websiteExtractionService.js';

/**
 * Website extraction (onboarding "continue with your website"): URL validation
 * and how worker failures are reported. The Python worker is mocked at the
 * axios layer - no website is ever fetched by these tests.
 */

let posts;
let postImpl;
let seq = 0;
const uid = () => `user-${++seq}-${Date.now()}`; // per-user rate limiting is module state

const workerOk = (data = {}) => ({ data: { success: true, data: { business_name: 'Naxonify', title: 'Naxonify', ...data } } });

beforeEach(() => {
  process.env.PYTHON_WORKER_URL = 'http://worker.invalid';
  posts = [];
  postImpl = async () => workerOk();
  mock.method(axios, 'post', (url, body) => { posts.push({ url, body }); return postImpl(url, body); });
  for (const level of ['log', 'warn', 'error']) mock.method(console, level, () => {});
});

afterEach(() => mock.restoreAll());

describe('validateUrl', () => {
  test('accepts normal public websites', () => {
    assert.equal(validateUrl('https://naxonify.com').valid, true);
    assert.equal(validateUrl('https://naxonify.com/').valid, true);
    assert.equal(validateUrl('http://www.example.co.uk/page').valid, true);
  });

  test('rejects unsupported schemes, internal hosts, IPs, credentials and custom ports', () => {
    for (const u of [
      'javascript:alert(1)', 'file:///etc/passwd', 'ftp://example.com', 'naxonify.com',
      'http://localhost', 'http://127.0.0.1', 'http://10.1.2.3', 'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/', 'http://metadata.google.internal/', 'http://printer.local', 'http://2130706433/',
      'https://user:pw@example.com', 'https://example.com:8443', 'http://8.8.8.8',
    ]) {
      assert.equal(validateUrl(u).valid, false, u);
    }
  });
});

describe('extractBusinessData', () => {
  test('never calls the worker for an invalid or internal URL', async () => {
    for (const u of ['http://169.254.169.254/', 'http://localhost:5000', 'file:///etc/passwd']) {
      const r = await extractBusinessData(u, uid());
      assert.equal(r.success, false, u);
      assert.equal(r.error, 'INVALID_URL', u);
    }
    assert.equal(posts.length, 0);
  });

  test('success: sends the NORMALIZED url to the worker and returns normalized data', async () => {
    const r = await extractBusinessData('https://Naxonify.com/', uid());
    assert.equal(r.success, true);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].body.url, 'https://naxonify.com');
    assert.equal(r.data.businessName, 'Naxonify');
  });

  test('the worker refusing a destination (blocked_url, e.g. a redirect to metadata) -> INVALID_URL, and it is NOT retried', async () => {
    postImpl = async () => ({ data: { success: false, error: 'blocked_url', message: 'This URL is not allowed for security reasons' } });
    const r = await extractBusinessData('https://redirects-somewhere.example', uid());
    assert.equal(r.success, false);
    assert.equal(r.error, 'INVALID_URL');
    assert.equal(posts.length, 1, 'a deterministic refusal must not be retried');
  });

  test('worker timeout code -> TIMEOUT', async () => {
    postImpl = async () => ({ data: { success: false, error: 'timeout', message: 'Website took too long to respond' } });
    const r = await extractBusinessData('https://slow.example', uid());
    assert.equal(r.error, 'TIMEOUT');
  });

  test('a worker failure never leaks the worker message / stack to the client', async () => {
    postImpl = async () => ({ data: { success: false, error: 'extraction_failed', message: 'Failed to extract data: /srv/app/secret.py line 42' } });
    const r = await extractBusinessData('https://broken.example', uid());
    assert.equal(r.success, false);
    assert.ok(!JSON.stringify(r).includes('secret.py'));
  });

  test('worker unreachable -> SERVICE_UNAVAILABLE', async () => {
    postImpl = async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); };
    const r = await extractBusinessData('https://example.com', uid());
    assert.equal(r.error, 'SERVICE_UNAVAILABLE');
  });

  test('per-user rate limit', async () => {
    const user = uid();
    for (let i = 0; i < 5; i++) await extractBusinessData(`https://site${i}.example.com`, user);
    const r = await extractBusinessData('https://site6.example.com', user);
    assert.equal(r.error, 'RATE_LIMIT_EXCEEDED');
  });
});
