import AuditIqServiceRequest, { REQUEST_TYPES, OPEN_STATUSES } from '../model/AuditIqServiceRequest.js';
import { sendMail } from '../../mail/services/mailService.js';
import { MAIL_TYPES } from '../../mail/constants/emailTypes.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * Monthly Maintenance is deliberately NOT offered: no maintenance product, Stripe
 * price or subscription exists in this codebase (config/plans.js defines only
 * Starter/Pro/Premium audit plans), so there is nothing to enroll a user in or
 * bill them for. This is reported to the UI as unavailable rather than pretending.
 * When a real service exists, this is the one place that should change.
 */
export function getMaintenanceAvailability() {
  return { available: false, reason: 'NOT_OFFERED' };
}

/**
 * Strategy-call booking: only a URL an operator configured (AUDITIQ_BOOKING_URL)
 * is ever returned — never a guessed one. It must be a plain https URL with no
 * embedded credentials; anything else is treated as "not configured".
 */
export function getStrategyCallAvailability(env = process.env) {
  const raw = (env.AUDITIQ_BOOKING_URL || '').trim();
  if (!raw) return { available: false, reason: 'NOT_CONFIGURED', url: null };
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
      LoggerUtil.warn('AUDITIQ_BOOKING_URL ignored: must be an https URL without credentials');
      return { available: false, reason: 'NOT_CONFIGURED', url: null };
    }
    return { available: true, reason: null, url: parsed.toString() };
  } catch {
    LoggerUtil.warn('AUDITIQ_BOOKING_URL ignored: not a valid URL');
    return { available: false, reason: 'NOT_CONFIGURED', url: null };
  }
}

/** Customer-facing shape. No userId, contact details, or internal flags. */
export function serializeRequest(doc) {
  if (!doc) return null;
  return {
    id: String(doc._id),
    requestType: doc.requestType,
    issueKey: doc.issueKey,
    issueTitle: doc.issueTitle,
    affectedPageCount: doc.affectedPageCount ?? null,
    pageUrl: doc.pageUrl || null,
    message: doc.message || null,
    status: doc.status,
    isOpen: !!doc.isOpen,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/**
 * The newest request of each type for one issue of one project (any status), so the
 * UI can show an open request, a completed one, or none.
 * @returns {Promise<Record<string, object|null>>}
 */
export async function getLatestRequestsByType(projectId, issueKey) {
  const docs = await AuditIqServiceRequest.find({ projectId, issueKey })
    .sort({ createdAt: -1 })
    .limit(30)
    .lean();
  const byType = Object.fromEntries(REQUEST_TYPES.map((t) => [t, null]));
  for (const doc of docs) {
    if (byType[doc.requestType] === null) byType[doc.requestType] = serializeRequest(doc);
  }
  return byType;
}

function duplicateError(existing) {
  const error = new Error('You already have an open request of this type for this issue.');
  error.code = 'DUPLICATE_OPEN_REQUEST';
  error.existing = serializeRequest(existing);
  return error;
}

async function notifyStaff(request) {
  const to = process.env.SALES_NOTIFICATION_EMAIL;
  if (!to) {
    LoggerUtil.warn('AuditIQ request: SALES_NOTIFICATION_EMAIL not configured, staff notification skipped', { requestId: request._id });
    return false;
  }
  try {
    const sent = await sendMail(MAIL_TYPES.AUDITIQ_REQUEST_ADMIN_NOTIFICATION, to, {
      requestId: String(request._id),
      requestType: request.requestType,
      issueTitle: request.issueTitle,
      issueKey: request.issueKey,
      issueCategory: request.issueCategory,
      affectedPageCount: request.affectedPageCount,
      pageUrl: request.pageUrl,
      projectName: request.projectName,
      projectUrl: request.projectUrl,
      contactName: request.contactName,
      contactEmail: request.contactEmail,
      message: request.message,
    });
    if (!sent) LoggerUtil.warn('AuditIQ request: staff notification email did not send (request still stored)', { requestId: request._id });
    return !!sent;
  } catch (error) {
    LoggerUtil.error('AuditIQ request: unexpected error sending staff email (request still stored)', error, { requestId: request._id });
    return false;
  }
}

/**
 * Stores a request, then best-effort notifies staff. Email failure never fails the
 * request — it is already durably stored — but is recorded in `staffNotified`.
 *
 * @param {{user: object, project: object, input: object}} p
 *   `user` and `project` come from the authenticated, access-checked request — never the body.
 * @throws {Error} .code === 'DUPLICATE_OPEN_REQUEST' (with .existing) when an open request of
 *   the same type already exists for this issue.
 */
export async function createServiceRequest({ user, project, input }) {
  const scope = { projectId: project._id, issueKey: input.issueKey, requestType: input.requestType, isOpen: true };

  const existing = await AuditIqServiceRequest.findOne(scope).lean();
  if (existing) throw duplicateError(existing);

  let created;
  try {
    created = await AuditIqServiceRequest.create({
      userId: user._id,
      projectId: project._id,
      requestType: input.requestType,
      issueKey: input.issueKey,
      issueTitle: input.issueTitle,
      issueCategory: input.issueCategory,
      affectedPageCount: input.affectedPageCount,
      pageUrl: input.pageUrl,
      projectName: project.project_name || '',
      projectUrl: project.main_url || '',
      message: input.message,
      contactEmail: user.email || '',
      contactName: [user.firstName, user.lastName].filter(Boolean).join(' '),
    });
  } catch (error) {
    // The partial unique index is the real guard: a concurrent request that slipped past the
    // pre-check above lands here instead of creating a second open request.
    if (error?.code === 11000) {
      const winner = await AuditIqServiceRequest.findOne(scope).lean();
      if (winner) throw duplicateError(winner);
    }
    throw error;
  }

  LoggerUtil.info('AuditIQ service request submitted', {
    requestId: created._id, projectId: project._id, userId: user._id, requestType: input.requestType,
  });

  const notified = await notifyStaff(created.toObject());
  if (notified) {
    await AuditIqServiceRequest.updateOne({ _id: created._id }, { $set: { staffNotified: true } });
    created.staffNotified = true;
  }

  return created.toObject();
}

export { OPEN_STATUSES };
