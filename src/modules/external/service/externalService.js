import User from '../../user/model/User.js';
import SeoProject from '../../app_user/model/SeoProject.js';
import { JobService } from '../../jobs/service/jobService.js';
import { JOB_TYPES } from '../../jobs/constants/jobTypes.js';
import mongoose from 'mongoose';
import axios from 'axios';
import { getEnvVar } from '../../../config/env.js';
import { searchBusinesses, getPlaceDetails } from '../../../services/googlePlacesService.js';
import { getGrade } from '../../homepageAuditPdf/constants/homepageAuditConstants.js';
import { deductCredits, refundCredits } from '../../../utils/creditService.js';

class ExternalService {
  constructor() {
    this.jobService = new JobService();
    this.pythonWorkerUrl = getEnvVar('PYTHON_WORKER_URL');
    // Simple in-memory cache (10 minute TTL)
    this.cache = new Map();
    this.cacheTTL = 10 * 60 * 1000; // 10 minutes
  }

  /**
   * Handle external onboarding from email-only input
   */
  async onboardFromEmail(email, website = null) {
    try {
      console.log(`[EXTERNAL] Starting onboarding for email: ${email}, website: ${website}`);

      // 1. Find or create user
      const user = await this.findOrCreateUser(email);
      console.log(`[EXTERNAL] User ${user.isNew ? 'created' : 'found'}: ${user._id}`);

      // 2. Same project-credit rule as the authenticated creation endpoint
      // (seoProjectController.js): 1 credit = 1 project, atomic deduction via
      // the shared creditService, refunded if project creation itself fails.
      // Reuses the exact same service functions — no duplicated credit logic.
      try {
        await deductCredits(user._id, 1);
      } catch (creditError) {
        if (creditError.code === 'INSUFFICIENT_CREDITS') {
          return {
            success: false,
            code: 'INSUFFICIENT_CREDITS',
            message: 'No credits remaining for this account.'
          };
        }
        throw creditError;
      }

      // 3. Create default project
      let project;
      try {
        project = await this.createDefaultProject(user._id, email, website);
      } catch (projectError) {
        // Project creation failed after the credit was already spent —
        // refund it. A later failure (e.g. job dispatch, below) does NOT
        // refund: the credit pays for the project existing, not for the
        // audit pipeline starting, matching every other creation path.
        await refundCredits(user._id, 1);
        throw projectError;
      }
      console.log(`[EXTERNAL] Project created: ${project._id} with URL: ${project.main_url}`);

      // 4. Create and dispatch LINK_DISCOVERY job
      const job = await this.createAndDispatchLinkDiscoveryJob(user._id, project._id, project);
      console.log(`[EXTERNAL] LINK_DISCOVERY job created: ${job._id}`);

      return {
        success: true,
        message: 'External onboarding completed successfully',
        data: {
          userId: user._id,
          projectId: project._id,
          jobId: job._id,
          status: 'onboarded',
          message: 'External user onboarded and job dispatched successfully'
        }
      };

    } catch (error) {
      console.error('[EXTERNAL] Onboarding failed:', error);
      return {
        success: false,
        message: 'External onboarding failed',
        error: error.message
      };
    }
  }

  /**
   * Find existing user or create new one for external onboarding
   */
  async findOrCreateUser(email) {
    // Check if user exists
    let user = await User.findOne({ email: email.toLowerCase() });

    if (user) {
      user.isNew = false;
      return user;
    }

    // Create new user with minimal required fields
    const [firstName, lastName] = email.split('@')[0].split(/[._-]/).slice(0, 2);
    
    user = new User({
      firstName: firstName || 'User',
      lastName: lastName || 'External',
      email: email.toLowerCase(),
      password: 'EXTERNAL_USER_NO_PASSWORD', // Placeholder password
      roleId: 5, // Regular user
      isEmailVerified: true, // Auto-verify for external users
      oauthProvider: 'external' // Mark as external user
    });

    user.isNew = true;
    await user.save();
    return user;
  }

