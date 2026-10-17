import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import taskVerificationService from './TaskVerificationService.js';
import Task from '../model/Task.js';
import { attachmentExactPaths } from '../../external_integration/mediaFix/imageIdentity.js';
import { UPLOADS, mediaItem } from '../../external_integration/mediaFix/__fixtures__/media.js';

// Live Mongo, auto-skip if unreachable (same pattern as the other TaskVerificationService tests).
//
// A typed per-image alt fix records EVERY image it changed. The recrawl must show the approved alt on THE SAME image — found by the
// wp-image id or an exact upload path — not "some image with that alt text" (the legacy check), and not by file-name similarity.

let mongoAvailable = false;
before(async () => {
  try { await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 }); mongoAvailable = true; } catch { mongoAvailable = false; }
});
const createdProjectIds = [];
after(async () => {
  if (mongoAvailable) {
    const db = mongoose.connection.db;
    await Task.deleteMany({ projectId: { $in: createdProjectIds } });
    for (const name of ['seo_page_data', 'seo_page_issues']) await db.collection(name).deleteMany({ projectId: { $in: createdProjectIds } });
    await mongoose.connection.close();
  }
});

const ALT = 'Dr Rao examining a patient with a slit lamp';
const SRC = `${UPLOADS}/2024/10/dr-rao.jpg`;
const target = { src: SRC, attachmentId: 42, alt: ALT, exactPaths: [...attachmentExactPaths(mediaItem(42, '2024/10/dr-rao.jpg'))] };

async function createAltTask(projectId, pageUrl, expectedAfterValue) {
  return Task.create({
    projectId, issueKey: 'images_missing_alt_text', pageUrl, status: 'implemented', origin: 'wordpress_auto',
    fixHistory: [{
      attemptNumber: 1, attemptKind: 'fix_attempt', origin: 'wordpress_auto', status: 'pending_verification',
      before: { capturedAt: new Date(), source: 'unavailable', dataPath: null, value: null },
      fixApplied: { capturedAt: new Date(), recommendationId: null, recommendationVersion: null, snapshot: null, expectedAfterValue },
      implementedAt: new Date(),
      verification: { verifiedAt: null, method: null, result: null, matched: null, after: { source: 'unavailable', value: null }, triggerJobId: null },
    }],
  });
}

