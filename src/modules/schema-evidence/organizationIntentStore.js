/**
 * Reads back the schema intent of the recommendation ODITO most recently generated for a task's page, so that
 * verification can check the deployed markup against what was RECOMMENDED (a Hospital, a LocalBusiness …) and not
 * only against "some Organization exists". Read-only; returns null whenever nothing usable is stored.
 */

export async function loadIntendedOrganization(projectId, issueKey, pageUrl, { model } = {}) {
  if (!projectId || !issueKey || !pageUrl) return null;
  try {
    const Model = model || (await import('../recommendations/model/Recommendation.js')).default;
    const doc = await Model.findOne({ projectId, ruleId: issueKey, pageUrl, invalidatedAt: null })
      .sort({ updatedAt: -1 })
      .select({ 'sections.sourceAttribution': 1 })
      .lean();
    const cs = doc?.sections?.sourceAttribution?.contextSources;
    if (!cs?.schemaType || !cs?.schemaAction) return null;
    const address = cs.schemaAddress?.fields && cs.schemaAction === 'generate' ? { address: cs.schemaAddress.fields } : {};
    return { type: cs.schemaType, types: cs.schemaTypes || [cs.schemaType], action: cs.schemaAction, intent: cs.schemaIntent || null, ...address };
  } catch (err) {
    console.warn(`[INTENDED_ORGANIZATION] unavailable: ${err.message}`);
    return null;
  }
}

export default { loadIntendedOrganization };