  /**
   * Create project with default values for external onboarding
   */
  async createDefaultProject(userId, email, website = null) {
    const domain = email.split('@')[1];
    const defaultUrl = website || `https://www.${domain}`;

    const project = new SeoProject({
      user_id: userId,
      project_name: `External Project - ${domain.replace(/[.-]/g, '')}`,
      main_url: defaultUrl,
      business_type: 'Unknown Business',
      industry: null,
      location: 'India',
      country: 'IN',
      language: 'en',
      // seo_scope has no neutral default at the schema level (its `default:
      // null` is not itself a valid enum value, so the field must always be
      // set explicitly on creation) — 'national' since external onboarding
      // has no local-business context to infer from.
      seo_scope: 'national',
      keywords: [domain.replace(/[.-]/g, '')], // Use cleaned domain as initial keyword
      description: `External onboarding project for ${email}`,
      status: 'active',
      scrape_frequency: 'manual',
      source: 'external'
    });

    await project.save();
    return project;
  }

  /**
   * Create and dispatch LINK_DISCOVERY job
   */
  async createAndDispatchLinkDiscoveryJob(userId, projectId) {
    // Get project details for job input
    const project = await SeoProject.findById(projectId);
    
    if (!project) {
      throw new Error('Project not found');
    }

    // Create LINK_DISCOVERY job
    const job = await this.jobService.createJob({
      user_id: userId,
      seo_project_id: projectId,
      jobType: JOB_TYPES.LINK_DISCOVERY,
      input_data: {
        main_url: project.main_url
      },
      priority: 5
    });

    // Dispatch job to Python worker via HTTP (using dynamic import to avoid circular dependency)
    console.log(`[EXTERNAL] Dispatching LINK_DISCOVERY job: ${job._id}`);
    
    try {
      // Dynamic import to avoid circular dependency (JobDispatcher is default export)
      const JobDispatcher = (await import('../../jobs/service/jobDispatcher.js')).default;
      const jobDispatcher = new JobDispatcher();
      
      console.log(`[EXTERNAL] JobDispatcher instantiated, calling dispatchLinkDiscoveryJob`);
      console.log(`[EXTERNAL] Job details:`, {
        jobId: job._id,
        jobType: job.jobType,
        projectId: job.project_id,
        main_url: job.input_data.main_url
      });
      
      const dispatchResult = await jobDispatcher.dispatchLinkDiscoveryJob(job);
      
      console.log(`[EXTERNAL] Dispatch result:`, dispatchResult);
      
      if (!dispatchResult.success) {
        throw new Error(`Failed to dispatch job to worker: ${dispatchResult.error}`);
      }

      console.log(`[EXTERNAL] Job dispatched successfully: ${job._id}`);
      return job;
      
    } catch (dispatchError) {
      console.error(`[EXTERNAL] Dispatch failed for job ${job._id}:`, {
        error: dispatchError.message,
        stack: dispatchError.stack,
        jobDetails: {
          jobId: job._id,
          jobType: job.jobType,
          projectId: job.project_id
        }
      });
      
      // Mark job as failed since dispatch didn't work
      await this.jobService.updateJobStatus(job._id, 'FAILED', {
        completed_at: new Date(),
        error_message: `Dispatch failed: ${dispatchError.message}`
      });
      
      throw new Error(`Job dispatch failed: ${dispatchError.message}`);
    }
  }

