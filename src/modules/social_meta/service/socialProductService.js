import mongoose from 'mongoose';
import SocialProduct, { PRODUCT_STATUSES } from '../model/SocialProduct.js';
import SeoProject from '../../app_user/model/SeoProject.js';
import mediaStorageService from './media/mediaStorageService.js';
import { processAndStoreCatalogImage } from './media/catalogMedia.js';
import {
  bad, isPlainObject, assertKnownKeys, text, stringList, url, money, currency, enumValue, objectIdString, formatPrice, ValidationError,
} from './catalogValidation.js';

/**
 * socialProductService — validation + persistence for the project's Product Catalog (model/SocialProduct.js).
 *
 * Contract (same as socialBusinessProfileService):
 *  - Every function takes the projectId that validateProjectAccess() already authorised, and EVERY query filters
 *    on it: a productId or mediaId from another project is simply "not found", never read, never changed.
 *  - Only the fields in PRODUCT_FIELDS can be written. Anything else — an operator ({ $set }), `images`, a
 *    `project_id`, a storage key — is rejected with UNKNOWN_FIELD; it is never silently dropped.
 *  - Every value is validated and COERCED to a plain primitive before it reaches a query.
 *  - Images are never accepted as JSON: they only arrive through addProductImage / replaceProductImage, which run
 *    the bytes through the shared media pipeline (media/catalogMedia.js). The client never supplies a URL, a
 *    storage key or a file name.
 *
 * Returned products are the PUBLIC shape (toPublicProduct): no storage key, no user ids, no Mongo internals.
 */

export const LIMITS = Object.freeze({
  maxProducts: 100,
  maxImages: 8,
  name: 150,
  slug: 120,
  description: 2000,
  shortDescription: 300,
  category: 100,
  subcategory: 100,
  sku: 64,
  altText: 200,
  features: { items: 10, length: 200 },
  benefits: { items: 10, length: 200 },
  tags: { items: 15, length: 40 },
});

export const PRODUCT_FIELDS = Object.freeze([
  'name', 'slug', 'description', 'shortDescription', 'category', 'subcategory', 'features', 'benefits',
  'price', 'salePrice', 'currency', 'productUrl', 'sku', 'status', 'tags',
]);

const fail = (code, message) => ({ success: false, error: { code, message } });
const NOT_FOUND = () => fail('NOT_FOUND', 'Product not found.');
const PROJECT_NOT_FOUND = () => fail('NOT_FOUND', 'Project not found.');

// ── validation ───────────────────────────────────────────────────────────────

export function slugify(name) {
  const slug = String(name || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, LIMITS.slug - 6);
  return slug.replace(/-+$/g, '') || 'product';
}

function slugValue(value) {
  const raw = text(value, 'slug', LIMITS.slug, { required: true });
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw)) bad('slug may only contain lowercase letters, numbers and single hyphens.', 'INVALID_PRODUCT');
  return raw;
}

function skuValue(value) {
  const raw = text(value, 'sku', LIMITS.sku);
  if (raw === null) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._\-/#]*$/.test(raw)) bad('sku contains characters that are not allowed.', 'INVALID_PRODUCT');
  return raw;
}

const asProductError = (fn) => (...args) => {
  try {
    return fn(...args);
  } catch (error) {
    if (error instanceof ValidationError && error.code === 'INVALID_PROFILE') throw new ValidationError('INVALID_PRODUCT', error.message);
    throw error;
  }
};

/**
 * Validates a create / update body. `partial: true` (PATCH) needs at least one field; create needs a name.
 * Returns { set } (plain field -> value) or { error: { code, message } } — never throws for bad input.
 */
