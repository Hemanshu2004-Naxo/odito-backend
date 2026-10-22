import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import 'dotenv/config';
import { promises as fs } from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import express from 'express';
import sharp from 'sharp';
import apiRoutes from '../../../routes/index.js';
import User from '../../user/model/User.js';
import SeoProject from '../../app_user/model/SeoProject.js';
import SocialProduct from '../model/SocialProduct.js';
import SocialBusinessProfile from '../model/SocialBusinessProfile.js';
import { signAuthToken } from '../../user/service/tokenService.js';

/**
 * The Product Catalog API end to end: a real Express app mounting the real /api router (real JWT auth, real
 * multer, real validateProjectAccess), real MongoDB, real files under storage/social_media/. Every case is a
 * no-op pass when MongoDB is unreachable (same convention as the other live-Mongo tests).
 */

let server;
let base;
let mongoAvailable = false;
let owner;
let stranger;
let projectA;
let projectB;
let tokenA;
let tokenB;
const created = { products: [] };

const STORAGE_ROOT = path.resolve(process.cwd(), 'storage', 'social_media');

before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
  } catch { mongoAvailable = false; }

  const app = express();
  app.use(express.json());
  app.use('/api', apiRoutes);
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  if (!mongoAvailable) return;

  const mkUser = (tag) => User.create({ firstName: 'Cat', lastName: tag, email: `catalog-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`, password: 'password123', roleId: 5, isActive: true, isEmailVerified: true });
  owner = await mkUser('A');
  stranger = await mkUser('B');
  const mkProject = (u, tag) => SeoProject.create({ user_id: u._id, project_name: `Catalog ${tag} ${Date.now()} ${Math.random().toString(36).slice(2, 8)}`, main_url: 'https://example.com', seo_scope: 'local', keywords: ['k'] });
  projectA = await mkProject(owner, 'A');
  projectB = await mkProject(stranger, 'B');
  tokenA = signAuthToken(owner);
  tokenB = signAuthToken(stranger);
});

after(async () => {
  server?.close();
  if (!mongoAvailable) return;
  const ids = [projectA?._id, projectB?._id].filter(Boolean);
  await SocialProduct.deleteMany({ project_id: { $in: ids } });
  await SocialBusinessProfile.deleteMany({ project_id: { $in: ids } });
  await SeoProject.deleteMany({ _id: { $in: ids } });
  await User.deleteMany({ _id: { $in: [owner?._id, stranger?._id].filter(Boolean) } });
  for (const id of ids) await fs.rm(path.join(STORAGE_ROOT, String(id)), { recursive: true, force: true });
  await mongoose.connection.close();
});

// ── helpers ──────────────────────────────────────────────────────────────────

async function call(method, urlPath, { token = tokenA, body, form } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(base + urlPath, { method, headers, body: payload });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json };
}

const pidA = () => String(projectA._id);
const pidB = () => String(projectB._id);
const q = (pid) => `projectId=${encodeURIComponent(pid)}`;
const createProduct = (body = {}, pid = pidA(), token = tokenA) => call('POST', '/api/social/products', { token, body: { projectId: pid, name: `Serum ${Math.random().toString(36).slice(2, 8)}`, ...body } });

async function pngBuffer({ width = 400, height = 300, color = '#3366cc' } = {}) {
  return sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
}

function imageForm(pid, buffer, { filename = 'photo.png', type = 'image/png' } = {}) {
  const form = new FormData();
  form.append('projectId', pid);
  form.append('file', new Blob([buffer], { type }), filename);
  return form;
}

const upload = (productId, buffer, opts = {}, pid = pidA(), token = tokenA) => call('POST', `/api/social/products/${productId}/images`, { token, form: imageForm(pid, buffer, opts) });
const fileOnDisk = (url) => path.join(process.cwd(), new URL(url).pathname.replace(/^\//, ''));
const exists = async (file) => fs.access(file).then(() => true, () => false);

// ── authentication / authorization ───────────────────────────────────────────

describe('Product Catalog API — authentication and project isolation', () => {
  test('1: every endpoint refuses a request without a JWT', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const fake = '507f1f77bcf86cd799439011';
    const calls = [
      ['GET', `/api/social/products?${q(pidA())}`], ['POST', '/api/social/products'], ['GET', `/api/social/products/${fake}?${q(pidA())}`],
      ['PATCH', `/api/social/products/${fake}`], ['DELETE', `/api/social/products/${fake}?${q(pidA())}`],
      ['POST', `/api/social/products/${fake}/images`], ['PATCH', `/api/social/products/${fake}/images/reorder`],
      ['PATCH', `/api/social/products/${fake}/images/${fake}`], ['PUT', `/api/social/products/${fake}/images/${fake}`],
      ['DELETE', `/api/social/products/${fake}/images/${fake}?${q(pidA())}`],
      ['POST', '/api/social/business-profile/logo'], ['DELETE', `/api/social/business-profile/logo?${q(pidA())}`],
    ];
    for (const [method, url] of calls) {
      const res = await call(method, url, { token: null, body: method === 'GET' || method === 'DELETE' ? undefined : { projectId: pidA() } });
      assert.equal(res.status, 401, `${method} ${url}`);
    }
  });

  test('2: a user cannot list, create or touch products in someone else\'s project (403/404 before any handler runs)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const made = await createProduct({ name: 'Owner Only Serum' });
    assert.equal(made.status, 201);
    const id = made.body.data.product.id;

    for (const [method, url, body] of [
      ['GET', `/api/social/products?${q(pidA())}`],
      ['GET', `/api/social/products/${id}?${q(pidA())}`],
      ['POST', '/api/social/products', { projectId: pidA(), name: 'Hijack' }],
      ['PATCH', `/api/social/products/${id}`, { projectId: pidA(), name: 'Hijacked' }],
      ['DELETE', `/api/social/products/${id}?${q(pidA())}`],
    ]) {
      const res = await call(method, url, { token: tokenB, body });
      assert.ok([403, 404].includes(res.status), `${method} ${url} -> ${res.status}`);
      assert.equal(JSON.stringify(res.body).includes('Owner Only Serum'), false);
    }
    const doc = await SocialProduct.findById(id).lean();
    assert.equal(doc.name, 'Owner Only Serum', 'untouched');
    assert.equal(await SocialProduct.countDocuments({ project_id: projectA._id, name: 'Hijack' }), 0);
  });

  test('3: a product id from Project A is "not found" when addressed through the user\'s OWN Project B (no cross-project read or write)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const made = await createProduct({ name: 'Cross Project Serum' });
    const id = made.body.data.product.id;
    const img = await upload(id, await pngBuffer());
    assert.equal(img.status, 201);
    const mediaId = img.body.data.mediaId;

    const attempts = [
      ['GET', `/api/social/products/${id}?${q(pidB())}`],
      ['PATCH', `/api/social/products/${id}`, { projectId: pidB(), name: 'Stolen' }],
      ['DELETE', `/api/social/products/${id}?${q(pidB())}`],
      ['PATCH', `/api/social/products/${id}/images/${mediaId}`, { projectId: pidB(), altText: 'x' }],
      ['PATCH', `/api/social/products/${id}/images/reorder`, { projectId: pidB(), mediaIds: [mediaId] }],
      ['DELETE', `/api/social/products/${id}/images/${mediaId}?${q(pidB())}`],
    ];
    for (const [method, url, body] of attempts) {
      const res = await call(method, url, { token: tokenB, body });
      assert.equal(res.status, 404, `${method} ${url}`);
    }
    const up = await upload(id, await pngBuffer(), {}, pidB(), tokenB);
    assert.equal(up.status, 404);

    const doc = await SocialProduct.findById(id).lean();
    assert.equal(doc.name, 'Cross Project Serum');
    assert.equal(doc.images.length, 1, 'the image is still there');
    assert.equal(await exists(fileOnDisk(img.body.data.product.images[0].url)), true, 'and so is its file');
    assert.equal((await call('GET', `/api/social/products?${q(pidB())}`, { token: tokenB })).body.data.total, 0, 'Project B sees none of Project A\'s products');
  });

  test('4: an operator-shaped projectId (?projectId[$ne]=x) never returns data', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await createProduct({ name: 'Operator Probe' });
    const res = await call('GET', '/api/social/products?projectId[$ne]=x', { token: tokenA });
    assert.ok(res.status >= 400, String(res.status));
    assert.equal(JSON.stringify(res.body).includes('Operator Probe'), false);
  });
});

