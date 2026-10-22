import { validateCreateRequestInput } from '../validator/auditIqRequestValidation.js';
import {
  createServiceRequest,
  getLatestRequestsByType,
  getMaintenanceAvailability,
  getStrategyCallAvailability,
  serializeRequest,
} from '../service/auditIqRequestService.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * Both handlers run AFTER auth + validateProjectAccess(): `req.user` is the
 * authenticated user and `req.project` is a project that user owns. Neither is
 * ever read from the request body.
 */

/**
 * GET /auditiq/service-requests?projectId=&issueKey=
 * The newest request of each type for this issue, plus what the non-request
 * actions (maintenance, strategy call) can currently do.
 */
export async function getIssueServiceState(req, res) {
  try {
    const issueKey = typeof req.query.issueKey === 'string' ? req.query.issueKey.trim() : '';
    if (!issueKey || issueKey.length > 200) {
      return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', field: 'issueKey', message: 'issueKey is required' });
    }

    const requests = await getLatestRequestsByType(req.project._id, issueKey);
    return res.status(200).json({
      success: true,
      data: {
        requests,
        services: {
          maintenance: getMaintenanceAvailability(),
          strategyCall: getStrategyCallAvailability(),
        },
      },
    });
  } catch (error) {
    LoggerUtil.error('AuditIQ: failed to load service state', error, { userId: req.user?._id, projectId: req.project?._id });
    return res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'Could not load your requests. Please try again.' });
  }
}

/** POST /auditiq/service-requests */
export async function createIssueServiceRequest(req, res) {
  let input;
  try {
    input = validateCreateRequestInput(req.body);
  } catch (validationError) {
    return res.status(400).json({
      success: false,
      code: validationError.code || 'VALIDATION_ERROR',
      field: validationError.field,
      message: validationError.message,
    });
  }

  try {
    const request = await createServiceRequest({ user: req.user, project: req.project, input });
    return res.status(201).json({
      success: true,
      message: 'Request submitted',
      data: serializeRequest(request),
    });
  } catch (error) {
    if (error.code === 'DUPLICATE_OPEN_REQUEST') {
      return res.status(409).json({
        success: false,
        code: 'DUPLICATE_OPEN_REQUEST',
        message: error.message,
        data: error.existing,
      });
    }
    LoggerUtil.error('AuditIQ: failed to create service request', error, { userId: req.user?._id, projectId: req.project?._id });
    return res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'Could not submit your request. Please try again.' });
  }
}
