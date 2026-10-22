import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import metaApiService from '../metaApiService.js';
import { getPermalink, validateFacebookPermalink } from './facebookAdapter.js';
import adapters from './index.js';
import { attachPermalink } from '../publicationLifecycle.js';

/**
 * facebookAdapter.getPermalink / validateFacebookPermalink: the one Graph read made after a CONFIRMED publish. metaApiService.request
 * is substituted (same technique as facebookAdapter.test.js) so the REAL adapter logic runs without a network.
 */
async function withRequest(request, fn) {
  const original = metaApiService.request;
  metaApiService.request = request;
  try { return await fn(); } finally { metaApiService.request = original; }
}

const account = { pageId: '865439123326519', accessToken: 'TOKEN-XYZ' };
const POST_ID = '865439123326519_122145283227179997';
const URL_OK = 'https://www.facebook.com/122139385155179997/posts/122145283227179997';

describe('getPermalink - the request', () => {
  test('1: ONE GET /{externalPostId} with only fields=permalink_url, the Page token as the accessToken argument, a short timeout', async () => {
    const calls = [];
    const r = await withRequest(async (args) => { calls.push(args); return { success: true, status: 200, data: { permalink_url: URL_OK, id: POST_ID } }; }, () => getPermalink({ account, externalPostId: POST_ID }));
    assert.deepEqual(r, { permalink: URL_OK, code: null });
    assert.equal(calls.length, 1);
    const [c] = calls;
    assert.equal(c.method, 'GET');
    assert.equal(c.path, `/${POST_ID}`);
    assert.deepEqual(c.params, { fields: 'permalink_url' });
    assert.equal(c.accessToken, 'TOKEN-XYZ');
    assert.equal(c.context, 'facebook_permalink');
    assert.ok(c.timeoutMs > 0 && c.timeoutMs <= 10_000);
  });

  test('2: a bare numeric id (photo / video post) is accepted; anything that is not a Facebook post id is NEVER sent to Graph', async () => {
    const calls = [];
    const req = async (args) => { calls.push(args); return { success: true, status: 200, data: { permalink_url: URL_OK } }; };
    assert.equal((await withRequest(req, () => getPermalink({ account, externalPostId: '122145283227179997' }))).permalink, URL_OK);
    calls.length = 0;
    for (const bad of [undefined, null, '', 'abc', '12', '../me', `${POST_ID}?fields=x`, `${POST_ID}/comments`, `${POST_ID}_1`, '123456_', '_123456', {}, [POST_ID], 'a'.repeat(100)]) {
      const r = await withRequest(req, () => getPermalink({ account, externalPostId: bad }));
      assert.equal(r.permalink, null, String(bad));
      assert.equal(r.code, 'INVALID_POST_ID', String(bad));
    }
    assert.equal(calls.length, 0, 'no request for any of them');
  });
});

describe('getPermalink - outcomes (never throws; only a validated URL or a safe code comes back)', () => {
  const run = (response) => withRequest(async () => response, () => getPermalink({ account, externalPostId: POST_ID }));

  test('3: 200 without permalink_url -> NO_PERMALINK (several shapes)', async () => {
    for (const data of [{}, { id: POST_ID }, { permalink_url: null }, { permalink_url: '' }, null, undefined, 'text', []]) {
      assert.deepEqual(await run({ success: true, status: 200, data }), { permalink: null, code: 'NO_PERMALINK' }, JSON.stringify(data));
    }
  });

  test('4: Graph 4xx / 5xx -> HTTP_<status>', async () => {
    for (const status of [400, 401, 403, 404, 429, 500, 502, 503]) {
      assert.deepEqual(await run({ success: false, kind: 'http', status, data: { error: { message: 'secret detail' } }, message: 'secret detail' }), { permalink: null, code: `HTTP_${status}` });
    }
  });

  test('5: timeout -> TIMEOUT; network failures -> NETWORK; a thrown error -> NETWORK; an empty result -> NETWORK', async () => {
    assert.deepEqual(await run({ success: false, kind: 'timeout', status: null, data: null }), { permalink: null, code: 'TIMEOUT' });
    assert.deepEqual(await run({ success: false, kind: 'network_unknown', status: null, data: null }), { permalink: null, code: 'NETWORK' });
    assert.deepEqual(await run({ success: false, kind: 'network_unsent', status: null, data: null }), { permalink: null, code: 'NETWORK' });
    assert.deepEqual(await run(undefined), { permalink: null, code: 'NETWORK' });
    const thrown = await withRequest(async () => { throw new Error('boom TOKEN-XYZ'); }, () => getPermalink({ account, externalPostId: POST_ID }));
    assert.deepEqual(thrown, { permalink: null, code: 'NETWORK' });
  });

  test('6: nothing but the code leaves the function: no message, body or token in the result', async () => {
    const r = await run({ success: false, kind: 'http', status: 400, data: { error: { message: 'Invalid OAuth access token TOKEN-XYZ' } }, message: 'Invalid OAuth access token TOKEN-XYZ' });
    assert.equal(JSON.stringify(r).includes('TOKEN-XYZ'), false);
    assert.deepEqual(Object.keys(r).sort(), ['code', 'permalink']);
  });

  test('7: a 200 whose permalink_url is not a plain facebook.com https URL is refused INVALID_PERMALINK', async () => {
    for (const bad of ['http://www.facebook.com/x/posts/1', 'https://evil.example/x', 'https://facebook.com.evil.example/x', 'https://www.facebook.com.evil.example/x', 'javascript:alert(1)', 'https://user:pass@www.facebook.com/x', 'https://www.facebook.com/x?access_token=abc', '//www.facebook.com/x', 'not a url', 'https://www.facebook.com/' + 'a'.repeat(600), 12345, { u: 1 }]) {
      assert.deepEqual(await run({ success: true, status: 200, data: { permalink_url: bad } }), { permalink: null, code: 'INVALID_PERMALINK' }, String(bad).slice(0, 60));
    }
  });
});