describe('TaskVerificationService — typed image_alt (per-image identity)', () => {
  let projectId;
  beforeEach(async () => {
    if (!mongoAvailable) return;
    projectId = new mongoose.Types.ObjectId();
    createdProjectIds.push(projectId);
    await Task.deleteMany({ projectId });
    await mongoose.connection.db.collection('seo_page_data').deleteMany({ projectId });
    await mongoose.connection.db.collection('seo_page_issues').deleteMany({ projectId });
  });

  const page = (url, images) => mongoose.connection.db.collection('seo_page_data').insertOne({ projectId, url, images });
  const run = async (id) => { await taskVerificationService.verifyImplementedTasks(projectId, id); };

  test('verified_fixed when the SAME image (matched by the wp-image id) shows the approved alt', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const url = 'https://clinic.example/doctors';
    await page(url, [{ src: SRC, alt: ALT, wp_attachment_id: 42 }, { src: `${UPLOADS}/2024/10/other.jpg`, alt: 'Another picture' }]);
    const task = await createAltTask(projectId, url, { type: 'image_alt', alt: ALT, images: [target] });
    await run('ALT-OK');
    const saved = await Task.findById(task._id);
    assert.equal(saved.status, 'verified_fixed');
    assert.equal(saved.fixHistory.at(-1).verification.method, 'value_diff');
    assert.equal(saved.fixHistory.at(-1).verification.matched, true);
  });

  test('a responsive/CDN variant of the same attachment (exact upload path) is matched too', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const url = 'https://clinic.example/doctors-cdn';
    await page(url, [{ src: 'https://cdn.example/wp-content/uploads/2024/10/dr-rao-768x512.jpg', alt: ALT }]);
    const task = await createAltTask(projectId, url, { type: 'image_alt', alt: ALT, images: [target] });
    await run('ALT-CDN');
    assert.equal((await Task.findById(task._id)).status, 'verified_fixed');
  });

  test('REGRESSION: another image carrying the same alt text must NOT verify an image that still has none (the legacy "any image" check)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const url = 'https://clinic.example/doctors-wrong';
    await page(url, [{ src: SRC, alt: '', wp_attachment_id: 42 }, { src: `${UPLOADS}/2024/10/unrelated.jpg`, alt: ALT }]);
    const task = await createAltTask(projectId, url, { type: 'image_alt', alt: ALT, images: [target] });
    await run('ALT-WRONG');
    const saved = await Task.findById(task._id);
    assert.equal(saved.status, 'reopened');
    assert.equal(saved.fixHistory.at(-1).verification.matched, false);
  });

  test('the target cannot be found on the page by stable evidence -> not fixed', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const url = 'https://clinic.example/doctors-missing';
    await page(url, [{ src: `${UPLOADS}/2023/01/dr-rao.jpg`, alt: ALT }]);
    const task = await createAltTask(projectId, url, { type: 'image_alt', alt: ALT, images: [target] });
    await run('ALT-MISSING');
    assert.equal((await Task.findById(task._id)).status, 'reopened');
  });

  test('every image the fix changed must be verified: one good and one wrong -> not fixed', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const url = 'https://clinic.example/doctors-two';
    const second = { src: `${UPLOADS}/2024/11/nurse.jpg`, attachmentId: 43, alt: 'A nurse at the desk', exactPaths: [...attachmentExactPaths(mediaItem(43, '2024/11/nurse.jpg'))] };
    await page(url, [{ src: SRC, alt: ALT, wp_attachment_id: 42 }, { src: second.src, alt: '', wp_attachment_id: 43 }]);
    const task = await createAltTask(projectId, url, { type: 'image_alt', alt: ALT, images: [target, second] });
    await run('ALT-TWO');
    assert.equal((await Task.findById(task._id)).status, 'reopened');
  });

  test('the legacy single-alt expectation (no images list) still works as before', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const url = 'https://clinic.example/legacy';
    await page(url, [{ src: SRC, alt: ALT }]);
    const task = await createAltTask(projectId, url, { type: 'image_alt', alt: ALT });
    await run('ALT-LEGACY');
    assert.equal((await Task.findById(task._id)).status, 'verified_fixed');
  });
});

// ── A typed WordPress fix is judged only by a crawl taken AFTER the write ────────────────────────────────────────────────

