import WordPressForm from '../model/WordPressForm.js';
import leadService from '../../lead/service/leadService.js';
import { normalizeSubmission } from './wordPressSubmissionNormalizer.js';
import { notifyNewLead } from './wordPressNotificationService.js';
import { ValidationError } from '../../../utils/ErrorUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * WordPress Submission Service
 *
 *   plugin-authenticated request (pluginAuth already resolved req.pluginInstallation)
 *     -> verify the submitted form was actually registered AND still
 *        active for THIS installation's project (Phase 3A form; Phase 3C
 *        added the is_active check — see assertFormIsRegistered)
 *     -> normalize (wordPressSubmissionNormalizer.js)
 *     -> leadService.createLeadIdempotent() — the single Lead creation
 *        path (Phase 1), never duplicated here
 *     -> only for the winning (non-duplicate) creation: best-effort
 *        real-time notify (Socket.IO) + best-effort email notify
 *        (wordPressNotificationService.js, Phase 3C) — neither is awaited,
 *        neither can affect the HTTP response
 *
 * Every log line here is deliberately PII-free — see logSafeEvent() below.
 * No function in this file ever logs a field name/value from the
 * submission itself, only ids (projectId, pluginId, eventId, formExternalId).
 */

function logSafeEvent(event, context = {}) {
  LoggerUtil.service('WordPressSubmission', event, 'completed', context);
}

/**
 * Confirms the submitted form was actually discovered/registered during a
 * Phase 3A sync for THIS installation's project — Option A from the spec:
 * reject an unknown form rather than silently auto-registering it, so an
 * attacker (or a buggy/compromised plugin) can't fabricate leads against
 * forms Odito never actually saw on the site.
 *
 * Phase 3C gap fix: this used to check existence only, not `is_active` —
 * a form that a LATER sync stopped reporting (removed from the page,
 * deactivated, etc. — see wordPressFormService.syncForms's reconciliation)
 * was still silently accepted for submissions indefinitely. Now rejected
 * with a distinct FORM_NOT_ACTIVE code (never seen vs. seen-then-removed
 * are different situations worth telling the plugin apart, even though
 * both currently result in "don't create a lead").
 */
async function assertFormIsRegistered(installation, form) {
  const registered = await WordPressForm.findOne({
    project_id: installation.project_id,
    wordpress_plugin_installation_id: installation._id,
    provider: form.provider,
    external_id: form.externalId,
  }).select('is_active').lean();

  if (!registered) {
    logSafeEvent('lead_submission_rejected', {
      projectId: String(installation.project_id),
      pluginId: installation.plugin_id,
      provider: form.provider,
      formExternalId: form.externalId,
      reason: 'form_not_registered',
    });
    throw new ValidationError(
      'This form has not been synced yet. Run a form sync from the WordPress plugin settings page first.',
      { code: 'FORM_NOT_REGISTERED' }
    );
  }

  if (registered.is_active === false) {
    logSafeEvent('lead_submission_rejected', {
      projectId: String(installation.project_id),
      pluginId: installation.plugin_id,
      provider: form.provider,
      formExternalId: form.externalId,
      reason: 'form_not_active',
    });
    throw new ValidationError(
      'This form is no longer active on your website. Run a form sync to refresh it if it still exists.',
      { code: 'FORM_NOT_ACTIVE' }
    );
  }
}

/**
 * @param {object} installation - req.pluginInstallation (the authenticated
 *   plugin — the ONLY source of project_id; never read from the payload)
 * @param {object} payload - { eventId, form, submission, context }
 */
async function captureSubmission(installation, payload) {
  const { eventId, form, submission, context } = payload;

  logSafeEvent('lead_submission_received', {
    projectId: String(installation.project_id),
    pluginId: installation.plugin_id,
    eventId,
    provider: form?.provider,
    formExternalId: form?.externalId,
  });

  await assertFormIsRegistered(installation, form);

  const leadPayload = normalizeSubmission({ form, submission, context });

  const { lead, duplicate } = await leadService.createLeadIdempotent({
    projectId: installation.project_id,
    externalEventId: eventId,
    payload: leadPayload,
  });

  logSafeEvent(duplicate ? 'lead_submission_duplicate' : 'lead_submission_created', {
    projectId: String(installation.project_id),
    pluginId: installation.plugin_id,
    eventId,
    provider: form?.provider,
    formExternalId: form?.externalId,
    leadId: String(lead._id),
  });

  if (!duplicate) {
    // Both are best-effort and deliberately NOT awaited — Section 24/25:
    // the plugin's HTTP response (and CF7's own mail flow, upstream of
    // this) must never wait on a socket emit or an email round-trip, and
    // neither must ever run for a duplicate=true retry (a network-timeout
    // retry of an already-created lead must not send a second email or a
    // second socket event — this `if (!duplicate)` gate is what
    // guarantees that, not anything inside notifyNewLead/notifyLeadCreated
    // themselves).
    notifyLeadCreated(installation.project_id, lead._id);
    notifyNewLead(lead, installation.project_id).catch(() => {
      // notifyNewLead already catches internally and never rejects, but
      // guarded here too so a future change to that function can never
      // turn into an unhandled promise rejection on this fire-and-forget path.
    });
  }

  return { leadId: String(lead._id), duplicate };
}

/**
 * Best-effort real-time notification — never lets a Socket.IO problem
 * affect the submission response (the lead is already safely persisted by
 * the time this runs). Deliberately sends only ids, never the lead's PII
 * (name/email/phone/message), matching Section 35's explicit instruction.
 */
function notifyLeadCreated(projectId, leadId) {
  try {
    if (global.io) {
      global.io.to(`project-${projectId}`).emit('lead:created', {
        projectId: String(projectId),
        leadId: String(leadId),
      });
    }
  } catch (error) {
    console.error('[WORDPRESS_SUBMISSION] Failed to emit lead:created:', error.message);
  }
}

export default { captureSubmission };
