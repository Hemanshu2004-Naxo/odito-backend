import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { promises as fs } from 'fs';
import path from 'path';
import sharp from 'sharp';

dotenv.config();

import SeoProject from '../model/SeoProject.js';
import SocialBusinessProfile from '../../social_meta/model/SocialBusinessProfile.js';
import SocialProduct from '../../social_meta/model/SocialProduct.js';
import { addProductImage, createProduct } from '../../social_meta/service/socialProductService.js';
import { updateProfile, setBrandLogo } from '../../social_meta/service/socialBusinessProfileService.js';
import { processAndStoreCatalogImage } from '../../social_meta/service/media/catalogMedia.js';
import { deleteProjectCascade } from './projectCascadeDeleteService.js';

/**
 * Regression: permanently deleting a project must remove its Product Catalog (documents AND the image files they
 * point at), its embedded services, and its uploaded brand logo — and nothing of any other project.
 */
let mongoAvailable = false;
before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
  } catch {
    mongoAvailable = false;
  }
});
after(async () => {
  if (mongoAvailable) await mongoose.connection.close();
});

const STORAGE_ROOT = path.resolve(process.cwd(), 'storage', 'social_media');
const png = (color) => sharp({ create: { width: 300, height: 300, channels: 3, background: color } }).png().toBuffer();
const fileOf = (url) => path.join(process.cwd(), new URL(url).pathname.replace(/^\//, ''));
const exists = (file) => fs.access(file).then(() => true, () => false);

describe('deleteProjectCascade — Product Catalog, services and brand logo', () => {
  let userId;
  const created = [];
  beforeEach(() => { userId = new mongoose.Types.ObjectId(); });
  after(async () => {
    for (const id of created) await fs.rm(path.join(STORAGE_ROOT, String(id)), { recursive: true, force: true });
  });

  const project = async () => {
    const p = await SeoProject.create({ user_id: userId, project_name: `Cascade Catalog ${Date.now()} ${Math.random().toString(36).slice(2, 8)}`, main_url: 'https://example.com', seo_scope: 'local', keywords: ['k'] });
    created.push(p._id);
    return p;
  };

  /** products with real image files, services, and an uploaded logo for one project; returns every file it wrote */
  async function seed(p) {
    const pid = String(p._id);
    await updateProfile(pid, userId, { businessModel: 'product', services: [{ name: 'Consultation' }], goals: ['x'] });
    const files = [];
    for (const name of ['Serum', 'Cream']) {
      const made = await createProduct(pid, userId, { name });
      for (const color of ['#aa0000', '#00aa00']) {
        const img = await addProductImage(pid, made.product.id, userId, await png(color));
        assert.equal(img.success, true, JSON.stringify(img));
        files.push(fileOf(img.product.images.at(-1).url));
      }
    }
    const logo = await processAndStoreCatalogImage({ buffer: await png('#0000aa'), projectId: pid });
    await setBrandLogo(pid, userId, logo.media);
    files.push(fileOf(logo.media.url));
    return files;
  }

  test('1: removes the project\'s products, their image files and its logo file — and leaves every other project\'s alone', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const doomed = await project();
    const kept = await project();
    const doomedFiles = await seed(doomed);
    const keptFiles = await seed(kept);
    assert.equal(doomedFiles.length, 5);
    for (const f of [...doomedFiles, ...keptFiles]) assert.equal(await exists(f), true);

    const summary = await deleteProjectCascade(String(doomed._id));
    assert.equal(summary.projectDeleted, true);
    assert.equal(summary.failures.length, 0);
    assert.equal(summary.collectionCounts.social_products, 2, 'both products are purged');
    assert.equal(summary.collectionCounts.socialbusinessprofiles, 1, 'the profile (with its embedded services) is purged');
    assert.deepEqual(summary.catalogMediaCounts, { filesDeleted: 5, filesMissing: 0 }, '4 product images + the logo');

    assert.equal(await SocialProduct.countDocuments({ project_id: doomed._id }), 0, 'no orphaned product');
    assert.equal(await SocialBusinessProfile.countDocuments({ project_id: doomed._id }), 0);
    for (const f of doomedFiles) assert.equal(await exists(f), false, 'file removed');
    // the whole media folder of a purged project is removed: it is fine for it to be gone entirely, not merely empty
    assert.equal((await fs.readdir(path.join(STORAGE_ROOT, String(doomed._id))).catch(() => [])).length, 0, 'nothing left in the project\'s media folder');

    // the other project is untouched: documents and files
    assert.equal(await SocialProduct.countDocuments({ project_id: kept._id }), 2);
    assert.equal(await SocialBusinessProfile.countDocuments({ project_id: kept._id }), 1);
    for (const f of keptFiles) assert.equal(await exists(f), true, 'the other project\'s files are intact');

    await deleteProjectCascade(String(kept._id));
    assert.equal(await SocialProduct.countDocuments({ project_id: kept._id }), 0);
    for (const f of keptFiles) assert.equal(await exists(f), false);
  });

  test('2: is idempotent and survives a file that is already gone', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await project();
    const files = await seed(p);
    await fs.rm(files[0]); // e.g. an operator cleaned the folder by hand
    const first = await deleteProjectCascade(String(p._id));
    assert.equal(first.failures.length, 0);
    assert.deepEqual(first.catalogMediaCounts, { filesDeleted: 4, filesMissing: 1 });
    const again = await deleteProjectCascade(String(p._id));
    assert.equal(again.failures.length, 0);
    assert.equal(again.collectionCounts.social_products, 0);
    assert.deepEqual(again.catalogMediaCounts, { filesDeleted: 0, filesMissing: 0 });
  });

  test('3: a corrupted storage key (path traversal, another project\'s folder) is never followed', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const doomed = await project();
    const other = await project();
    const otherFiles = await seed(other);
    const victim = otherFiles[0];
    const victimKey = `${other._id}/${path.basename(victim)}`;

    const mk = await createProduct(String(doomed._id), userId, { name: 'Tampered' });
    await SocialProduct.collection.updateOne({ _id: new mongoose.Types.ObjectId(mk.product.id) }, { $set: { images: [
      { mediaId: new mongoose.Types.ObjectId(), url: 'https://x/a.png', storageKey: victimKey, mimeType: 'image/png' }, // another project's file
      { mediaId: new mongoose.Types.ObjectId(), url: 'https://x/b.png', storageKey: '../../../package.json', mimeType: 'image/png' },
      { mediaId: new mongoose.Types.ObjectId(), url: 'https://x/c.png', storageKey: `${doomed._id}/../${path.basename(victim)}`, mimeType: 'image/png' },
    ] } });

    const summary = await deleteProjectCascade(String(doomed._id));
    assert.equal(summary.failures.length, 0);
    assert.deepEqual(summary.catalogMediaCounts, { filesDeleted: 0, filesMissing: 3 }, 'none of them was a file of the project being deleted');
    assert.equal(await exists(victim), true, 'the other project\'s file survived a tampered reference');
    assert.equal(await exists(path.resolve(process.cwd(), 'package.json')), true);

    await deleteProjectCascade(String(other._id)); // this test's own second project: leave nothing behind
  });
});