export function validateProductInput(body, { partial = false } = {}) {
  try {
    return asProductError(() => {
      if (!isPlainObject(body)) bad('The request body must be an object.', 'INVALID_BODY');
      // projectId is the routing key validateProjectAccess() already used.
      const { projectId: _projectId, ...fields } = body;
      if ('images' in fields) bad('Images cannot be set here. Upload them with the product image endpoints.', 'UNKNOWN_FIELD');
      assertKnownKeys(fields, PRODUCT_FIELDS, '');

      const set = {};
      for (const [key, value] of Object.entries(fields)) {
        switch (key) {
          case 'name': set.name = text(value, 'name', LIMITS.name, { required: true }); break;
          case 'slug': set.slug = slugValue(value); break;
          case 'description': set.description = text(value, 'description', LIMITS.description, { multiline: true }) || ''; break;
          case 'shortDescription': set.shortDescription = text(value, 'shortDescription', LIMITS.shortDescription, { multiline: true }) || ''; break;
          case 'category': set.category = text(value, 'category', LIMITS.category); break;
          case 'subcategory': set.subcategory = text(value, 'subcategory', LIMITS.subcategory); break;
          case 'features': set.features = value === null ? [] : stringList(value, 'features', LIMITS.features); break;
          case 'benefits': set.benefits = value === null ? [] : stringList(value, 'benefits', LIMITS.benefits); break;
          case 'tags': set.tags = value === null ? [] : stringList(value, 'tags', LIMITS.tags); break;
          case 'price': set.price = money(value, 'price'); break;
          case 'salePrice': set.salePrice = money(value, 'salePrice'); break;
          case 'currency': set.currency = currency(value, 'currency'); break;
          case 'productUrl': set.productUrl = url(value, 'productUrl', { publicOnly: true }); break;
          case 'sku': set.sku = skuValue(value); break;
          case 'status': set.status = enumValue(value, 'status', PRODUCT_STATUSES); break;
          default: break;
        }
      }
      if (!partial && !('name' in set)) bad('name is required.');
      if (partial && Object.keys(set).length === 0) bad('Provide at least one field to update.', 'EMPTY_UPDATE');
      return { set };
    })();
  } catch (error) {
    if (error instanceof ValidationError) return { error: { code: error.code, message: error.message } };
    throw error;
  }
}

/** Rules that span fields, checked on the product as it will be AFTER the write (so a partial PATCH is covered too). */
function crossFieldProblem({ price, salePrice, currency: code }) {
  const has = (v) => typeof v === 'number';
  if (has(salePrice) && !has(price)) return 'salePrice needs a regular price.';
  if (has(salePrice) && has(price) && salePrice > price) return 'salePrice must not be higher than price.';
  if ((has(price) || has(salePrice)) && !code) return 'currency is required when a price is set.';
  return null;
}

// ── public shape ─────────────────────────────────────────────────────────────

const byOrder = (a, b) => (a.sortOrder - b.sortOrder);

export function toPublicImage(img) {
  return {
    mediaId: String(img.mediaId),
    url: img.url,
    mimeType: img.mimeType,
    width: img.width ?? null,
    height: img.height ?? null,
    size: img.size ?? null,
    altText: img.altText || '',
    isPrimary: !!img.isPrimary,
    sortOrder: img.sortOrder ?? 0,
  };
}

export function toPublicProduct(doc) {
  const images = [...(doc.images || [])].sort(byOrder).map(toPublicImage);
  const primary = images.find((i) => i.isPrimary) || images[0] || null;
  return {
    id: String(doc._id),
    name: doc.name,
    slug: doc.slug,
    description: doc.description || '',
    shortDescription: doc.shortDescription || '',
    category: doc.category ?? null,
    subcategory: doc.subcategory ?? null,
    features: [...(doc.features || [])],
    benefits: [...(doc.benefits || [])],
    price: doc.price ?? null,
    salePrice: doc.salePrice ?? null,
    currency: doc.currency ?? null,
    priceDisplay: formatPrice(doc.price, doc.currency),
    salePriceDisplay: formatPrice(doc.salePrice, doc.currency),
    productUrl: doc.productUrl ?? null,
    sku: doc.sku ?? null,
    status: doc.status || 'active',
    tags: [...(doc.tags || [])],
    images,
    primaryImageUrl: primary?.url ?? null,
    createdAt: doc.createdAt || null,
    updatedAt: doc.updatedAt || null,
  };
}

