/**
 * Persistence for user-supplied breadcrumb evidence. Every function is scoped by projectId — a
 * caller can never read or write another project's evidence by guessing a page URL.
 */

import mongoose from 'mongoose';
import SchemaBreadcrumbEvidence from './SchemaBreadcrumbEvidence.js';
import { breadcrumbEvidenceHash } from './breadcrumbHierarchy.js';

const oid = (v) => (v instanceof mongoose.Types.ObjectId ? v : new mongoose.Types.ObjectId(String(v)));

export async function getUserBreadcrumbEvidence(projectId, pageUrl) {
  if (!projectId || !pageUrl) return null;
  const doc = await SchemaBreadcrumbEvidence.findOne({ projectId: oid(projectId), pageUrl }).lean();
  return doc ? {
    items: (doc.items || []).map((i) => ({ position: i.position, name: i.name, url: i.url, origin: i.origin || 'manual' })),
    evidenceHash: doc.evidenceHash,
    canonicalUrl: doc.canonicalUrl || null,
    canonicalSource: doc.canonicalSource,
    submittedAt: doc.submittedAt,
    regeneratedAt: doc.regeneratedAt || null,
    revision: doc.revision || 1,
  } : null;
}

/**
 * Saves validated evidence. If the same hierarchy is already stored, nothing is rewritten and
 * `changed` is false — repeated submissions neither duplicate records nor churn the document.
 */
export async function saveUserBreadcrumbEvidence({ projectId, pageUrl, items, canonicalUrl, canonicalSource, userId = null, now = new Date() }) {
  const evidenceHash = breadcrumbEvidenceHash(items);
  const filter = { projectId: oid(projectId), pageUrl };
  const existing = await SchemaBreadcrumbEvidence.findOne(filter).select('evidenceHash canonicalUrl canonicalSource').lean();
  if (existing && existing.evidenceHash === evidenceHash && existing.canonicalUrl === (canonicalUrl || null) && existing.canonicalSource === canonicalSource) {
    return { changed: false, evidenceHash };
  }
  await SchemaBreadcrumbEvidence.findOneAndUpdate(
    filter,
    {
      $set: {
        items, canonicalUrl: canonicalUrl || null, canonicalSource, evidenceHash,
        submittedBy: userId ? oid(userId) : null, submittedAt: now, regeneratedAt: null,
      },
      $inc: { revision: 1 },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return { changed: true, evidenceHash };
}

export async function markBreadcrumbEvidenceRegenerated(projectId, pageUrl, now = new Date()) {
  await SchemaBreadcrumbEvidence.updateOne({ projectId: oid(projectId), pageUrl }, { $set: { regeneratedAt: now } });
}

export default { getUserBreadcrumbEvidence, saveUserBreadcrumbEvidence, markBreadcrumbEvidenceRegenerated };