  /**
   * Run homepage audit by calling Python worker
   * Synchronous call with timeout handling, retry logic, and caching
   */
  async runHomepageAudit(url, userId = null) {
    try {
      // Validate URL format (only http/https allowed)
      if (!this.isValidUrl(url)) {
        return {
          success: false,
          error: 'invalid_url',
          message: 'Invalid URL format. Only HTTP and HTTPS URLs are allowed.'
        };
      }

      // Check cache first
      const cacheKey = url.toLowerCase();
      const cached = this.getFromCache(cacheKey);
      if (cached) {
        console.log('[EXTERNAL] Cache hit for:', url);
        return cached;
      }

      // Normalize URL
      const { normalizeUrl } = await import('../../../utils/normalizeUrl.js');
      const normalizedUrl = normalizeUrl(url);

      console.log('[EXTERNAL] Starting homepage audit for:', normalizedUrl);

      // Ensure the URL passed to the python worker has a scheme (defaulting to https)
      let workerUrl = url.trim();
      if (!/^https?:\/\//i.test(workerUrl)) {
        workerUrl = `https://${workerUrl}`;
      }

      // Call Python worker with retry logic and fallback
      const response = await this.callPythonWithFallback(workerUrl);

      console.log('[EXTERNAL] Python worker response status:', response.status);
      console.log('[EXTERNAL] Python response data:', JSON.stringify(response.data, null, 2));

      if (!response.data.success) {
        const errorResult = {
          success: false,
          error: response.data.error || 'audit_failed',
          message: response.data.message || 'Audit failed'
        };
        return errorResult;
      }

      // Add conversion optimization fields with defensive coding
      const auditData = response.data.data || {};
      const pageInfo = auditData.page_info || {};
      const wordCount = pageInfo.word_count || 0;
      const issuesCount = auditData.issues?.length || 0;

      // Calculate realistic total_pages with fallback
      let total_pages;
      if (wordCount > 0) {
        total_pages = Math.max(15, Math.min(50, Math.floor(wordCount / 50)));
      } else {
        total_pages = 25; // Fallback value
      }

      // Grade: trust Python's mapper.py (canonical 85/70/50/F formula).
      // Fall back to the shared backend getGrade() only if Python omitted it —
      // never a locally hand-rolled formula.
      const score = auditData.score || 0;
      const grade = auditData.grade || getGrade(score);

      // Calculate hidden_issues with fallback
      const hidden_issues = issuesCount + Math.floor(Math.random() * 30) + 10;

      const optimizedData = {
        ...auditData,
        total_pages: total_pages,
        grade: grade,
        hidden_issues: hidden_issues,
        message: 'Analyzed homepage only. Full site audit available.',
        cta: 'unlock_full_report',
        analysis_depth: auditData.analysis_depth || 'homepage_only',
        locked: auditData.locked !== false
      };

      const result = {
        success: true,
        data: optimizedData
      };

      console.log('[EXTERNAL] Optimized response with conversion fields:', {
        grade: optimizedData.grade,
        total_pages: optimizedData.total_pages,
        hidden_issues: optimizedData.hidden_issues,
        has_message: !!optimizedData.message,
        has_cta: !!optimizedData.cta
      });

      // Persist snapshot to MongoDB — capture _id so frontend can update it after async tasks
      try {
        const HomepageAudit = (await import('../model/HomepageAudit.js')).default;
        const saved = await HomepageAudit.create({
          url: normalizedUrl,
          snapshot: optimizedData,
          score: optimizedData.score || null,
          user_id: userId || null
        });
        result.data._audit_id = saved._id.toString();
        console.log('[EXTERNAL] Homepage audit snapshot saved:', saved._id);
      } catch (saveError) {
        console.error('[EXTERNAL] Failed to save homepage audit snapshot:', saveError.message);
      }

      // Cache the result
      this.setCache(cacheKey, result);

      console.log('[EXTERNAL] Homepage audit completed for:', normalizedUrl);
      return result;

    } catch (error) {
      console.error('[EXTERNAL] Homepage audit failed:', error);

      return this.handleAuditError(error);
    }
  }

  /**
   * Call Python worker with HTTP fallback strategy
   * Try HTTPS first, fallback to HTTP if it fails
   */
  async callPythonWithFallback(url) {
    // Try HTTPS first
    try {
      return await this.callPythonWithRetry(url);
    } catch (httpsError) {
      console.log('[EXTERNAL] HTTPS failed, trying HTTP fallback for:', url);
      
      // Fallback to HTTP
      const httpUrl = url.replace('https://', 'http://');
      try {
        return await this.callPythonWithRetry(httpUrl);
      } catch (httpError) {
        throw httpsError;
      }
    }
  }