// ── CRUD + validation ────────────────────────────────────────────────────────

describe('Product Catalog API — create, read, update, delete', () => {
  test('5: create returns the PUBLIC shape (no storage key, no user ids) and a generated slug; read and list agree', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const res = await createProduct({
      name: 'Premium Face Serum', description: 'Hydrating vitamin C serum.', shortDescription: 'Vitamin C', category: 'Skincare', subcategory: 'Serums',
      features: ['Vitamin C', 'Hyaluronic acid'], benefits: ['Brighter skin'], price: 999, salePrice: '799.50', currency: 'inr',
      productUrl: 'shop.example.com/serum', sku: 'SER-001', tags: ['skincare', 'Skincare', 'serum'],
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const p = res.body.data.product;
    assert.equal(p.slug, 'premium-face-serum');
    assert.equal(p.currency, 'INR');
    assert.equal(p.price, 999);
    assert.equal(p.salePrice, 799.5);
    assert.equal(p.priceDisplay, '₹999');
    assert.equal(p.salePriceDisplay, '₹799.50');
    assert.equal(p.productUrl, 'https://shop.example.com/serum');
    assert.deepEqual(p.tags, ['skincare', 'serum'], 'case-insensitive duplicates removed');
    assert.equal(p.status, 'active');
    assert.deepEqual(p.images, []);
    for (const hidden of ['project_id', 'createdBy', 'updatedBy', '__v', '_id', 'storageKey']) assert.equal(hidden in p, false, hidden);

    const one = await call('GET', `/api/social/products/${p.id}?${q(pidA())}`);
    assert.equal(one.status, 200);
    assert.equal(one.body.data.product.name, 'Premium Face Serum');
    const list = await call('GET', `/api/social/products?${q(pidA())}`);
    assert.ok(list.body.data.products.some((x) => x.id === p.id));
    assert.equal(list.body.data.limit, 100);
  });

  test('6: optional fields really are optional (no SKU, no price, no URL) and two products can both have no SKU', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const a = await createProduct({ name: 'Plain One' });
    const b = await createProduct({ name: 'Plain Two' });
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    const p = a.body.data.product;
    assert.deepEqual([p.price, p.salePrice, p.currency, p.productUrl, p.sku, p.priceDisplay], [null, null, null, null, null, null]);
  });

  test('7: update changes only the named fields; null clears an optional one; the slug stays stable when the name changes', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const made = await createProduct({ name: 'Original Name', price: 10, currency: 'USD', category: 'Cat', sku: 'UPD-1' });
    const p = made.body.data.product;
    const res = await call('PATCH', `/api/social/products/${p.id}`, { body: { projectId: pidA(), name: 'Renamed', price: 12.5, sku: null, status: 'draft' } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const u = res.body.data.product;
    assert.deepEqual([u.name, u.price, u.sku, u.status, u.category, u.currency, u.slug], ['Renamed', 12.5, null, 'draft', 'Cat', 'USD', p.slug]);
    const cleared = await call('PATCH', `/api/social/products/${p.id}`, { body: { projectId: pidA(), price: null, currency: null } });
    assert.equal(cleared.status, 200);
    assert.deepEqual([cleared.body.data.product.price, cleared.body.data.product.currency], [null, null]);
  });

  test('8: delete removes the product and its image files; a second delete is 404', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const made = await createProduct({ name: 'To Delete' });
    const id = made.body.data.product.id;
    const img = await upload(id, await pngBuffer());
    const file = fileOnDisk(img.body.data.product.images[0].url);
    assert.equal(await exists(file), true);

    const del = await call('DELETE', `/api/social/products/${id}?${q(pidA())}`);
    assert.equal(del.status, 200);
    assert.equal(await SocialProduct.countDocuments({ _id: id }), 0);
    assert.equal(await exists(file), false, 'the image file is gone with the product');
    assert.equal((await call('DELETE', `/api/social/products/${id}?${q(pidA())}`)).status, 404);
    assert.equal((await call('GET', `/api/social/products/${id}?${q(pidA())}`)).status, 404);
  });

  test('9: duplicate SKU is a 409 inside a project but fine across projects; a duplicate name gets its own slug', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const sku = `DUP-${Date.now()}`;
    assert.equal((await createProduct({ name: 'Sku One', sku })).status, 201);
    const dup = await createProduct({ name: 'Sku Two', sku });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.details.code, 'DUPLICATE_SKU');
    assert.equal((await createProduct({ name: 'Other Project Same Sku', sku }, pidB(), tokenB)).status, 201, 'SKU uniqueness is per project');

    const one = await createProduct({ name: 'Twin Product' });
    const two = await createProduct({ name: 'Twin Product' });
    assert.equal(one.status, 201);
    assert.equal(two.status, 201);
    assert.notEqual(one.body.data.product.slug, two.body.data.product.slug);
    assert.match(two.body.data.product.slug, /^twin-product-\d+$/);

    const slugClash = await createProduct({ name: 'Third', slug: one.body.data.product.slug });
    assert.equal(slugClash.status, 409);
    assert.equal(slugClash.body.details.code, 'DUPLICATE_SLUG');
    const upd = await call('PATCH', `/api/social/products/${two.body.data.product.id}`, { body: { projectId: pidA(), sku } });
    assert.equal(upd.status, 409, 'an update cannot steal an existing SKU either');
  });

  test('10: the catalog size is bounded per project', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const spare = await SeoProject.create({ user_id: owner._id, project_name: `Catalog Full ${Date.now()}`, main_url: 'https://example.com', seo_scope: 'local', keywords: ['k'] });
    try {
      await SocialProduct.insertMany(Array.from({ length: 100 }, (_, i) => ({ project_id: spare._id, name: `P${i}`, slug: `p-${i}` })));
      const res = await createProduct({ name: 'One Too Many' }, String(spare._id));
      assert.equal(res.status, 409);
      assert.equal(res.body.details.code, 'PRODUCT_LIMIT_REACHED');
    } finally {
      await SocialProduct.deleteMany({ project_id: spare._id });
      await SeoProject.deleteOne({ _id: spare._id });
    }
  });

  test('11: status filter works, and an operator-shaped status is refused', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const draft = await createProduct({ name: 'Draft One', status: 'draft' });
    const draftId = draft.body.data.product.id;
    const onlyDrafts = await call('GET', `/api/social/products?${q(pidA())}&status=draft`);
    assert.equal(onlyDrafts.status, 200);
    assert.ok(onlyDrafts.body.data.products.every((p) => p.status === 'draft'));
    assert.ok(onlyDrafts.body.data.products.some((p) => p.id === draftId));
    assert.equal((await call('GET', `/api/social/products?${q(pidA())}&status=bogus`)).status, 400);
    assert.equal((await call('GET', `/api/social/products?${q(pidA())}&status[$ne]=draft`)).status, 400);
  });
});

