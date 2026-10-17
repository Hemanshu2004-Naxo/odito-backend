/**
 * Persistence for the owner-confirmed Organization address, plus the loader that gathers every other address source ODITO
 * holds for a project. Every function is scoped by projectId — a caller can never read or write another project's data by
 * guessing an id — and the loader never throws: an unavailable source is simply "nothing found".
 */

import crypto from 'crypto';
import mongoose from 'mongoose';
import SchemaOrganizationAddress from './SchemaOrganizationAddress.js';
import { ADDRESS_FIELDS } from './organizationAddress.js';

const oid = (v) => (v instanceof mongoose.Types.ObjectId ? v : new mongoose.Types.ObjectId(String(v)));

export const addressHashOf = (fields) => crypto.createHash('sha256')
  .update(JSON.stringify(ADDRESS_FIELDS.map((f) => String(fields?.[f] ?? '').trim().toLowerCase())))
  .digest('hex').slice(0, 32);

export async function getConfirmedAddress(projectId, { model = SchemaOrganizationAddress } = {}) {
  if (!projectId) return null;
  const doc = await model.findOne({ projectId: oid(projectId) }).lean();
  return doc ? {
    fields: Object.fromEntries(ADDRESS_FIELDS.filter((f) => doc.fields?.[f]).map((f) => [f, doc.fields[f]])),
    basis: doc.basis, confirmedAt: doc.confirmedAt, revision: doc.revision || 1, addressHash: doc.addressHash,
  } : null;
}

/**
 * Saves a validated address. The same address already stored => nothing is rewritten and `changed` is false, so repeated
 * submissions neither duplicate records nor churn the document.
 */
export async function saveConfirmedAddress({ projectId, fields, basis = 'typed', basisSource = null, userId = null, now = new Date(), model = SchemaOrganizationAddress }) {
  const addressHash = addressHashOf(fields);
  const filter = { projectId: oid(projectId) };
  const existing = await model.findOne(filter).select('addressHash').lean();
  if (existing && existing.addressHash === addressHash) return { changed: false, addressHash };
  await model.findOneAndUpdate(
    filter,
    {
      $set: { fields, basis, basisSource, addressHash, confirmedBy: userId ? oid(userId) : null, confirmedAt: now },
      $inc: { revision: 1 },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return { changed: true, addressHash };
}

/**
 * Everything else ODITO stores about the business location, as plain data for collectAddressCandidates().
 * Sources: the project (Places selection at onboarding, website-extraction text) and the owner's business details entered
 * for Social Media AI. The connected Google Business Profile is loaded separately (businessProfileFacts).
 */
export async function loadAddressSources(projectId, { siteUrl = null, db = mongoose.connection?.db } = {}) {
  const out = { project: null, owner: null, confirmed: null };
  if (!projectId) return out;
  try { out.confirmed = await getConfirmedAddress(projectId); } catch (err) { console.warn(`[ADDRESS_SOURCES] confirmed address unavailable: ${err.message}`); }
  if (!db) return out;
  try {
    const project = await db.collection('seoprojects').findOne(
      { _id: oid(projectId) },
      { projection: { verified_business: 1, 'extracted_metadata.contact_info': 1, main_url: 1 } },
    );
    if (project) {
      out.project = {
        siteUrl: siteUrl || project.main_url || null,
        verifiedBusiness: project.verified_business || null,
        contactInfo: project.extracted_metadata?.contact_info || null,
      };
    }
  } catch (err) { console.warn(`[ADDRESS_SOURCES] project business details unavailable: ${err.message}`); }
  try {
    const profile = await db.collection('socialbusinessprofiles').findOne({ project_id: oid(projectId) }, { projection: { overrides: 1 } });
    if (profile?.overrides) out.owner = profile.overrides;
  } catch (err) { console.warn(`[ADDRESS_SOURCES] owner business details unavailable: ${err.message}`); }
  return out;
}

export default { addressHashOf, getConfirmedAddress, saveConfirmedAddress, loadAddressSources };