// ── reads ────────────────────────────────────────────────────────────────────

const validObjectId = (id) => typeof id === 'string' && /^[a-f0-9]{24}$/i.test(id);

/** A project's products in stable catalog order (oldest first), optionally one status. */
export async function listProducts(projectId, { status = null } = {}) {
  if (!validObjectId(String(projectId))) return PROJECT_NOT_FOUND();
  const filter = { project_id: projectId };
  if (status !== null && status !== undefined) {
    if (!PRODUCT_STATUSES.includes(status)) return fail('INVALID_PRODUCT', `status must be one of: ${PRODUCT_STATUSES.join(', ')}.`);
    filter.status = status;
  }
  const docs = await SocialProduct.find(filter).sort({ createdAt: 1, _id: 1 }).limit(LIMITS.maxProducts).lean();
  return { success: true, products: docs.map(toPublicProduct), total: docs.length, limit: LIMITS.maxProducts };
}

export async function getProduct(projectId, productId) {
  if (!validObjectId(String(projectId)) || !validObjectId(productId)) return NOT_FOUND();
  const doc = await SocialProduct.findOne({ _id: productId, project_id: projectId }).lean();
  return doc ? { success: true, product: toPublicProduct(doc) } : NOT_FOUND();
}

/** The active products the resolver / AI snapshot use, in the stable order. */
export async function listActiveProducts(projectId) {
  if (!validObjectId(String(projectId))) return [];
  const docs = await SocialProduct.find({ project_id: projectId, status: 'active' }).sort({ createdAt: 1, _id: 1 }).limit(LIMITS.maxProducts).lean();
  return docs.map(toPublicProduct);
}

/**
 * The asset references a future product post / design request needs: the product and its image URLs, only when
 * the product belongs to THIS project and every URL is one Odito's own storage issued. Nothing is fetched.
 */
export async function resolveProductAssets(projectId, productId) {
  const found = await getProduct(projectId, productId);
  if (!found.success) return found;
  const { product } = found;
  const images = product.images.filter((img) => mediaStorageService.isOwnedUrl(img.url));
  return { success: true, productId: product.id, name: product.name, productUrl: product.productUrl, images, primaryImageUrl: (images.find((i) => i.isPrimary) || images[0])?.url ?? null };
}

// ── writes ───────────────────────────────────────────────────────────────────

