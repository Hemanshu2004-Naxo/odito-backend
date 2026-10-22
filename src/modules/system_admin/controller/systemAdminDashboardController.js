import { getDashboardStats } from '../service/systemAdminDashboardService.js';
import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * GET /api/system-admin/dashboard
 * Aggregate stats only — no CRUD, no per-record data. Route is protected by
 * auth + requireSystemAdmin() (see routes/systemAdminRoutes.js), so req.user
 * is never read here; there is nothing user-scoped about this response.
 */
const getDashboard = async (req, res) => {
  try {
    const stats = await getDashboardStats();
    return res.status(200).json(ResponseUtil.success(stats));
  } catch (error) {
    LoggerUtil.error('System Admin dashboard aggregation failed', error, {
      endpoint: req.path,
    });
    return res.status(500).json(ResponseUtil.error('Failed to load dashboard statistics', 500));
  }
};

export { getDashboard };
