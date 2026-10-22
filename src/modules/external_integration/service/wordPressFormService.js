import WordPressForm, { FORM_PROVIDERS } from '../model/WordPressForm.js';
import WordPressPluginInstallation from '../model/WordPressPluginInstallation.js';
import { ValidationError } from '../../../utils/ErrorUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import { isSensitiveField } from '../utils/sensitiveFieldFilter.js';

/**
 * WordPress Form Service — sync + list only. No submission capture, no
 * lead creation (Phase 3B). Structure only: field NAME and TYPE, never a
 * submitted VALUE — the sync payload this accepts has no field for values
 * at all (see wordPressPluginValidator.js), and this file filters
 * sensitive-*named* fields server-side too, even though the plugin already
 * filters them (class-odito-forms.php) — never trust a client-supplied
 * payload as the only line of defense.
 */

const MAX_FORMS_PER_SYNC = 200;
const MAX_FIELDS_PER_FORM = 100;

function normalizeFields(rawFields) {
  if (!Array.isArray(rawFields)) return [];
  return rawFields
    .filter((f) => f && typeof f.name === 'string' && f.name.trim())
    .filter((f) => !isSensitiveField(f.name))
    .slice(0, MAX_FIELDS_PER_FORM)
    .map((f) => ({
      name: f.name.trim().slice(0, 200),
      type: (typeof f.type === 'string' ? f.type.trim() : 'text').slice(0, 50) || 'text',
    }));
}

/**
 * Upserts the plugin's normalized form list for a project, idempotently.
 * Repeated sync of the same forms updates in place (unique key
 * {project_id, provider, external_id}); forms no longer reported are
 * marked inactive, not deleted, so history survives a form being
 * temporarily removed.
 */
async function syncForms(installation, forms) {
  if (!Array.isArray(forms)) {
    throw new ValidationError('forms must be an array');
  }
  if (forms.length > MAX_FORMS_PER_SYNC) {
    throw new ValidationError(`Cannot sync more than ${MAX_FORMS_PER_SYNC} forms in one request`);
  }

  const projectId = installation.project_id;
  const seenIds = [];

  for (const raw of forms) {
    if (!raw || typeof raw.externalId !== 'string' || !raw.externalId.trim()) continue;
    if (!FORM_PROVIDERS.includes(raw.provider)) continue;

    const doc = await WordPressForm.findOneAndUpdate(
      { project_id: projectId, provider: raw.provider, external_id: raw.externalId.trim().slice(0, 200) },
      {
        $set: {
          wordpress_plugin_installation_id: installation._id,
          name: typeof raw.name === 'string' ? raw.name.trim().slice(0, 200) : null,
          page_url: typeof raw.pageUrl === 'string' ? raw.pageUrl.trim().slice(0, 2000) : null,
          fields: normalizeFields(raw.fields),
          is_active: true,
          last_seen_at: new Date(),
        },
      },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
    );
    seenIds.push(doc._id);
  }

  const deactivateResult = await WordPressForm.updateMany(
    { project_id: projectId, is_active: true, _id: { $nin: seenIds } },
    { $set: { is_active: false } }
  );

  await WordPressPluginInstallation.updateOne(
    { _id: installation._id },
    { $set: { last_form_sync_at: new Date() } }
  );

  LoggerUtil.service('WordPressPlugin', 'form_sync', 'completed', {
    projectId: String(projectId),
    pluginId: installation.plugin_id,
    formsSynced: seenIds.length,
    formsDeactivated: deactivateResult.modifiedCount,
  });

  return { formsSynced: seenIds.length, formsDeactivated: deactivateResult.modifiedCount };
}

/** Active forms for the dashboard's "detected forms" list. */
async function getForms(projectId) {
  return WordPressForm.find({ project_id: projectId, is_active: true })
    .sort({ last_seen_at: -1 })
    .select('-wordpress_plugin_installation_id -__v')
    .lean();
}

export default {
  syncForms,
  getForms,
  isSensitiveField,
};
