import mongoose from 'mongoose';

/**
 * WordPressForm Model
 *
 * A persistent model (not just a sync summary) because the Phase 3A success
 * criterion explicitly includes "Odito can display detected forms" — that
 * needs a queryable list with per-form field metadata, not just a count.
 *
 * Structure only: field NAME and TYPE, never submitted VALUES (see
 * wordPressFormService.js's sensitive-field filtering, applied again here
 * server-side even though the plugin already filters — defense in depth,
 * per Section 29 of the Phase 3A spec).
 */

const FORM_PROVIDERS = ['contact_form_7', 'divi', 'generic'];

const formFieldSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    type: { type: String, trim: true, maxlength: 50, default: 'text' },
  },
  { _id: false }
);

const wordPressFormSchema = new mongoose.Schema({
  project_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SeoProject',
    required: true,
  },
  wordpress_plugin_installation_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'WordPressPluginInstallation',
    required: true,
  },
  // The plugin's own stable identifier for this form (e.g. the CF7 post ID,
  // or a slug the plugin derives for Divi/generic forms) — stable across
  // repeated syncs so upserts are idempotent, NOT a Mongo ObjectId.
  external_id: {
    type: String,
    required: true,
    trim: true,
    maxlength: 200,
  },
  provider: {
    type: String,
    enum: FORM_PROVIDERS,
    required: true,
  },
  name: {
    type: String,
    trim: true,
    maxlength: 200,
    default: null,
  },
  page_url: {
    type: String,
    trim: true,
    maxlength: 2000,
    default: null,
  },
  fields: {
    type: [formFieldSchema],
    default: [],
  },
  // Flips to false when a later sync no longer reports this form (form
  // deleted/deactivated in WordPress) — kept, not deleted, so form history
  // survives a form being temporarily removed and re-added.
  is_active: {
    type: Boolean,
    default: true,
  },
  last_seen_at: {
    type: Date,
    default: Date.now,
  },
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
});

// Idempotency key for sync upserts — repeated sync of the same form must
// update, never duplicate.
wordPressFormSchema.index({ project_id: 1, provider: 1, external_id: 1 }, { unique: true });

// Dashboard list view: active forms for a project, most-recently-seen first.
wordPressFormSchema.index({ project_id: 1, is_active: 1, last_seen_at: -1 });

export { FORM_PROVIDERS };

const WordPressForm = mongoose.model('WordPressForm', wordPressFormSchema);
export default WordPressForm;
