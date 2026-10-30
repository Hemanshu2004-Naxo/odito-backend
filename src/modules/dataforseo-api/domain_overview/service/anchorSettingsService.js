import SeoProject from '../../../app_user/model/SeoProject.js';

/**
 * The Anchors page's two saved lists, kept on the project: `anchor_brand_terms` and `anchor_target_keywords`, plus the time they were
 * first saved (`anchor_settings_saved_at`). All three are `select: false` on the model (a project list never carries them) and are read
 * and written here explicitly. A project that never saved has none of them: `saved: false`, and the page falls back to suggestions.
 * A save is ONE atomic $set of both lists, so two tabs can never leave one list from each.
 */

const alive = (projectId) => ({ _id: projectId, is_deleted: { $ne: true } });
const FIELDS = '+anchor_brand_terms +anchor_target_keywords +anchor_settings_saved_at';

const shape = (doc) => ({
  saved: Boolean(doc?.anchor_settings_saved_at),
  brand_terms: [...(doc?.anchor_brand_terms ?? [])],
  target_keywords: [...(doc?.anchor_target_keywords ?? [])],
  saved_at: doc?.anchor_settings_saved_at ? new Date(doc.anchor_settings_saved_at).toISOString() : null,
});

/** @returns {Promise<{ saved: boolean, brand_terms: string[], target_keywords: string[], saved_at: string|null }>} */
export async function getAnchorSettings(projectId) {
  const doc = await SeoProject.findOne(alive(projectId)).select(FIELDS).lean();
  return shape(doc);
}

/** Replaces both lists (already validated and clean). Resolves to the settings as saved. */
export async function saveAnchorSettings({ projectId, brandTerms, targetKeywords, now = new Date() }) {
  await SeoProject.updateOne(alive(projectId), {
    $set: { anchor_brand_terms: brandTerms, anchor_target_keywords: targetKeywords, anchor_settings_saved_at: now },
  });
  return getAnchorSettings(projectId);
}
