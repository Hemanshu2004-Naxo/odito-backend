import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import express from 'express';
import jwt from 'jsonwebtoken';

dotenv.config();

import { resolveChromePath } from './chromePath.js';

/**
 * Route-level test: the REAL pdfRoutes (JWT auth + validateProjectAccess +
 * download handler + canonical report service + Chromium) against a throw-away
 * user/project in the local development MongoDB. Skipped when MongoDB or Chrome
 * is unavailable. No audit is run; the project has no audit data.
 */

let mongoOk = false;
let server;
let base;
const ids = { ownerUser: new mongoose.Types.ObjectId(), otherUser: new mongoose.Types.ObjectId(), project: new mongoose.Types.ObjectId() };
const tag = `dltest-${Date.now()}`;
const token = (id) => jwt.sign({ id: String(id) }, process.env.JWT_SECRET, { expiresIn: '10m' });
const get = (path, tok) => fetch(`${base}/api/pdf/${path}`, { headers: tok ? { Authorization: `Bearer ${tok}` } : {} });
const chrome = (() => { try { return resolveChromePath({ managedPath: null }); } catch { return null; } })();

before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoOk = true;
  } catch { return; }
  const db = mongoose.connection.db;
  await db.collection('users').insertMany([
    { _id: ids.ownerUser, email: `${tag}-a@test.local`, firstName: 'A', lastName: 'T', isActive: true },
    { _id: ids.otherUser, email: `${tag}-b@test.local`, firstName: 'B', lastName: 'T', isActive: true },
  ]);
  await db.collection('seoprojects').insertOne({
    _id: ids.project, user_id: ids.ownerUser, project_name: 'Download Test', main_url: 'https://dl-test.example/',
    website_score: 70, pages_crawled: 3, created_at: new Date(),
  });
  const { default: pdfRoutes } = await import('../routes/pdfRoutes.js');
  const app = express();
  app.use('/api/pdf', pdfRoutes);
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (!mongoOk) return;
  const db = mongoose.connection.db;
  await db.collection('users').deleteMany({ _id: { $in: [ids.ownerUser, ids.otherUser] } });
  await db.collection('seoprojects').deleteOne({ _id: ids.project });
  const { getPdfBrowserService } = await import('./pdfBrowserService.js');
  await getPdfBrowserService().closeBrowser();
  await new Promise((r) => (server ? server.close(r) : r()));
  await mongoose.connection.close();
});

const skip = (t) => (!mongoOk ? (t.skip('local MongoDB not reachable'), true) : false);

describe('GET /api/pdf/:projectId/download (real routes, real auth)', () => {
  test('owner gets a valid PDF attachment; /report still works', async (t) => {
    if (skip(t)) return;
    if (!chrome) return t.skip('no Chrome/Chromium available');
    const res = await get(`${ids.project}/download`, token(ids.ownerUser));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    assert.match(res.headers.get('content-disposition'), /^attachment; filename="odito-full-audit-dl-test-example-\d{4}-\d{2}-\d{2}\.pdf"$/);
    assert.match(res.headers.get('cache-control'), /private, no-store/);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
    assert.equal(Number(res.headers.get('content-length')), buf.length);
    assert.ok(buf.length > 5000);

    const report = await get(`${ids.project}/report`, token(ids.ownerUser));
    assert.equal(report.status, 200);
    assert.equal((await report.json()).data.metadata.projectId, String(ids.project));
  });

  test('another user is forbidden (403) and receives no PDF', async (t) => {
    if (skip(t)) return;
    const res = await get(`${ids.project}/download`, token(ids.otherUser));
    assert.equal(res.status, 403);
    assert.doesNotMatch(res.headers.get('content-type') || '', /pdf/);
  });

  test('no token -> 401; invalid token -> 401', async (t) => {
    if (skip(t)) return;
    assert.equal((await get(`${ids.project}/download`)).status, 401);
    assert.equal((await get(`${ids.project}/download`, 'garbage')).status, 401);
  });

  test('well-formed but nonexistent project -> 404 JSON that says "Project not found"', async (t) => {
    if (skip(t)) return;
    const res = await get(`${new mongoose.Types.ObjectId()}/download`, token(ids.ownerUser));
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.match(body.message || body.error?.message, /project not found/i);
  });

  test('malformed project id -> 400; bad audit numbers -> 400; unknown audit -> 404 AUDIT_NOT_FOUND', async (t) => {
    if (skip(t)) return;
    assert.equal((await get('not-an-id/download', token(ids.ownerUser))).status, 400);
    for (const bad of ['abc', '0', '-1', '1.5']) {
      const r = await get(`${ids.project}/download?auditNumber=${bad}`, token(ids.ownerUser));
      assert.equal(r.status, 400, bad);
      assert.equal((await r.json()).error.code, 'INVALID_AUDIT_NUMBER');
    }
    const missing = await get(`${ids.project}/download?auditNumber=99`, token(ids.ownerUser));
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, 'AUDIT_NOT_FOUND');
  });

  test('a path the server does not have is a plain 404 with no JSON error code (what an outdated backend returns for /download)', async (t) => {
    if (skip(t)) return;
    const res = await get(`${ids.project}/no-such-endpoint`, token(ids.ownerUser));
    assert.equal(res.status, 404);
    assert.doesNotMatch(res.headers.get('content-type') || '', /json/);
  });
});