describe('Product Catalog API — validation', () => {
  const rejects = async (body, code, pattern) => {
    const res = await createProduct(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    if (code) assert.equal(res.body.details.code, code, JSON.stringify(res.body));
    if (pattern) assert.match(res.body.message, pattern);
    return res;
  };

  test('12: name is required and bounded; bad types are refused', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    assert.equal((await call('POST', '/api/social/products', { body: { projectId: pidA() } })).status, 400);
    await rejects({ name: '   ' }, 'INVALID_PRODUCT', /name/);
    await rejects({ name: 'x'.repeat(151) }, 'INVALID_PRODUCT', /150/);
    await rejects({ name: 42 }, 'INVALID_PRODUCT', /name/);
    await rejects({ name: 'ok', description: 'd'.repeat(2001) }, 'INVALID_PRODUCT', /description/);
    await rejects({ name: 'ok', shortDescription: 's'.repeat(301) }, 'INVALID_PRODUCT');
    await rejects({ name: 'bad\u0000name' }, 'INVALID_PRODUCT');
    await rejects({ name: 'multi\nline' }, 'INVALID_PRODUCT');
  });

  test('13: price, salePrice and currency are validated, including the rules between them', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await rejects({ price: -1, currency: 'USD' }, 'INVALID_PRODUCT', /price/);
    await rejects({ price: 'abc', currency: 'USD' }, 'INVALID_PRODUCT', /price/);
    await rejects({ price: 1.234, currency: 'USD' }, 'INVALID_PRODUCT', /decimal/);
    await rejects({ price: 'NaN', currency: 'USD' }, 'INVALID_PRODUCT', /price/);
    await rejects({ price: 'Infinity', currency: 'USD' }, 'INVALID_PRODUCT', /price/);
    await rejects({ price: 1e12, currency: 'USD' }, 'INVALID_PRODUCT', /large/);
    await rejects({ price: { $gt: 0 }, currency: 'USD' }, 'INVALID_PRODUCT');
    await rejects({ price: 10 }, 'INVALID_PRODUCT', /currency is required/);
    await rejects({ price: 10, currency: 'XXZ' }, 'INVALID_PRODUCT', /currency/);
    await rejects({ price: 10, currency: 'US' }, 'INVALID_PRODUCT', /currency/);
    await rejects({ price: 10, currency: 'US$' }, 'INVALID_PRODUCT', /currency/);
    await rejects({ price: 10, salePrice: 20, currency: 'USD' }, 'INVALID_PRODUCT', /salePrice/);
    await rejects({ salePrice: 5, currency: 'USD' }, 'INVALID_PRODUCT', /regular price/);
    assert.equal((await createProduct({ price: 0, currency: 'USD' })).status, 201, 'free is a valid price');
  });

  test('14: productUrl must be a safe public web address', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    for (const bad of [
      'javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd', 'ftp://example.com/x', 'vbscript:x',
      'http://localhost/admin', 'http://127.0.0.1/', 'http://10.0.0.5/x', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/', 'http://2130706433/', 'http://0x7f000001/',
      'https://user:pass@example.com/', 'http://internal.local/', 'notaurl', `https://example.com/${'a'.repeat(500)}`,
    ]) {
      await rejects({ productUrl: bad }, 'INVALID_PRODUCT');
    }
    assert.equal((await createProduct({ productUrl: 'https://shop.example.com/p?id=1' })).status, 201);
  });

  test('15: sku, tags, features and benefits are bounded', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await rejects({ sku: 'x'.repeat(65) }, 'INVALID_PRODUCT', /sku/);
    await rejects({ sku: '../../etc/passwd' }, 'INVALID_PRODUCT', /sku/);
    await rejects({ sku: { $ne: null } }, 'INVALID_PRODUCT');
    await rejects({ tags: Array.from({ length: 16 }, (_, i) => `tag${i}`) }, 'INVALID_PRODUCT', /tags/);
    await rejects({ tags: ['t'.repeat(41)] }, 'INVALID_PRODUCT', /tags/);
    await rejects({ tags: 'not-a-list' }, 'INVALID_PRODUCT');
    await rejects({ features: Array.from({ length: 11 }, (_, i) => `f${i}`) }, 'INVALID_PRODUCT', /features/);
    await rejects({ benefits: ['b'.repeat(201)] }, 'INVALID_PRODUCT', /benefits/);
    await rejects({ status: 'deleted' }, 'INVALID_PRODUCT', /status/);
    await rejects({ slug: 'Not A Slug!' }, 'INVALID_PRODUCT', /slug/);
    await rejects({ slug: '../../x' }, 'INVALID_PRODUCT', /slug/);
  });

  test('16: unknown fields, Mongo operators, images and project ids in the body are rejected, never stored', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await rejects({ $where: 'sleep(1000)' }, 'UNKNOWN_FIELD');
    await rejects({ '$set': { name: 'x' } }, 'UNKNOWN_FIELD');
    await rejects({ project_id: String(projectB._id) }, 'UNKNOWN_FIELD');
    await rejects({ createdBy: String(stranger._id) }, 'UNKNOWN_FIELD');
    await rejects({ _id: '507f1f77bcf86cd799439011' }, 'UNKNOWN_FIELD');
    await rejects({ storageKey: 'x/y.png' }, 'UNKNOWN_FIELD');
    await rejects({ images: [{ url: 'https://evil.example/x.png', storageKey: '../../etc/passwd' }] }, 'UNKNOWN_FIELD', /upload/i);
    await rejects({ name: { $gt: '' } }, 'INVALID_PRODUCT');
    await rejects({ name: ['a'] }, 'INVALID_PRODUCT');

    const made = await createProduct({ name: 'Operator Target' });
    const id = made.body.data.product.id;
    for (const bad of [{ $set: { name: 'x' } }, { name: 'ok', 'images.0.url': 'x' }, { $unset: { name: 1 } }, {}]) {
      const res = await call('PATCH', `/api/social/products/${id}`, { body: { projectId: pidA(), ...bad } });
      assert.equal(res.status, 400, JSON.stringify(bad));
    }
    assert.equal((await SocialProduct.findById(id).lean()).name, 'Operator Target');
  });
});

