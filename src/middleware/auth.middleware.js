import { AuthUtil } from '../utils/AuthUtil.js';
import { ResponseUtil } from '../utils/ResponseUtil.js';
import { LoggerUtil } from '../utils/LoggerUtil.js';

/**
 * Authentication Middleware
 * Centralized project access validation
 */
export class AuthMiddleware {
  
  /**
   * Validate project ownership middleware
   * Attaches project to request object
   */
  static validateProjectAccess() {
    return async (req, res, next) => {
      try {
        const userId = req.user?.id || req.userId;
        const projectId = req.params.id || req.params.projectId || req.body.projectId || req.query.projectId;

        if (!userId) {
          LoggerUtil.security('Missing user ID', null, {
            endpoint: req.path,
            method: req.method
          });
          return res.status(401).json(
            ResponseUtil.error('User authentication required', 401)
          );
        }

        if (!projectId) {
          LoggerUtil.security('Missing project ID', userId, {
            endpoint: req.path,
            method: req.method
          });
          return res.status(400).json(
            ResponseUtil.error('Project ID is required', 400)
          );
        }

        // Validate project access using AuthUtil
        const project = await AuthUtil.validateProjectAccess(userId, projectId);
        
        // Attach project to request for downstream use
        req.project = project;
        req.projectId = projectId;
        req.userId = userId;

        LoggerUtil.debug('Project access validated', {
          userId: userId,
          projectId: projectId,
          endpoint: req.path
        });

        next();
      } catch (error) {
        LoggerUtil.security('Project access denied', req.userId, {
          projectId: req.params.projectId,
          endpoint: req.path,
          error: error.message
        });

        // Handle specific error types
        if (error.type === 'NOT_FOUND') {
          return res.status(404).json(
            ResponseUtil.notFound(error.message)
          );
        }

        if (error.type === 'ACCESS_DENIED') {
          return res.status(403).json(
            ResponseUtil.accessDenied(error.message)
          );
        }

        // Handle other errors
        return res.status(error.statusCode || 500).json(
          ResponseUtil.error(error.message || 'Authentication failed', error.statusCode || 500)
        );
      }
    };
  }

  /**
   * Optional project access validation (doesn't fail if no project)
   */
  static optionalProjectAccess() {
    return async (req, res, next) => {
      try {
        const userId = req.user?.id || req.userId;
        const projectId = req.params.id || req.params.projectId || req.body.projectId || req.query.projectId;

        if (userId && projectId) {
          const project = await AuthUtil.validateProjectAccess(userId, projectId);
          req.project = project;
          req.projectId = projectId;
        }

        req.userId = userId;
        next();
      } catch (error) {
        LoggerUtil.warn('Optional project access failed', {
          userId: req.userId,
          projectId: req.params.projectId,
          endpoint: req.path,
          error: error.message
        });

        // For optional access, we don't fail the request
        req.userId = req.user?.id || req.userId;
        next();
      }
    };
  }

  /**
   * User authentication middleware (basic)
   */
  static requireAuth() {
    return (req, res, next) => {
      const userId = req.user?.id || req.userId;

      if (!userId) {
        LoggerUtil.security('Unauthenticated access attempt', null, {
          endpoint: req.path,
          method: req.method,
          ip: req.ip
        });

        return res.status(401).json(
          ResponseUtil.error('Authentication required', 401)
        );
      }

      req.userId = userId;
      next();
    };
  }

  /**
   * Admin access middleware.
   *
   * Checks the real User schema field (roleId, numeric 1-5 — see
   * modules/user/model/User.js) rather than a 'role' string field that does
   * not exist on the model. roleId <= 3 covers systemadmin/superadmin/admin;
   * 4 (agency admin) and 5 (regular user) are not admin-authorized.
   */
  static requireAdmin() {
    return (req, res, next) => {
      const userId = req.user?.id || req.user?._id || req.userId;
      const roleId = req.user?.roleId;

      if (!userId) {
        return res.status(401).json(
          ResponseUtil.error('Authentication required', 401)
        );
      }

      if (!roleId || roleId > 3) {
        LoggerUtil.security('Admin access denied', userId, {
          endpoint: req.path,
          method: req.method,
          roleId: roleId
        });

        return res.status(403).json(
          ResponseUtil.accessDenied('Admin access required')
        );
      }

      req.userId = userId;
      req.userRole = roleId;
      next();
    };
  }

  /**
   * System Admin access middleware.
   *
   * Narrower than requireAdmin(): the System Admin console is reserved for
   * roleId === 1 only (superadmin/admin/agency_admin/user are all rejected).
   * Fails closed — any missing/non-numeric/mismatched roleId is denied.
   * Reuses the same req.user populated by the existing auth middleware; does
   * not perform its own token verification or DB lookup.
   */
  static requireSystemAdmin() {
    return (req, res, next) => {
      const userId = req.user?.id || req.user?._id || req.userId;
      const roleId = req.user?.roleId;

      if (!userId) {
        return res.status(401).json(
          ResponseUtil.error('Authentication required', 401)
        );
      }

      if (roleId !== 1) {
        LoggerUtil.security('System Admin access denied', userId, {
          endpoint: req.path,
          method: req.method,
          roleId: roleId
        });

        return res.status(403).json(
          ResponseUtil.accessDenied('System Admin access required')
        );
      }

      req.userId = userId;
      req.userRole = roleId;
      next();
    };
  }
}

/**
 * Common auth middleware instances
 */
export const {
  validateProjectAccess,
  optionalProjectAccess,
  requireAuth,
  requireAdmin,
  requireSystemAdmin
} = AuthMiddleware;
