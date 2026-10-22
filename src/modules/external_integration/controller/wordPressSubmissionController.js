import { validationResult } from 'express-validator';
import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import wordPressSubmissionService from '../service/wordPressSubmissionService.js';

/**
 * Every error this endpoint returns carries a stable `code` (Section 31,
 * Phase 3C) so the plugin can decide retry-or-not by field, not by parsing
 * message text — see class-odito-cf7-capture.php's send_with_fallback(),
 * which branches on HTTP status the same way this file documents (4xx
 * except 429 = permanent, never queued; 401/429/5xx = temporary, queued).
 */
function handleError(res, error, fallbackMessage) {
  if (error.type === 'NOT_FOUND') {
    return res.status(404).json(ResponseUtil.notFound(error.message));
  }
  if (error.type === 'ACCESS_DENIED') {
    return res.status(403).json(ResponseUtil.accessDenied(error.message));
  }
  if (error.type === 'VALIDATION_ERROR') {
    // 400 — permanent validation error (Section 30): the plugin must NOT
    // retry this. error.details carries a machine-readable code (e.g.
    // FORM_NOT_REGISTERED, FORM_NOT_ACTIVE) for the plugin/queue to branch on.
    return res.status(400).json({ success: false, message: error.message, code: error.details?.code || 'INVALID_PAYLOAD', errors: error.details });
  }
  console.error(`[WORDPRESS_SUBMISSION] ${fallbackMessage}:`, error.message, error.stack);
  return res.status(error.statusCode || 500).json(
    { success: false, message: error.message || fallbackMessage, code: 'TEMPORARY_FAILURE' }
  );
}

// POST /api/wordpress/plugin/submissions
// Plugin-credential-authenticated (pluginAuth middleware) — never JWT.
export async function submitForm(req, res) {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      // Malformed payload is a permanent error (Section 30) — 400, no retry.
      return res.status(400).json({ success: false, message: errors.array()[0].msg, code: 'INVALID_PAYLOAD', errors: errors.array() });
    }

    const { eventId, form, submission, context } = req.body;
    const result = await wordPressSubmissionService.captureSubmission(req.pluginInstallation, {
      eventId,
      form,
      submission,
      context: context || {},
    });

    // Only ids ever leave this endpoint — never the lead document itself
    // (Section 29): no name/email/phone/message, no Mongo ownership
    // metadata beyond the two ids the plugin needs to stop retrying.
    return res.status(result.duplicate ? 200 : 201).json({
      success: true,
      accepted: true,
      duplicate: result.duplicate,
      eventId,
      leadId: result.leadId,
    });
  } catch (error) {
    return handleError(res, error, 'Failed to process form submission');
  }
}
