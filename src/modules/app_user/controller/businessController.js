import { randomUUID } from 'node:crypto';
import { searchBusinesses, PlacesError, PLACES_ERROR } from '../../../services/googlePlacesService.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import { rankBusinessResults, hasGoodResults } from '../../../services/businessRankingService.js';
import { extractBusinessData } from '../../../services/websiteExtractionService.js';

/**
 * Business Controller
 * 
 * Handles business search and verification endpoints
 * Integrates Google Places API with ranking algorithm
 */

// PlacesError code -> [HTTP status, legacy `error` key, end-user message].
// `code` (the PlacesError code) is what the onboarding UI branches on; the
// legacy `error` key is kept so existing consumers keep working. Messages never
// contain keys, project ids or upstream text - that stays in the server log
// line googlePlacesService writes.
const SEARCH_ERROR_RESPONSES = {
  [PLACES_ERROR.NOT_CONFIGURED]:   [503, 'API_CONFIGURATION_ERROR', 'Business search is not available right now.'],
  [PLACES_ERROR.KEY_INVALID]:      [503, 'API_CONFIGURATION_ERROR', 'Business search is not available right now.'],
  [PLACES_ERROR.ACCESS_DENIED]:    [503, 'API_CONFIGURATION_ERROR', 'Business search is not available right now.'],
  [PLACES_ERROR.BILLING_REQUIRED]: [503, 'API_CONFIGURATION_ERROR', 'Business search is not available right now.'],
  [PLACES_ERROR.RATE_LIMITED]:     [429, 'RATE_LIMIT_EXCEEDED', 'Too many searches. Please wait a moment and try again.'],
  [PLACES_ERROR.TIMEOUT]:          [504, 'SEARCH_TIMEOUT', 'The business search timed out. Please try again.'],
  [PLACES_ERROR.UNAVAILABLE]:      [502, 'SEARCH_UNAVAILABLE', 'Business search is temporarily unavailable.'],
  [PLACES_ERROR.BAD_RESPONSE]:     [502, 'SEARCH_UNAVAILABLE', 'Business search is temporarily unavailable.'],
  [PLACES_ERROR.INVALID_REQUEST]:  [400, 'INVALID_REQUEST', 'Invalid search. Please check your business name and location.']
};

const MAX_SEARCH_FIELD_LENGTH = 120;

