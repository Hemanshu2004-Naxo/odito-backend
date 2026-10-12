import { validationResult } from 'express-validator';
import mongoose from 'mongoose';
import ExternalService from '../service/externalService.js';
import HomepageAuditVideoService from '../service/homepageAuditVideo.service.js';
import { discoverBusinessFromUrl } from '../service/businessDiscoveryService.js';
import { randomUUID } from 'node:crypto';
import { searchBusinesses, PlacesError, PLACES_ERROR } from '../../../services/googlePlacesService.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

const externalService = new ExternalService();

/**
 * Local SEO fetch controller
 * Handles POST /external/local-seo requests
 * No authentication required (follows external module pattern)
 */
export const localSeoController = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { businessName, location, scrapedData } = req.body;

    if (!businessName || !businessName.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Business name is required'
      });
    }

    if (!location || !location.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Location is required'
      });
    }

    console.log('[EXTERNAL] Local SEO controller processing request for:', businessName, location);

    const result = await externalService.localSeoFetch(
      businessName.trim(),
      location.trim(),
      scrapedData || {}
    );

    if (!result.success) {
      const statusCode = getErrorStatusCode(result.error);
      return res.status(statusCode).json(result);
    }

    res.status(200).json(result);

  } catch (error) {
    console.error('[EXTERNAL] Local SEO controller error:', error);
    res.status(500).json({
      success: false,
      error: 'server_error',
      message: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
};

/**
 * External onboarding controller
 * Handles POST /external/onboard requests
 */
export const externalOnboardController = async (req, res) => {
  try {
    // Validate request
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { email, website } = req.body;

    // Process external onboarding
    const result = await externalService.onboardFromEmail(email, website);

    if (!result.success) {
      if (result.code === 'INSUFFICIENT_CREDITS') {
        return res.status(403).json({
          success: false,
          code: 'INSUFFICIENT_CREDITS',
          message: result.message
        });
      }
      return res.status(500).json({
        success: false,
        message: result.message || 'External onboarding failed',
        error: process.env.NODE_ENV === 'development' ? result.error : undefined
      });
    }

    res.status(201).json({
      success: true,
      message: 'External onboarding completed successfully',
      data: result.data
    });

  } catch (error) {
    console.error('[EXTERNAL] Onboarding controller error:', error);
    
    res.status(500).json({
      success: false,
      message: 'External onboarding failed',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
};

/**
 * Homepage audit controller
 * Handles POST /external/audit/free requests
 */
export const homepageAuditController = async (req, res) => {
  try {
    // Validate request
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { url } = req.body;
    const userId = req.user?._id || null;

    // Process homepage audit
    const result = await externalService.runHomepageAudit(url, userId);

    // Return appropriate status code based on result
    if (!result.success) {
      const statusCode = getErrorStatusCode(result.error);
      return res.status(statusCode).json(result);
    }

    res.status(200).json(result);

  } catch (error) {
    console.error('[EXTERNAL] Homepage audit controller error:', error);
    
    res.status(500).json({
      success: false,
      error: 'server_error',
      message: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
};

/**
 * Homepage PageSpeed controller
 * Handles POST /external/homepage-pagespeed requests
 */
export const homepagePageSpeedController = async (req, res) => {
  try {
    // Validate request
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { url } = req.body;

    console.log('[EXTERNAL] PageSpeed controller processing request for:', url);

    // Process homepage PageSpeed analysis
    const result = await externalService.runHomepagePageSpeed(url);

    // Return appropriate status code based on result
    if (!result.success) {
      const statusCode = getErrorStatusCode(result.error);
      return res.status(statusCode).json(result);
    }

    res.status(200).json(result);

  } catch (error) {
    console.error('[EXTERNAL] PageSpeed controller error:', error);
    
    res.status(500).json({
      success: false,
      error: 'server_error',
      message: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
};

/**
 * Patch homepage audit snapshot with completed async data (performance or accessibility).
 * Called by the frontend after PageSpeed or Accessibility background tasks finish.
 * No auth required — the audit_id acts as the opaque token.
 *
 * Body: { type: 'performance' | 'accessibility', ...fields }
 */
export const patchHomepageAuditController = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid audit ID' });
    }

    const { type, ...fields } = req.body;
    if (!type) {
      return res.status(400).json({ success: false, message: 'type is required' });
    }

    const HomepageAudit = (await import('../model/HomepageAudit.js')).default;

    let setFields = {};

    if (type === 'performance') {
      if (fields.performance)           setFields['snapshot.performance']           = fields.performance;
      if (fields.performance_metrics)   setFields['snapshot.performance_metrics']   = fields.performance_metrics;
      if (fields.performance_score != null) setFields['snapshot.performance_score'] = fields.performance_score;
      if (fields.sections_performance)  setFields['snapshot.sections.performance']  = fields.sections_performance;
    } else if (type === 'accessibility') {
      if (fields.accessibility_metrics)   setFields['snapshot.accessibility_metrics']   = fields.accessibility_metrics;
      if (fields.sections_accessibility)  setFields['snapshot.sections.accessibility']  = fields.sections_accessibility;
      if (fields.sections_summary)        setFields['snapshot.sections.summary']        = fields.sections_summary;
      if (fields.rules_summary)           setFields['snapshot.rules_summary']           = fields.rules_summary;
      if (fields.top_issues)              setFields['snapshot.top_issues']              = fields.top_issues;
    } else if (type === 'local_seo') {
      if (fields.google_business_presence != null) {
        setFields['snapshot.page_info.google_business_presence'] = fields.google_business_presence;
      }
    } else {
      return res.status(400).json({ success: false, message: 'type must be performance, accessibility, or local_seo' });
    }

    if (Object.keys(setFields).length === 0) {
      return res.status(400).json({ success: false, message: 'No valid fields to update' });
    }

    const updated = await HomepageAudit.findByIdAndUpdate(
      id,
      { $set: setFields },
      { new: false }   // We don't need the updated document
    );

    if (!updated) {
      return res.status(404).json({ success: false, message: 'Audit not found' });
    }

    console.log(`[EXTERNAL] Snapshot patched (${type}) for audit: ${id}`);
    return res.status(200).json({ success: true });

  } catch (error) {
    console.error('[EXTERNAL] Patch audit controller error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

/**
 * POST /external/homepage-audit-video
 * Initiate (or return existing) Homepage Audit video generation.
 * Source of truth: HomepageAudit.snapshot ONLY.
 * Body: { auditId }
 */
export const generateHomepageAuditVideoController = async (req, res) => {
  try {
    const { auditId } = req.body;
    const userId = req.user?._id || null;

    if (!auditId) {
      return res.status(400).json({ success: false, message: 'auditId is required' });
    }

    const result = await HomepageAuditVideoService.initiate(auditId, userId);

    return res.status(200).json({
      success: true,
      data: result,
      message: result.existing
        ? `Video already ${result.status === 'RENDERED' ? 'rendered' : 'processing'}`
        : 'Homepage audit video generation started'
    });
  } catch (error) {
    console.error('[EXTERNAL] Generate homepage audit video error:', error);
    const statusCode = error.statusCode || 500;
    return res.status(statusCode).json({
      success: false,
      message: error.message || 'Failed to start homepage audit video'
    });
  }
};

/**
 * GET /external/homepage-audit-video/:auditId
 * Return current video status for a HomepageAudit.
 */
export const getHomepageAuditVideoController = async (req, res) => {
  try {
    const { auditId } = req.params;
    const result = await HomepageAuditVideoService.getStatus(auditId);

    if (result === null) {
      return res.status(404).json({ success: false, message: 'Homepage audit not found' });
    }

    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error('[EXTERNAL] Get homepage audit video error:', error);
    const statusCode = error.statusCode || 500;
    return res.status(statusCode).json({
      success: false,
      message: error.message || 'Failed to get homepage audit video status'
    });
  }
};

/**
 * POST /external/discover-business
 * Lightweight business discovery from a URL using cheerio HTML parsing.
 * Always 200 — returns empty data if nothing can be detected.
 */
export const discoverBusinessController = async (req, res) => {
  try {
    const { url } = req.body;
    if (!url || !url.trim()) {
      return res.status(400).json({ success: false, message: 'URL is required' });
    }

    console.log('[EXTERNAL] Business discovery started for:', url);
    const result = await discoverBusinessFromUrl(url.trim());
    return res.status(200).json(result);

  } catch (error) {
    console.error('[EXTERNAL] discoverBusinessController error:', error);
    return res.status(200).json({
      success: true,
      data: { businessName: '', location: '', city: '', state: '', country: '', source: 'manual', confidence: 'none' }
    });
  }
};

export const BUSINESS_SEARCH_MIN_QUERY = 2;
export const BUSINESS_SEARCH_MAX_QUERY = 120;
export const BUSINESS_SEARCH_MAX_LOCATION = 120;
const BUSINESS_SEARCH_MAX_RESULTS = 4;

// PlacesError code -> what the browser gets. Messages are safe for end users
// (no keys, project ids or upstream bodies); the technical detail is only in
// the server log line written by googlePlacesService.
const PLACES_HTTP = {
  [PLACES_ERROR.NOT_CONFIGURED]:   [503, 'Business search is not available right now. You can add your business manually or skip this step.'],
  [PLACES_ERROR.KEY_INVALID]:      [503, 'Business search is not available right now. You can add your business manually or skip this step.'],
  [PLACES_ERROR.ACCESS_DENIED]:    [503, 'Business search is not available right now. You can add your business manually or skip this step.'],
  [PLACES_ERROR.BILLING_REQUIRED]: [503, 'Business search is not available right now. You can add your business manually or skip this step.'],
  [PLACES_ERROR.RATE_LIMITED]:     [429, 'Too many searches. Please wait a moment and try again.'],
  [PLACES_ERROR.TIMEOUT]:          [504, 'The business search timed out. Please try again.'],
  [PLACES_ERROR.UNAVAILABLE]:      [502, 'Google business search is temporarily unavailable. Please try again.'],
  [PLACES_ERROR.BAD_RESPONSE]:     [502, 'Google business search returned an unexpected response. Please try again.'],
  [PLACES_ERROR.INVALID_REQUEST]:  [400, 'That search could not be processed. Please check the business name.']
};

/**
 * Map a Places search failure to a response. Never forwards upstream bodies,
 * messages from Google, or stack traces.
 */
export function placesErrorResponse(error) {
  const code = error instanceof PlacesError ? error.code : 'PLACES_UNAVAILABLE';
  const [status, message] = PLACES_HTTP[code] || PLACES_HTTP[PLACES_ERROR.UNAVAILABLE];
  return { status, body: { success: false, code, message } };
}

/**
 * Stable application schema for a Places candidate - no raw Google payload.
 * `requiresGoogleConnection` is intentionally absent: public Places discovery
 * never needs a connected Google account.
 */
export function toBusinessCandidate(place) {
  return {
    placeId: place.placeId,
    name: place.name,
    formattedAddress: place.address || '',
    // Alias kept for existing consumers of this endpoint (address-based UIs).
    address: place.address || '',
    location: place.lat != null && place.lng != null
      ? { latitude: place.lat, longitude: place.lng }
      : null,
    businessStatus: place.businessStatus || null,
    website: place.website || '',
    phone: place.phone || '',
    source: 'google_places'
  };
}

/**
 * POST /external/search-businesses
 * Public Places discovery (no auth, no Google account needed) for the Quick
 * Audit business step. Returns up to 4 normalized candidates.
 *
 * Failures are returned as non-2xx with a stable `code` so the UI can tell
 * "Google found nothing" (200, data: []) from "the search itself failed".
 */
export const searchBusinessCandidatesController = async (req, res) => {
  const requestId = randomUUID();
  const startedAt = Date.now();
  res.set?.('X-Request-Id', requestId);

  const rawQuery = req.body?.query;
  const rawLocation = req.body?.location ?? '';

  if (typeof rawQuery !== 'string' || typeof rawLocation !== 'string') {
    return res.status(400).json({ success: false, code: 'INVALID_QUERY', message: 'query must be a string' });
  }
  const query = rawQuery.trim().replace(/\s+/g, ' ');
  const location = rawLocation.trim().replace(/\s+/g, ' ');

  if (query.length < BUSINESS_SEARCH_MIN_QUERY) {
    return res.status(400).json({ success: false, code: 'INVALID_QUERY', message: `query must be at least ${BUSINESS_SEARCH_MIN_QUERY} characters` });
  }
  if (query.length > BUSINESS_SEARCH_MAX_QUERY || location.length > BUSINESS_SEARCH_MAX_LOCATION) {
    return res.status(400).json({ success: false, code: 'INVALID_QUERY', message: `query must be at most ${BUSINESS_SEARCH_MAX_QUERY} characters` });
  }

  try {
    const results = await searchBusinesses(query, location, { requestId });
    const data = results.slice(0, BUSINESS_SEARCH_MAX_RESULTS).map(toBusinessCandidate);

    LoggerUtil.info('[EXTERNAL] Business candidates search', {
      requestId, provider: 'google_places', queryLength: query.length,
      candidates: data.length, durationMs: Date.now() - startedAt, status: 200
    });
    return res.status(200).json({ success: true, data, meta: { source: 'google_places', count: data.length } });

  } catch (error) {
    const { status, body } = placesErrorResponse(error);
    LoggerUtil.warn('[EXTERNAL] Business candidates search failed', {
      requestId, provider: 'google_places', queryLength: query.length,
      errorCode: body.code, durationMs: Date.now() - startedAt, status
    });
    return res.status(status).json(body);
  }
};

/**
 * Map error codes to HTTP status codes
 */
function getErrorStatusCode(errorCode) {
  const statusMap = {
    'fetch_timeout': 408,
    'fetch_failed': 502,
    'timeout': 408,
    'pipeline_error': 500,
    'server_error': 500,
    'invalid_url': 400,
    'service_unavailable': 503,
    'api_error': 502,
    'unknown_error': 500,
    'business_not_found': 404
  };
  return statusMap[errorCode] || 500;
}
