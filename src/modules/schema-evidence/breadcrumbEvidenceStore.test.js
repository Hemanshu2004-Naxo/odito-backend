import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SchemaBreadcrumbEvidence from './SchemaBreadcrumbEvidence.js';
import { getUserBreadcrumbEvidence, markBreadcrumbEvidenceRegenerated, saveUserBreadcrumbEvidence } from './breadcrumbEvidenceStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAGE = 'https://store-test.example/blog';
const ITEMS = [{ position: 1, name: 'Home', url: 'https://store-test.example/' }, { position: 2, name: 'Blog', url: 'https://store-test.example/blog/' }];
const save = (projectId, over = {}) => saveUserBreadcrumbEvidence({ projectId, pageUrl: PAGE, items: ITEMS, canonicalUrl: ITEMS[1].url, canonicalSource: 'canonical_tag', userId: new mongoose.Types.ObjectId(), ...over });

let mongoAvailable = false;
const ids = [];
before(async () => {
  try { await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 }); mongoAvailable = true; } catch { mongoAvailable = false; }
});
after(async () => {
  if (mongoAvailable) { await SchemaBreadcrumbEvidence.deleteMany({ projectId: { $in: ids } }); await mongoose.connection.close(); }
});

describe('breadcrumbEvidenceStore', () => {
  let a; let b;
  beforeEach(() => { a = new mongoose.Types.ObjectId(); b = new mongoose.Types.ObjectId(); ids.push(a, b); });

  test('saves only what is needed to regenerate and audit, and reads it back', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const r = await save(a);
    assert.equal(r.changed, true);
    const doc = await SchemaBreadcrumbEvidence.findOne({ projectId: a }).lean();
    assert.deepEqual(Object.keys(doc).sort(), ['__v', '_id', 'canonicalSource', 'canonicalUrl', 'createdAt', 'evidenceHash', 'items', 'pageUrl', 'projectId', 'regeneratedAt', 'revision', 'submittedAt', 'submittedBy', 'updatedAt']);
    const read = await getUserBreadcrumbEvidence(a, PAGE);
    // every item also records HOW it came about (typed by default); nothing else about the page is kept
    assert.deepEqual(read.items, ITEMS.map((i) => ({ ...i, origin: 'manual' })));
    assert.equal(read.evidenceHash, r.evidenceHash);
  });

  test('an unchanged submission is not persisted again (no new document, no revision bump, no new timestamp)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await save(a);
    const first = await SchemaBreadcrumbEvidence.findOne({ projectId: a }).lean();
    const again = await save(a);
    const second = await SchemaBreadcrumbEvidence.findOne({ projectId: a }).lean();
    assert.equal(again.changed, false);
    assert.equal(await SchemaBreadcrumbEvidence.countDocuments({ projectId: a }), 1);
    assert.equal(second.revision, first.revision);
    assert.equal(String(second.submittedAt), String(first.submittedAt));
  });

  test('a changed hierarchy updates the same document, bumps the revision and resets regeneratedAt', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await save(a);
    await markBreadcrumbEvidenceRegenerated(a, PAGE);
    assert.ok((await SchemaBreadcrumbEvidence.findOne({ projectId: a }).lean()).regeneratedAt);
    const r = await save(a, { items: [ITEMS[0], { position: 2, name: 'News', url: 'https://store-test.example/news/' }, { position: 3, name: 'Blog', url: ITEMS[1].url }] });
    assert.equal(r.changed, true);
    const doc = await SchemaBreadcrumbEvidence.findOne({ projectId: a }).lean();
    assert.equal(await SchemaBreadcrumbEvidence.countDocuments({ projectId: a }), 1);
    assert.equal(doc.revision, 2);
    assert.equal(doc.items.length, 3);
    assert.equal(doc.regeneratedAt, null);
  });

  test('evidence is strictly project-scoped: another project never reads, overwrites or shares it', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await save(a);
    assert.equal(await getUserBreadcrumbEvidence(b, PAGE), null);
    await save(b, { items: [ITEMS[0], { position: 2, name: 'Journal', url: ITEMS[1].url }] });
    assert.equal((await getUserBreadcrumbEvidence(a, PAGE)).items[1].name, 'Blog');
    assert.equal((await getUserBreadcrumbEvidence(b, PAGE)).items[1].name, 'Journal');
    assert.equal(await SchemaBreadcrumbEvidence.countDocuments({ projectId: { $in: [a, b] } }), 2);
  });

  test('missing arguments return null instead of querying', async () => {
    assert.equal(await getUserBreadcrumbEvidence(null, PAGE), null);
    assert.equal(await getUserBreadcrumbEvidence(new mongoose.Types.ObjectId(), ''), null);
  });

  test('the model refuses a one-item trail and over-long fields', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await assert.rejects(SchemaBreadcrumbEvidence.create({ projectId: a, pageUrl: PAGE, items: [ITEMS[0]], canonicalSource: 'canonical_tag', evidenceHash: 'x', submittedAt: new Date() }));
    await assert.rejects(SchemaBreadcrumbEvidence.create({ projectId: a, pageUrl: PAGE, items: [{ ...ITEMS[0], name: 'x'.repeat(121) }, ITEMS[1]], canonicalSource: 'canonical_tag', evidenceHash: 'x', submittedAt: new Date() }));
  });
});

describe('project deletion', () => {
  test('the collection is registered with the project cascade delete, so a deleted project leaves no evidence behind', () => {
    const text = fs.readFileSync(path.join(__dirname, '../app_user/service/projectCascadeDeleteService.js'), 'utf8');
    assert.match(text, /collection:\s*'schema_breadcrumb_evidence',\s*field:\s*'projectId'/);
    assert.equal(SchemaBreadcrumbEvidence.collection.collectionName, 'schema_breadcrumb_evidence');
  });
});