/**
 * Search for businesses using name and location
 *
 * A failure is NEVER returned as an empty result list: `200 { results: [] }`
 * means Google really found nothing; anything else is a non-2xx with a `code`.
 *
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export async function searchBusiness(req, res) {
  const requestId = randomUUID();
  const startedAt = Date.now();
  res.set?.('X-Request-Id', requestId);

  try {
    const { businessName, businessLocation } = req.body || {};

    // Validate required fields
    if (typeof businessName !== 'string' || !businessName.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Business name is required'
      });
    }

    if (typeof businessLocation !== 'string' || !businessLocation.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Business location is required'
      });
    }

    const name = businessName.trim().replace(/s+/g, ' ');
    const location = businessLocation.trim().replace(/s+/g, ' ');
    if (name.length > MAX_SEARCH_FIELD_LENGTH || location.length > MAX_SEARCH_FIELD_LENGTH) {
      return res.status(400).json({
        success: false,
        message: 'Business name and location must be at most 120 characters',
        code: PLACES_ERROR.INVALID_REQUEST,
        error: 'INVALID_REQUEST'
      });
    }

    // Search for businesses using Google Places API
    const rawResults = await searchBusinesses(name, location, { requestId });

    if (rawResults.length === 0) {
      return res.json({
        success: true,
        data: {
          results: [],
          message: 'No businesses found. Try different search terms.',
          hasResults: false
        }
      });
    }

    // Rank results by relevance
    const rankedResults = rankBusinessResults(rawResults, name, location);

    // Check if results are good enough
    const hasGoodMatches = hasGoodResults(rankedResults);

    // Return response
    res.json({
      success: true,
      data: {
        results: rankedResults,
        message: hasGoodMatches 
          ? `Found ${rankedResults.length} matching businesses.`
          : 'Found some businesses, but none seem to match well. Try different search terms.',
        hasResults: rankedResults.length > 0,
        hasGoodMatches,
        searchQuery: `${name} in ${location}`
      }
    });

  } catch (error) {
    const code = error instanceof PlacesError ? error.code : null;
    const [status, errorKey, message] = SEARCH_ERROR_RESPONSES[code] || [500, 'INTERNAL_ERROR', 'Something went wrong while searching for businesses. Please try again.'];

    // Never log the request body (it contains what the user typed) - just
    // correlation + classification. googlePlacesService already logged the
    // upstream status/reason for Places failures.
    LoggerUtil.warn('[BUSINESS_CONTROLLER] Search failed', {
      requestId,
      errorCode: code || 'UNEXPECTED',
      status,
      durationMs: Date.now() - startedAt,
      ...(code ? {} : { error: error?.message })
    });

    return res.status(status).json({ success: false, message, code: code || 'INTERNAL_ERROR', error: errorKey });
  }
}

/**
 * Get business details by place ID (for future use)
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export async function getBusinessDetails(req, res) {
  try {
    const { placeId } = req.params;
    
    if (!placeId) {
      return res.status(400).json({
        success: false,
        message: 'Place ID is required'
      });
    }
    
    // This would implement Google Places Details API
    // For now, return a placeholder response
    res.json({
      success: true,
      data: {
        message: 'Business details endpoint not yet implemented',
        placeId
      }
    });
    
  } catch (error) {
    console.error('[BUSINESS_CONTROLLER] Get details failed', {
      error: error.message,
      placeId: req.params.placeId
    });
    
    res.status(500).json({
      success: false,
      message: 'Failed to get business details',
      error: 'INTERNAL_ERROR'
    });
  }
}

/**
 * Health check for business service
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export async function healthCheck(req, res) {
  try {
    // Check if Google Places API key is configured
    const apiKey = process.env.GOOGLE_PLACES_API_KEY;
    
    res.json({
      success: true,
      data: {
        status: 'healthy',
        apiKeyConfigured: !!apiKey,
        timestamp: new Date().toISOString()
      }
    });
    
  } catch (error) {
    console.error('[BUSINESS_CONTROLLER] Health check failed', {
      error: error.message
    });
    
    res.status(500).json({
      success: false,
      message: 'Service health check failed',
      error: 'INTERNAL_ERROR'
    });
  }
}

/**
 * Extract business data from a website URL
 * Used when Google Places search fails to find the business
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export async function extractFromWebsite(req, res) {
  try {
    const { url } = req.body;

    if (!url || typeof url !== 'string' || !url.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Website URL is required',
        error: 'MISSING_URL'
      });
    }

    const userId = req.user?._id?.toString();
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
    }

    console.log('[BUSINESS_CONTROLLER] Website extraction request', {
      url: url.trim(),
      userId
    });

    // Call extraction service (handles validation, rate limiting, caching, scraping)
    const result = await extractBusinessData(url.trim(), userId);

    if (!result.success) {
      // Map error codes to HTTP status codes
      const statusMap = {
        'INVALID_URL': 400,
        'RATE_LIMIT_EXCEEDED': 429,
        'TIMEOUT': 504,
        'SERVICE_UNAVAILABLE': 503,
        'BAD_REQUEST': 400
      };
      const status = statusMap[result.error] || 500;

      return res.status(status).json({
        success: false,
        message: result.message,
        error: result.error
      });
    }

    console.log('[BUSINESS_CONTROLLER] Extraction succeeded', {
      url: result.source_url,
      businessName: result.data?.businessName,
      confidence: result.data?.confidence
    });

    return res.json({
      success: true,
      data: result.data,
      source_url: result.source_url,
      extracted_at: result.extracted_at
    });

  } catch (error) {
    console.error('[BUSINESS_CONTROLLER] Website extraction failed', {
      error: error.message,
      stack: error.stack,
      url: req.body?.url
    });

    res.status(500).json({
      success: false,
      message: 'Failed to extract business information. Please try again.',
      error: 'INTERNAL_ERROR'
    });
  }
}

export default {
  searchBusiness,
  getBusinessDetails,
  healthCheck,
  extractFromWebsite
};
