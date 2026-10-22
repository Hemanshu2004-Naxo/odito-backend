import mongoose from 'mongoose';

/**
 * SocialProduct — one product in a project's Social Media product catalog.
 *
 * The catalog is USER-OWNED structured input: there is no automatic product source (GBP and the website are
 * never mined for products), so everything here was typed or uploaded on purpose and is trusted by the
 * resolver / AI snapshot as such.
 *
 * One document per product, scoped by `project_id` (every query in socialProductService.js filters on it).
 * Images are references only — the files live in the existing social media storage
 * (storage/social_media/<projectId>/<uuid>.<ext>, mediaStorageService.js); no binary is ever stored in MongoDB.
 * `images[].storageKey` is the relative "<projectId>/<file>" key used to delete the file; it is internal and
 * never returned by the API.
 *
 * Bounds (counts / lengths / formats) are enforced by socialProductService.js before anything reaches this
 * schema; the schema's own maxlength values are a second line of defence.
 *
 * Extensibility: `_id` is the stable product id future features reference (a calendar item's `productId`,
 * a design request's product assets). New optional fields can be added without a migration.
 */
export const PRODUCT_STATUSES = Object.freeze(['active', 'draft', 'archived']);

const imageSchema = new mongoose.Schema({
  mediaId: { type: mongoose.Schema.Types.ObjectId, required: true },
  url: { type: String, required: true, maxlength: 600 },
  storageKey: { type: String, required: true, maxlength: 200 },
  mimeType: { type: String, required: true, maxlength: 40 },
  width: { type: Number, default: null },
  height: { type: Number, default: null },
  size: { type: Number, default: null },
  altText: { type: String, default: '', maxlength: 200 },
  isPrimary: { type: Boolean, default: false },
  sortOrder: { type: Number, default: 0 },
}, { _id: false });

const socialProductSchema = new mongoose.Schema({
  project_id: { type: mongoose.Schema.Types.ObjectId, ref: 'SeoProject', required: true },

  name: { type: String, required: true, trim: true, maxlength: 150 },
  slug: { type: String, required: true, trim: true, lowercase: true, maxlength: 120 },
  description: { type: String, default: '', trim: true, maxlength: 2000 },
  shortDescription: { type: String, default: '', trim: true, maxlength: 300 },
  category: { type: String, default: null, trim: true, maxlength: 100 },
  subcategory: { type: String, default: null, trim: true, maxlength: 100 },
  features: { type: [String], default: [] },
  benefits: { type: [String], default: [] },

  // Optional. null = "the business has not given one" — never a made-up value.
  price: { type: Number, default: null, min: 0 },
  salePrice: { type: Number, default: null, min: 0 },
  currency: { type: String, default: null, uppercase: true, minlength: 3, maxlength: 3 },
  productUrl: { type: String, default: null, trim: true, maxlength: 500 },
  sku: { type: String, default: null, trim: true, maxlength: 64 },

  status: { type: String, enum: PRODUCT_STATUSES, default: 'active' },
  tags: { type: [String], default: [] },
  images: { type: [imageSchema], default: [] },

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, {
  timestamps: true,
  // Never let an unknown key be persisted by accident.
  strict: true,
  collection: 'social_products',
});

// The hot query: a project's products, filtered by status.
socialProductSchema.index({ project_id: 1, status: 1 }, { name: 'product_project_status' });
// Slug is the per-project lookup key and is always unique inside a project.
socialProductSchema.index({ project_id: 1, slug: 1 }, { unique: true, name: 'unique_product_slug' });
// SKU is optional: only products that HAVE one take part in uniqueness (a partial index, so many products may have none).
socialProductSchema.index(
  { project_id: 1, sku: 1 },
  { unique: true, partialFilterExpression: { sku: { $type: 'string' } }, name: 'unique_product_sku' },
);

const SocialProduct = mongoose.model('SocialProduct', socialProductSchema);
export default SocialProduct;
