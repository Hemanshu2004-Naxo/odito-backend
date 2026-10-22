import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { promises as fs } from 'fs';
import path from 'path';
import sharp from 'sharp';

dotenv.config();

import SeoProject from '../../app_user/model/SeoProject.js';
import GoogleConnection from '../../app_user/model/GoogleConnection.js';
import BusinessProfileMetadata from '../../app_user/model/BusinessProfileMetadata.js';
import SocialBusinessProfile from '../model/SocialBusinessProfile.js';
import SocialProduct from '../model/SocialProduct.js';
import SocialAIStrategy from '../model/SocialAIStrategy.js';
import { resolveSocialBusinessProfile } from './socialBusinessProfileResolver.js';
import { updateProfile } from './socialBusinessProfileService.js';
import productService from './socialProductService.js';
import { buildProfileData, hashProfileData } from './aiStrategy/profileSnapshot.js';
import { startGeneration, getStrategyState, setProviderOverride, resetProviderOverride } from './aiStrategy/socialAIStrategyService.js';
import { mockProvider } from '../testSupport/aiStrategyFixtures.js';

/**
 * Real MongoDB. The Product Catalog / services / Brand Kit as the RESOLVER and the AI STRATEGY see them:
 * precedence, source labels, GBP freshness, backward compatibility with profiles saved before these fields
 * existed, the strategy's change detection, and that the strategy prompt really carries the catalog.
 */

let mongoAvailable = false;
before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
    await SocialProduct.init();
    await SocialAIStrategy.init();
  } catch {
    mongoAvailable = false;
  }
});
after(async () => {
  resetProviderOverride();
  if (mongoAvailable) await mongoose.connection.close();
});

const NOW = new Date('2026-10-10T12:00:00.000Z');
const noLogo = async () => ({ brandLogo: null, favicon: null, source: 'initials', resolution: null, fallbackType: 'generated_initials' });
const STORAGE_ROOT = path.resolve(process.cwd(), 'storage', 'social_media');
const png = (width = 400, height = 400, color = '#336699') => sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();