// ── images ───────────────────────────────────────────────────────────────────

describe('Product Catalog API — product images', () => {
  const freshProduct = async (name = 'Imaged Product') => (await createProduct({ name })).body.data.product.id;

  test('17: an uploaded image is validated, re-encoded and stored under the project folder; the first one is primary', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const id = await freshProduct();
    const res = await upload(id, await pngBuffer({ width: 640, height: 480 }));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const img = res.body.data.product.images[0];
    assert.match(img.mediaId, /^[a-f0-9]{24}$/);
    assert.equal(img.mimeType, 'image/png');
    assert.deepEqual([img.width, img.height], [640, 480]);
    assert.equal(img.isPrimary, true);
    assert.equal(img.sortOrder, 0);
    assert.equal(res.body.data.product.primaryImageUrl, img.url);
    assert.ok(img.url.includes(`/storage/social_media/${pidA()}/`), img.url);
    assert.match(new URL(img.url).pathname, /\/[0-9a-f-]{36}\.png$/, 'a fresh UUID name, never the client\'s');
    assert.equal(JSON.stringify(res.body).includes('storageKey'), false, 'the storage key is internal');
    assert.equal(await exists(fileOnDisk(img.url)), true);
    // the document holds the reference, not bytes
    const doc = await SocialProduct.findById(id).lean();
    assert.equal(doc.images[0].storageKey.startsWith(`${pidA()}/`), true);
    assert.ok(JSON.stringify(doc).length < 2000, 'no binary in MongoDB');
  });

  test('18: the client file name never reaches storage (path-traversal names are ignored)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const id = await freshProduct();
    const res = await upload(id, await pngBuffer(), { filename: '../../../../etc/passwd.png' });
    assert.equal(res.status, 201);
    const url = res.body.data.product.images[0].url;
    assert.equal(url.includes('passwd'), false);
    assert.equal(url.includes('..'), false);
    assert.equal(path.dirname(fileOnDisk(url)), path.join(STORAGE_ROOT, pidA()));
  });

  test('19: EXIF / GPS metadata is stripped from the stored file', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const id = await freshProduct();
    const withExif = await sharp({ create: { width: 400, height: 400, channels: 3, background: '#aa3300' } })
      .jpeg().withExif({ IFD0: { Copyright: 'SECRET-OWNER', ImageDescription: 'GPS-HOME' } }).toBuffer();
    assert.equal((await sharp(withExif).metadata()).exif !== undefined, true, 'fixture really has EXIF');
    const res = await upload(id, withExif, { filename: 'p.jpg', type: 'image/jpeg' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const stored = await fs.readFile(fileOnDisk(res.body.data.product.images[0].url));
    assert.equal(stored.includes(Buffer.from('SECRET-OWNER')), false);
    assert.equal(stored.includes(Buffer.from('GPS-HOME')), false);
    assert.equal((await sharp(stored).metadata()).exif, undefined);
  });

  test('20: unsupported or disguised files are refused and nothing is stored', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const id = await freshProduct();
    const dir = path.join(STORAGE_ROOT, pidA());
    const before = await fs.readdir(dir).catch(() => []);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><script>alert(1)</script><rect width="400" height="400"/></svg>');
    const html = Buffer.from('<html><script>alert(document.cookie)</script></html>');
    const gif = await sharp({ create: { width: 400, height: 400, channels: 3, background: '#000' } }).gif().toBuffer();
    const tiff = await sharp({ create: { width: 400, height: 400, channels: 3, background: '#000' } }).tiff().toBuffer();
    const polyglot = Buffer.concat([await pngBuffer(), Buffer.from('<script>alert(1)</script>')]);

    const cases = [
      ['svg as image/svg+xml', svg, { filename: 'a.svg', type: 'image/svg+xml' }, 'INVALID_MEDIA_TYPE'],
      ['svg disguised as png', svg, { filename: 'a.png', type: 'image/png' }, 'INVALID_MEDIA_TYPE'],
      ['html disguised as png', html, { filename: 'a.png', type: 'image/png' }, 'INVALID_MEDIA_TYPE'],
      ['gif disguised as png', gif, { filename: 'a.png', type: 'image/png' }, 'INVALID_MEDIA_TYPE'],
      ['tiff disguised as jpg', tiff, { filename: 'a.jpg', type: 'image/jpeg' }, 'INVALID_MEDIA_TYPE'],
      ['pdf', Buffer.from('%PDF-1.4 test'), { filename: 'a.pdf', type: 'application/pdf' }, 'INVALID_MEDIA_TYPE'],
      ['executable', Buffer.from('MZ\x90\x00'), { filename: 'a.exe', type: 'application/octet-stream' }, 'INVALID_MEDIA_TYPE'],
      ['double extension', svg, { filename: 'a.png.svg', type: 'image/png' }, 'INVALID_MEDIA_TYPE'],
      ['video', Buffer.from('....ftypmp42....'), { filename: 'a.mp4', type: 'video/mp4' }, 'INVALID_MEDIA_TYPE'],
      ['empty file', Buffer.alloc(0), { filename: 'a.png', type: 'image/png' }, null],
      ['truncated png', (await pngBuffer()).subarray(0, 30), { filename: 'a.png', type: 'image/png' }, 'INVALID_MEDIA_TYPE'],
    ];
    for (const [label, buffer, opts, code] of cases) {
      const res = await upload(id, buffer, opts);
      assert.equal(res.status, 400, `${label}: ${res.status} ${JSON.stringify(res.body)}`);
      if (code) assert.equal(res.body.details.code, code, label);
    }
    // a real PNG with trailing script bytes is accepted but RE-ENCODED, so the trailing bytes are gone
    const ok = await upload(id, polyglot);
    assert.equal(ok.status, 201);
    const stored = await fs.readFile(fileOnDisk(ok.body.data.product.images[0].url));
    assert.equal(stored.includes(Buffer.from('<script>')), false, 'anything appended to the file is dropped');

    const after = await fs.readdir(dir);
    assert.equal(after.length - before.length, 1, 'only the one valid image was written');
  });

  test('21: a missing file, a missing field and a too-small image are refused', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const id = await freshProduct();
    const noFile = new FormData();
    noFile.append('projectId', pidA());
    const res = await call('POST', `/api/social/products/${id}/images`, { form: noFile });
    assert.equal(res.status, 400);
    assert.equal(res.body.details.code, 'MEDIA_REQUIRED');
    const tiny = await upload(id, await pngBuffer({ width: 20, height: 20 }));
    assert.equal(tiny.status, 400);
    assert.equal(tiny.body.details.code, 'MEDIA_TOO_SMALL');
  });

  test('22: an oversized upload is a 413 and is not stored', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const id = await freshProduct();
    const big = Buffer.alloc(9 * 1024 * 1024, 7);
    const res = await upload(id, big);
    assert.equal(res.status, 413);
    assert.equal(res.body.details.code, 'MEDIA_TOO_LARGE');
    assert.equal((await SocialProduct.findById(id).lean()).images.length, 0);
  });

  test('23: at most 8 images per product; the 9th is a 409 and its file is not left behind', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const id = await freshProduct('Eight Images');
    let last;
    for (let i = 0; i < 8; i += 1) {
      last = await upload(id, await pngBuffer({ color: `#${(i * 30 + 40).toString(16).padStart(2, '0')}5599` }));
      assert.equal(last.status, 201, `image ${i + 1}`);
    }
    const dir = path.join(STORAGE_ROOT, pidA());
    const filesBefore = (await fs.readdir(dir)).length;
    const ninth = await upload(id, await pngBuffer());
    assert.equal(ninth.status, 409);
    assert.equal(ninth.body.details.code, 'IMAGE_LIMIT_REACHED');
    assert.equal((await fs.readdir(dir)).length, filesBefore, 'rejected before anything was written');
    assert.equal(last.body.data.product.images.length, 8);
    assert.deepEqual(last.body.data.product.images.map((i) => i.sortOrder), [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.equal(last.body.data.product.images.filter((i) => i.isPrimary).length, 1);
  });

  test('24: reorder, choose primary, alt text — and the rules (exact set, no foreign ids)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const id = await freshProduct('Reorder Me');
    const ids = [];
    for (let i = 0; i < 3; i += 1) ids.push((await upload(id, await pngBuffer({ color: `#0${i}0${i}ff` }))).body.data.mediaId);

    const reorder = (body, token = tokenA, pid = pidA()) => call('PATCH', `/api/social/products/${id}/images/reorder`, { token, body: { projectId: pid, ...body } });
    let res = await reorder({ mediaIds: [ids[2], ids[0], ids[1]] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.data.product.images.map((i) => i.mediaId), [ids[2], ids[0], ids[1]]);
    assert.deepEqual(res.body.data.product.images.map((i) => i.sortOrder), [0, 1, 2]);
    assert.equal(res.body.data.product.images.find((i) => i.isPrimary).mediaId, ids[0], 'reordering keeps the primary');

    res = await reorder({ mediaIds: [ids[1], ids[2], ids[0]], primaryMediaId: ids[2] });
    assert.equal(res.body.data.product.images.find((i) => i.isPrimary).mediaId, ids[2]);

    for (const bad of [
      { mediaIds: [ids[0], ids[1]] }, // missing one
      { mediaIds: [ids[0], ids[1], ids[1]] }, // duplicate
      { mediaIds: [ids[0], ids[1], ids[2], '507f1f77bcf86cd799439011'] }, // foreign id
      { mediaIds: [ids[0], ids[1], '507f1f77bcf86cd799439011'] }, // swapped for a foreign id
      { mediaIds: 'nope' }, { mediaIds: [{ $ne: 1 }, ids[1], ids[2]] }, { mediaIds: ['../../x', ids[1], ids[2]] },
      { mediaIds: ids, primaryMediaId: '507f1f77bcf86cd799439011' }, { mediaIds: ids, extra: 1 },
    ]) {
      const r = await reorder(bad);
      assert.equal(r.status, 400, JSON.stringify(bad));
    }

    const alt = await call('PATCH', `/api/social/products/${id}/images/${ids[0]}`, { body: { projectId: pidA(), altText: 'Front of the bottle', isPrimary: true } });
    assert.equal(alt.status, 200, JSON.stringify(alt.body));
    const first = alt.body.data.product.images.find((i) => i.mediaId === ids[0]);
    assert.equal(first.altText, 'Front of the bottle');
    assert.equal(first.isPrimary, true);
    assert.equal(alt.body.data.product.images.filter((i) => i.isPrimary).length, 1);
    assert.equal(alt.body.data.product.primaryImageUrl, first.url);

    for (const bad of [{ isPrimary: false }, { altText: 'x'.repeat(201) }, {}, { url: 'https://evil.example/x.png' }, { altText: { $gt: '' } }]) {
      assert.equal((await call('PATCH', `/api/social/products/${id}/images/${ids[0]}`, { body: { projectId: pidA(), ...bad } })).status, 400, JSON.stringify(bad));
    }
    assert.equal((await call('PATCH', `/api/social/products/${id}/images/507f1f77bcf86cd799439011`, { body: { projectId: pidA(), altText: 'x' } })).status, 404);
  });

  test('25: deleting an image removes its file; deleting the primary promotes the next one; foreign / malformed ids are 404', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const id = await freshProduct('Delete Images');
    const a = await upload(id, await pngBuffer({ color: '#112233' }));
    const b = await upload(id, await pngBuffer({ color: '#445566' }));
    const aId = a.body.data.mediaId;
    const bId = b.body.data.mediaId;
    const aFile = fileOnDisk(a.body.data.product.images[0].url);
    assert.equal(a.body.data.product.images[0].isPrimary, true);

    const del = await call('DELETE', `/api/social/products/${id}/images/${aId}?${q(pidA())}`);
    assert.equal(del.status, 200);
    assert.equal(await exists(aFile), false);
    assert.deepEqual(del.body.data.product.images.map((i) => [i.mediaId, i.isPrimary, i.sortOrder]), [[bId, true, 0]]);

    // (a bare ".." segment is collapsed by the client's URL parser before it is sent, so traversal is tried with encoded slashes)
    for (const badId of ['507f1f77bcf86cd799439011', '..%2F..%2Fetc%2Fpasswd', '%2e%2e%2f%2e%2e%2fetc', '..%5C..%5Cwindows', 'not-an-id', encodeURIComponent('{"$ne":1}')]) {
      const res = await call('DELETE', `/api/social/products/${id}/images/${badId}?${q(pidA())}`);
      assert.ok([404, 400].includes(res.status), `${badId} -> ${res.status}`);
    }
    assert.equal((await SocialProduct.findById(id).lean()).images.length, 1);
  });

  test('26: replacing an image keeps its slot, alt text and id, stores a new file and deletes the old one', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const id = await freshProduct('Replace Image');
    const first = await upload(id, await pngBuffer({ color: '#aa0000' }));
    const mediaId = first.body.data.mediaId;
    await call('PATCH', `/api/social/products/${id}/images/${mediaId}`, { body: { projectId: pidA(), altText: 'Keep me' } });
    const oldFile = fileOnDisk(first.body.data.product.images[0].url);

    const res = await call('PUT', `/api/social/products/${id}/images/${mediaId}`, { form: imageForm(pidA(), await pngBuffer({ width: 500, height: 500, color: '#00aa00' })) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const img = res.body.data.product.images[0];
    assert.equal(img.mediaId, mediaId);
    assert.equal(img.altText, 'Keep me');
    assert.equal(img.isPrimary, true);
    assert.deepEqual([img.width, img.height], [500, 500]);
    assert.notEqual(img.url, first.body.data.product.images[0].url);
    assert.equal(await exists(oldFile), false, 'the replaced file is deleted');
    assert.equal(await exists(fileOnDisk(img.url)), true);

    const bad = await call('PUT', `/api/social/products/${id}/images/${mediaId}`, { form: imageForm(pidA(), Buffer.from('<svg/>'), { filename: 'x.png' }) });
    assert.equal(bad.status, 400);
    assert.equal((await SocialProduct.findById(id).lean()).images[0].url, img.url, 'a failed replace changes nothing');
    const ghost = await call('PUT', `/api/social/products/${id}/images/507f1f77bcf86cd799439011`, { form: imageForm(pidA(), await pngBuffer()) });
    assert.equal(ghost.status, 404);
  });

  test('27: concurrent uploads to one product all land (no lost update) and leave exactly one primary', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const id = await freshProduct('Concurrent');
    const buffers = await Promise.all([0, 1, 2, 3].map((i) => pngBuffer({ color: `#${i}${i}${i}${i}ff` })));
    const results = await Promise.all(buffers.map((b) => upload(id, b)));
    const ok = results.filter((r) => r.status === 201);
    const conflicts = results.filter((r) => r.status === 409);
    assert.equal(ok.length + conflicts.length, 4, JSON.stringify(results.map((r) => r.status)));
    assert.ok(ok.length >= 1);
    const doc = await SocialProduct.findById(id).lean();
    assert.equal(doc.images.length, ok.length, 'every accepted upload is recorded');
    assert.equal(doc.images.filter((i) => i.isPrimary).length, 1);
    const files = await fs.readdir(path.join(STORAGE_ROOT, pidA()));
    for (const img of doc.images) assert.ok(files.includes(img.storageKey.split('/')[1]), 'its file exists');
  });
});

