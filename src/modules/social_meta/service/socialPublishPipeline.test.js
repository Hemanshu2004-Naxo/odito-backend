import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SeoProject from '../../app_user/model/SeoProject.js';
import SocialAccount from '../model/SocialAccount.js';
import SocialPublication from '../model/SocialPublication.js';
import metaApiService from './metaApiService.js';
import adapters from './platformAdapters/index.js';
import { getPermalink as realGetPermalink } from './platformAdapters/facebookAdapter.js';
import { reconcileUnknownPublication, attachPermalink } from './publicationLifecycle.js';
import { storedTestMediaUrl, removeStoredTestMedia, TEST_MEDIA_ORIGIN } from '../testSupport/storedMedia.js';
import { updatePublication } from './socialPublishingService.js';
import { promises as fsp } from 'fs';
import path from 'path';
import {
  createPublication, submitContentForApproval, approveContent, submitDesignForApproval, approveDesign,
  schedulePublication, publishNow, executeDuePublications, getPublication,
} from './socialPublishingService.js';

/**
 * The REAL pipeline, end to end, with ONLY the Meta HTTP call replaced (metaApiService.request): approved post ->
 * schedule -> the existing scheduler claims it -> the REAL Facebook adapter builds the Graph request -> result is
 * recorded -> (only after a confirmed publish) one best-effort permalink read. This is what the live Facebook test
 * exercises, minus the network, so each property can be asserted deterministically.
 */

let mongoAvailable = false;
before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
  } catch { mongoAvailable = false; }
});
after(async () => { if (mongoAvailable) await mongoose.connection.close(); });

const TOKEN = 'FB-PAGE-TOKEN-SECRET-VALUE-123';
const POST_ID = '865439123326519_122145283227179997';
const PERMALINK = 'https://www.facebook.com/122139385155179997/posts/122145283227179997';
const future = (ms = 4 * 60_000) => new Date(Date.now() + ms).toISOString();
const publishes = (reqs) => reqs.filter((r) => r.method === 'POST');
const lookups = (reqs) => reqs.filter((r) => r.context === 'facebook_permalink'); // reconciliation also READS the Page feed; that is not a permalink lookup

