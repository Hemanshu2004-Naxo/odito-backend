import mongoose from 'mongoose';
import CustomPlanRequest from '../model/CustomPlanRequest.js';
import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

// Kept in sync with CustomPlanRequest.js's status enum by hand — same
// convention adminSubscriptionController.js already uses for
// SUBSCRIPTION_STATUSES.
const REQUEST_STATUSES = ['pending', 'contacted', 'closed'];

async function loadTargetRequest(id, res) {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400).json(ResponseUtil.error('Invalid request id', 400));
    return null;
  }
  const request = await CustomPlanRequest.findById(id);
  if (!request) {
    res.status(404).json(ResponseUtil.error('Custom plan request not found', 404));
    return null;
  }
  return request;
}

/**
 * POST /subscription/admin/custom-plan-requests/:id/status
 * Body: { status }
 *
 * No transition guard (pending must go through contacted before closed,
 * etc.) — same "flexible override tool, not a strict state machine"
 * philosophy adminUpdateStatus already uses for subscription.status; a
 * sales rep closing a request directly from 'pending' (e.g. spam, dead
 * lead) is a completely normal, valid action here. Every change is
 * recorded in statusHistory (fromStatus/toStatus/changedBy/changedAt) —
 * this collection's own equivalent of SystemAdminAuditLog, since that model's
 * targetUser field can't reference a CustomPlanRequest (see the model
 * file's comment).
 */
export const updateCustomPlanRequestStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!status || !REQUEST_STATUSES.includes(status)) {
      return res.status(400).json(ResponseUtil.error(`status must be one of: ${REQUEST_STATUSES.join(', ')}`, 400));
    }

    const request = await loadTargetRequest(id, res);
    if (!request) return;

    const fromStatus = request.status;
    if (fromStatus === status) {
      return res.status(200).json(ResponseUtil.success({ changed: false, status }, `Already ${status}`));
    }

    request.status = status;
    request.statusHistory.push({
      fromStatus,
      toStatus: status,
      changedBy: req.user._id,
      changedAt: new Date(),
    });
    await request.save();

    LoggerUtil.info('System Admin updated custom plan request status', {
      adminId: req.user._id, requestId: request._id, fromStatus, toStatus: status,
    });

    return res.status(200).json(ResponseUtil.success({ changed: true, status }, 'Status updated'));
  } catch (error) {
    LoggerUtil.error('Error in updateCustomPlanRequestStatus', error, { adminId: req.user?._id, requestId: req.params?.id });
    return res.status(500).json(ResponseUtil.error('Failed to update status', 500));
  }
};

/**
 * POST /subscription/admin/custom-plan-requests/:id/notes
 * Body: { note }
 *
 * Internal-only — never exposed to the customer-facing GET
 * /custom-request/me endpoint (confirmed: that endpoint's serializer
 * doesn't include adminNotes at all, see subscriptionController.js's
 * serializeCustomPlanRequest).
 */
export const addCustomPlanRequestNote = async (req, res) => {
  try {
    const { id } = req.params;
    const { note } = req.body;

    if (!note || typeof note !== 'string' || note.trim().length === 0) {
      return res.status(400).json(ResponseUtil.error('note is required', 400));
    }
    const trimmedNote = note.trim();
    if (trimmedNote.length > 2000) {
      return res.status(400).json(ResponseUtil.error('note cannot exceed 2000 characters', 400));
    }

    const request = await loadTargetRequest(id, res);
    if (!request) return;

    request.adminNotes.push({
      note: trimmedNote,
      addedBy: req.user._id,
      addedAt: new Date(),
    });
    await request.save();

    LoggerUtil.info('System Admin added custom plan request note', { adminId: req.user._id, requestId: request._id });

    return res.status(201).json(ResponseUtil.success({ added: true }, 'Note added'));
  } catch (error) {
    LoggerUtil.error('Error in addCustomPlanRequestNote', error, { adminId: req.user?._id, requestId: req.params?.id });
    return res.status(500).json(ResponseUtil.error('Failed to add note', 500));
  }
};
