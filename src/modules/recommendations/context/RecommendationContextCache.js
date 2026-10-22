/**
 * RecommendationContextCache
 *
 * In-process LRU cache for built RecommendationContext objects.
 *
 * Cache key:  SHA256(issueId + pageUrl + contextHash)
 *   — contextHash is a hash of the IssueContext content (from builderMeta)
 *   — changes automatically when page data changes
 *
 * TTL:        5 minutes (matches IssueContext staleTime in the frontend)
 * Max size:   500 entries — hard eviction of oldest entry when exceeded
 *
 * Separate from the Recommendation cache (30 days, MongoDB):
 *   - Context build is cheap (no AI calls, no DB queries)
 *   - Context expires quickly when page data changes
 *   - Prevents redundant re-building within the same request burst
 */

import crypto from 'crypto';
import { CACHE_CONFIG } from './RecommendationContextSchema.js';

class RecommendationContextCache {
  constructor() {
    // Map of cacheKey → { context, expiresAt, insertedAt }
    this._store = new Map();
    this._hits  = 0;
    this._misses = 0;
  }

  /**
   * Compute the cache key for a given issueId + pageUrl + contextHash.
   *
   * @param {string} issueId
   * @param {string} pageUrl
   * @param {string} contextHash — SHA256 hash of the IssueContext content
   * @returns {string}
   */
  buildKey(issueId, pageUrl, contextHash) {
    const raw = [
      (issueId   || '').trim().toLowerCase(),
      (pageUrl   || '').trim().toLowerCase(),
      (contextHash || '').slice(0, 16),
    ].join(':');
    return crypto.createHash('sha256').update(raw).digest('hex');
  }

  /**
   * Get a cached RecommendationContext, or null if miss/expired.
   *
   * @param {string} key
   * @returns {object | null}
   */
  get(key) {
    const entry = this._store.get(key);
    if (!entry) { this._misses++; return null; }

    if (entry.expiresAt < Date.now()) {
      this._store.delete(key);
      this._misses++;
      return null;
    }

    this._hits++;
    return entry.context;
  }

  /**
   * Store a built RecommendationContext.
   *
   * @param {string} key
   * @param {object} context
   */
  set(key, context) {
    // Evict oldest entry when at capacity
    if (this._store.size >= CACHE_CONFIG.MAX_ENTRIES) {
      const oldestKey = this._store.keys().next().value;
      this._store.delete(oldestKey);
    }

    this._store.set(key, {
      context,
      expiresAt:  Date.now() + CACHE_CONFIG.TTL_MS,
      insertedAt: Date.now(),
    });
  }

  /**
   * Explicitly invalidate a key (call when IssueContext is known to have changed).
   *
   * @param {string} key
   */
  invalidate(key) {
    this._store.delete(key);
  }

  /**
   * Invalidate all cached contexts for a specific page URL.
   * Called when a page re-crawl is detected.
   *
   * @param {string} pageUrl
   */
  invalidateByPage(pageUrl) {
    const normalized = (pageUrl || '').trim().toLowerCase();
    for (const [key, entry] of this._store.entries()) {
      if (entry.context?.pageContext?.pageUrl?.toLowerCase() === normalized) {
        this._store.delete(key);
      }
    }
  }

  /**
   * Invalidate all cached contexts for a specific issue ID.
   * Called when issue rule logic changes.
   *
   * @param {string} issueId
   */
  invalidateByIssue(issueId) {
    const normalized = (issueId || '').trim().toLowerCase();
    for (const [key, entry] of this._store.entries()) {
      if (entry.context?.identity?.issueId?.toLowerCase() === normalized) {
        this._store.delete(key);
      }
    }
  }

  /**
   * Clear all entries (e.g. on server restart).
   */
  clear() {
    this._store.clear();
    this._hits  = 0;
    this._misses = 0;
  }

  /**
   * Stats for observability.
   *
   * @returns {{ size, hits, misses, hitRate }}
   */
  stats() {
    const total   = this._hits + this._misses;
    const hitRate = total > 0 ? (this._hits / total * 100).toFixed(1) + '%' : 'N/A';
    return { size: this._store.size, hits: this._hits, misses: this._misses, hitRate };
  }
}

export default new RecommendationContextCache();
