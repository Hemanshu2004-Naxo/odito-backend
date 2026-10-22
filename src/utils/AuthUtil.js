import SeoProject from '../modules/app_user/model/SeoProject.js';

/**
 * Authentication Utility - AUTH ONLY
 * Single responsibility: Project access validation
 */
export class AuthUtil {
  
  /**
   * Validate project ownership - AUTH ONLY
   * @param {string} userId - User ID
   * @param {string} projectId - Project ID
   * @returns {Promise<Object>} Project object
   * @throws {NotFoundError} When project not found
   * @throws {AccessDeniedError} When user doesn't own project
   */
  static async validateProjectAccess(userId, projectId) {
    if (!userId || !projectId) {
      const error = new Error('User ID and Project ID are required');
      error.statusCode = 400;
      error.type = 'VALIDATION_ERROR';
      throw error;
    }

    // Soft-deleted (trashed) projects must behave as if they don't exist for
    // every route that goes through this shared check — this is the single
    // choke point ~25 project-scoped routes already run through, so fixing
    // it here covers all of them (dashboard, overview, issues, technical
    // checks, etc.) without touching each controller individually.
    const project = await SeoProject.findOne({ _id: projectId, is_deleted: { $ne: true } });

    if (!project) {
      const error = new Error('Project not found');
      error.statusCode = 404;
      error.type = 'NOT_FOUND';
      throw error;
    }

    if (project.user_id.toString() !== userId.toString()) {
      const error = new Error('Access denied');
      error.statusCode = 403;
      error.type = 'ACCESS_DENIED';
      throw error;
    }

    return project;
  }

  /**
   * Determine user landing page based on project existence
   * @param {string} userId - User ID
   * @returns {Promise<Object>} { hasProjects, redirectTo }
   */
  static async determineUserLandingPage(userId) {
    if (!userId) {
      return {
        hasProjects: false,
        redirectTo: '/onboarding'
      };
    }

    try {
      const projectCount = await SeoProject.countDocuments({ user_id: userId });
      const hasProjects = projectCount > 0;
      return {
        hasProjects,
        redirectTo: hasProjects ? '/dashboard' : '/onboarding'
      };
    } catch (error) {
      console.error('Error determining landing page:', error);
      return {
        hasProjects: false,
        redirectTo: '/onboarding'
      };
    }
  }
}

