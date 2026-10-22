import CustomPlanRequest from '../model/CustomPlanRequest.js';
import { sendMail } from '../../mail/services/mailService.js';
import { MAIL_TYPES } from '../../mail/constants/emailTypes.js';
import { getEnvVar } from '../../../config/env.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

// Same CORS_ORIGIN-as-frontend-URL idiom already used by
// subscriptionWebhookService.js's MANAGE_SUBSCRIPTION_URL.
const FRONTEND_URL = getEnvVar('CORS_ORIGIN');
const MANAGE_SUBSCRIPTION_URL = `${FRONTEND_URL}/settings/subscription`;

// Statuses that mean "this user already has an open request a sales rep is
// (or should be) working" — a second submission while one of these is open
// would just create a duplicate lead for the same conversation. 'closed'
// deliberately does NOT block a new submission (see model file comment).
const OPEN_STATUSES = ['pending', 'contacted'];

/**
 * @param {string} userId
 * @returns {Promise<object|null>} the user's most recent CustomPlanRequest, or null
 */
export async function getLatestCustomPlanRequest(userId) {
  return CustomPlanRequest.findOne({ userId }).sort({ createdAt: -1 }).lean();
}

/**
 * Creates a new Custom Plan request, then best-effort sends the customer
 * confirmation + admin notification emails. Email failures are logged but
 * NEVER thrown — the request is already durably stored by the time either
 * send is attempted, and a flaky mail provider must never make a real lead
 * look like it failed to submit (see sendMail()'s own never-throws design).
 *
 * @param {string} userId
 * @param {object} validatedPayload - output of validateCustomPlanRequestInput()
 * @param {{firstName?: string}} userDisplay - for the email greeting only
 * @returns {Promise<object>} the created CustomPlanRequest document (lean)
 * @throws {Error} .code === 'DUPLICATE_OPEN_REQUEST' if the user already has
 *   a pending/contacted request
 */
export async function submitCustomPlanRequest(userId, validatedPayload, userDisplay = {}) {
  const existing = await getLatestCustomPlanRequest(userId);
  if (existing && OPEN_STATUSES.includes(existing.status)) {
    const error = new Error(
      `You already have a ${existing.status} custom plan request. Our team will be in touch — no need to submit another.`
    );
    error.code = 'DUPLICATE_OPEN_REQUEST';
    throw error;
  }

  const created = await CustomPlanRequest.create({ userId, ...validatedPayload });
  const request = created.toObject();

  LoggerUtil.info('Custom plan request submitted', { userId, requestId: request._id, companyName: request.companyName });

  await sendCustomPlanRequestEmails(request, userDisplay);

  return request;
}

async function sendCustomPlanRequestEmails(request, userDisplay) {
  try {
    const sent = await sendMail(MAIL_TYPES.CUSTOM_PLAN_REQUEST_RECEIVED, request.contactEmail, {
      firstName: userDisplay.firstName || request.contactName,
      companyName: request.companyName,
      teamSize: request.teamSize,
      projectCount: request.projectCount,
      manageUrl: MANAGE_SUBSCRIPTION_URL,
    });
    if (!sent) {
      LoggerUtil.warn('Custom plan request: customer confirmation email did not send (request still stored)', { requestId: request._id });
    }
  } catch (error) {
    // sendMail() already never throws (it catches internally) — this
    // try/catch is a second layer of defense in depth, matching the
    // explicit "email failures must never block the request" requirement.
    LoggerUtil.error('Custom plan request: unexpected error sending customer email (request still stored)', error, { requestId: request._id });
  }

  const adminEmail = process.env.SALES_NOTIFICATION_EMAIL;
  if (!adminEmail) {
    LoggerUtil.warn('Custom plan request: SALES_NOTIFICATION_EMAIL not configured, admin notification skipped', { requestId: request._id });
    return;
  }

  try {
    const sent = await sendMail(MAIL_TYPES.CUSTOM_PLAN_REQUEST_ADMIN_NOTIFICATION, adminEmail, {
      companyName: request.companyName,
      companyWebsite: request.companyWebsite,
      contactName: request.contactName,
      contactEmail: request.contactEmail,
      contactPhone: request.contactPhone,
      teamSize: request.teamSize,
      projectCount: request.projectCount,
      requiredCredits: request.requiredCredits,
      requiredPages: request.requiredPages,
      featureRequirements: request.featureRequirements,
      budgetRange: request.budgetRange,
      timeline: request.timeline,
      additionalRequirements: request.additionalRequirements,
    });
    if (!sent) {
      LoggerUtil.warn('Custom plan request: admin notification email did not send (request still stored)', { requestId: request._id });
    }
  } catch (error) {
    LoggerUtil.error('Custom plan request: unexpected error sending admin email (request still stored)', error, { requestId: request._id });
  }
}
