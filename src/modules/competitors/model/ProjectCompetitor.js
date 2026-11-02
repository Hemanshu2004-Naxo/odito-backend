import mongoose from 'mongoose';
import { REQUIRED_INDEXES, SUPPORTING_INDEXES } from './indexSpec.js';

/**
 * A competitor the user chose for one project ("My Competitors"): the project's canonical competitor identity. Never produced or
 * removed by a provider refresh: only the routes in competitors/routes/myCompetitorsRoutes.js (and the enrichment worker, which writes
 * ONLY the `enrichment` object) write it, so a manual entry survives every discovery run, whatever its distance.
 *
 * Identity. One record is one business as the user thinks of it. `domain` (its website) and `place_id` (its primary Google place) are both
 * optional, but at least a name is always kept. A brand with several physical branches stays ONE record: `branches` lists every Google place
 * known for it (the primary one is always branches[0]); two different place ids are never merged merely because the name matches.
 * Absent optional fields are stored as null, never as "": the validator turns blanks into null.
 *
 * Provenance. `source` is how the record FIRST got here (immutable). `provenance` is every way it has been found or added since
 * (manual / seo / local / legacy / social), so adding the same business from another discovery source adds an entry here instead of a
 * second record.
 *
 * Google Places content. Only the place id (indefinitely) and latitude / longitude (with `coords_fetched_at`: Google allows caching them for
 * 30 days, after which they must not be used) are kept from Google. Ratings, review counts, categories, status and the like are NOT stored;
 * the Local Competitors tab shows them from the live search result.
 *
 * Enrichment. `enrichment` is the background SEO-metrics state: the queue fields (status, lease, attempts, next attempt) and one record per
 * section, saved independently. Missing provider data is null and never zero.
 *
 * Unique indexes (model/indexSpec.js) are the feature's guarantees: no duplicate website, no duplicate place (primary or branch), and
 * the capacity limit (every record owns one `slot` in 0..MY_COMPETITORS_MAX-1, so a project can never exceed it however many adds arrive at
 * once; a failed insert consumes nothing; no transaction needed).
 */
export const COMPETITOR_SOURCES = Object.freeze(['manual', 'seo', 'local', 'legacy', 'social']);
export const MY_COMPETITORS_MAX = 100;
export const ENRICHMENT_STATUSES = Object.freeze(['no_website', 'pending', 'processing', 'enriched', 'partial', 'failed', 'no_data']);
export const SECTION_STATUSES = Object.freeze(['ok', 'no_data', 'failed', 'not_configured']);
export const SECTION_KEYS = Object.freeze(['rank', 'backlinks', 'shared']);

const sectionSchema = new mongoose.Schema({
  status: { type: String, enum: SECTION_STATUSES, required: true },
  fetched_at: { type: Date, default: null },
  data: { type: mongoose.Schema.Types.Mixed, default: null },
  error_code: { type: String, default: null, maxlength: 60 },
  cost: { type: Number, default: null },
  attempts: { type: Number, default: 0 },
}, { _id: false });

const branchSchema = new mongoose.Schema({
  place_id: { type: String, required: true, maxlength: 200 },
  address: { type: String, default: null, maxlength: 300 },
  lat: { type: Number, default: null },
  lng: { type: Number, default: null },
  coords_fetched_at: { type: Date, default: null },
  added_at: { type: Date, default: Date.now },
}, { _id: false });

const provenanceSchema = new mongoose.Schema({
  kind: { type: String, enum: COMPETITOR_SOURCES, required: true },
  ref: { type: String, default: null, maxlength: 200 },
  at: { type: Date, default: Date.now },
  user_id: { type: mongoose.Schema.Types.ObjectId, default: null },
}, { _id: false });

const enrichmentSchema = new mongoose.Schema({
  status: { type: String, enum: ENRICHMENT_STATUSES, required: true },
  requested_at: { type: Date, default: null },
  started_at: { type: Date, default: null },
  finished_at: { type: Date, default: null },
  last_success_at: { type: Date, default: null },
  attempts: { type: Number, default: 0 },
  next_attempt_at: { type: Date, default: null },
  lease_owner: { type: String, default: null, maxlength: 80 },
  lease_until: { type: Date, default: null },
  last_error_code: { type: String, default: null, maxlength: 60 },
  market: { type: new mongoose.Schema({ location: String, language: String }, { _id: false }), default: null },
  sections: {
    rank: { type: sectionSchema, default: undefined },
    backlinks: { type: sectionSchema, default: undefined },
    shared: { type: sectionSchema, default: undefined },
  },
}, { _id: false });

const projectCompetitorSchema = new mongoose.Schema({
  project_id: { type: mongoose.Schema.Types.ObjectId, ref: 'SeoProject', required: true, index: true },
  slot: { type: Number, required: true, min: 0, max: MY_COMPETITORS_MAX - 1, immutable: true },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  domain: { type: String, default: null, maxlength: 253 },
  address: { type: String, default: null, maxlength: 300 },
  place_id: { type: String, default: null, maxlength: 200 },
  source: { type: String, enum: COMPETITOR_SOURCES, default: 'manual', immutable: true },
  notes: { type: String, default: null, maxlength: 500 },
  aliases: { type: [{ type: String, maxlength: 120 }], default: undefined, validate: [(v) => !v || v.length <= 10, 'at most 10 aliases'] },
  branches: { type: [branchSchema], default: undefined, validate: [(v) => !v || v.length <= 25, 'at most 25 branches'] },
  provenance: { type: [provenanceSchema], default: undefined, validate: [(v) => !v || v.length <= 25, 'at most 25 provenance entries'] },
  enrichment: { type: enrichmentSchema, default: undefined },
}, { collection: 'project_competitors', timestamps: true });

// Declared from the shared spec (model/indexSpec.js) so the model, the write-time check and the inspection script cannot drift apart.
for (const { key, ...options } of [...REQUIRED_INDEXES, ...SUPPORTING_INDEXES.filter((i) => i.name !== 'project_id_1')]) {
  projectCompetitorSchema.index({ ...key }, JSON.parse(JSON.stringify(options)));
}

const ProjectCompetitor = mongoose.models.ProjectCompetitor || mongoose.model('ProjectCompetitor', projectCompetitorSchema);

export default ProjectCompetitor;