describe('TaskVerificationService — typed WordPress fixes need a post-write crawl', () => {
  let projectId;
  beforeEach(async () => {
    if (!mongoAvailable) return;
    projectId = new mongoose.Types.ObjectId();
    createdProjectIds.push(projectId);
    await Task.deleteMany({ projectId });
    await mongoose.connection.db.collection('seo_page_data').deleteMany({ projectId });
    await mongoose.connection.db.collection('seo_page_issues').deleteMany({ projectId });
  });

  const writtenAt = new Date('2026-10-15T10:00:00Z');
  const before = new Date('2026-10-15T09:00:00Z');
  const after = new Date('2026-10-15T11:00:00Z');
  const typedTask = async (url, field = 'image_alt', expected = { type: 'image_alt', alt: ALT, images: [target] }) => {
    const task = await createAltTask(projectId, url, expected);
    task.fixHistory[0].fixApplied.externalWrite = { system: 'wordpress', provider: 'none', field, wordpressPostId: 42, httpStatus: 200, writtenAt, scope: 'post' };
    task.fixHistory[0].implementedAt = writtenAt;
    task.markModified('fixHistory');
    await task.save();
    return task;
  };
  const page = (url, scraped_at, images) => mongoose.connection.db.collection('seo_page_data').insertOne({ projectId, url, images, scraped_at });
  const run = async (id) => { await taskVerificationService.verifyImplementedTasks(projectId, id); };

  test('a crawl OLDER than the write that still shows the old alt does not reopen the task; it stays pending', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const url = 'https://clinic.example/stale-1';
    await page(url, before, [{ src: SRC, alt: '', wp_attachment_id: 42 }]);
    await mongoose.connection.db.collection('seo_page_issues').insertOne({ projectId, page_url: url, rule_id: 'images_missing_alt_text', status: 'open' });
    const task = await typedTask(url);
    await run('FRESH-1');
    assert.equal((await Task.findById(task._id)).status, 'implemented', 'neither verified nor reopened on an old crawl');
  });

  test('a page that is not in the crawl at all is pending, never "the finding is gone so it is fixed"', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const task = await typedTask('https://clinic.example/not-crawled');
    await run('FRESH-2');
    assert.equal((await Task.findById(task._id)).status, 'implemented');
  });

  test('a crawl taken AFTER the write that shows the approved alt on the same image verifies the task', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const url = 'https://clinic.example/fresh-ok';
    await page(url, after, [{ src: SRC, alt: ALT, wp_attachment_id: 42 }]);
    const task = await typedTask(url);
    await run('FRESH-3');
    assert.equal((await Task.findById(task._id)).status, 'verified_fixed');
  });

  test('a crawl taken AFTER the write that still shows the old alt reopens it (that is a real failure, not staleness)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const url = 'https://clinic.example/fresh-bad';
    await page(url, after, [{ src: SRC, alt: '', wp_attachment_id: 42 }]);
    const task = await typedTask(url);
    await run('FRESH-4');
    assert.equal((await Task.findById(task._id)).status, 'reopened');
  });

  test('LEGACY tasks (no typed write recorded) keep their previous behaviour', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const url = 'https://clinic.example/legacy';
    await page(url, before, [{ src: SRC, alt: ALT, wp_attachment_id: 42 }]);
    const task = await createAltTask(projectId, url, { type: 'image_alt', alt: ALT, images: [target] });
    await run('FRESH-5');
    assert.equal((await Task.findById(task._id)).status, 'verified_fixed');
  });
});

describe('TaskVerificationService — a finding WITHDRAWN as not applicable is not a fix', () => {
  let projectId;
  const FB = 'https://www.facebook.com/tr?id=1064713942451011&ev=PageView&noscript=1';
  beforeEach(async () => {
    if (!mongoAvailable) return;
    projectId = new mongoose.Types.ObjectId();
    createdProjectIds.push(projectId);
    await Task.deleteMany({ projectId });
    await mongoose.connection.db.collection('seo_page_data').deleteMany({ projectId });
    await mongoose.connection.db.collection('seo_page_issues').deleteMany({ projectId });
  });
  const finding = (url, status, src = FB) => mongoose.connection.db.collection('seo_page_issues').insertOne({
    projectId, page_url: url, issue_code: 'images_missing_alt_text', rule_id: 'images_missing_alt_text', status, detected_value: src, dedup_key: `${url}|${src}|${status}`,
  });
  const run = async (id) => { await taskVerificationService.verifyImplementedTasks(projectId, id); };

  test('the only finding was an excluded tracking pixel: the task stays implemented — never "verified fixed"', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const url = 'https://clinic.example/about-us';
    await finding(url, 'excluded');
    const task = await createAltTask(projectId, url, null);
    await run('WITHDRAWN-1');
    assert.equal((await Task.findById(task._id)).status, 'implemented');
  });

  test('a genuinely RESOLVED real image on the same page is a real fix: verified_fixed still happens', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const url = 'https://clinic.example/real-fix';
    await finding(url, 'excluded');
    await finding(url, 'resolved', SRC);
    const task = await createAltTask(projectId, url, null);
    await run('WITHDRAWN-2');
    assert.equal((await Task.findById(task._id)).status, 'verified_fixed');
  });

  test('unchanged behaviour: nothing recorded at all -> verified_fixed; a real open finding -> reopened', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const none = 'https://clinic.example/no-docs';
    const open = 'https://clinic.example/still-open';
    await finding(open, 'open', SRC);
    const a = await createAltTask(projectId, none, null);
    const b = await createAltTask(projectId, open, null);
    await run('WITHDRAWN-3');
    assert.equal((await Task.findById(a._id)).status, 'verified_fixed');
    assert.equal((await Task.findById(b._id)).status, 'reopened');
  });
});

