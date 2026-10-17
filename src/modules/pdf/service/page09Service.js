/**
 * Page 09 Service - Structured Data Analysis
 * Handles schema analysis data from seo_page_data collection
 */

import mongoose from 'mongoose';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

export class Page09Service {
  
  /**
   * Get structured data analysis for Page 09
   * @param {string} projectId - Project ID
   * @returns {Object} Structured data analysis
   */
  static async getPage09Data(projectId) {
    const startTime = Date.now();
    
    try {
      LoggerUtil.info('Page 09 data generation started', { projectId });
      
      if (!projectId) {
        throw new Error('Project ID is required');
      }
      
      const db = mongoose.connection.db;
      const { ObjectId } = mongoose.Types;
      const projectIdObj = new ObjectId(projectId);
      
      // Task 1: Basic Metrics
      const { withSchema, withoutSchema, coverage } = await this.getSchemaCoverage(db, projectIdObj);
      
      // Task 2: Detect schema coverage case
      const mode = withoutSchema === 0 ? 'distribution' : 'coverage';
      
      // Task 3: Get schema errors
      const errors = await this.getSchemaErrors(db, projectIdObj);
      
      // Task 4: Schema distribution (for 100% coverage case)
      let schemaTypes = [];
      if (mode === 'distribution') {
        schemaTypes = await this.getSchemaDistribution(db, projectIdObj);
      }
      
      // Task 6: Final response structure
      const page09Data = {
        withSchema,
        withoutSchema,
        coverage,
        errors,
        schemaTypes,
        mode
      };
      
      const totalTime = Date.now() - startTime;
      
      LoggerUtil.info('Page 09 data generation completed', {
        projectId,
        totalTime,
        mode,
        withSchema,
        withoutSchema,
        coverage,
        errorCount: errors,
        schemaTypesCount: schemaTypes.length
      });
      
      return {
        success: true,
        data: page09Data,
        metadata: {
          generatedAt: new Date(),
          generationTime: totalTime,
          projectId
        }
      };
      
    } catch (error) {
      LoggerUtil.error('Page 09 data generation failed', error, { projectId });
      
      return {
        success: false,
        error: {
          message: error.message,
          code: 'PAGE09_GENERATION_FAILED',
          details: process.env.NODE_ENV === 'development' ? error.stack : undefined
        }
      };
    }
  }
  
  /**
   * Task 1: Get basic schema coverage metrics
   */
  static async getSchemaCoverage(db, projectIdObj) {
    try {
      // Ensure database connection
      if (!db || !db.collection) {
        throw new Error('Database connection not available');
      }
      
      // Count total pages
      const totalPages = await db.collection('seo_page_data')
        .distinct('url', { projectId: projectIdObj });
      
      // Count pages with schema
      const withSchemaPages = await db.collection('seo_page_data')
        .distinct('url', { 
          projectId: projectIdObj,
          structured_data: { $exists: true, $ne: null, $ne: [] }
        });
      
      // Count pages without schema
      const withoutSchemaPages = await db.collection('seo_page_data')
        .distinct('url', { 
          projectId: projectIdObj,
          $or: [
            { structured_data: { $exists: false } },
            { structured_data: null },
            { structured_data: [] }
          ]
        });
      
      const withSchema = withSchemaPages.length;
      const withoutSchema = withoutSchemaPages.length;
      const coverage = totalPages.length > 0 ? Math.round((withSchema / totalPages.length) * 100) : 0;
      
      LoggerUtil.debug('Schema coverage calculated', {
        totalPages: totalPages.length,
        withSchema,
        withoutSchema,
        coverage
      });
      
      return { withSchema, withoutSchema, coverage };
      
    } catch (error) {
      LoggerUtil.error('Failed to get schema coverage', error);
      return { withSchema: 0, withoutSchema: 0, coverage: 0 };
    }
  }
  
  /**
   * Task 3: Get schema-related errors from seo_page_issues
   */
  static async getSchemaErrors(db, projectIdObj) {
    try {
      // Look for schema-related issues
      const schemaErrorPatterns = [
        'schema',
        'structured_data',
        'json_ld',
        'markup'
      ];
      
      const schemaErrors = await db.collection('seo_page_issues')
        .countDocuments({
          projectId: projectIdObj,
          status: { $ne: 'excluded' },
          $or: schemaErrorPatterns.map(pattern => ({
            issue_code: { $regex: pattern, $options: 'i' }
          }))
        });
      
      LoggerUtil.debug('Schema errors counted', { schemaErrors });
      return schemaErrors;
      
    } catch (error) {
      LoggerUtil.error('Failed to get schema errors', error);
      return 0;
    }
  }
  
  /**
   * Task 3: Schema distribution for 100% coverage case
   */
  static async getSchemaDistribution(db, projectIdObj) {
    try {
      console.log("PAGE09: Fetching schema distribution for projectId:", projectIdObj);
      
      const pipeline = [
        { $match: { projectId: projectIdObj } },
        { $unwind: '$structured_data' },
        {
          $group: {
            _id: '$structured_data.@type',
            count: { $sum: 1 },
            pages: { $addToSet: '$url' }
          }
        },
        {
          $project: {
            _id: 0,
            type: '$_id',
            count: 1,
            pages: { $size: '$pages' }
          }
        },
        { $sort: { count: -1 } }
      ];
      
      const schemaTypes = await db.collection('seo_page_data')
        .aggregate(pipeline).toArray();
      
      console.log("PAGE09: Found schema types:", schemaTypes.length);
      
      LoggerUtil.debug('Schema distribution calculated', { 
        count: schemaTypes.length,
        types: schemaTypes.map(t => `${t.type}: ${t.count}`) 
      });
      
      return schemaTypes;
      
    } catch (error) {
      LoggerUtil.error('Failed to get schema distribution', error);
      return [];
    }
  }
}
