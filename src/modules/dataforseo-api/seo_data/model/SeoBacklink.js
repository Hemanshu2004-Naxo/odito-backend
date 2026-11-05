import mongoose from 'mongoose';

/**
 * One backlink (live or lost) to a project's domain, as of ONE scan. Append-only per scan, like the keyword rankings: a new scan writes a
 * new set, and new / lost links are the difference between two sets. `row` is the parsed record exactly as the Backlinks page consumes it
 * (domainOverviewProvider.parseBacklink); the flat fields are for indexing, filtering and sorting. Null = the provider sent nothing.
 *
 * Natural key `nk` = sha1(status | source url | target url | anchor | link type): the same page can link to the same target several times
 * (different anchors, an image and a text link), and a link that overlaps between two provider batches is written once.
 */
const schema = new mongoose.Schema({
  projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'SeoProject', required: true },
  domain: { type: String, required: true, maxlength: 253 },
  scanId: { type: mongoose.Schema.Types.ObjectId, required: true },
  status: { type: String, enum: ['live', 'lost'], required: true },
  nk: { type: String, required: true, maxlength: 40 },
  sourceUrl: { type: String, default: null, maxlength: 2000 },
  targetUrl: { type: String, default: null, maxlength: 2000 },
  sourceDomain: { type: String, default: null, maxlength: 253 },
  anchor: { type: String, default: null, maxlength: 400 },
  linkType: { type: String, default: null, maxlength: 30 },
  isFollow: { type: Boolean, default: null },
  rank: { type: Number, default: null },
  pageRank: { type: Number, default: null },
  domainRank: { type: Number, default: null },
  spamScore: { type: Number, default: null },
  firstSeen: { type: Date, default: null },
  lastSeen: { type: Date, default: null },
  semanticLocation: { type: String, default: null, maxlength: 40 },
  sourceCountry: { type: String, default: null, maxlength: 10 },
  isNewLink: { type: Boolean, default: null },
  isBroken: { type: Boolean, default: null },
  linkAttributes: { type: [String], default: [] },
  row: { type: mongoose.Schema.Types.Mixed, required: true },
  provider: { type: new mongoose.Schema({ name: String, endpoint: String }, { _id: false }), default: null },
  capturedAt: { type: Date, required: true },
}, { collection: 'seo_backlinks', timestamps: true, minimize: false });

schema.index({ projectId: 1, scanId: 1, nk: 1 }, { unique: true, name: 'seo_bl_scan_nk' });
// The page's sorts within one scan + tab: rank (default), first seen, domain rank. `_id` ends each key (the sort's tie-break), so the index
// serves the sort in both directions and a page reads only skip + limit entries.
schema.index({ projectId: 1, scanId: 1, status: 1, rank: -1, _id: -1 }, { name: 'seo_bl_scan_rank' });
schema.index({ projectId: 1, scanId: 1, status: 1, firstSeen: -1, _id: -1 }, { name: 'seo_bl_scan_first_seen' });
schema.index({ projectId: 1, scanId: 1, status: 1, domainRank: -1, _id: -1 }, { name: 'seo_bl_scan_domain_rank' });
// Exact-match filters ("links from this domain", "links to this page").
schema.index({ projectId: 1, scanId: 1, status: 1, sourceDomain: 1 }, { name: 'seo_bl_scan_source_domain' });
schema.index({ projectId: 1, scanId: 1, status: 1, targetUrl: 1 }, { name: 'seo_bl_scan_target' });

export default mongoose.models.SeoBacklink || mongoose.model('SeoBacklink', schema);