describe('TaskVerificationService — a Divi module fix changes ONE use of an attachment (per-occurrence verification)', () => {
  let projectId;
  const HEADER = 'Sapphire Digital Agency header logo';
  const FOOTER = 'Sapphire Digital Agency';
  const occurrenceTarget = { ...target, attachmentId: 42, alt: HEADER, occurrence: { mode: 'one_use', otherAlts: [FOOTER] } };
  beforeEach(async () => {
    if (!mongoAvailable) return;
    projectId = new mongoose.Types.ObjectId();
    createdProjectIds.push(projectId);
    await Task.deleteMany({ projectId });
    await mongoose.connection.db.collection('seo_page_data').deleteMany({ projectId });
    await mongoose.connection.db.collection('seo_page_issues').deleteMany({ projectId });
  });
  const page = (url, images) => mongoose.connection.db.collection('seo_page_data').insertOne({ projectId, url, images, scraped_at: new Date(Date.now() + 60_000) });
  const typed = async (url, expected) => {
    const task = await createAltTask(projectId, url, expected);
    task.fixHistory[0].fixApplied.externalWrite = { system: 'wordpress', provider: 'none', field: 'image_alt', wordpressPostId: 6, httpStatus: 200, writtenAt: new Date(Date.now() - 60_000), scope: 'post' };
    task.fixHistory[0].implementedAt = new Date(Date.now() - 60_000);
    task.markModified('fixHistory');
    await task.save();
    return task;
  };
  const run = async (id) => { await taskVerificationService.verifyImplementedTasks(projectId, id); };
  const expectedFor = (images) => ({ type: 'image_alt', alt: HEADER, images });

  test('the header use now shows the approved text and the footer use keeps its own alt: verified_fixed', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const url = 'https://clinic.example/home-ok';
    await page(url, [{ src: SRC, alt: HEADER, wp_attachment_id: 42 }, { src: SRC, alt: FOOTER, wp_attachment_id: 42 }]);
    const task = await typed(url, expectedFor([occurrenceTarget]));
    await run('OCC-OK');
    assert.equal((await Task.findById(task._id)).status, 'verified_fixed');
  });

  test('the header use is STILL empty: not fixed, even though the footer use has alt text', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const url = 'https://clinic.example/home-empty';
    await page(url, [{ src: SRC, alt: '', wp_attachment_id: 42 }, { src: SRC, alt: FOOTER, wp_attachment_id: 42 }]);
    const task = await typed(url, expectedFor([occurrenceTarget]));
    await run('OCC-EMPTY');
    assert.equal((await Task.findById(task._id)).status, 'reopened');
  });

  test('a use that shows some OTHER text nobody approved is not accepted', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const url = 'https://clinic.example/home-other';
    await page(url, [{ src: SRC, alt: HEADER, wp_attachment_id: 42 }, { src: SRC, alt: 'Something else entirely', wp_attachment_id: 42 }]);
    const task = await typed(url, expectedFor([occurrenceTarget]));
    await run('OCC-OTHER');
    assert.equal((await Task.findById(task._id)).status, 'reopened');
  });

  test('the approved text is shown by NO use (the footer alone has alt): not fixed', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const url = 'https://clinic.example/home-none';
    await page(url, [{ src: SRC, alt: FOOTER, wp_attachment_id: 42 }]);
    const task = await typed(url, expectedFor([occurrenceTarget]));
    await run('OCC-NONE');
    assert.equal((await Task.findById(task._id)).status, 'reopened');
  });

  test('without the occurrence marker the strict rule is unchanged: every use must show the approved text (media-library writes)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const url = 'https://clinic.example/home-strict';
    await page(url, [{ src: SRC, alt: HEADER, wp_attachment_id: 42 }, { src: SRC, alt: FOOTER, wp_attachment_id: 42 }]);
    const task = await typed(url, expectedFor([{ ...target, attachmentId: 42, alt: HEADER }]));
    await run('OCC-STRICT');
    assert.equal((await Task.findById(task._id)).status, 'reopened');
  });
});
