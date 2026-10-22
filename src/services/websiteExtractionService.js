import axios from 'axios';
import { checkPublicWebsiteUrl } from '../utils/publicWebsiteUrl.js';

/**
 * Website Extraction Service
 * 
 * Orchestrates website scraping and business data extraction for the
 * "Website Manual Fallback" onboarding flow.
 * 
 * When Google Places search fails to find a business, this service
 * allows users to provide their website URL. It scrapes the site and
 * extracts business information (name, address, phone, metadata, schema, etc.)
 * 
 * Security: SSRF protection via URL blocklist
 * Performance: In-memory caching (10min TTL), 30s scraping timeout
 * Reliability: Retry with exponential backoff
 */

// ─── SSRF Protection: Blocked URL Patterns ──────────────────────────────
const BLOCKED_URL_PATTERNS = [
  /^https?:\/\/localhost/i,
  /^https?:\/\/127\./,
  /^https?:\/\/0\./,
  /^https?:\/\/10\./,
  /^https?:\/\/172\.(1[6-9]|2[0-9]|3[01])\./,
  /^https?:\/\/192\.168\./,
  /^https?:\/\/169\.254\./,             // Link-local
  /^https?:\/\/\[::1\]/,                // IPv6 localhost
  /^https?:\/\/\[fe80:/i,               // IPv6 link-local
  /^https?:\/\/metadata\.google/i,      // GCP metadata
  /^https?:\/\/169\.254\.169\.254/,     // AWS/GCP metadata endpoint
  /^https?:\/\/metadata\.internal/i,    // Internal metadata
];

// ─── Rate Limiting: Per-user extraction limits ──────────────────────────
const rateLimitMap = new Map();
const RATE_LIMIT_MAX = 5;          // Max extractions per window
const RATE_LIMIT_WINDOW = 60 * 60 * 1000; // 1 hour

// ─── Extraction Cache ───────────────────────────────────────────────────
const extractionCache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// ─── Configuration ──────────────────────────────────────────────────────
const SCRAPE_TIMEOUT = 30000;      // 30 seconds
const MAX_RETRIES = 1;             // 1 retry (2 total attempts)

/**
 * Get Python worker URL from environment
 */
function getPythonWorkerUrl() {
  const url = process.env.PYTHON_WORKER_URL;
  if (!url) {
    throw new Error('PYTHON_WORKER_URL environment variable is required');
  }
  return url;
}

// ═══════════════════════════════════════════════════════════════════════════
//  URL Validation & Security
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Validate URL format — only HTTP/HTTPS allowed
 * @param {string} url - URL to validate
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateUrl(url) {
  // Syntactic gate: scheme, credentials, ports, IP literals, internal hostnames.
  // The authoritative DNS + redirect-hop checks live in the Python worker, which
  // is the process that actually performs the fetch.
  const check = checkPublicWebsiteUrl(url);
  if (!check.ok) return { valid: false, error: check.reason };

  // Legacy blocklist kept as defence in depth (cheap, and covers metadata names).
  if (isBlockedUrl(url.trim())) {
    return { valid: false, error: 'This URL is not allowed for security reasons' };
  }
  return { valid: true };
}

/**
 * Check if URL matches any blocked pattern (SSRF protection)
 * @param {string} url - URL to check
 * @returns {boolean}
 */
export function isBlockedUrl(url) {
  return BLOCKED_URL_PATTERNS.some(pattern => pattern.test(url));
}

/**
 * Normalize URL — add https if missing, remove trailing slash, lowercase hostname
 * @param {string} url - URL to normalize
 * @returns {string} - Normalized URL
 */
export function normalizeUrl(url) {
  try {
    let input = url.trim();

    // Add https:// if no protocol
    if (!/^https?:\/\//i.test(input)) {
      input = `https://${input}`;
    }

    const urlObj = new URL(input);

    // Prefer HTTPS
    if (urlObj.protocol === 'http:') {
      urlObj.protocol = 'https:';
    }

    // Remove trailing slash from pathname
    if (urlObj.pathname === '/') {
      urlObj.pathname = '';
    }

    let normalized = urlObj.toString();
    if (normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1);
    }

    return normalized;
  } catch {
    return url.trim();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Rate Limiting
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check and enforce per-user rate limit
 * @param {string} userId - User ID
 * @returns {{ allowed: boolean, remaining: number, resetIn?: number }}
 */
export function checkRateLimit(userId) {
  const key = `extract:${userId}`;
  const now = Date.now();

  let entry = rateLimitMap.get(key);

  // Clean expired entry
  if (entry && (now - entry.windowStart) > RATE_LIMIT_WINDOW) {
    rateLimitMap.delete(key);
    entry = null;
  }

  if (!entry) {
    rateLimitMap.set(key, { count: 1, windowStart: now });
    return { allowed: true, remaining: RATE_LIMIT_MAX - 1 };
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    const resetIn = Math.ceil((entry.windowStart + RATE_LIMIT_WINDOW - now) / 1000);
    return { allowed: false, remaining: 0, resetIn };
  }

  entry.count++;
  return { allowed: true, remaining: RATE_LIMIT_MAX - entry.count };
}

// ═══════════════════════════════════════════════════════════════════════════
//  Caching
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get cached extraction result
 * @param {string} url - Normalized URL as cache key
 * @returns {Object|null}
 */
function getCachedExtraction(url) {
  const cached = extractionCache.get(url.toLowerCase());
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
    console.log(`[WEBSITE_EXTRACTION] Cache hit for: ${url}`);
    return cached.data;
  }
  if (cached) {
    extractionCache.delete(url.toLowerCase());
  }
  return null;
}

/**
 * Cache extraction result
 * @param {string} url - Normalized URL
 * @param {Object} data - Extraction result
 */
function setCachedExtraction(url, data) {
  extractionCache.set(url.toLowerCase(), {
    data,
    timestamp: Date.now()
  });

  // Evict old entries when cache grows too large
  if (extractionCache.size > 100) {
    const now = Date.now();
    for (const [key, value] of extractionCache.entries()) {
      if (now - value.timestamp > CACHE_TTL) {
        extractionCache.delete(key);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Core Extraction Logic
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Extract business data from a website URL
 * Main entry point for the extraction pipeline
 * 
 * @param {string} url - Website URL to scrape
 * @param {string} userId - User ID for rate limiting
 * @returns {Promise<Object>} - Extraction result
 */
export async function extractBusinessData(url, userId) {
  try {
    console.log('[WEBSITE_EXTRACTION] Starting extraction', { url, userId });

    // 1. Validate URL
    const validation = validateUrl(url);
    if (!validation.valid) {
      return {
        success: false,
        error: 'INVALID_URL',
        message: validation.error
      };
    }

    // 2. Rate limit check
    const rateLimit = checkRateLimit(userId);
    if (!rateLimit.allowed) {
      return {
        success: false,
        error: 'RATE_LIMIT_EXCEEDED',
        message: `Too many extraction requests. Please try again in ${rateLimit.resetIn} seconds.`,
        resetIn: rateLimit.resetIn
      };
    }

    // 3. Normalize URL
    const normalizedUrl = normalizeUrl(url);

    // 4. Check cache
    const cached = getCachedExtraction(normalizedUrl);
    if (cached) {
      return cached;
    }

    // 5. Call Python worker to scrape and extract
    const rawData = await callPythonExtractor(normalizedUrl);

    // 6. Normalize extracted data
    const normalizedData = normalizeExtractedData(rawData, normalizedUrl);

    // 7. Build result
    const result = {
      success: true,
      data: normalizedData,
      source_url: normalizedUrl,
      extracted_at: new Date().toISOString()
    };

    // 8. Cache result
    setCachedExtraction(normalizedUrl, result);

    console.log('[WEBSITE_EXTRACTION] Extraction completed', {
      url: normalizedUrl,
      businessName: normalizedData.businessName,
      hasAddress: !!normalizedData.address,
      hasPhone: !!normalizedData.phone,
      hasSchema: !!normalizedData.schemaOrg
    });

    return result;

  } catch (error) {
    console.error('[WEBSITE_EXTRACTION] Extraction failed', {
      url,
      error: error.message,
      code: error.code
    });

    return handleExtractionError(error);
  }
}

/**
 * Call Python worker for website scraping and data extraction
 * Includes retry logic with exponential backoff
 * 
 * @param {string} url - Normalized URL to scrape
 * @returns {Promise<Object>} - Raw extraction data from Python worker
 */
async function callPythonExtractor(url) {
  const pythonWorkerUrl = getPythonWorkerUrl();
  const endpoint = `${pythonWorkerUrl}/api/extract-website-data`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`[WEBSITE_EXTRACTION] Calling Python worker (attempt ${attempt + 1})`, { url });

      const response = await axios.post(endpoint, { url }, {
        timeout: SCRAPE_TIMEOUT,
        headers: { 'Content-Type': 'application/json' }
      });

      if (!response.data) {
        throw new Error('Empty response from extraction worker');
      }

      if (!response.data.success) {
        const workerError = new Error(response.data.message || response.data.error || 'Extraction failed');
        workerError.workerCode = response.data.error || null;
        throw workerError;
      }

      return response.data.data || {};

    } catch (error) {
      console.warn(`[WEBSITE_EXTRACTION] Attempt ${attempt + 1} failed`, {
        url,
        error: error.message,
        status: error.response?.status
      });

      // A deterministic refusal (blocked destination) will not change on retry.
      if (error.workerCode === 'blocked_url') {
        throw error;
      }

      // Don't retry on 4xx errors (client errors like bad URL)
      if (error.response?.status >= 400 && error.response?.status < 500) {
        throw error;
      }

      if (attempt === MAX_RETRIES) {
        throw error;
      }

      // Exponential backoff: 1s, 2s
      const delay = Math.pow(2, attempt) * 1000;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

/**
 * Normalize raw extracted data into a clean, typed structure
 * Handles missing fields gracefully with sensible defaults
 * 
 * @param {Object} rawData - Raw data from Python worker
 * @param {string} sourceUrl - The URL that was scraped
 * @returns {Object} - Normalized business data
 */
export function normalizeExtractedData(rawData, sourceUrl) {
  const data = rawData || {};

  // Extract business name with fallback chain
  const businessName = sanitizeText(
    data.business_name ||
    data.og_site_name ||
    data.title ||
    extractDomainName(sourceUrl)
  );

  // Extract and sanitize address
  const address = sanitizeText(
    data.address ||
    data.contact_info?.address ||
    data.schema_address ||
    ''
  );

  // Extract phone
  const phone = sanitizeText(
    data.phone ||
    data.contact_info?.phone ||
    data.schema_phone ||
    ''
  );

  // Extract email
  const email = sanitizeText(
    data.email ||
    data.contact_info?.email ||
    ''
  );

  return {
    businessName: truncate(businessName, 200),
    address: truncate(address, 500),
    phone: truncate(phone, 50),
    email: truncate(email, 200),
    website: sourceUrl,

    // Metadata
    title: truncate(sanitizeText(data.title || ''), 300),
    description: truncate(sanitizeText(data.meta_description || data.description || ''), 500),

    // Open Graph
    ogTags: {
      title: sanitizeText(data.og_title || ''),
      description: sanitizeText(data.og_description || ''),
      image: data.og_image || '',
      siteName: sanitizeText(data.og_site_name || '')
    },

    // Schema.org / JSON-LD
    schemaOrg: data.schema_org || null,

    // Social links
    socialLinks: Array.isArray(data.social_links)
      ? data.social_links.filter(link => typeof link === 'string').slice(0, 20)
      : [],

    // Keywords extracted from content
    keywords: Array.isArray(data.keywords)
      ? data.keywords.filter(k => typeof k === 'string').slice(0, 10)
      : [],

    // Industry/category hint (from schema or AI)
    category: sanitizeText(data.category || data.schema_type || ''),

    // Extraction confidence
    confidence: calculateConfidence(data),

    // Extraction completeness flags
    hasSchema: !!data.schema_org,
    hasContactInfo: !!(address || phone || email),
    hasSocialLinks: Array.isArray(data.social_links) && data.social_links.length > 0
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Sanitize text — strip HTML tags, excessive whitespace
 * @param {string} text
 * @returns {string}
 */
function sanitizeText(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/<[^>]*>/g, '')         // Strip HTML tags
    .replace(/&[^;]+;/g, ' ')       // Strip HTML entities
    .replace(/\s+/g, ' ')           // Collapse whitespace
    .trim();
}

/**
 * Truncate string to max length
 */
function truncate(str, maxLen) {
  if (!str) return '';
  return str.length > maxLen ? str.substring(0, maxLen) : str;
}

/**
 * Extract domain name from URL as fallback business name
 */
function extractDomainName(url) {
  try {
    const hostname = new URL(url).hostname;
    return hostname
      .replace('www.', '')
      .split('.')[0]
      .replace(/-/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
  } catch {
    return 'Unknown Business';
  }
}

/**
 * Calculate extraction confidence score (0-100)
 * More data points extracted = higher confidence
 */
function calculateConfidence(data) {
  let score = 0;
  if (data.title) score += 15;
  if (data.meta_description || data.description) score += 10;
  if (data.business_name) score += 20;
  if (data.address || data.contact_info?.address || data.schema_address) score += 15;
  if (data.phone || data.contact_info?.phone || data.schema_phone) score += 10;
  if (data.schema_org) score += 15;
  if (data.social_links?.length > 0) score += 5;
  if (data.og_title || data.og_description) score += 5;
  if (data.keywords?.length > 0) score += 5;
  return Math.min(score, 100);
}

/**
 * Handle extraction errors with user-friendly messages
 */
function handleExtractionError(error) {
  if (error.workerCode === 'blocked_url') {
    return {
      success: false,
      error: 'INVALID_URL',
      message: 'This URL is not allowed for security reasons'
    };
  }

  if (error.workerCode === 'timeout') {
    return {
      success: false,
      error: 'TIMEOUT',
      message: 'This website is taking too long to analyze. Please try again or enter your business details manually.'
    };
  }

  if (error.code === 'ECONNABORTED') {
    return {
      success: false,
      error: 'TIMEOUT',
      message: 'This website is taking too long to analyze. Please try again or enter your business details manually.'
    };
  }

  if (error.code === 'ECONNREFUSED') {
    return {
      success: false,
      error: 'SERVICE_UNAVAILABLE',
      message: 'Extraction service is temporarily unavailable. Please try again later.'
    };
  }

  if (error.response?.status === 400) {
    return {
      success: false,
      error: 'BAD_REQUEST',
      message: error.response.data?.message || 'Could not analyze this website. Please check the URL.'
    };
  }

  if (error.response?.status === 429) {
    return {
      success: false,
      error: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many requests. Please wait a moment and try again.'
    };
  }

  return {
    success: false,
    error: 'EXTRACTION_FAILED',
    message: 'Failed to extract business information. You can enter your details manually.'
  };
}

export default {
  extractBusinessData,
  validateUrl,
  normalizeUrl,
  isBlockedUrl,
  checkRateLimit,
  normalizeExtractedData
};
