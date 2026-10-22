import SeoProject from '../../app_user/model/SeoProject.js';
import User from '../../user/model/User.js';
import { sendMail } from '../../mail/services/mailService.js';
import { MAIL_TYPES } from '../../mail/constants/emailTypes.js';
import { getEnvVar } from '../../../config/env.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * WordPress Lead Notification Service — the first real notification
 * capability for Lead Capture (Phase 3C). Uses the existing Resend-backed
 * mailService.js exactly the way jobCompletionHandler.js already does for
 * AUDIT_COMPLETED — no second email provider, no new send path.
 *
 * Deliberately best-effort: notifyNewLead() never throws, and
 * wordPressSubmissionService.js calls it WITHOUT awaiting (fire-and-forget,
 * caught) — Lead creation and the plugin's HTTP response must never wait
 * on, or fail because of, an email round-trip (Section 24).
 */

/**
 * Builds the exact, minimal set of fields the email template is allowed to
 * see — never the raw Lead Mongoose document. Deliberately excludes
 * anything not meant for an email: _id, isDeleted, notes, assignedTo,
 * createdBy/updatedBy, utm*, externalEventId, __v, timestamps other than
 * createdAt. This is the one place that decides "what a lead notification
 * email is allowed to contain."
 */
export function buildLeadNotificationPayload(lead, { projectName, dashboardUrl, firstName } = {}) {
  return {
    firstName: firstName || null,
    projectName: projectName || null,
    name: lead.name || null,
    email: lead.email || null,
    phone: lead.phone || null,
    company: lead.company || null,
    message: lead.message || null,
    formName: lead.formName || null,
    pageUrl: lead.pageUrl || null,
    receivedAt: lead.createdAt ? new Date(lead.createdAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : null,
    dashboardUrl,
  };
}

/**
 * Notifies the project owner that a new WordPress lead was captured.
 * Called only for the winning creation (never for a duplicate=true retry —
 * see wordPressSubmissionService.js, which checks this before calling).
 * Resolves the recipient the same way jobCompletionHandler.js resolves the
 * AUDIT_COMPLETED recipient: SeoProject.user_id -> User.email.
 */
export async function notifyNewLead(lead, projectId) {
  try {
    const project = await SeoProject.findById(projectId).select('project_name user_id').lean();
    if (!project) {
      LoggerUtil.warn('WordPressNotification: project not found, skipping notification', { projectId: String(projectId) });
      return false;
    }

    const user = await User.findById(project.user_id).select('email firstName').lean();
    if (!user || !user.email) {
      LoggerUtil.warn('WordPressNotification: project owner not found, skipping notification', { projectId: String(projectId) });
      return false;
    }

    const frontendUrl = getEnvVar('CORS_ORIGIN');
    const dashboardUrl = `${frontendUrl}/app/leads?project=${project._id}`;

    const payload = buildLeadNotificationPayload(lead, {
      projectName: project.project_name,
      dashboardUrl,
      firstName: user.firstName,
    });

    const sent = await sendMail(MAIL_TYPES.NEW_WORDPRESS_LEAD, user.email, payload);

    LoggerUtil.service('WordPressNotification', 'new_lead_email', sent ? 'completed' : 'failed', {
      projectId: String(projectId),
      leadId: String(lead._id),
    });

    return sent;
  } catch (error) {
    // Never propagate — a notification failure must never affect lead
    // creation or the plugin's HTTP response, both of which have already
    // completed by the time this runs (see the fire-and-forget call site).
    LoggerUtil.error('WordPressNotification: failed to send new lead email', error, {
      projectId: String(projectId),
      leadId: String(lead?._id),
    });
    return false;
  }
}

export default { notifyNewLead, buildLeadNotificationPayload };
