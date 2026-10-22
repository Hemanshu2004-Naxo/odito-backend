import mongoose from 'mongoose';

/**
 * SchemaOrganizationAddress — the business address the site owner confirmed in ODITO for the Organization entity.
 *
 * Why a separate, tiny collection: the Organization is a SITE-level entity, so this is one document per project (not per
 * page), and the input has to survive recommendation regeneration, reloads and re-crawls — `recommendations` is a
 * fingerprint-keyed cache and cannot hold it (same reasoning as SchemaBreadcrumbEvidence).
 *
 * It holds only the five PostalAddress fields the owner confirmed, how they were confirmed, who did and when. It is
 * "confirmed by the owner" evidence, not an externally verified fact, and the UI/API say exactly that.
 * Registered with the project cascade delete (projectCascadeDeleteService.js).
 */
const fieldsSchema = new mongoose.Schema({
  streetAddress: { type: String, required: true, maxlength: 200 },
  addressLocality: { type: String, required: true, maxlength: 100 },
  addressRegion: { type: String, default: undefined, maxlength: 100 },
  postalCode: { type: String, default: undefined, maxlength: 20 },
  addressCountry: { type: String, default: undefined, maxlength: 60 },
}, { _id: false });

const schema = new mongoose.Schema({
  projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'SeoProject', required: true },
  fields: { type: fieldsSchema, required: true },
  /** typed = the owner entered it; selected_candidate = the owner picked a structured address ODITO had found. */
  basis: { type: String, enum: ['typed', 'selected_candidate'], default: 'typed' },
  /** For selected_candidate: which source the owner chose it from (informational). */
  basisSource: { type: String, default: null, maxlength: 60 },
  addressHash: { type: String, required: true },
  revision: { type: Number, default: 1 },
  confirmedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
  /**
   * What the confirmation means: the USER asserts the address is correct. It was NOT checked by any external source
   * (`verifiedExternally` is always false for this collection). Kept explicit so no consumer mistakes one for the other.
   */
  source: { type: String, enum: ['user_provided'], default: 'user_provided' },
  state: { type: String, enum: ['confirmed_by_user'], default: 'confirmed_by_user' },
  verifiedExternally: { type: Boolean, default: false },
  /** The exact website (origin), issue and Organization entity this confirmation was given for. null on records that predate binding. */
  website: { type: String, default: null, maxlength: 300 },
  issueId: { type: String, default: null, maxlength: 120 },
  entityId: { type: String, default: null, maxlength: 500 },
  confirmedAt: { type: Date, required: true },
}, { timestamps: true, collection: 'schema_organization_address' });

schema.index({ projectId: 1 }, { unique: true });

export default mongoose.models.SchemaOrganizationAddress || mongoose.model('SchemaOrganizationAddress', schema);
