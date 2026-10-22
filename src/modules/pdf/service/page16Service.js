/**
 * Page 16 Service - Keyword Ranking Analysis
 * Provides keyword ranking insights from seo_rankings collection
 */

import mongoose from 'mongoose';

export class Page16Service {
  
  /**
   * Get Keyword Ranking Analysis for Page 16
   * @param {string} projectId - Project ID
   * @returns {Promise<Object>} - Keyword ranking analysis data
   */
  static async getKeywordRankingAnalysis(projectId) {
    console.log("🔍 PAGE16 SERVICE: Starting keyword ranking analysis");
    console.log("🔍 PAGE16 SERVICE: Project ID:", projectId);
    
    try {
      // Validate projectId
      if (!projectId || typeof projectId !== 'string') {
        console.error("❌ PAGE16 SERVICE: Invalid projectId format");
        throw new Error('INVALID_PROJECT_ID');
      }

      console.log("✅ PAGE16 SERVICE: Project ID validation passed");

      // Convert to ObjectId for MongoDB query
      const projectObjectId = new mongoose.Types.ObjectId(projectId);
      console.log("✅ PAGE16 SERVICE: Converted to ObjectId:", projectObjectId);

      // Get the latest ranking data for this project
      console.log("🔍 PAGE16 SERVICE: Querying seo_rankings collection...");
      const SeoRanking = mongoose.model('SeoRanking');
      const rankingData = await SeoRanking
        .findOne({ project_id: projectObjectId })
        .sort({ created_at: -1 })
        .lean();

      console.log("🔍 PAGE16 SERVICE: Raw DB query result:", {
        found: !!rankingData,
        hasKeywords: !!(rankingData && rankingData.keywords),
        keywordsCount: rankingData?.keywords?.length || 0,
        domain: rankingData?.domain,
        createdAt: rankingData?.created_at
      });

      // Handle case where no ranking data found
      if (!rankingData || !rankingData.keywords || rankingData.keywords.length === 0) {
        console.warn("⚠️ PAGE16 SERVICE: No keyword ranking data found");
        return {
          success: false,
          error: {
            message: 'No keyword ranking data found for this project. Please run keyword ranking analysis first.',
            code: 'NO_RANKING_DATA'
          }
        };
      }

      console.log("✅ PAGE16 SERVICE: Found ranking data, processing keywords...");

      const keywords = rankingData.keywords;
      
      // Calculate ranking metrics
      const totalKeywords = keywords.length;
      const rankingKeywords = keywords.filter(k => k.rank !== null && k.rank !== undefined).length;
      const notRankingKeywords = keywords.filter(k => k.rank === null || k.rank === undefined).length;
      
      const top3 = keywords.filter(k => k.rank !== null && k.rank <= 3).length;
      const top10 = keywords.filter(k => k.rank !== null && k.rank <= 10).length;
      const nearTop10 = keywords.filter(k => k.rank !== null && k.rank >= 11 && k.rank <= 25).length;

      console.log("🔍 PAGE16 SERVICE: Ranking metrics calculated:", {
        totalKeywords,
        rankingKeywords,
        notRankingKeywords,
        top3,
        top10,
        nearTop10
      });

      // Process keywords for display
      const processedKeywords = keywords.map(k => ({
        keyword: k.keyword,
        rank: k.rank,
        status: k.rank === null || k.rank === undefined ? "not_ranking" : "ranking"
      }));

      // Check if all keywords are not ranking
      const allNotRanking = notRankingKeywords === totalKeywords;

      console.log("🔍 PAGE16 SERVICE: Keyword processing complete:", {
        processedKeywordsCount: processedKeywords.length,
        allNotRanking,
        sampleTopRankings: processedKeywords.filter(k => k.rank <= 10).slice(0, 3),
        sampleOpportunities: processedKeywords.filter(k => k.rank >= 11 && k.rank <= 30).slice(0, 3)
      });

      const result = {
        success: true,
        data: {
          totalKeywords,
          rankingKeywords,
          notRankingKeywords,
          top3,
          top10,
          nearTop10,
          keywords: processedKeywords,
          allNotRanking,
          metadata: {
            domain: rankingData.domain,
            location: rankingData.location,
            lastUpdated: rankingData.created_at,
            generatedAt: new Date()
          }
        }
      };

      console.log("✅ PAGE16 SERVICE: Successfully processed keyword data:", {
        success: result.success,
        totalKeywords: result.data.totalKeywords,
        topRankings: result.data.top10,
        opportunities: result.data.nearTop10
      });

      return result;

    } catch (error) {
      console.error('❌ PAGE16 SERVICE ERROR:', error);
      console.error('❌ PAGE16 SERVICE ERROR DETAILS:', {
        message: error.message,
        stack: error.stack,
        projectId
      });

      // Handle specific error cases
      if (error.message === 'INVALID_PROJECT_ID') {
        return {
          success: false,
          error: {
            message: 'Invalid projectId format',
            code: 'INVALID_PROJECT_ID'
          }
        };
      }

      // Handle MongoDB connection errors
      if (error.name === 'MongooseServerSelectionError') {
        return {
          success: false,
          error: {
            message: 'Database connection error. Please try again later.',
            code: 'DATABASE_CONNECTION_ERROR'
          }
        };
      }

      // Handle other errors
      return {
        success: false,
        error: {
          message: 'Failed to get keyword ranking analysis',
          code: 'SERVICE_ERROR',
          details: error.message
        }
      };
    }
  }
}
