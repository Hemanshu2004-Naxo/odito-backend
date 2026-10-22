import { getAccessibilityIssues as getAccessibilityIssuesService } from '../../../services/accessibilityIssuesService.js';

/**
 * Get accessibility issues from seo_page_issues collection
 * Uses the same aggregation logic as On-Page issues
 */
export async function getAccessibilityIssues({ projectId, seo_jobId, severity }) {
  try {
    // For now, we only support projectId filter (same as On-Page)
    // Additional filters (seo_jobId, severity) can be added later if needed
    if (!projectId) {
      throw new Error('projectId is required');
    }

    // Use the service to get grouped and aggregated issues
    const result = await getAccessibilityIssuesService(projectId);

    return result;

  } catch (error) {
    console.error('[Accessibility Controller] Error:', error);
    throw error;
  }
}