describe('scheduler -> real Facebook adapter -> published -> permalink (Meta HTTP stubbed)', () => {
  let userId, reviewerId, project, pid, fb, created, metaRequests, respond, realRequest, realAdapterPermalink, captured, realConsole;
  const track = (d) => { created.push(d); return d; };

  const okPublish = () => ({ success: true, status: 200, data: { id: POST_ID } });
  const okLookup = () => ({ success: true, status: 200, data: { permalink_url: PERMALINK } });

  beforeEach(async () => {
    if (!mongoAvailable) return;
    created = [];
    userId = new mongoose.Types.ObjectId();
    reviewerId = new mongoose.Types.ObjectId();
    project = track(await SeoProject.create({ user_id: userId, project_name: `Pipeline ${Date.now()} ${Math.random().toString(36).slice(2, 8)}`, main_url: 'https://example.com', seo_scope: 'local', keywords: ['k'] }));
    pid = project._id.toString();
    fb = await SocialAccount.create({ user_id: userId, project_id: project._id, platform: 'facebook', platformAccountId: '865439123326519', platformAccountName: 'Page', accountType: 'page', pageId: '865439123326519', accessToken: TOKEN, status: 'active', isActive: true, scopes: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'] });
    metaRequests = [];
    respond = async (args) => (args.method === 'GET' ? okLookup() : okPublish());
    realRequest = metaApiService.request;
    realAdapterPermalink = adapters.facebook.getPermalink;
    adapters.facebook.getPermalink = realGetPermalink; // the REAL lookup (other test files stub it)
    metaApiService.request = async (args) => {
      metaRequests.push({ method: args.method, path: args.path, params: { ...(args.params || {}) }, hasToken: args.accessToken === TOKEN, context: args.context, timeoutMs: args.timeoutMs });
      return respond(args);
    };
    captured = [];
    realConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
    for (const k of Object.keys(realConsole)) console[k] = (...a) => { captured.push(a.map(String).join(' ')); };
  });

  afterEach(async () => {
    if (realConsole) for (const k of Object.keys(realConsole)) console[k] = realConsole[k];
    metaApiService.request = realRequest;
    adapters.facebook.getPermalink = realAdapterPermalink;
    if (!mongoAvailable) return;
    const ids = created.map((d) => d._id);
    await Promise.all([SocialPublication.deleteMany({ project_id: { $in: ids } }), SocialAccount.deleteMany({ project_id: { $in: ids } })]);
    await SeoProject.deleteMany({ _id: { $in: ids } });
    for (const id of ids) removeStoredTestMedia(id);
  });

  /** A text-only Facebook post taken through the real approval workflow and scheduled a few minutes out. */
  async function scheduledTextPost(content = 'Odito automated publishing test - please ignore.') {
    const r = await createPublication(pid, userId, { platform: 'facebook', socialAccountId: fb._id.toString(), content });
    const id = r.publication.id;
    await submitContentForApproval(pid, id, userId);
    assert.equal((await approveContent(pid, id, reviewerId, 1)).success, true);
    assert.equal((await submitDesignForApproval(pid, id, userId)).success, true);
    assert.equal((await approveDesign(pid, id, reviewerId, 1)).success, true);
    assert.equal((await schedulePublication(pid, id, userId, future(), 'UTC')).success, true);
    return id;
  }
  const makeDue = (id) => SocialPublication.updateOne({ _id: id }, { $set: { scheduledAt: new Date(Date.now() - 60_000) } });
  const row = (id) => SocialPublication.findById(id).lean();
  const publishDue = async (id) => { await makeDue(id); return executeDuePublications({ projectId: pid }); };

  // ── scheduling vs publishing ──────────────────────────────────────────────
  test('1: scheduling alone makes ZERO Meta requests; a not-yet-due post is left alone by every scheduler tick', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const id = await scheduledTextPost();
    assert.deepEqual(metaRequests, []);
    for (let i = 0; i < 3; i += 1) await executeDuePublications({ projectId: pid });
    assert.deepEqual(metaRequests, []);
    assert.equal((await row(id)).status, 'scheduled');
  });

  test('2: when due, the scheduler claims it and the REAL adapter makes exactly ONE publish request: POST /{page}/feed with only the message, the Page token passed securely', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const id = await scheduledTextPost();
    const run = await publishDue(id);
    assert.equal(run.succeeded, 1);
    assert.equal(publishes(metaRequests).length, 1);
    const [req] = publishes(metaRequests);
    assert.equal(req.path, '/865439123326519/feed');
    assert.deepEqual(req.params, { message: 'Odito automated publishing test - please ignore.' });
    assert.equal(req.hasToken, true);
    assert.equal(req.context, 'facebook_publish_post');
  });

  // ── permalink: success ────────────────────────────────────────────────────
  test('3: after a CONFIRMED publish, ONE permalink read is made: GET /{externalPostId}?fields=permalink_url, token as the accessToken argument, bounded timeout', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const id = await scheduledTextPost();
    await publishDue(id);
    assert.equal(lookups(metaRequests).length, 1);
    const [look] = lookups(metaRequests);
    assert.equal(look.path, `/${POST_ID}`);
    assert.deepEqual(look.params, { fields: 'permalink_url' });
    assert.equal(look.hasToken, true);
    assert.equal(look.context, 'facebook_permalink');
    assert.ok(look.timeoutMs > 0 && look.timeoutMs <= 10_000);
    assert.equal(metaRequests.indexOf(look), metaRequests.length - 1, 'the lookup comes AFTER the publish');
    assert.equal(publishes(metaRequests).length, 1, 'no second publish');
  });

  test('4: the canonical permalink, externalPostId and publishedAt are stored together; status published; the API exposes the permalink', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const id = await scheduledTextPost();
    const before = Date.now();
    await publishDue(id);
    const after = await row(id);
    assert.equal(after.status, 'published');
    assert.equal(after.externalPostId, POST_ID);
    assert.equal(after.permalink, PERMALINK);
    assert.ok(after.publishedAt instanceof Date && after.publishedAt.getTime() >= before - 5_000);
    assert.equal(after.attempts, 1);
    assert.equal(after.lockedBy ?? null, null);
    const api = await getPublication(pid, id);
    assert.equal(api.permalink, PERMALINK);
    assert.equal(api.externalPostId, POST_ID);
    assert.equal(api.status, 'published');
  });

  test('5: the permalink is NEVER built from the post id: it is exactly what Meta returned, even though its numeric segment differs from the Page id in externalPostId', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const id = await scheduledTextPost();
    await publishDue(id);
    const after = await row(id);
    assert.notEqual(after.permalink, `https://www.facebook.com/${POST_ID.split('_')[0]}/posts/${POST_ID.split('_')[1]}`);
    assert.equal(after.permalink, PERMALINK);
  });

  // ── permalink: every failure leaves a published post published ───────────
  const failures = [
    ['200 without permalink_url', async () => ({ success: true, status: 200, data: {} }), 'NO_PERMALINK'],
    ['200 with an empty permalink_url', async () => ({ success: true, status: 200, data: { permalink_url: '' } }), 'NO_PERMALINK'],
    ['200 with a malformed body (not an object)', async () => ({ success: true, status: 200, data: 'oops' }), 'NO_PERMALINK'],
    ['200 with a non-Facebook URL', async () => ({ success: true, status: 200, data: { permalink_url: 'https://evil.example/phish' } }), 'INVALID_PERMALINK'],
    ['200 with an http (not https) URL', async () => ({ success: true, status: 200, data: { permalink_url: 'http://www.facebook.com/x/posts/1' } }), 'INVALID_PERMALINK'],
    ['200 with a URL carrying an access_token', async () => ({ success: true, status: 200, data: { permalink_url: `https://www.facebook.com/x/posts/1?access_token=${TOKEN}` } }), 'INVALID_PERMALINK'],
    ['Graph 4xx (400)', async () => ({ success: false, kind: 'http', status: 400, data: { error: { message: `Unsupported get request ${TOKEN}`, code: 100 } }, message: `Unsupported get request ${TOKEN}` }), 'HTTP_400'],
    ['Graph 4xx (403 permission)', async () => ({ success: false, kind: 'http', status: 403, data: { error: { code: 10, message: 'permission' } }, message: 'permission' }), 'HTTP_403'],
    ['Graph 5xx (503)', async () => ({ success: false, kind: 'http', status: 503, data: null, message: 'down' }), 'HTTP_503'],
    ['timeout', async () => ({ success: false, kind: 'timeout', status: null, data: null, message: 'timed out' }), 'TIMEOUT'],
    ['network error', async () => ({ success: false, kind: 'network_unknown', status: null, data: null, message: 'Could not reach Meta API' }), 'NETWORK'],
  ];
  for (const [label, lookup, code] of failures) {
    test(`6: permalink lookup ${label} -> the post STAYS published (id + publishedAt kept), permalink null, safe code ${code} logged, no second publish`, async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      respond = async (args) => (args.method === 'GET' ? lookup(args) : okPublish());
      const id = await scheduledTextPost();
      const run = await publishDue(id);
      assert.equal(run.succeeded, 1, 'the publish itself still counts as a success');
      const after = await row(id);
      assert.equal(after.status, 'published');
      assert.equal(after.externalPostId, POST_ID);
      assert.ok(after.publishedAt instanceof Date);
      assert.equal(after.permalink ?? null, null);
      assert.equal(after.failureCode ?? null, null);
      assert.equal(after.outcomeUnknown, false);
      assert.equal(publishes(metaRequests).length, 1);
      assert.equal(lookups(metaRequests).length, 1, 'one lookup, never retried');
      const logs = captured.join('\n');
      assert.match(logs, new RegExp(`\\[SOCIAL_PERMALINK\\][^\\n]*"code":"${code}"`));
      for (const secret of [TOKEN, 'Unsupported get request', 'evil.example', 'access_token']) assert.equal(logs.includes(secret), false, `logs must not contain: ${secret}`);
    });
  }

  test('7: a lookup that THROWS (unexpected error) cannot fail the publish', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    respond = async (args) => { if (args.method === 'GET') throw new Error(`boom ${TOKEN}`); return okPublish(); };
    const id = await scheduledTextPost();
    const run = await publishDue(id);
    assert.equal(run.succeeded, 1);
    const after = await row(id);
    assert.equal(after.status, 'published');
    assert.equal(after.permalink ?? null, null);
    assert.equal(captured.join('\n').includes(TOKEN), false);
  });

  // ── unknown outcome / reconciliation ──────────────────────────────────────
  test('8: UNKNOWN outcome (Meta OK but no post id): no permalink lookup at all - there is nothing confirmed to look up', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    respond = async () => ({ success: true, status: 200, data: {} });
    const id = await scheduledTextPost();
    await publishDue(id);
    const after = await row(id);
    assert.equal(after.outcomeUnknown, true);
    assert.equal(after.permalink ?? null, null);
    assert.equal(lookups(metaRequests).length, 0, 'no Graph read with an unconfirmed id');
    await executeDuePublications({ projectId: pid });
    await publishNow(pid, id, userId);
    assert.equal(lookups(metaRequests).length, 0);
    assert.equal(publishes(metaRequests).length, 1, 'no blind re-send either');
  });

  test('9: a definite Meta failure (permission) makes no lookup', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    respond = async () => ({ success: false, kind: 'http', status: 403, data: { error: { type: 'OAuthException', code: 200, message: '(#200) permission' } }, message: '(#200) permission' });
    const id = await scheduledTextPost();
    await publishDue(id);
    assert.equal((await row(id)).status, 'failed');
    assert.equal(lookups(metaRequests).length, 0);
  });

  test('10: reconciliation that CONFIRMS the post exists is the only other route to a lookup: the post becomes published and gets its permalink', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const id = await scheduledTextPost();
    await SocialPublication.updateOne({ _id: id }, { $set: { status: 'failed', outcomeUnknown: true, failureCode: 'PUBLISH_OUTCOME_UNKNOWN', scheduledAt: new Date(Date.now() - 10 * 60_000), lastAttemptAt: new Date(Date.now() - 5 * 60_000) } });
    const realReconcile = adapters.facebook.reconcile;
    adapters.facebook.reconcile = async () => ({ status: 'found', externalPostId: POST_ID });
    try {
      const doc = await SocialPublication.findById(id);
      const r = await reconcileUnknownPublication(doc);
      assert.equal(r.resolution, 'published');
    } finally { adapters.facebook.reconcile = realReconcile; }
    const after = await row(id);
    assert.equal(after.status, 'published');
    assert.equal(after.externalPostId, POST_ID);
    assert.equal(after.permalink, PERMALINK);
    assert.equal(publishes(metaRequests).length, 0, 'reconciliation never publishes');
    assert.equal(lookups(metaRequests).length, 1);
  });

  test('11: reconciliation that finds nothing / cannot tell makes no lookup', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const id = await scheduledTextPost();
    await SocialPublication.updateOne({ _id: id }, { $set: { status: 'failed', outcomeUnknown: true, failureCode: 'PUBLISH_OUTCOME_UNKNOWN', lastAttemptAt: new Date(Date.now() - 5 * 60_000) } });
    const realReconcile = adapters.facebook.reconcile;
    try {
      for (const found of [{ status: 'not_found' }, { status: 'unknown', reason: 'X' }]) {
        adapters.facebook.reconcile = async () => found;
        await reconcileUnknownPublication(await SocialPublication.findById(id));
      }
    } finally { adapters.facebook.reconcile = realReconcile; }
    assert.equal(lookups(metaRequests).length, 0);
    assert.notEqual((await row(id)).status, 'published');
  });

  // ── duplicates ────────────────────────────────────────────────────────────
  test('12: repeated scheduler ticks and several workers at once publish exactly once and look the permalink up exactly once', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    respond = async (args) => { await new Promise((r) => setTimeout(r, 60)); return args.method === 'GET' ? okLookup() : okPublish(); };
    const id = await scheduledTextPost();
    await makeDue(id);
    await Promise.all(Array.from({ length: 5 }, () => executeDuePublications({ projectId: pid })));
    await executeDuePublications({ projectId: pid });
    await executeDuePublications({ projectId: pid });
    assert.equal(publishes(metaRequests).length, 1);
    assert.equal(lookups(metaRequests).length, 1);
    const after = await row(id);
    assert.equal(after.attempts, 1);
    assert.equal(after.permalink, PERMALINK);
    assert.equal(await SocialPublication.countDocuments({ project_id: project._id, externalPostId: POST_ID }), 1);
  });

  test('13: a manual publish of an already-published post sends nothing and does not look the permalink up again; another project cannot publish it at all', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const id = await scheduledTextPost();
    await publishDue(id);
    const sent = metaRequests.length;
    const again = await publishNow(pid, id, userId);
    assert.equal(again.success, false);
    const other = track(await SeoProject.create({ user_id: new mongoose.Types.ObjectId(), project_name: `Pipeline other ${Date.now()}`, main_url: 'https://example.org', seo_scope: 'local', keywords: ['k'] }));
    assert.equal((await publishNow(other._id.toString(), id, userId)).success, false);
    assert.equal(metaRequests.length, sent, 'no further Meta request of any kind');
    assert.equal(await getPublication(other._id.toString(), id), null, 'another project cannot even read it (so cannot read the permalink)');
  });

  test('13b: a stale in-memory copy (permalink still null) can never overwrite a permalink another worker already stored; the stored value and publishedAt are untouched', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const id = await scheduledTextPost();
    await publishDue(id);
    const stored = await row(id);
    assert.equal(stored.permalink, PERMALINK);
    const OTHER = 'https://www.facebook.com/999/posts/888';
    respond = async () => ({ success: true, status: 200, data: { permalink_url: OTHER } });
    const stale = { ...stored, permalink: null };
    const result = await attachPermalink(stale, fb);
    const after = await row(id);
    assert.equal(after.permalink, PERMALINK, 'the first stored permalink wins');
    assert.equal(result.permalink, null, 'the stale copy is returned as-is, nothing was written');
    assert.equal(after.status, 'published');
    assert.equal(after.externalPostId, POST_ID);
    assert.equal(after.publishedAt.getTime(), stored.publishedAt.getTime());
  });

  // ── definite failures / media ─────────────────────────────────────────────
  test('14: a Meta rejection (permission) is a definite, non-retryable failure: failed, no id, no publishedAt, no permalink, one request only', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    respond = async () => ({ success: false, status: 403, error: { type: 'OAuthException', code: 200, message: '(#200) Requires pages_manage_posts permission', fbtrace_id: 'x' } });
    const id = await scheduledTextPost();
    await publishDue(id);
    await executeDuePublications({ projectId: pid });
    assert.equal(metaRequests.length, 1, 'not retried');
    const after = await row(id);
    assert.equal(after.status, 'failed');
    assert.equal(after.externalPostId ?? null, null);
    assert.equal(after.publishedAt ?? null, null);
    assert.equal(after.permalink ?? null, null);
  });

  test('15: an IMAGE post whose media URL is not publicly reachable HTTPS (the dev BACKEND_URL case) is refused BEFORE any Meta request', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { backend } = (await import('../../../config/env.js')).getServiceUrls();
    const r = await createPublication(pid, userId, { platform: 'facebook', socialAccountId: fb._id.toString(), content: 'with image', media: [{ url: `${backend}/storage/social_media/${pid}/${'a'.repeat(8)}-0000-4000-8000-000000000000.jpg`, type: 'image' }] });
    const id = r.publication.id;
    await submitContentForApproval(pid, id, userId);
    await approveContent(pid, id, reviewerId, 1);
    await submitDesignForApproval(pid, id, userId);
    await approveDesign(pid, id, reviewerId, 1);
    const scheduled = await schedulePublication(pid, id, userId, future(), 'UTC');
    const reachable = /^https:\/\//.test(backend) && !/localhost|127\.0\.0\.1|^https:\/\/(10\.|192\.168\.)/.test(backend);
    if (!reachable) {
      assert.equal(scheduled.success, false, 'refused at scheduling time with a clear code');
      assert.equal(scheduled.error.code, 'MEDIA_URL_NOT_PUBLIC');
      assert.deepEqual(metaRequests, []);
    } else {
      assert.equal(scheduled.success, true);
    }
  });

  // ── image posts: the existing Facebook adapter, public HTTPS media ────────
  /** An image post taken through the real approval workflow with a STORED media file on the public HTTPS media origin. */
  async function scheduledImagePost(content = 'Odito image publishing test - please ignore.') {
    const mediaUrl = storedTestMediaUrl(pid);
    const r = await createPublication(pid, userId, { platform: 'facebook', socialAccountId: fb._id.toString(), content, media: [{ url: mediaUrl, type: 'image' }] });
    assert.equal(r.success, true, JSON.stringify(r));
    const id = r.publication.id;
    await submitContentForApproval(pid, id, userId);
    assert.equal((await approveContent(pid, id, reviewerId, 1)).success, true);
    assert.equal((await submitDesignForApproval(pid, id, userId)).success, true);
    assert.equal((await approveDesign(pid, id, reviewerId, 1)).success, true);
    const s = await schedulePublication(pid, id, userId, future(), 'UTC');
    assert.equal(s.success, true, JSON.stringify(s));
    return { id, mediaUrl };
  }

  test('18: an IMAGE post with stored public HTTPS media is published by the SAME adapter via POST /{page}/photos with the server-generated public URL; post_id becomes externalPostId; permalink stored', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    respond = async (args) => (args.method === 'GET' ? okLookup() : { success: true, status: 200, data: { id: '122145283227179001', post_id: POST_ID } });
    const { id, mediaUrl } = await scheduledImagePost();
    assert.deepEqual(metaRequests, [], 'scheduling made no Meta request');
    const before = Date.now();
    const run = await publishDue(id);
    assert.equal(run.succeeded, 1);
    assert.equal(publishes(metaRequests).length, 1, 'one publish request');
    const [req] = publishes(metaRequests);
    assert.equal(req.path, '/865439123326519/photos');
    assert.deepEqual(req.params, { url: mediaUrl, caption: 'Odito image publishing test - please ignore.', published: true });
    assert.ok(req.params.url.startsWith(`${TEST_MEDIA_ORIGIN}/storage/social_media/${pid}/`), 'the URL Meta fetches is on the public media origin');
    assert.equal(req.context, 'facebook_publish_photo');
    assert.equal(lookups(metaRequests).length, 1);
    assert.equal(lookups(metaRequests)[0].path, `/${POST_ID}`, 'the permalink is read for the post id, not the photo id');
    const after = await row(id);
    assert.equal(after.status, 'published');
    assert.equal(after.externalPostId, POST_ID);
    assert.equal(after.permalink, PERMALINK);
    assert.ok(after.publishedAt.getTime() >= before - 5_000);
    assert.equal(after.attempts, 1);
    assert.equal(after.media[0].url, mediaUrl);
    assert.equal(await SocialPublication.countDocuments({ project_id: project._id, externalPostId: POST_ID }), 1);
  });

  test('19: an image post is published ONCE under concurrent workers and repeated ticks (one /photos request)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    respond = async (args) => { await new Promise((r) => setTimeout(r, 50)); return args.method === 'GET' ? okLookup() : { success: true, status: 200, data: { id: '1', post_id: POST_ID } }; };
    const { id } = await scheduledImagePost();
    await makeDue(id);
    await Promise.all(Array.from({ length: 4 }, () => executeDuePublications({ projectId: pid })));
    await executeDuePublications({ projectId: pid });
    assert.equal(publishes(metaRequests).length, 1);
    assert.equal(lookups(metaRequests).length, 1);
  });

  test('20: scheduling refuses media Meta cannot fetch, with a clear code and ZERO Meta requests: a legacy private-origin URL, a deleted file', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { backend } = (await import('../../../config/env.js')).getServiceUrls();
    const legacy = `${backend}/storage/social_media/${pid}/123e4567-e89b-42d3-a456-426614174000.jpg`;
    const approvedWith = async (url) => {
      const r = await createPublication(pid, userId, { platform: 'facebook', socialAccountId: fb._id.toString(), content: 'x', media: [{ url, type: 'image' }] });
      assert.equal(r.success, true, JSON.stringify(r));
      await submitContentForApproval(pid, r.publication.id, userId);
      await approveContent(pid, r.publication.id, reviewerId, 1);
      await submitDesignForApproval(pid, r.publication.id, userId);
      await approveDesign(pid, r.publication.id, reviewerId, 1);
      return r.publication.id;
    };
    const privateId = await approvedWith(legacy);
    const a = await schedulePublication(pid, privateId, userId, future(), 'UTC');
    assert.equal(a.error.code, 'MEDIA_URL_NOT_PUBLIC');
    assert.match(a.error.message, /publicly reachable HTTPS media URL/);

    const goneUrl = storedTestMediaUrl(pid);
    const goneId = await approvedWith(goneUrl);
    await fsp.rm(path.join(process.cwd(), 'storage', 'social_media', pid, goneUrl.split('/').pop()), { force: true });
    const b = await schedulePublication(pid, goneId, userId, future(), 'UTC');
    assert.equal(b.error.code, 'MEDIA_FILE_MISSING');
    assert.equal((await row(privateId)).status, 'draft');
    assert.equal((await row(goneId)).status, 'draft');
    assert.deepEqual(metaRequests, []);
  });

  test('21: a client cannot put an arbitrary media URL on a post: create and edit both refuse anything that is not an Odito-issued URL (SSRF / look-alike / metadata addresses)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const forged = [
      `https://evil.example/storage/social_media/${pid}/123e4567-e89b-42d3-a456-426614174000.jpg`, `${TEST_MEDIA_ORIGIN}.evil.example/storage/social_media/${pid}/123e4567-e89b-42d3-a456-426614174000.jpg`,
      'http://169.254.169.254/latest/meta-data/', 'file:///etc/passwd', 'https://cdn.example.com/photo.jpg',
    ];
    const ok = await createPublication(pid, userId, { platform: 'facebook', socialAccountId: fb._id.toString(), content: 'plain' });
    for (const url of forged) {
      const c = await createPublication(pid, userId, { platform: 'facebook', socialAccountId: fb._id.toString(), content: 'x', media: [{ url, type: 'image' }] });
      assert.equal(c.success, false, url);
      assert.equal(c.error.code, 'INVALID_MEDIA');
      const u = await updatePublication(pid, ok.publication.id, userId, { media: [{ url, type: 'image' }] });
      assert.equal(u.success, false, url);
      assert.equal(u.error.code, 'INVALID_MEDIA');
    }
    assert.equal((await row(ok.publication.id)).media.length, 0);
    assert.deepEqual(metaRequests, []);
  });

  // ── secrets ───────────────────────────────────────────────────────────────
  test('16: the Page token never appears in logs, the stored publication, the API publication, or scheduler results - on success, lookup failure or publish failure', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const ok = await scheduledTextPost('first');
    const run1 = await publishDue(ok);
    respond = async (args) => (args.method === 'GET' ? { success: false, kind: 'http', status: 400, data: { error: { message: `bad ${TOKEN}` } }, message: `bad ${TOKEN}` } : { success: false, status: 400, error: { type: 'OAuthException', code: 100, message: `Invalid parameter (request used access_token=${TOKEN})` } });
    const bad = await scheduledTextPost('second');
    const run2 = await publishDue(bad);
    const everything = JSON.stringify([run1, run2, await row(ok), await row(bad), await getPublication(pid, ok), await getPublication(pid, bad)]);
    const logs = captured.join('\n');
    assert.ok(logs.includes('SOCIAL_'), 'the capture is live');
    assert.equal(everything.includes(TOKEN), false, 'data');
    assert.equal(logs.includes(TOKEN), false, 'logs');
    assert.equal(/access_token/i.test(logs), false, 'no token query parameter in logs');
  });

  test('17: safe attempt info is logged (publication, project, platform, attempt, outcome) so a live run can be reconstructed', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const id = await scheduledTextPost();
    await publishDue(id);
    const logs = captured.join('\n');
    assert.match(logs, new RegExp(`"publicationId":"${id}"`));
    assert.match(logs, /SOCIAL_PUBLISH_SUCCESS|SOCIAL_PUBLISH_CLAIM|SOCIAL_SCHEDULER_CHECK/);
  });
});
