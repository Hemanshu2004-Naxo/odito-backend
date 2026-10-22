import express from 'express';
import { 
  searchBusiness, 
  getBusinessDetails, 
  healthCheck,
  extractFromWebsite
} from '../controller/businessController.js';

const router = express.Router();

/**
 * POST /api/app_user/business/search
 * Search for businesses using Google Places API
 * Body: { businessName: string, businessLocation: string }
 */
router.post('/business/search', searchBusiness);

/**
 * POST /api/app_user/business/extract-from-website
 * Extract business data from a website URL (manual fallback flow)
 * Body: { url: string }
 */
router.post('/business/extract-from-website', extractFromWebsite);

/**
 * GET /api/app_user/business/details/:placeId
 * Get detailed information about a specific business
 * Params: placeId
 */
router.get('/business/details/:placeId', getBusinessDetails);

/**
 * GET /api/app_user/business/health
 * Health check endpoint for business service
 */
router.get('/business/health', healthCheck);

export default router;