describe('validateFacebookPermalink', () => {
  test('8: accepts https facebook.com hosts (incl. subdomains) and returns the normalised URL', () => {
    assert.equal(validateFacebookPermalink(URL_OK), URL_OK);
    assert.equal(validateFacebookPermalink('https://facebook.com/page/posts/1'), 'https://facebook.com/page/posts/1');
    assert.equal(validateFacebookPermalink('https://m.facebook.com/story.php?story_fbid=1&id=2'), 'https://m.facebook.com/story.php?story_fbid=1&id=2');
  });
  test('9: rejects everything else', () => {
    for (const bad of [null, undefined, '', 5, 'https://notfacebook.com/x', 'https://fb.example/x', 'ftp://www.facebook.com/x', 'https://www.facebook.com@evil.example/x']) assert.equal(validateFacebookPermalink(bad), null, String(bad));
  });
});

describe('attachPermalink - its own guards (the lookup happens only for a CONFIRMED published Facebook post)', () => {
  const TOKEN = 'ATTACH-TOKEN-SECRET';
  const acct = { pageId: '865439123326519', accessToken: TOKEN };
  const doc = (over = {}) => ({ _id: '6ac090c313dd4aec1c53acc1', status: 'published', platform: 'facebook', externalPostId: POST_ID, permalink: null, ...over });

  /** Runs attachPermalink with the real adapter lookup and a counted Graph client; returns what it did. */
  async function attach(d, account = acct, { respond = async () => ({ success: true, status: 200, data: { permalink_url: URL_OK } }), adapterOverride = null } = {}) {
    const requests = [];
    const logs = [];
    const realLog = { warn: console.warn, info: console.info, log: console.log, error: console.error };
    const realGet = adapters.facebook.getPermalink;
    for (const k of Object.keys(realLog)) console[k] = (...a) => { logs.push(a.map(String).join(' ')); };
    adapters.facebook.getPermalink = adapterOverride || getPermalink;
    try {
      const result = await withRequest(async (args) => { requests.push(args); return respond(args); }, () => attachPermalink(d, account));
      return { result, requests, logs: logs.join('\n') };
    } finally { Object.assign(console, realLog); adapters.facebook.getPermalink = realGet; }
  }

  test('10: a document that is NOT confirmed published never triggers a Graph read (failed, unknown outcome, scheduled, publishing, draft)', async () => {
    for (const over of [{ status: 'failed' }, { status: 'failed', outcomeUnknown: true }, { status: 'scheduled' }, { status: 'publishing' }, { status: 'draft' }]) {
      const { result, requests } = await attach(doc(over));
      assert.equal(requests.length, 0, JSON.stringify(over));
      assert.equal(result.permalink, null);
    }
  });

  test('11: no externalPostId, an existing permalink, another platform, a null document or no account -> no Graph read and nothing overwritten', async () => {
    for (const [d, a] of [[doc({ externalPostId: null }), acct], [doc({ externalPostId: '' }), acct], [doc({ permalink: URL_OK }), acct], [doc({ platform: 'instagram' }), acct], [null, acct], [doc(), null]]) {
      const { result, requests } = await attach(d, a);
      assert.equal(requests.length, 0);
      assert.equal(result, d, 'the document comes back untouched');
    }
  });

  test('12: a lookup that THROWS can never throw out of attachPermalink (the publish stays successful); only a code is logged', async () => {
    const { result, requests, logs } = await attach(doc(), acct, { adapterOverride: async () => { throw new Error(`explode ${TOKEN}`); } });
    assert.equal(requests.length, 0);
    assert.equal(result.status, 'published');
    assert.match(logs, /SOCIAL_PERMALINK/);
    assert.match(logs, /LOOKUP_ERROR/);
    assert.equal(logs.includes(TOKEN), false);
    assert.equal(logs.includes('explode'), false);
  });

  test('13: a failed lookup logs only a safe code - not the account, not the token, not Meta\'s message', async () => {
    const { result, logs } = await attach(doc(), acct, { respond: async () => ({ success: false, kind: 'http', status: 400, data: { error: { message: `Invalid token ${TOKEN}` } }, message: `Invalid token ${TOKEN}` }) });
    assert.equal(result.permalink, null);
    assert.match(logs, /"code":"HTTP_400"/);
    for (const secret of [TOKEN, 'Invalid token', 'accessToken', '865439123326519']) assert.equal(logs.includes(secret), false, secret);
  });
});