// ── business profile: model, services, brand kit, logo, resolved profile ────

describe('Business profile API — business model, services, brand kit, logo and the resolved profile', () => {
  const put = (body, token = tokenA, pid = pidA()) => call('PUT', '/api/social/business-profile', { token, body: { projectId: pid, ...body } });
  const getProfile = (token = tokenA, pid = pidA()) => call('GET', `/api/social/business-profile?${q(pid)}`, { token });

  test('28: the business model is validated, optional and never guessed', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const fresh = await getProfile(tokenB, pidB());
    assert.equal(fresh.body.data.editableProfile.businessModel, null);
    assert.equal(fresh.body.data.resolvedProfile.business.businessModel.source, 'unavailable');

    assert.equal((await put({ businessModel: 'subscription' })).status, 400);
    assert.equal((await put({ businessModel: { $ne: null } })).status, 400);
    const ok = await put({ businessModel: 'product' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual([ok.body.data.resolvedProfile.business.businessModel.value, ok.body.data.resolvedProfile.business.businessModel.source], ['product', 'social_override']);
    const cleared = await put({ businessModel: null });
    assert.equal(cleared.body.data.resolvedProfile.business.businessModel.source, 'unavailable');
  });

  test('29: services: add, edit (ids are stable), remove; bounded; only active ones reach the resolved profile', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const added = await put({ businessModel: 'service', services: [
      { name: 'Teeth Whitening', description: 'Professional whitening.', category: 'Cosmetic', features: ['Laser'], benefits: ['Brighter smile'], serviceUrl: 'clinic.example.com/whitening', tags: ['cosmetic'] },
      { name: 'Hidden Draft', status: 'draft' },
    ] });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    const svcs = added.body.data.editableProfile.services;
    assert.equal(svcs.length, 2);
    assert.match(svcs[0].id, /^[a-f0-9]{24}$/);
    assert.equal(svcs[0].serviceUrl, 'https://clinic.example.com/whitening');
    assert.deepEqual(added.body.data.resolvedProfile.services.map((s) => s.name), ['Teeth Whitening'], 'a draft service is not part of the profile the AI sees');
    assert.equal(added.body.data.resolvedProfile.meta.catalog.serviceCount, 1);

    const edited = await put({ services: [{ id: svcs[0].id, name: 'Teeth Whitening Plus' }] });
    const after = edited.body.data.editableProfile.services;
    assert.equal(after.length, 1);
    assert.equal(after[0].id, svcs[0].id, 'an edited service keeps its id (a future calendar item can reference it)');
    assert.equal(after[0].name, 'Teeth Whitening Plus');

    const foreignId = '507f1f77bcf86cd799439011';
    const claimed = await put({ services: [{ id: foreignId, name: 'Claims a foreign id' }] });
    assert.notEqual(claimed.body.data.editableProfile.services[0].id, foreignId, 'an unknown id is never adopted');

    for (const bad of [
      [{ name: '' }], [{ name: 'x', serviceUrl: 'javascript:alert(1)' }], [{ name: 'x', serviceUrl: 'http://127.0.0.1/' }], [{ name: 'x', $set: 1 }], [{ name: 'x', status: 'gone' }],
      [{ name: 'x', features: Array.from({ length: 11 }, (_, i) => `f${i}`) }], [{ name: 'x', id: '../../x' }], [{ name: 'x', id: foreignId }, { name: 'y', id: foreignId }],
      Array.from({ length: 31 }, (_, i) => ({ name: `S${i}` })), 'not-a-list',
    ]) {
      assert.equal((await put({ services: bad })).status, 400, JSON.stringify(bad).slice(0, 80));
    }
    assert.equal((await put({ services: [] })).body.data.editableProfile.services.length, 0, 'an empty list removes them all');
  });

  test('30: the Brand Kit identity and messaging save and validate; overrides cover city, region, country, postal code and categories', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const res = await put({
      brand: {
        name: 'Acme Brand', description: 'Smiles, made simple.', voice: 'Friendly, plain-spoken', personality: ['warm', 'Warm', 'trustworthy'], tagline: 'Smile more',
        keyMessages: ['Gentle care'], preferredWords: ['smile'], additionalInstructions: 'Never use emojis.', primaryColor: '#abc',
      },
      overrides: { city: 'Leeds', region: 'West Yorkshire', country: 'United Kingdom', postalCode: 'LS1 4AB', secondaryCategories: ['Orthodontist', 'orthodontist', 'Implants'] },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const { editableProfile: e, resolvedProfile: r } = res.body.data;
    assert.deepEqual(e.brand.personality, ['warm', 'trustworthy']);
    assert.equal(e.brand.tagline, 'Smile more');
    assert.equal(r.brand.voice, 'Friendly, plain-spoken');
    assert.equal('logo' in r.brand, false, 'the logo has one resolved home: media.logo');
    for (const [fact, value] of [[r.business.location.city, 'Leeds'], [r.business.location.region, 'West Yorkshire'], [r.business.location.country, 'United Kingdom'], [r.business.location.postalCode, 'LS1 4AB']]) {
      assert.deepEqual([fact.value, fact.source], [value, 'social_override']);
    }
    assert.deepEqual(r.business.secondaryCategories.value, ['Orthodontist', 'Implants']);

    for (const bad of [
      { brand: { logo: { url: 'https://evil.example/x.png' } } }, { brand: { name: 'x'.repeat(101) } }, { brand: { tagline: 'x'.repeat(151) } },
      { brand: { personality: Array.from({ length: 9 }, (_, i) => `p${i}`) } }, { brand: { keyMessages: Array.from({ length: 11 }, (_, i) => `k${i}`) } },
      { brand: { preferredWords: [{ $ne: 1 }] } }, { brand: { primaryColor: 'red' } }, { overrides: { postalCode: '<script>' } }, { overrides: { city: 'x'.repeat(101) } },
    ]) {
      assert.equal((await put(bad)).status, 400, JSON.stringify(bad));
    }
  });

  test('31: an override wins, the underlying value stays visible, and clearing the override restores it', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SeoProject.updateOne({ _id: projectA._id }, { $set: { project_name: `Catalog Underlying ${projectA._id}` } });
    const before = await getProfile();
    const baseName = before.body.data.resolvedProfile.business.name;
    const res = await put({ overrides: { businessName: 'Acme Dental' } });
    const name = res.body.data.resolvedProfile.business.name;
    assert.deepEqual([name.value, name.source], ['Acme Dental', 'social_override']);
    assert.deepEqual(name.underlying, { value: baseName.value, source: baseName.source }, 'what would be used without the override');
    const cleared = await put({ overrides: { businessName: null } });
    const back = cleared.body.data.resolvedProfile.business.name;
    assert.deepEqual([back.value, back.source], [baseName.value, baseName.source]);
    assert.equal('underlying' in back, false);
  });

  test('32: the resolved profile contains the ACTIVE catalog products only, as safe public products', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await put({ businessModel: 'product' });
    const active = await createProduct({ name: 'Resolved Active', price: 20, currency: 'GBP' });
    await createProduct({ name: 'Resolved Draft', status: 'draft' });
    await createProduct({ name: 'Resolved Archived', status: 'archived' });
    const res = await getProfile();
    const names = res.body.data.resolvedProfile.products.map((p) => p.name);
    assert.ok(names.includes('Resolved Active'));
    assert.equal(names.includes('Resolved Draft'), false);
    assert.equal(names.includes('Resolved Archived'), false);
    const p = res.body.data.resolvedProfile.products.find((x) => x.id === active.body.data.product.id);
    assert.equal(p.priceDisplay, '£20');
    assert.equal(JSON.stringify(res.body).includes('storageKey'), false);
    assert.equal(res.body.data.resolvedProfile.meta.catalog.productCount, names.length);
    assert.equal((await getProfile(tokenB, pidB())).body.data.resolvedProfile.products.some((x) => x.name === 'Resolved Active'), false, 'another project never sees them');
  });

  test('33: the brand logo: upload, resolved as the user\'s own logo, replace deletes the old file, delete falls back', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const logoForm = (buf, opts) => imageForm(pidA(), buf, opts);
    const up = await call('POST', '/api/social/business-profile/logo', { form: logoForm(await pngBuffer({ width: 300, height: 300, color: '#ff0066' })) });
    assert.equal(up.status, 201, JSON.stringify(up.body));
    const logo = up.body.data.resolvedProfile.media.logo;
    assert.deepEqual([logo.source, logo.detail], ['social_override', 'user_upload']);
    assert.ok(logo.value.includes(`/storage/social_media/${pidA()}/`));
    assert.equal(up.body.data.editableProfile.brand.logo.url, logo.value);
    assert.equal(JSON.stringify(up.body).includes('storageKey'), false);
    const firstFile = fileOnDisk(logo.value);
    assert.equal(await exists(firstFile), true);

    const second = await call('POST', '/api/social/business-profile/logo', { form: logoForm(await pngBuffer({ width: 320, height: 320, color: '#0066ff' })) });
    assert.equal(second.status, 201);
    assert.equal(await exists(firstFile), false, 'the replaced logo file is deleted');
    const secondFile = fileOnDisk(second.body.data.resolvedProfile.media.logo.value);
    assert.equal(await exists(secondFile), true);

    const bad = await call('POST', '/api/social/business-profile/logo', { form: logoForm(Buffer.from('<svg onload="alert(1)"/>'), { filename: 'logo.svg', type: 'image/svg+xml' }) });
    assert.equal(bad.status, 400);
    assert.equal((await getProfile()).body.data.resolvedProfile.media.logo.value, second.body.data.resolvedProfile.media.logo.value, 'a refused upload changes nothing');

    const removed = await call('DELETE', `/api/social/business-profile/logo?${q(pidA())}`);
    assert.equal(removed.status, 200);
    assert.equal(await exists(secondFile), false);
    assert.notEqual(removed.body.data.resolvedProfile.media.logo.source, 'social_override', 'falls back to the Google / website logo (or none)');
    assert.equal(removed.body.data.editableProfile.brand.logo, null);
    assert.equal((await call('DELETE', `/api/social/business-profile/logo?${q(pidA())}`)).status, 200, 'removing nothing is not an error');

    const cross = await call('DELETE', `/api/social/business-profile/logo?${q(pidA())}`, { token: tokenB });
    assert.ok([403, 404].includes(cross.status));
  });

  test('34: the user\'s logo is not reachable or changeable from another project', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const up = await call('POST', '/api/social/business-profile/logo', { form: imageForm(pidA(), await pngBuffer()) });
    const logoUrl = up.body.data.resolvedProfile.media.logo.value;
    const attempt = await call('POST', '/api/social/business-profile/logo', { token: tokenB, form: imageForm(pidA(), await pngBuffer()) });
    assert.ok([403, 404].includes(attempt.status));
    const resB = await getProfile(tokenB, pidB());
    assert.equal(JSON.stringify(resB.body).includes(logoUrl), false);
    assert.equal(await exists(fileOnDisk(logoUrl)), true);
  });
});
