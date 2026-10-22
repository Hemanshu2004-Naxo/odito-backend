import mongoose from 'mongoose';

/**
 * Business Profile Metadata Model
 *
 * One document per project. Stores the business's static profile info
 * (name, category, phone, website, address) plus its rating/review-count
 * summary and the current capability status of the reviews pipeline.
 *
 * capability_status exists because Google's reviews access is gated
 * (legacy v4 API must be enabled + allowlisted per Google Cloud project -
 * see businessProfileReviewService.js checkReviewsCapability()). The
 * frontend reads this field to decide whether to render real numbers or
 * "Unavailable" with a reason - never a fabricated 0.
 */
const businessProfileMetadataSchema = new mongoose.Schema({
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },

  project_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SeoProject',
    required: true,
    unique: true,
    index: true
  },

  business_account_id: { type: String, required: true },
  business_location_id: { type: String, required: true },

  // 🏢 Business metadata (from Business Information API v1 - always available)
  business_name: { type: String, default: null },
  category: { type: String, default: null },
  phone: { type: String, default: null },
  website: { type: String, default: null },
  address: { type: String, default: null },

  // 🏢 Extended profile fields (Business Information API v1, EXTENDED_LOCATION_READ_MASK -
  // see businessProfileService.getBusinessProfileLocationDetails()). Additive
  // to the original metadata above; same always-available access as it.
  description: { type: String, default: null },
  secondary_categories: { type: [String], default: [] },
  business_status: { type: String, default: null }, // Google's openInfo.status, e.g. OPEN / CLOSED_TEMPORARILY / CLOSED_PERMANENTLY
  has_voice_of_merchant: { type: Boolean, default: null },
  latitude: { type: Number, default: null },
  longitude: { type: Number, default: null },
  // Fallback coordinates when Google doesn't return latlng for this listing
  // (a real, confirmed case - see businessProfileService.geocodeAddress()).
  // Kept separate from latitude/longitude above so the Google-authoritative
  // fields are never conflated with a locally-derived approximation; the
  // API layer prefers latitude/longitude and only falls back to these.
  geocoded_latitude: { type: Number, default: null },
  geocoded_longitude: { type: Number, default: null },
  geocoded_at: { type: Date, default: null },
  maps_uri: { type: String, default: null },
  new_review_uri: { type: String, default: null },
  place_id: { type: String, default: null },
  // Schema-flexible: these are Google's own nested shapes (serviceArea.places,
  // regularHours.periods[], specialHours.specialHourPeriods[]) passed through
  // as-is rather than remodeled field-by-field for a Phase 1 read-only display.
  service_area: { type: mongoose.Schema.Types.Mixed, default: null },
  regular_hours: { type: mongoose.Schema.Types.Mixed, default: null },
  special_hours: { type: mongoose.Schema.Types.Mixed, default: null },
  details_last_synced_at: { type: Date, default: null },

  // ⭐ Rating summary (only ever populated when reviews_capability.status === 'available')
  average_rating: { type: Number, default: null, min: 0, max: 5 },
  total_review_count: { type: Number, default: null, min: 0 },

  // 🚦 Reviews pipeline capability - the source of truth for the frontend's
  // "Unavailable" vs real-data decision. Re-checked on every sync (cheap:
  // one lightweight probe call) rather than assumed permanent, so access
  // being granted later is picked up automatically without a code change.
  reviews_capability: {
    status: {
      type: String,
      enum: ['available', 'api_disabled', 'restricted', 'rate_limited', 'error', 'unknown'],
      default: 'unknown'
    },
    reason: { type: String, default: null },
    checked_at: { type: Date, default: null }
  },

  // 🔄 Sync bookkeeping
  metadata_last_synced_at: { type: Date, default: null },
  reviews_last_synced_at: { type: Date, default: null },
  sync_error: { type: String, default: null }

}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'business_profile_metadata'
});

/**
 * Upsert metadata + capability status for a project in one call.
 * @param {string} projectId
 * @param {Object} fields - Partial fields to $set
 */
businessProfileMetadataSchema.statics.upsertForProject = async function(projectId, userId, fields) {
  return this.findOneAndUpdate(
    { project_id: projectId },
    { $set: { user_id: userId, ...fields } },
    { upsert: true, new: true, runValidators: true }
  );
};

const BusinessProfileMetadata = mongoose.model('BusinessProfileMetadata', businessProfileMetadataSchema);
export default BusinessProfileMetadata;