async function uniqueSlug(projectId, base) {
  for (let i = 1; i <= 50; i += 1) {
    const candidate = i === 1 ? base : `${base}-${i}`;
    // eslint-disable-next-line no-await-in-loop
    if (!(await SocialProduct.exists({ project_id: projectId, slug: candidate }))) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

function duplicateKeyError(error) {
  if (error?.code !== 11000) return null;
  const key = error.keyPattern || {};
  if ('sku' in key || String(error.message).includes('unique_product_sku')) return fail('DUPLICATE_SKU', 'Another product in this project already uses that SKU.');
  if ('slug' in key || String(error.message).includes('unique_product_slug')) return fail('DUPLICATE_SLUG', 'Another product in this project already uses that slug.');
  return null;
}

export async function createProduct(projectId, userId, body) {
  if (!validObjectId(String(projectId))) return PROJECT_NOT_FOUND();
  const validated = validateProductInput(body, { partial: false });
  if (validated.error) return { success: false, error: validated.error };
  const set = validated.set;

  const problem = crossFieldProblem({ price: set.price, salePrice: set.salePrice, currency: set.currency });
  if (problem) return fail('INVALID_PRODUCT', problem);

  // Defence in depth behind validateProjectAccess(): never create a product for a project that does not exist (or is trashed).
  if (!(await SeoProject.exists({ _id: projectId, is_deleted: { $ne: true } }))) return PROJECT_NOT_FOUND();
  if ((await SocialProduct.countDocuments({ project_id: projectId })) >= LIMITS.maxProducts) {
    return fail('PRODUCT_LIMIT_REACHED', `A project can have at most ${LIMITS.maxProducts} products.`);
  }

  const explicitSlug = 'slug' in set;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const slug = explicitSlug ? set.slug : await uniqueSlug(projectId, slugify(set.name)); // eslint-disable-line no-await-in-loop
    try {
      // eslint-disable-next-line no-await-in-loop
      const doc = await SocialProduct.create({ ...set, slug, project_id: projectId, images: [], createdBy: userId, updatedBy: userId });
      return { success: true, product: toPublicProduct(doc.toObject()) };
    } catch (error) {
      const dup = duplicateKeyError(error);
      if (!dup) throw error;
      // a generated slug lost a race: pick the next free one; an explicit slug or a SKU is the caller's to change
      if (dup.error.code === 'DUPLICATE_SLUG' && !explicitSlug) continue;
      return dup;
    }
  }
  return fail('CONFLICT', 'The catalog was changed at the same time. Please try again.');
}

export async function updateProduct(projectId, productId, userId, body) {
  if (!validObjectId(String(projectId)) || !validObjectId(productId)) return NOT_FOUND();
  const validated = validateProductInput(body, { partial: true });
  if (validated.error) return { success: false, error: validated.error };

  const existing = await SocialProduct.findOne({ _id: productId, project_id: projectId }).lean();
  if (!existing) return NOT_FOUND();

  const problem = crossFieldProblem({ ...existing, ...validated.set });
  if (problem) return fail('INVALID_PRODUCT', problem);

  try {
    const doc = await SocialProduct.findOneAndUpdate(
      { _id: productId, project_id: projectId },
      { $set: { ...validated.set, updatedBy: userId } },
      { new: true, runValidators: true },
    ).lean();
    return doc ? { success: true, product: toPublicProduct(doc) } : NOT_FOUND();
  } catch (error) {
    const dup = duplicateKeyError(error);
    if (dup) return dup;
    throw error;
  }
}

/** Deletes the product and then its image files (best effort; a missing file is not an error). */
export async function deleteProduct(projectId, productId) {
  if (!validObjectId(String(projectId)) || !validObjectId(productId)) return NOT_FOUND();
  const doc = await SocialProduct.findOneAndDelete({ _id: productId, project_id: projectId }).lean();
  if (!doc) return NOT_FOUND();
  await Promise.all((doc.images || []).map((img) => mediaStorageService.deleteByKey(img.storageKey, { projectId })));
  return { success: true, id: String(doc._id) };
}

// ── images ───────────────────────────────────────────────────────────────────

/** Sorted, re-numbered 0..n-1, and exactly one primary (the first flagged, else the first image). */
function normalizeImages(images) {
  const sorted = [...images].sort(byOrder);
  const primaryIndex = Math.max(0, sorted.findIndex((i) => i.isPrimary));
  return sorted.map((img, i) => ({ ...img, sortOrder: i, isPrimary: sorted.length > 0 && i === primaryIndex }));
}

/**
 * Read -> change -> conditional write. The write only lands if the product has not been modified since it was
 * read (matched on `updatedAt`), so two simultaneous image operations can never silently overwrite each other;
 * the loser re-reads and re-applies. `change(images, doc)` returns { images, result? } or { error }.
 */
async function mutateImages(projectId, productId, userId, change) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const doc = await SocialProduct.findOne({ _id: productId, project_id: projectId }).lean();
    if (!doc) return NOT_FOUND();
    const out = change((doc.images || []).map((i) => ({ ...i })), doc);
    if (out.error) return { success: false, error: out.error };
    // eslint-disable-next-line no-await-in-loop
    const updated = await SocialProduct.findOneAndUpdate(
      { _id: productId, project_id: projectId, updatedAt: doc.updatedAt },
      { $set: { images: normalizeImages(out.images), updatedBy: userId } },
      { new: true },
    ).lean();
    if (updated) return { success: true, product: toPublicProduct(updated), result: out.result ?? null };
  }
  return fail('CONFLICT', 'The product was changed at the same time. Please try again.');
}