  /**
   * Call Python worker with retry logic
   * Updated: 35 second timeout (higher than Python's 30s to prevent double timeout)
   */
  async callPythonWithRetry(url, retries = 1) {
    for (let i = 0; i <= retries; i++) {
      try {
        const response = await axios.post(
          `${this.pythonWorkerUrl}/api/homepage-audit`,
          { url: url },
          {
            timeout: 35000, // 35 seconds (must be higher than Python's 30s)
            headers: {
              'Content-Type': 'application/json'
            }
          }
        );
        return response;
      } catch (error) {
        if (i === retries) {
          throw error;
        }
        console.log(`[EXTERNAL] Retry ${i + 1}/${retries} for:`, url);
        await this.sleep(500);
      }
    }
  }

  /**
   * Handle audit errors with proper classification
   */
  handleAuditError(error) {
    if (error.code === 'ECONNABORTED') {
      return {
        success: false,
        error: 'timeout',
        message: 'This website is taking longer to analyze. Please try again.'
      };
    }

    if (error.code === 'ECONNREFUSED') {
      return {
        success: false,
        error: 'service_unavailable',
        message: 'Audit service is currently unavailable. Please try again later.'
      };
    }

    if (error.response) {
      return {
        success: false,
        error: 'python_error',
        message: error.response.data?.detail || error.response.data?.message || 'Python service error'
      };
    }

    if (error.request) {
      return {
        success: false,
        error: 'service_unavailable',
        message: 'Could not reach audit service'
      };
    }

    return {
      success: false,
      error: 'server_error',
      message: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    };
  }

  /**
   * Validate URL format (only http/https allowed)
   */
  isValidUrl(url) {
    try {
      const urlObj = new URL(url);
      return urlObj.protocol === 'http:' || urlObj.protocol === 'https:';
    } catch {
      return false;
    }
  }

  /**
   * Normalize URL (add https if missing, remove trailing slash)
   */
  normalizeUrl(url) {
    try {
      const urlObj = new URL(url);
      
      // Add https if missing
      if (urlObj.protocol === 'http:') {
        urlObj.protocol = 'https:';
      }
      
      // Remove trailing slash
      let normalized = urlObj.toString();
      if (normalized.endsWith('/')) {
        normalized = normalized.slice(0, -1);
      }
      
      return normalized;
    } catch {
      return url;
    }
  }

  /**
   * Get from cache if valid
   */
  getFromCache(key) {
    const cached = this.cache.get(key);
    if (!cached) return null;
    
    // Check if expired
    if (Date.now() - cached.timestamp > this.cacheTTL) {
      this.cache.delete(key);
      return null;
    }
    
    return cached.data;
  }

  /**
   * Set cache with timestamp
   */
  setCache(key, data) {
    this.cache.set(key, {
      data: data,
      timestamp: Date.now()
    });
    
    // Clean old entries if cache is too large
    if (this.cache.size > 100) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
  }

