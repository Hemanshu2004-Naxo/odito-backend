import mongoose from 'mongoose';

/**
 * What a website says about itself, read from its public homepage (service/siteFacts.js), cached ACROSS projects so that two projects that
 * look at the same site read it once. It holds only small extracted facts (title, description, headings, structured-data types, address,
 * a short text sample), never project data and never the page itself. It expires on its own: a month for a page that was read, six hours
 * for one that could not be (so a temporary failure is retried soon).
 */
const profileSchema = new mongoose.Schema({
  domain: { type: String, required: true, unique: true, maxlength: 253 },
  facts: { type: mongoose.Schema.Types.Mixed, required: true },
  fetched_at: { type: Date, required: true },
  expires_at: { type: Date, required: true },
}, { collection: 'competitor_domain_profiles' });

profileSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0, name: 'competitor_domain_profiles_ttl' });

const CompetitorDomainProfile = mongoose.models.CompetitorDomainProfile || mongoose.model('CompetitorDomainProfile', profileSchema);
export default CompetitorDomainProfile;
