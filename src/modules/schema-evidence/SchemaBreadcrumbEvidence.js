import mongoose from 'mongoose';

/**
 * SchemaBreadcrumbEvidence — the breadcrumb hierarchy a site owner confirmed for ONE page.
 *
 * Why a separate, tiny collection: `recommendations` is a fingerprint-keyed cache (a changed
 * fingerprint means a new document), so it cannot be the home of an input that has to survive
 * regeneration, reloads and re-crawls. This holds only what is needed to regenerate and audit the
 * recommendation — the confirmed names/URLs, the canonical they were checked against, who submitted
 * them and when. No page content, no HTML.
 *
 * One document per (projectId, pageUrl); submitting an unchanged hierarchy never rewrites it.
 * Registered with the project cascade delete (projectCascadeDeleteService.js).
 */
const itemSchema = new mongoose.Schema({
  position: { type: Number, required: true, min: 1 },
  name: { type: String, required: true, maxlength: 120 },
  url: { type: String, required: true, maxlength: 2048 },
  /** How the owner arrived at this item: taken from a discovered trail, a suggestion they accepted, typed, or a discovered one they edited. */
  origin: { type: String, enum: ['discovered', 'suggested', 'manual', 'edited'], default: 'manual' },
}, { _id: false });

const schema = new mongoose.Schema({
  projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'SeoProject', required: true },
  /** The crawl identity of the audited page (seo_page_data.url) — the same key the recommendation uses. */
  pageUrl: { type: String, required: true, maxlength: 2048 },
  items: { type: [itemSchema], validate: (v) => Array.isArray(v) && v.length >= 2 && v.length <= 10 },
  /** The canonical the final item was validated against, and whether it was verified from the site. */
  canonicalUrl: { type: String, default: null, maxlength: 2048 },
  canonicalSource: { type: String, enum: ['canonical_tag', 'user_confirmed'], required: true },
  evidenceHash: { type: String, required: true },
  revision: { type: Number, default: 1 },
  submittedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
  submittedAt: { type: Date, required: true },
  /** Last time a recommendation was (re)generated from this evidence. */
  regeneratedAt: { type: Date, default: null },
}, { timestamps: true, collection: 'schema_breadcrumb_evidence' });

schema.index({ projectId: 1, pageUrl: 1 }, { unique: true });

export default mongoose.models.SchemaBreadcrumbEvidence || mongoose.model('SchemaBreadcrumbEvidence', schema);