const dropFile = (storageKey, projectId) => mediaStorageService.deleteByKey(storageKey, { projectId });

export async function addProductImage(projectId, productId, userId, buffer) {
  if (!validObjectId(String(projectId)) || !validObjectId(productId)) return NOT_FOUND();
  const current = await SocialProduct.findOne({ _id: productId, project_id: projectId }).select('images').lean();
  if (!current) return NOT_FOUND();
  if ((current.images || []).length >= LIMITS.maxImages) return fail('IMAGE_LIMIT_REACHED', `A product can have at most ${LIMITS.maxImages} images.`);

  const processed = await processAndStoreCatalogImage({ buffer, projectId: String(projectId) });
  if (processed.error) return { success: false, error: processed.error };
  const { media } = processed;

  const mediaId = new mongoose.Types.ObjectId();
  const result = await mutateImages(projectId, productId, userId, (images) => {
    if (images.length >= LIMITS.maxImages) return { error: { code: 'IMAGE_LIMIT_REACHED', message: `A product can have at most ${LIMITS.maxImages} images.` } };
    images.push({ mediaId, ...media, altText: '', isPrimary: images.length === 0, sortOrder: images.length });
    return { images, result: String(mediaId) };
  });
  if (!result.success) await dropFile(media.storageKey, projectId); // stored but never attached
  return result.success ? { success: true, product: result.product, mediaId: result.result } : result;
}

export async function replaceProductImage(projectId, productId, mediaId, userId, buffer) {
  if (!validObjectId(String(projectId)) || !validObjectId(productId) || !validObjectId(mediaId)) return NOT_FOUND();
  mediaId = mediaId.toLowerCase(); // ObjectId strings are lowercase; compare like with like
  const owns = await SocialProduct.exists({ _id: productId, project_id: projectId, 'images.mediaId': mediaId });
  if (!owns) return fail('NOT_FOUND', 'Image not found.');

  const processed = await processAndStoreCatalogImage({ buffer, projectId: String(projectId) });
  if (processed.error) return { success: false, error: processed.error };
  const { media } = processed;

  const result = await mutateImages(projectId, productId, userId, (images) => {
    const idx = images.findIndex((i) => String(i.mediaId) === mediaId);
    if (idx === -1) return { error: { code: 'NOT_FOUND', message: 'Image not found.' } };
    const old = images[idx];
    images[idx] = { ...old, ...media };
    return { images, result: old.storageKey };
  });
  if (!result.success) {
    await dropFile(media.storageKey, projectId);
    return result;
  }
  await dropFile(result.result, projectId); // the file that was replaced
  return { success: true, product: result.product };
}

export async function deleteProductImage(projectId, productId, mediaId, userId) {
  if (!validObjectId(String(projectId)) || !validObjectId(productId) || !validObjectId(mediaId)) return NOT_FOUND();
  mediaId = mediaId.toLowerCase(); // ObjectId strings are lowercase; compare like with like
  const result = await mutateImages(projectId, productId, userId, (images) => {
    const idx = images.findIndex((i) => String(i.mediaId) === mediaId);
    if (idx === -1) return { error: { code: 'NOT_FOUND', message: 'Image not found.' } };
    const [removed] = images.splice(idx, 1);
    return { images, result: removed.storageKey };
  });
  if (!result.success) return result;
  await dropFile(result.result, projectId);
  return { success: true, product: result.product };
}