describe('Catalog + Brand Kit in the resolved profile and the AI strategy (real MongoDB)', () => {
  let userId; let project; let pid; let created;
  const track = (d) => { created.push(d); return d; };

  const resolve = (id = pid, opts = {}) => resolveSocialBusinessProfile(id, { now: NOW, brandResolver: noLogo, ...opts });
  const addProduct = async (body = {}) => {
    const r = await productService.createProduct(pid, userId, { name: `Product ${Math.random().toString(36).slice(2, 7)}`, ...body });
    assert.equal(r.success, true, JSON.stringify(r));
    return r.product;
  };

  beforeEach(async () => {
    if (!mongoAvailable) return;
    created = [];
    userId = new mongoose.Types.ObjectId();
    project = track(await SeoProject.create({
      user_id: userId, project_name: `Catalog Live ${Date.now()} ${Math.random().toString(36).slice(2, 8)}`, main_url: 'https://example.com', seo_scope: 'local', keywords: ['k'],
      description: 'Family skincare brand', industry: 'Skincare', country: 'in',
      verified_business: { name: 'Verified Name', city: 'Pune', state: 'Maharashtra', country: 'India', verifiedAt: NOW },
    }));
    pid = project._id.toString();
  });

  afterEach(async () => {
    resetProviderOverride();
    if (!mongoAvailable) return;
    const ids = created.map((d) => d._id);
    await Promise.all([
      SocialProduct.deleteMany({ project_id: { $in: ids } }),
      SocialAIStrategy.deleteMany({ project_id: { $in: ids } }),
      SocialBusinessProfile.deleteMany({ project_id: { $in: ids } }),
      GoogleConnection.deleteMany({ project_id: { $in: ids } }),
      BusinessProfileMetadata.deleteMany({ project_id: { $in: ids } }),
    ]);
    await SeoProject.deleteMany({ _id: { $in: ids } });
    for (const id of ids) await fs.rm(path.join(STORAGE_ROOT, String(id)), { recursive: true, force: true });
  });

  // ── model ────────────────────────────────────────────────────────────────
  test('1: the product collection has the project-scoped indexes (status lookup, unique slug, partial-unique SKU)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const indexes = await SocialProduct.collection.indexes();
    const byName = Object.fromEntries(indexes.map((i) => [i.name, i]));
    assert.deepEqual(byName.product_project_status.key, { project_id: 1, status: 1 });
    assert.deepEqual([byName.unique_product_slug.key, byName.unique_product_slug.unique], [{ project_id: 1, slug: 1 }, true]);
    assert.deepEqual([byName.unique_product_sku.key, byName.unique_product_sku.unique], [{ project_id: 1, sku: 1 }, true]);
    assert.deepEqual(byName.unique_product_sku.partialFilterExpression, { sku: { $type: 'string' } }, 'products without a SKU do not collide');
    assert.equal(SocialProduct.collection.collectionName, 'social_products');
  });

  test('2: the product schema is strict (an unknown key is never persisted) and a stored product holds only references', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const viaModel = await SocialProduct.create({ project_id: project._id, name: 'Via model', slug: 'via-model', rogue: 'x', injected: { $set: 1 } });
    const raw = await SocialProduct.collection.findOne({ _id: viaModel._id });
    assert.equal('rogue' in raw, false);
    assert.equal('injected' in raw, false);

    const p = await addProduct({ name: 'Stored Product' });
    await productService.addProductImage(pid, p.id, userId, await png());
    const stored = await SocialProduct.collection.findOne({ _id: new mongoose.Types.ObjectId(p.id) });
    assert.deepEqual(Object.keys(stored.images[0]).sort(), ['altText', 'height', 'isPrimary', 'mediaId', 'mimeType', 'size', 'sortOrder', 'storageKey', 'url', 'width']);
    assert.ok(JSON.stringify(stored).length < 2000, 'a reference, not the image');
  });

  // ── services / business model / resolved profile ─────────────────────────
  test('3: SERVICE business — model, services and Brand Kit resolve together; the AI-facing profile has services and no products', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const saved = await updateProfile(pid, userId, {
      businessModel: 'service',
      overrides: { description: 'We make smiles brighter.' },
      services: [{ name: 'Whitening', benefits: ['Brighter'] }, { name: 'Old Service', status: 'archived' }],
      audience: { primary: 'Young families' },
      toneOfVoice: { primary: 'Warm' },
      brand: { voice: 'Friendly', tagline: 'Smile more' },
    });
    assert.equal(saved.success, true, JSON.stringify(saved));
    const { resolvedProfile: r } = await resolve();
    assert.deepEqual([r.business.businessModel.value, r.business.businessModel.source], ['service', 'social_override']);
    assert.deepEqual([r.business.description.value, r.business.description.source], ['We make smiles brighter.', 'social_override']);
    assert.deepEqual(r.services.map((s) => s.name), ['Whitening']);
    assert.deepEqual(r.products, []);
    assert.equal(r.brand.voice, 'Friendly');
    assert.equal(r.strategy.audience.primary, 'Young families');
    const data = buildProfileData(r, { seoScope: 'local' });
    assert.equal(data.businessModel, 'service');
    assert.deepEqual(data.services.map((s) => s.name), ['Whitening']);
    assert.equal('products' in data, false);
  });

  test('4: PRODUCT business — an empty catalog is a real empty list; two products resolve in a stable order with display prices', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await updateProfile(pid, userId, { businessModel: 'product' });
    assert.deepEqual((await resolve()).resolvedProfile.products, []);

    const a = await addProduct({ name: 'Product A', price: 999, currency: 'INR', features: ['Vitamin C'] });
    const b = await addProduct({ name: 'Product B', price: 1299, salePrice: 999, currency: 'INR' });
    const first = (await resolve()).resolvedProfile;
    const second = (await resolve()).resolvedProfile;
    assert.deepEqual(first.products.map((p) => p.id), [a.id, b.id]);
    assert.equal(JSON.stringify(first.products), JSON.stringify(second.products), 'deterministic');
    assert.deepEqual(first.products.map((p) => p.priceDisplay), ['₹999', '₹1,299']);
    assert.equal(first.meta.catalog.productCount, 2);

    const data = buildProfileData(first, { seoScope: 'local' });
    assert.deepEqual(data.products.map((p) => p.name), ['Product A', 'Product B']);
    assert.equal(hashProfileData(data), hashProfileData(buildProfileData((await resolve()).resolvedProfile, { seoScope: 'local' })));
  });

  test('5: products are never invented — a profile with Google data and a description but no catalog has no products', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    track(await GoogleConnection.create({ user_id: userId, project_id: project._id, purpose: 'business_profile', service_type: ['business_profile'], business_account_id: 'a1', business_location_id: 'l1', refresh_token: 'SECRET-REFRESH', access_token: 'SECRET-ACCESS', google_email: 'o@example.com', google_name: 'O', status: 'active' }));
    track(await BusinessProfileMetadata.create({ user_id: userId, project_id: project._id, business_account_id: 'a1', business_location_id: 'l1', business_name: 'Google Name', category: 'Skincare store', description: 'We sell serums, creams and cleansers for every skin type.', metadata_last_synced_at: new Date(), details_last_synced_at: new Date() }));
    await updateProfile(pid, userId, { businessModel: 'product' });
    const { resolvedProfile: r } = await resolve();
    assert.deepEqual(r.products, [], 'serums / creams / cleansers in a description are NOT turned into products');
    assert.equal('products' in buildProfileData(r), false);
  });

  test('6: a draft or archived product, or one from another project, is not part of the resolved profile', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const other = track(await SeoProject.create({ user_id: userId, project_name: `Catalog Other ${Date.now()}`, main_url: 'https://other.example', seo_scope: 'local', keywords: ['k'] }));
    await productService.createProduct(String(other._id), userId, { name: 'Other Project Product' });
    await addProduct({ name: 'Live One' });
    await addProduct({ name: 'Draft One', status: 'draft' });
    await addProduct({ name: 'Archived One', status: 'archived' });
    const names = (await resolve()).resolvedProfile.products.map((p) => p.name);
    assert.deepEqual(names, ['Live One']);
  });

  // ── precedence / freshness ───────────────────────────────────────────────
  test('7: override > GBP > verified business > project, with the replaced value kept as `underlying`; the GBP data itself is untouched', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    track(await GoogleConnection.create({ user_id: userId, project_id: project._id, purpose: 'business_profile', service_type: ['business_profile'], business_account_id: 'a1', business_location_id: 'l1', refresh_token: 'SECRET-REFRESH', access_token: 'SECRET-ACCESS', google_email: 'o@example.com', google_name: 'O', status: 'active' }));
    const meta = track(await BusinessProfileMetadata.create({ user_id: userId, project_id: project._id, business_account_id: 'a1', business_location_id: 'l1', business_name: 'Acme Dental Clinic', category: 'Dentist', secondary_categories: ['Cosmetic dentist'], metadata_last_synced_at: new Date(), details_last_synced_at: new Date() }));
    const gbpBefore = JSON.stringify(await BusinessProfileMetadata.findById(meta._id).lean());

    let r = (await resolve()).resolvedProfile.business;
    assert.deepEqual([r.name.value, r.name.source], ['Acme Dental Clinic', 'google_business_profile']);
    assert.equal('underlying' in r.name, false, 'no override, nothing underlying');

    await updateProfile(pid, userId, { overrides: { businessName: 'Acme Dental', city: 'Mumbai', secondaryCategories: ['Implants'] } });
    r = (await resolve()).resolvedProfile.business;
    assert.deepEqual([r.name.value, r.name.source], ['Acme Dental', 'social_override']);
    assert.deepEqual(r.name.underlying, { value: 'Acme Dental Clinic', source: 'google_business_profile' });
    assert.deepEqual([r.location.city.value, r.location.city.source], ['Mumbai', 'social_override']);
    assert.deepEqual(r.location.city.underlying, { value: 'Pune', source: 'verified_business' });
    assert.deepEqual(r.secondaryCategories.value, ['Implants']);
    assert.deepEqual(r.secondaryCategories.underlying, { value: ['Cosmetic dentist'], source: 'google_business_profile' });
    assert.equal(JSON.stringify(await BusinessProfileMetadata.findById(meta._id).lean()), gbpBefore, 'GBP data untouched by the override');

    // GBP changes -> the resolver sees the new value; the override and the user-owned data stay intact
    await updateProfile(pid, userId, { services: [{ name: 'Kept Service' }], brand: { tagline: 'Kept tagline' } });
    await BusinessProfileMetadata.updateOne({ _id: meta._id }, { $set: { business_name: 'Acme Dental Group', category: 'Orthodontist' } });
    r = (await resolve()).resolvedProfile;
    assert.deepEqual([r.business.name.value, r.business.name.source], ['Acme Dental', 'social_override'], 'the override survives a GBP change');
    assert.equal(r.business.name.underlying.value, 'Acme Dental Group', 'and the underlying value is the NEW Google value');
    assert.deepEqual([r.business.category.value, r.business.category.source], ['Orthodontist', 'google_business_profile']);
    assert.deepEqual(r.services.map((s) => s.name), ['Kept Service']);
    assert.equal(r.brand.tagline, 'Kept tagline');

    // clearing the override restores the live Google value (nothing was copied out of Google)
    await updateProfile(pid, userId, { overrides: { businessName: null, city: null, secondaryCategories: null } });
    r = (await resolve()).resolvedProfile.business;
    assert.deepEqual([r.name.value, r.name.source], ['Acme Dental Group', 'google_business_profile']);
    assert.deepEqual([r.location.city.value, r.location.city.source], ['Pune', 'verified_business']);
    assert.deepEqual(r.secondaryCategories.value, ['Cosmetic dentist']);
    const raw = await mongoose.connection.db.collection('socialbusinessprofiles').findOne({ project_id: project._id });
    assert.equal(JSON.stringify(raw).includes('Acme Dental Group'), false, 'Google values are never copied into the user-owned document');
  });

  test('8: the user-uploaded logo is the top logo source (no network); removing it falls back to the shared brand resolver', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { setBrandLogo, clearBrandLogo } = await import('./socialBusinessProfileService.js');
    const websiteLogo = async () => ({ brandLogo: 'https://site.example/logo.png', favicon: null, source: 'website_logo', resolution: null, fallbackType: 'website_logo' });
    let r = (await resolve(pid, { brandResolver: websiteLogo })).resolvedProfile;
    assert.deepEqual([r.media.logo.value, r.media.logo.source], ['https://site.example/logo.png', 'website_extraction']);

    const never = async () => { throw new Error('the brand resolver must not run when the user has a logo'); };
    await setBrandLogo(pid, userId, { url: 'https://media.example/storage/social_media/x/y.png', storageKey: `${pid}/11111111-1111-4111-8111-111111111111.png`, mimeType: 'image/png', width: 300, height: 300, size: 10 });
    r = (await resolve(pid, { brandResolver: never })).resolvedProfile;
    assert.deepEqual([r.media.logo.value, r.media.logo.source, r.media.logo.detail], ['https://media.example/storage/social_media/x/y.png', 'social_override', 'user_upload']);
    // even a caller that skips logo resolution (change detection) gets the stored logo — it costs no network
    r = (await resolve(pid, { includeLogo: false, brandResolver: never })).resolvedProfile;
    assert.equal(r.media.logo.source, 'social_override');
    const data = buildProfileData(r);
    assert.equal(data.brandKit.logoUrl, 'https://media.example/storage/social_media/x/y.png');
    assert.equal(JSON.stringify(data).includes(`${pid}/11111111`), false, 'no storage key in a snapshot');

    const cleared = await clearBrandLogo(pid, userId);
    assert.equal(cleared.previousStorageKey, `${pid}/11111111-1111-4111-8111-111111111111.png`);
    r = (await resolve(pid, { brandResolver: websiteLogo })).resolvedProfile;
    assert.equal(r.media.logo.source, 'website_extraction');
  });

  // ── backward compatibility ───────────────────────────────────────────────
  test('9: a profile document saved BEFORE these fields existed still resolves — nothing guessed, nothing invented', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    // exactly the shape the previous version wrote (no businessModel, services, brand identity, logo, new overrides)
    await mongoose.connection.db.collection('socialbusinessprofiles').insertOne({
      project_id: project._id, audience: { primary: 'Locals', secondary: [] }, toneOfVoice: { primary: 'Warm', secondary: [] }, goals: ['Grow'], uniqueSellingPoints: [], offers: [], competitors: [],
      brand: { primaryColor: '#112233', secondaryColor: null, accentColor: null, fontHeading: null, fontBody: null }, prohibitedPhrases: [], contentPillars: [], additionalInstructions: '',
      overrides: { businessName: 'Legacy Name', description: null, category: null, phone: null, website: null, address: null, serviceArea: null },
      createdAt: new Date(), updatedAt: new Date(), __v: 0,
    });
    const { resolvedProfile: r, editableProfile: e } = await resolve();
    assert.equal(e.exists, true);
    assert.equal(e.businessModel, null);
    assert.deepEqual(e.services, []);
    assert.deepEqual([r.business.name.value, r.business.name.source], ['Legacy Name', 'social_override']);
    assert.equal(r.business.businessModel.source, 'unavailable');
    assert.deepEqual([r.services, r.products], [[], []]);
    assert.equal(r.brand.primaryColor, '#112233');
    assert.equal(r.brand.name, null);
    const data = buildProfileData(r, { seoScope: 'local' });
    for (const k of ['businessModel', 'brandKit', 'services', 'products']) assert.equal(k in data, false, k);
    // and it can be edited like any other
    assert.equal((await updateProfile(pid, userId, { businessModel: 'service' })).success, true);
    assert.equal((await resolve()).editableProfile.goals[0], 'Grow');
  });

  test('10: the business model is never inferred — a product-sounding project stays "not chosen"', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SeoProject.updateOne({ _id: project._id }, { $set: { business_type: 'Online store', industry: 'E-commerce' } });
    const r = (await resolve()).resolvedProfile;
    assert.equal(r.business.businessModel.source, 'unavailable');
    assert.equal(r.meta.catalog.businessModel, null);
  });

  // ── AI strategy ──────────────────────────────────────────────────────────
  test('11: the strategy consumes the catalog: the prompt carries the products, the stored snapshot has them, no secrets, no images', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await updateProfile(pid, userId, { businessModel: 'product', audience: { primary: 'Skincare lovers' }, goals: ['More sales'], brand: { voice: 'Friendly' } });
    const serum = await addProduct({ name: 'Premium Face Serum', description: 'Hydrating vitamin C serum.', price: 999, currency: 'INR', productUrl: 'https://shop.example.com/serum', benefits: ['Brighter skin'] });
    await productService.addProductImage(pid, serum.id, userId, await png());

    const provider = mockProvider();
    setProviderOverride(provider);
    const res = await startGeneration(pid, userId, { background: false });
    assert.equal(res.generation.status, 'ready', JSON.stringify(res));

    const user = provider.calls[0].user;
    for (const needle of ['business_model: product-based', '<products>', 'Premium Face Serum', 'price: ₹999', 'https://shop.example.com/serum', 'brand_voice: Friendly']) assert.ok(user.includes(needle), needle);
    assert.equal(/\bsku\b|storageKey/i.test(user), false);

    const doc = await SocialAIStrategy.findOne({ project_id: project._id }).lean();
    assert.equal(doc.profileSnapshot.data.businessModel, 'product');
    assert.equal(doc.profileSnapshot.data.products[0].name, 'Premium Face Serum');
    assert.equal(doc.profileSnapshot.data.products[0].images.length, 1, 'a media REFERENCE');
    const dump = JSON.stringify(doc);
    for (const secret of ['storageKey', 'refresh_token', 'access_token', 'SECRET', 'enc:v1', 'base64', 'data:image']) assert.equal(dump.includes(secret), false, secret);
    assert.ok(dump.length < 30_000, 'the snapshot stays small');
    assert.equal(doc.profileSnapshot.hash, hashProfileData(doc.profileSnapshot.data));
  });

  test('12: changing the catalog marks the strategy as based on an older profile — it is never regenerated automatically; media changes do not', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await updateProfile(pid, userId, { businessModel: 'product', audience: { primary: 'Skincare lovers' }, goals: ['More sales'] });
    const serum = await addProduct({ name: 'Face Serum', price: 999, currency: 'INR' });
    const provider = mockProvider();
    setProviderOverride(provider);
    await startGeneration(pid, userId, { background: false });
    assert.equal((await getStrategyState(pid)).profile.changed, false);

    // media only: a product photo and a brand logo — not a change the strategy depends on
    await productService.addProductImage(pid, serum.id, userId, await png());
    const { setBrandLogo } = await import('./socialBusinessProfileService.js');
    await setBrandLogo(pid, userId, { url: 'https://media.example/storage/social_media/x/l.png', storageKey: `${pid}/22222222-2222-4222-8222-222222222222.png`, mimeType: 'image/png' });
    let state = await getStrategyState(pid);
    assert.equal(state.profile.changed, false, 'a new product image / logo file does not stale the strategy');

    // a product edit and a new product do
    await productService.updateProduct(pid, serum.id, userId, { name: 'Face Serum Pro', price: 1099 });
    state = await getStrategyState(pid);
    assert.equal(state.profile.changed, true);
    assert.deepEqual(state.profile.changes, ['products']);
    await addProduct({ name: 'Night Cream' });
    await updateProfile(pid, userId, { businessModel: 'service', services: [{ name: 'Consultation' }], brand: { tagline: 'New tagline' } });
    state = await getStrategyState(pid);
    assert.deepEqual(state.profile.changes.sort(), ['brandKit', 'businessModel', 'products', 'services']);
    assert.equal(state.status, 'ready', 'the old strategy stays viewable');
    assert.equal(provider.calls.length, 1, 'nothing was regenerated');
    assert.equal(await SocialAIStrategy.countDocuments({ project_id: project._id }), 1);

    // removing the product that was just added is itself a change again relative to the stored snapshot only if the rest differs:
    // the renamed product still differs, so 'products' stays listed
    const added = (await productService.listProducts(pid)).products.find((p) => p.name === 'Night Cream');
    assert.equal((await productService.deleteProduct(pid, added.id)).success, true);
    state = await getStrategyState(pid);
    assert.equal(state.profile.changes.includes('products'), true, 'the renamed product is still a change');
  });

  test('13: an EXISTING strategy (generated before the catalog existed) stays readable and is not reported as changed', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await updateProfile(pid, userId, { audience: { primary: 'Locals' }, goals: ['Grow'], toneOfVoice: { primary: 'Warm' } });
    // store a strategy whose snapshot has exactly the OLD shape (no new keys) and the hash of that old data
    const live = await resolve(pid, { includeLogo: false });
    const oldData = buildProfileData(live.resolvedProfile, { seoScope: 'local' });
    for (const k of ['businessModel', 'brandKit', 'services', 'products', 'productCount']) assert.equal(k in oldData, false);
    await SocialAIStrategy.create({
      project_id: project._id, version: 1, status: 'ready', strategy: { summary: 'An older strategy' },
      profileSnapshot: { generatedAt: new Date(), hash: hashProfileData(oldData), data: oldData }, generation: { finishedAt: new Date(), promptVersion: 'social-ai-strategy-v1' },
    });
    const state = await getStrategyState(pid);
    assert.equal(state.status, 'ready');
    assert.equal(state.strategy.strategy.summary, 'An older strategy');
    assert.equal(state.profile.changed, false, 'no new field makes an old strategy look stale');
    assert.deepEqual(state.profile.changes, []);
    // the profile gaps for the live profile now also say what to complete next
    assert.ok(state.profile.gaps.some((g) => g.field === 'businessModel'));

    // choosing a model + adding something then flags it, as designed
    await updateProfile(pid, userId, { businessModel: 'service', services: [{ name: 'Consultation' }] });
    assert.deepEqual((await getStrategyState(pid)).profile.changes.sort(), ['businessModel', 'services']);
  });

  test('14: resolveProductAssets — product + image URLs for a future post/design, only within the project, only Odito-owned URLs', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await addProduct({ name: 'Asset Product', productUrl: 'https://shop.example.com/a' });
    const added = await productService.addProductImage(pid, p.id, userId, await png());
    const assets = await productService.resolveProductAssets(pid, p.id);
    assert.equal(assets.success, true);
    assert.equal(assets.images.length, 1);
    assert.equal(assets.primaryImageUrl, added.product.images[0].url);
    assert.equal(assets.productUrl, 'https://shop.example.com/a');
    assert.equal(JSON.stringify(assets).includes('storageKey'), false);

    const stranger = track(await SeoProject.create({ user_id: userId, project_name: `Catalog Stranger ${Date.now()}`, main_url: 'https://s.example', seo_scope: 'local', keywords: ['k'] }));
    assert.equal((await productService.resolveProductAssets(String(stranger._id), p.id)).success, false, 'another project cannot resolve this product\'s assets');
    assert.equal((await productService.resolveProductAssets(pid, '507f1f77bcf86cd799439011')).error.code, 'NOT_FOUND');

    // a URL that Odito's storage did not issue is never handed on
    await SocialProduct.collection.updateOne({ _id: new mongoose.Types.ObjectId(p.id) }, { $set: { 'images.0.url': 'https://evil.example/x.png' } });
    assert.deepEqual((await productService.resolveProductAssets(pid, p.id)).images, []);
  });
});
