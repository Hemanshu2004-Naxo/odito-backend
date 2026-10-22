import mongoose from 'mongoose';
import * as systemAdminProjectService from '../service/systemAdminProjectService.js';
import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * GET /api/system-admin/projects
 */
const listProjects = async (req, res) => {
  try {
    const result = await systemAdminProjectService.listProjects(req.query);
    return res.status(200).json(ResponseUtil.success(result));
  } catch (error) {
    LoggerUtil.error('Error listing System Admin projects', error, { adminId: req.user?._id });
    return res.status(500).json(ResponseUtil.error('Failed to list projects', 500));
  }
};

/**
 * GET /api/system-admin/projects/summary
 */
const getProjectsSummary = async (req, res) => {
  try {
    const summary = await systemAdminProjectService.getProjectsSummary();
    return res.status(200).json(ResponseUtil.success(summary));
  } catch (error) {
    LoggerUtil.error('Error loading System Admin projects summary', error, { adminId: req.user?._id });
    return res.status(500).json(ResponseUtil.error('Failed to load projects summary', 500));
  }
};

/**
 * GET /api/system-admin/projects/:id
 */
const getProjectDetail = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json(ResponseUtil.error('Invalid project id', 400));
    }

    const detail = await systemAdminProjectService.getProjectDetail(id);
    if (!detail) {
      return res.status(404).json(ResponseUtil.error('Project not found', 404));
    }

    return res.status(200).json(ResponseUtil.success(detail));
  } catch (error) {
    LoggerUtil.error('Error loading System Admin project detail', error, { adminId: req.user?._id, projectId: req.params?.id });
    return res.status(500).json(ResponseUtil.error('Failed to load project', 500));
  }
};

/**
 * POST /api/system-admin/projects/:id/start-audit
 * Body: { reason? }
 */
const startAudit = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json(ResponseUtil.error('Invalid project id', 400));
    }

    const result = await systemAdminProjectService.startAuditForProject(id, req.user._id, reason);
    if (!result) {
      return res.status(404).json(ResponseUtil.error('Project not found', 404));
    }

    if (!result.success) {
      // startProjectAudit()'s own guards (already-running, access-denied,
      // not-found) — surfaced as-is, not reinterpreted.
      return res.status(409).json(ResponseUtil.error(result.message || 'Could not start audit', 409, { code: result.code }));
    }

    LoggerUtil.info('System Admin started project audit', { adminId: req.user._id, projectId: id });
    return res.status(200).json(ResponseUtil.success(result, 'Audit started'));
  } catch (error) {
    LoggerUtil.error('Error starting project audit', error, { adminId: req.user?._id, projectId: req.params?.id });
    return res.status(500).json(ResponseUtil.error('Failed to start audit', 500));
  }
};

/**
 * DELETE /api/system-admin/projects/:id
 * Body: { reason? }
 */
const deleteProject = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json(ResponseUtil.error('Invalid project id', 400));
    }

    // A reason is mandatory for this action — never trust the frontend's own
    // validation. Checked before any mutation or audit log write.
    if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
      return res.status(400).json(ResponseUtil.error('A reason is required to delete a project', 400));
    }

    const result = await systemAdminProjectService.deleteProjectSoft(id, req.user._id, reason.trim());
    if (!result) {
      return res.status(404).json(ResponseUtil.error('Project not found', 404));
    }

    if (result.blocked) {
      return res.status(409).json(ResponseUtil.error(
        'An audit is currently running for this project. Wait for it to finish before deleting.',
        409,
        { code: result.code }
      ));
    }

    LoggerUtil.info('System Admin soft-deleted project', { adminId: req.user._id, projectId: id });
    return res.status(200).json(ResponseUtil.success({ projectId: id }, 'Project moved to trash'));
  } catch (error) {
    LoggerUtil.error('Error deleting project', error, { adminId: req.user?._id, projectId: req.params?.id });
    return res.status(500).json(ResponseUtil.error('Failed to delete project', 500));
  }
};

/**
 * POST /api/system-admin/projects/:id/restore
 * Body: { reason? }
 */
const restoreProject = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json(ResponseUtil.error('Invalid project id', 400));
    }

    const result = await systemAdminProjectService.restoreProjectAdmin(id, req.user._id, reason);
    if (!result) {
      return res.status(404).json(ResponseUtil.error('Project not found', 404));
    }

    if (result.notDeleted) {
      return res.status(400).json(ResponseUtil.error('Project is not deleted', 400));
    }

    LoggerUtil.info('System Admin restored project', { adminId: req.user._id, projectId: id });
    return res.status(200).json(ResponseUtil.success(result, 'Project restored'));
  } catch (error) {
    LoggerUtil.error('Error restoring project', error, { adminId: req.user?._id, projectId: req.params?.id });
    return res.status(500).json(ResponseUtil.error('Failed to restore project', 500));
  }
};

/**
 * DELETE /api/system-admin/projects/:id/permanent
 * Body: { reason? }
 */
const permanentlyDeleteProject = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json(ResponseUtil.error('Invalid project id', 400));
    }

    const result = await systemAdminProjectService.permanentlyDeleteProjectAdmin(id, req.user._id, reason);
    if (!result) {
      return res.status(404).json(ResponseUtil.error('Project not found', 404));
    }

    if (result.notDeleted) {
      return res.status(400).json(ResponseUtil.error('Project must be in trash before it can be permanently deleted', 400));
    }

    LoggerUtil.info('System Admin permanently deleted project', { adminId: req.user._id, projectId: id });
    return res.status(200).json(ResponseUtil.success(result, 'Project permanently deleted'));
  } catch (error) {
    LoggerUtil.error('Error permanently deleting project', error, { adminId: req.user?._id, projectId: req.params?.id });
    return res.status(500).json(ResponseUtil.error('Failed to permanently delete project', 500));
  }
};

export {
  listProjects,
  getProjectsSummary,
  getProjectDetail,
  startAudit,
  deleteProject,
  restoreProject,
  permanentlyDeleteProject,
};