/** altText and / or "make this the primary image". */
export async function updateProductImage(projectId, productId, mediaId, userId, body) {
  if (!validObjectId(String(projectId)) || !validObjectId(productId) || !validObjectId(mediaId)) return NOT_FOUND();
  mediaId = mediaId.toLowerCase(); // ObjectId strings are lowercase; compare like with like
  let altText;
  let makePrimary = false;
  try {
    if (!isPlainObject(body)) bad('The request body must be an object.', 'INVALID_BODY');
    const { projectId: _projectId, ...fields } = body;
    assertKnownKeys(fields, ['altText', 'isPrimary'], '');
    if ('altText' in fields) altText = text(fields.altText, 'altText', LIMITS.altText) || '';
    if ('isPrimary' in fields) {
      if (fields.isPrimary !== true) bad('isPrimary can only be set to true (choose another image to change the primary).', 'INVALID_PRODUCT');
      makePrimary = true;
    }
    if (altText === undefined && !makePrimary) bad('Provide altText or isPrimary.', 'EMPTY_UPDATE');
  } catch (error) {
    if (error instanceof ValidationError) return { success: false, error: { code: error.code === 'INVALID_PROFILE' ? 'INVALID_PRODUCT' : error.code, message: error.message } };
    throw error;
  }

  const result = await mutateImages(projectId, productId, userId, (images) => {
    const idx = images.findIndex((i) => String(i.mediaId) === mediaId);
    if (idx === -1) return { error: { code: 'NOT_FOUND', message: 'Image not found.' } };
    if (altText !== undefined) images[idx].altText = altText;
    if (makePrimary) images.forEach((img, i) => { img.isPrimary = i === idx; });
    return { images };
  });
  return result.success ? { success: true, product: result.product } : result;
}

/** { mediaIds: [every image id, in the new order], primaryMediaId?: id } */
export async function reorderProductImages(projectId, productId, userId, body) {
  if (!validObjectId(String(projectId)) || !validObjectId(productId)) return NOT_FOUND();
  let order;
  let primaryId = null;
  try {
    if (!isPlainObject(body)) bad('The request body must be an object.', 'INVALID_BODY');
    const { projectId: _projectId, ...fields } = body;
    assertKnownKeys(fields, ['mediaIds', 'primaryMediaId'], '');
    if (!Array.isArray(fields.mediaIds)) bad('mediaIds must be a list.', 'INVALID_PRODUCT');
    if (fields.mediaIds.length > LIMITS.maxImages) bad(`mediaIds can have at most ${LIMITS.maxImages} entries.`, 'INVALID_PRODUCT');
    order = fields.mediaIds.map((id, i) => objectIdString(id, `mediaIds[${i}]`));
    if (new Set(order).size !== order.length) bad('mediaIds lists an image twice.', 'INVALID_PRODUCT');
    if (fields.primaryMediaId !== undefined && fields.primaryMediaId !== null) primaryId = objectIdString(fields.primaryMediaId, 'primaryMediaId');
  } catch (error) {
    if (error instanceof ValidationError) return { success: false, error: { code: error.code === 'INVALID_PROFILE' ? 'INVALID_PRODUCT' : error.code, message: error.message } };
    throw error;
  }

  const result = await mutateImages(projectId, productId, userId, (images) => {
    const have = new Set(images.map((i) => String(i.mediaId)));
    if (order.length !== have.size || !order.every((id) => have.has(id))) {
      return { error: { code: 'INVALID_ORDER', message: 'mediaIds must list every image of the product exactly once.' } };
    }
    if (primaryId && !have.has(primaryId)) return { error: { code: 'INVALID_ORDER', message: 'primaryMediaId is not an image of this product.' } };
    const position = new Map(order.map((id, i) => [id, i]));
    const next = images.map((img) => ({ ...img, sortOrder: position.get(String(img.mediaId)), isPrimary: primaryId ? String(img.mediaId) === primaryId : img.isPrimary }));
    return { images: next };
  });
  return result.success ? { success: true, product: result.product } : result;
}

export default {
  LIMITS, PRODUCT_FIELDS, slugify, validateProductInput, toPublicProduct, toPublicImage,
  listProducts, getProduct, listActiveProducts, resolveProductAssets,
  createProduct, updateProduct, deleteProduct,
  addProductImage, replaceProductImage, deleteProductImage, updateProductImage, reorderProductImages,
};
