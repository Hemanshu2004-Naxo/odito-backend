/**
 * Client for the Python worker's SSRF-safe image verification
 * (python_workers/api/logo_verification.py -> api/image_probe.py -> api/safe_fetch.py).
 *
 * The Node API deliberately does NOT fetch customer-supplied image URLs itself: DNS-pinned
 * connections, per-hop redirect validation and the response-size cap already exist in the
 * worker (the same fetcher the onboarding extractor uses), and a second, weaker HTTP client
 * here would be exactly the SSRF surface that module was written to close. This file only
 *   1. rejects URLs that are obviously not fetchable before bothering the worker,
 *   2. batches the rest into one call, and
 *   3. caches the answers (a logo rarely changes; a slow site must not be re-probed on every click).
 *
 * Failure is never reported as "broken": if the worker is unreachable, or the probe timed out
 * / was blocked, the candidate stays UNVERIFIED (conclusive: false) and the generator omits it.
 */

import axios from 'axios';
import { checkPublicWebsiteUrl } from '../../utils/publicWebsiteUrl.js';

const MAX_PER_CALL = 6;
const CONCLUSIVE_TTL_MS = 6 * 60 * 60 * 1000;
const INCONCLUSIVE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;
const REQUEST_TIMEOUT_MS = 35000; // worker: 3 concurrent, 15 s deadline per URL, <= 6 URLs

const cache = new Map(); // url -> { probe, expiresAt }

export function resetImageProbeCache() { cache.clear(); }

const unverified = (url, status, reason) => ({ url, ok: false, status, conclusive: false, reason, http_status: null, final_url: null, content_type: null, format: null, width: null, height: null, bytes_read: 0, redirects: 0 });

function remember(probe, now) {
  if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(probe.url, { probe, expiresAt: now + (probe.conclusive ? CONCLUSIVE_TTL_MS : INCONCLUSIVE_TTL_MS) });
}

/**
 * @param {string[]} urls candidate image URLs (untrusted: they came from a customer's website)
 * @param {{ post?: Function, workerUrl?: string, now?: () => number }} [deps] injectable for tests
 * @returns {Promise<object[]>} one probe per distinct input URL (max 6), in input order
 */
export async function verifyImageUrls(urls, { post = axios.post, workerUrl = process.env.PYTHON_WORKER_URL, now = Date.now } = {}) {
  const distinct = [...new Set((urls || []).filter((u) => typeof u === 'string' && u.trim()).map((u) => u.trim()))].slice(0, MAX_PER_CALL);
  const out = new Map();
  const toFetch = [];

  for (const url of distinct) {
    const syntactic = checkPublicWebsiteUrl(url);
    if (!syntactic.ok) { out.set(url, unverified(url, 'blocked', syntactic.reason)); continue; }
    const hit = cache.get(url);
    if (hit && hit.expiresAt > now()) { out.set(url, hit.probe); continue; }
    toFetch.push(url);
  }

  if (toFetch.length) {
    if (!workerUrl) {
      toFetch.forEach((u) => out.set(u, unverified(u, 'worker_unavailable', 'Image verification is not configured (PYTHON_WORKER_URL)')));
    } else {
      try {
        const res = await post(`${workerUrl}/api/verify-logo-candidates`, { urls: toFetch }, { timeout: REQUEST_TIMEOUT_MS, headers: { 'Content-Type': 'application/json' } });
        const results = res?.data?.success ? res.data.data?.results : null;
        if (!Array.isArray(results)) throw new Error(res?.data?.error || 'empty response');
        for (const probe of results) {
          if (!probe || typeof probe.url !== 'string' || !toFetch.includes(probe.url)) continue; // never trust URLs the worker did not get from us
          out.set(probe.url, probe);
          remember(probe, now());
        }
      } catch (err) {
        // Deliberately logs the failure class only — never the URLs or any response body.
        console.warn(`[IMAGE_VERIFY] worker call failed: ${err.code || err.message}`);
      }
      for (const u of toFetch) if (!out.has(u)) out.set(u, unverified(u, 'worker_unavailable', 'The verification service could not be reached'));
    }
  }

  return distinct.map((u) => out.get(u));
}

export default { verifyImageUrls, resetImageProbeCache };