  /**
   * Run homepage PageSpeed analysis by calling Python worker.
   * Checks MongoDB cache first — skips the Google API call if data is < 7 days old.
   */
  async runHomepagePageSpeed(url) {
    if (!this.isValidUrl(url)) {
      return {
        success: false,
        error: 'invalid_url',
        message: 'Please provide a valid HTTP or HTTPS URL'
      };
    }

    const { normalizeUrl } = await import('../../../utils/normalizeUrl.js');
    const cacheKey = normalizeUrl(url);
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

    // 1. Check MongoDB cache
    try {
      const PageSpeedCache = (await import('../model/PageSpeedCache.js')).default;
      const cached = await PageSpeedCache
        .findOne({ url: cacheKey })
        .sort({ fetched_at: -1 })
        .select('score mobile desktop status fetched_at')
        .lean();

      if (cached && (Date.now() - cached.fetched_at.getTime()) < SEVEN_DAYS_MS) {
        console.log(`[PAGESPEED_CACHE] Hit for: ${cacheKey}`);
        return {
          success: true,
          data: {
            success: true,
            score:   cached.score,
            mobile:  cached.mobile,
            desktop: cached.desktop,
            status:  cached.status,
            message: 'Using cached result'
          }
        };
      }
    } catch (cacheReadError) {
      console.error('[PAGESPEED_CACHE] Cache lookup failed, falling through to live call:', cacheReadError.message);
    }

    // 2. Call Python worker
    console.log(`[PAGESPEED_CACHE] Miss — calling Python worker for: ${cacheKey}`);
    try {
      let workerUrl = url.trim();
      if (!/^https?:\/\//i.test(workerUrl)) {
        workerUrl = `https://${workerUrl}`;
      }
      const response = await axios.post(
        `${this.pythonWorkerUrl}/api/homepage-pagespeed`,
        { url: workerUrl },
        { timeout: 120000, headers: { 'Content-Type': 'application/json' } }
      );

      const metrics = response.data?.data;

      // 3. Save to cache — only completed/partial results, never fallback
      if (metrics && (metrics.status === 'completed' || metrics.status === 'partial')) {
        try {
          const PageSpeedCache = (await import('../model/PageSpeedCache.js')).default;
          await PageSpeedCache.create({
            url:        cacheKey,
            score:      metrics.score   ?? null,
            mobile:     metrics.mobile  ?? null,
            desktop:    metrics.desktop ?? null,
            status:     metrics.status,
            fetched_at: new Date()
          });
          console.log(`[PAGESPEED_CACHE] Saved for: ${cacheKey}`);
        } catch (cacheSaveError) {
          console.error('[PAGESPEED_CACHE] Save failed:', cacheSaveError.message);
        }
      }

      console.log(`[EXTERNAL] PageSpeed analysis completed for: ${url}`);
      return response.data;
    } catch (error) {
      console.error(`[EXTERNAL] PageSpeed analysis failed for: ${url}`, error.message);
      return this.handlePageSpeedError(error);
    }
  }

  /**
   * Handle PageSpeed errors with proper classification
   */
  handlePageSpeedError(error) {
    if (error.code === 'ECONNABORTED') {
      return {
        success: false,
        error: 'timeout',
        message: 'PageSpeed analysis is taking longer than expected. Please try again.'
      };
    }

    if (error.code === 'ECONNREFUSED') {
      return {
        success: false,
        error: 'service_unavailable',
        message: 'PageSpeed service is currently unavailable. Please try again later.'
      };
    }

    if (error.response) {
      return {
        success: false,
        error: 'api_error',
        message: error.response.data?.message || 'PageSpeed analysis failed'
      };
    }

    return {
      success: false,
      error: 'unknown_error',
      message: 'An unexpected error occurred during PageSpeed analysis'
    };
  }

