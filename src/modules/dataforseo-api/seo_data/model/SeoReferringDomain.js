import mongoose from 'mongoose';

/**
 * One referring domain (live or lost) of a project's domain, as of ONE scan. Append-only per scan. `row` is the parsed record exactly as
 * the Referring Domains page consumes it, INCLUDING the quality values computed once at parse time (provider/referringDomainMetrics.js):
 * stored rows are never re-classified here. Named `_v2` because the old `seo_referring_domains` collection (the deleted snapshot design)
 * still exists in databases; nothing reads or writes it and it is left alone.
 *
 * Counts: the provider's `referring_pages` counts PAGES that link, so `followCount` is referring_pages minus referring_pages_nofollow
 * (null unless both are known). `referringIps` / `referringSubnets` are COUNTS (the endpoint reports how many, not which).
 */
const schema = new mongoose.Schema({
  projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'SeoProject', required: true },
  domain: { type: String, required: true, maxlength: 253 },
  scanId: { type: mongoose.Schema.Types.ObjectId, required: true },
  status: { type: String, enum: ['live', 'lost'], required: true },
  referringDomain: { type: String, required: true, maxlength: 253 },
  domainRank: { type: Number, default: null },
  backlinksCount: { type: Number, default: null },
  referringPages: { type: Number, default: null },
  followCount: { type: Number, default: null },
  nofollowCount: { type: Number, default: null },
  referringIps: { type: Number, default: null },
  referringSubnets: { type: Number, default: null },
  country: { type: String, default: null, maxlength: 10 },
  spamScore: { type: Number, default: null },
  brokenBacklinks: { type: Number, default: null },
  firstSeen: { type: Date, default: null },
  lostDate: { type: Date, default: null },
  qualityMetrics: { type: new mongoose.Schema({ quality: String, dofollowPct: Number, isSitewide: Boolean, topCountry: String, mainPlacement: String }, { _id: false }), default: null },
  row: { type: mongoose.Schema.Types.Mixed, required: true },
  provider: { type: new mongoose.Schema({ name: String, endpoint: String }, { _id: false }), default: null },
  capturedAt: { type: Date, required: true },
}, { collection: 'seo_referring_domains_v2', timestamps: true, minimize: false });

schema.index({ projectId: 1, scanId: 1, status: 1, referringDomain: 1 }, { unique: true, name: 'seo_rd_scan_domain' });
schema.index({ projectId: 1, scanId: 1, status: 1, domainRank: -1, _id: -1 }, { name: 'seo_rd_scan_rank' });
schema.index({ projectId: 1, scanId: 1, status: 1, backlinksCount: -1, _id: -1 }, { name: 'seo_rd_scan_backlinks' });
schema.index({ projectId: 1, scanId: 1, status: 1, firstSeen: -1, _id: -1 }, { name: 'seo_rd_scan_first_seen' });
// One domain across scans: when it appeared, its rank over time.
schema.index({ projectId: 1, referringDomain: 1, capturedAt: -1 }, { name: 'seo_rd_history' });

export default mongoose.models.SeoReferringDomainV2 || mongoose.model('SeoReferringDomainV2', schema);
