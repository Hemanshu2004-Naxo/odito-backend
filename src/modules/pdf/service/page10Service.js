/**
 * Page 10 Service - Technical SEO Health
 * Handles technical checks data from existing API
 */

import mongoose from 'mongoose';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import { TechnicalChecksService } from '../../app_user/service/technicalChecks.service.js';

export class Page10Service {
  
  /**
   * Get technical SEO health data for Page 10
   * @param {string} projectId - Project ID
   * @returns {Object} Technical SEO health analysis
   */
  static async getPage10Data(projectId) {
    const startTime = Date.now();
    
    try {
      LoggerUtil.info('Page 10 data generation started', { projectId });
      
      if (!projectId) {
        throw new Error('Project ID is required');
      }
      
      // Create a minimal project object for the service
      const project = { _id: projectId, user_id: null };
      
      console.log('[PAGE10] Calling TechnicalChecksService with project:', {
        projectId,
        projectKeys: Object.keys(project),
        has_id: !!project._id,
        has_user_id: !!project.user_id
      });
      
      // Get technical checks data from existing service
      const technicalChecksResult = await TechnicalChecksService.getTechnicalChecks(project);
      
      console.log('[PAGE10] TechnicalChecksService result:', {
        success: technicalChecksResult.success,
        hasData: !!technicalChecksResult.data,
        checksCount: technicalChecksResult.data?.checks?.length
      });
      
      if (!technicalChecksResult.success) {
        throw new Error(`Technical checks service failed: ${technicalChecksResult.error?.message || 'Unknown error'}`);
      }
      
      if (!technicalChecksResult.data) {
        throw new Error('Technical checks service returned no data');
      }
      
      const { checks, summary } = technicalChecksResult.data;
      
      // Validate required data structure
      if (!Array.isArray(checks)) {
        throw new Error('Technical checks data is invalid: checks is not an array');
      }
      
      if (!summary || typeof summary !== 'object') {
        throw new Error('Technical checks data is invalid: summary is missing or invalid');
      }
      
      // Calculate tech health percentage
      const total = summary.passing + summary.warnings + summary.critical;
      const techHealth = total > 0 ? Math.round((summary.passing / total) * 100) : 0;
      
      // Map API status to UI status
      const mapStatus = (status) => {
        if (status === "OK") return "PASS";
        if (status === "Warning") return "WARN";
        if (status === "Critical") return "FAIL";
        return "UNKNOWN";
      };
      
      // Transform checks for UI consumption
      const transformedChecks = checks.map(check => ({
        name: check.name,
        status: mapStatus(check.status),
        detail: check.message,
        affected_pages: check.affected_pages
      }));
      
      const page10Data = {
        checks: transformedChecks,
        summary: {
          passing: summary.passing,
          warnings: summary.warnings,
          critical: summary.critical,
          techHealth
        },
        totalChecks: checks.length
      };
      
      const duration = Date.now() - startTime;
      LoggerUtil.info('Page 10 data generated successfully', { 
        projectId, 
        duration,
        totalChecks: checks.length,
        techHealth 
      });
      
      return page10Data;
      
    } catch (error) {
      const duration = Date.now() - startTime;
      LoggerUtil.error('Page 10 data generation failed', error, { projectId, duration });
      throw error;
    }
  }
}