  /**
   * Fetch local SEO data using Google Places API
   * Step 1: Text Search to find the business and get place_id
   * Step 2: Place Details to get name, address, phone, category, website
   * Also compares with scraped website data for NAP inconsistency
   */
  async localSeoFetch(businessName, location, scrapedData = {}) {
    try {
      console.log('[EXTERNAL] Local SEO fetch started', { businessName, location });

      // Validate inputs
      if (!businessName || !businessName.trim()) {
        return {
          success: false,
          message: 'Business name is required'
        };
      }

      if (!location || !location.trim()) {
        return {
          success: false,
          message: 'Location is required'
        };
      }

      // Step 1: Call Google Places Text Search API
      const searchResults = await searchBusinesses(businessName.trim(), location.trim());

      // Debug: log search results
      console.log('[EXTERNAL] Places Results:', JSON.stringify(searchResults?.map(r => ({
        placeId: r.placeId,
        name: r.name,
        address: r.address
      })), null, 2));

      if (!searchResults || searchResults.length === 0) {
        return {
          success: false,
          error: 'business_not_found',
          message: 'Business not found'
        };
      }

      // Take the top (most relevant) result
      const topResult = searchResults[0];
      const placeId = topResult.placeId;

      // Debug: log selected place
      console.log('[EXTERNAL] Selected Place:', {
        placeId,
        name: topResult.name,
        address: topResult.address
      });

      if (!placeId) {
        return {
          success: false,
          error: 'business_not_found',
          message: 'Business not found - no place ID'
        };
      }

      // Step 2: Call Place Details API
      const details = await getPlaceDetails(placeId);

      // Step 3: Build clean response with extended data
      const response = {
        success: true,
        data: {
          place_id: placeId,
          name: details.name || '',
          address: details.address || '',
          phone: details.phone || 'Not available',
          category: details.category
            ? details.category.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
            : '',
          website: details.website || '',
          rating: details.rating || null,
          total_reviews: details.total_reviews || 0,
          google_maps_url: details.google_maps_url || '',
          location: details.location || { lat: null, lng: null },
          reviews: details.reviews || []
        }
      };

      // Bonus: NAP inconsistency detection
      // Compare Google Places data with scraped website data
      const napWarnings = this.detectNAPInconsistency(response.data, scrapedData);
      if (napWarnings.length > 0) {
        response.data.napInconsistency = true;
        response.data.napWarnings = napWarnings;
      } else {
        response.data.napInconsistency = false;
        response.data.napWarnings = [];
      }

      console.log('[EXTERNAL] Local SEO fetch completed', {
        businessName: response.data.name,
        hasNapInconsistency: response.data.napInconsistency
      });

      return response;

    } catch (error) {
      console.error('[EXTERNAL] Local SEO fetch failed:', error);

      // Handle specific error types
      if (error.message.includes('API key')) {
        return {
          success: false,
          message: 'Service temporarily unavailable. Please try again later.'
        };
      }

      if (error.message.includes('quota exceeded')) {
        return {
          success: false,
          message: 'Too many requests. Please wait a moment and try again.'
        };
      }

      return {
        success: false,
        message: error.message || 'Failed to fetch local SEO data'
      };
    }
  }

  /**
   * Detect NAP (Name, Address, Phone) inconsistency
   * between Google Places data and scraped website data
   * @param {Object} googleData - Data from Google Places
   * @param {Object} scrapedData - Data scraped from the website
   * @returns {Array<string>} - Array of warning messages
   */
  detectNAPInconsistency(googleData, scrapedData) {
    const warnings = [];

    if (!scrapedData || Object.keys(scrapedData).length === 0) {
      return warnings; // No scraped data to compare
    }

    // Compare phone numbers
    const scrapedPhone = scrapedData.phone || '';
    const googlePhone = googleData.phone || '';
    if (scrapedPhone && googlePhone && googlePhone !== 'Not available') {
      const normalizePhone = (p) => p.replace(/[\s\-\(\)\+]/g, '');
      if (normalizePhone(scrapedPhone) !== normalizePhone(googlePhone)) {
        warnings.push('Phone number mismatch between website and Google Business Profile');
      }
    }

    // Compare addresses (basic keyword match)
    const scrapedAddress = (scrapedData.address || '').toLowerCase();
    const googleAddress = (googleData.address || '').toLowerCase();
    if (scrapedAddress && googleAddress) {
      // Check if key address tokens overlap
      const scrapedTokens = scrapedAddress.split(/[\s,]+/).filter(t => t.length > 3);
      const googleTokens = googleAddress.split(/[\s,]+/).filter(t => t.length > 3);
      const overlap = scrapedTokens.filter(t => googleTokens.includes(t));
      if (overlap.length < Math.min(scrapedTokens.length, googleTokens.length) * 0.4) {
        warnings.push('Address mismatch between website and Google Business Profile');
      }
    }

    // Compare website URLs
    const scrapedWebsite = (scrapedData.website || '').toLowerCase().replace(/\/$/, '');
    const googleWebsite = (googleData.website || '').toLowerCase().replace(/\/$/, '');
    if (scrapedWebsite && googleWebsite && scrapedWebsite !== googleWebsite) {
      warnings.push('Website URL mismatch between website and Google Business Profile');
    }

    return warnings;
  }

  /**
   * Sleep utility for retry delay
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default ExternalService;
