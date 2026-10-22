import { validationResult } from 'express-validator';
import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { AuthUtil } from '../../../utils/AuthUtil.js';
import leadService from '../service/leadService.js';

/**
 * Translates a thrown error (typed ErrorUtil errors, or AuthUtil's plain
 * Error-with-.type/.statusCode) into the matching HTTP response — mirrors
 * taskAuthz.js's assertTaskOwnership catch block and
 * AuthMiddleware.validateProjectAccess()'s own error handling, so this
 * module's error shape stays consistent with the rest of the API.
 */
function handleError(res, error, fallbackMessage) {
  if (error.type === 'NOT_FOUND') {
    return res.status(404).json(ResponseUtil.notFound(error.message));
  }
  if (error.type === 'ACCESS_DENIED') {
    return res.status(403).json(ResponseUtil.accessDenied(error.message));
  }
  if (error.type === 'VALIDATION_ERROR') {
    return res.status(400).json(ResponseUtil.validationError(error.details, error.message));
  }
  console.error(`[LEAD] ${fallbackMessage}:`, error.message, error.stack);
  return res.status(error.statusCode || 500).json(
    ResponseUtil.error(error.message || fallbackMessage, error.statusCode || 500)
  );
}

/**
 * For :id-only routes (no projectId anywhere on the request), ownership can
 * only be resolved after the lead is loaded, from its own projectId — same
 * pattern as tasks/controller/taskAuthz.js's assertTaskOwnership. Writes the
 * response itself (404/403/500) and returns false on denial; callers must
 * `return` immediately when this returns false.
 */
async function assertLeadOwnership(req, res, lead) {
  try {
    await AuthUtil.validateProjectAccess(req.user._id, lead.projectId);
    return true;
  } catch (error) {
    handleError(res, error, 'Access check failed');
    return false;
  }
}

function firstValidationError(req, res) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return null;
  return res.status(400).json(ResponseUtil.validationError(errors.array(), errors.array()[0].msg));
}

// POST /api/leads
// projectId travels in the body — ownership already validated by
// validateProjectAccess() middleware before this handler runs.
export async function createLead(req, res) {
  try {
    if (firstValidationError(req, res)) return;

    const lead = await leadService.createLead({
      projectId: req.body.projectId,
      userId: req.user._id,
      payload: req.body,
    });

    return res.status(201).json(ResponseUtil.created(lead, 'Lead created successfully'));
  } catch (error) {
    return handleError(res, error, 'Failed to create lead');
  }
}

// GET /api/leads?projectId=&status=&priority=&search=&page=&limit=&sort=&sortOrder=
// projectId travels in the query — ownership already validated by
// validateProjectAccess() middleware before this handler runs.
export async function getLeads(req, res) {
  try {
    if (firstValidationError(req, res)) return;

    const { projectId, status, priority, search, page, limit, sort, sortOrder } = req.query;
    const { leads, pagination } = await leadService.getLeads(projectId, {
      status, priority, search, page, limit, sort, sortOrder,
    });

    return res.status(200).json({
      success: true,
      message: 'Leads retrieved successfully',
      data: leads,
      pagination,
    });
  } catch (error) {
    return handleError(res, error, 'Failed to fetch leads');
  }
}

// GET /api/leads/stats?projectId=
// projectId travels in the query — ownership already validated by
// validateProjectAccess() middleware before this handler runs.
export async function getLeadStats(req, res) {
  try {
    if (firstValidationError(req, res)) return;

    const stats = await leadService.getLeadStats(req.query.projectId);
    return res.status(200).json(ResponseUtil.success(stats, 'Lead stats retrieved successfully'));
  } catch (error) {
    return handleError(res, error, 'Failed to fetch lead stats');
  }
}

// GET /api/leads/:id
export async function getLeadById(req, res) {
  try {
    const lead = await leadService.getLeadById(req.params.id);
    if (!(await assertLeadOwnership(req, res, lead))) return;

    return res.status(200).json(ResponseUtil.success(lead, 'Lead retrieved successfully'));
  } catch (error) {
    return handleError(res, error, 'Failed to fetch lead');
  }
}

// PATCH /api/leads/:id
export async function updateLead(req, res) {
  try {
    if (firstValidationError(req, res)) return;

    const existing = await leadService.getLeadById(req.params.id);
    if (!(await assertLeadOwnership(req, res, existing))) return;

    const { note, ...updates } = req.body;
    const lead = await leadService.updateLead(req.params.id, {
      updates,
      note,
      userId: req.user._id,
    });

    return res.status(200).json(ResponseUtil.updated(lead, 'Lead updated successfully'));
  } catch (error) {
    return handleError(res, error, 'Failed to update lead');
  }
}

// DELETE /api/leads/:id
export async function deleteLead(req, res) {
  try {
    const existing = await leadService.getLeadById(req.params.id);
    if (!(await assertLeadOwnership(req, res, existing))) return;

    await leadService.deleteLead(req.params.id);
    return res.status(200).json(ResponseUtil.deleted('Lead deleted successfully'));
  } catch (error) {
    return handleError(res, error, 'Failed to delete lead');
  }
}
