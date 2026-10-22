/**
 * navigationPolicy — what a rendered page is allowed to request. One instance per render.
 *
 * Decided per request, BEFORE it leaves the browser (the browser service aborts anything denied):
 *   - GET only; http/https only (data:/blob: only for non-document subresources); no credentials, ports 80/443 only
 *   - document navigations (main frame, iframes, EVERY redirect hop) must stay on the audited site's host
 *   - every host is resolved through the same ssrfGuard used by plain fetches; a host with ANY non-public address is refused
 *   - heavy/irrelevant resource types are not fetched (images, media, fonts, websockets, event sources, pings)
 *   - hard caps on request count and total transferred bytes: a page cannot trigger unbounded subresource traffic
 *
 * Chromium resolves DNS itself, so a connection cannot be pinned the way plain fetches are. That residual window is closed AFTER the fact:
 * every response's actual remote IP is checked (`recordResponse`); if any was non-public the whole render is discarded as a violation.
 * (A single GET may have reached an internal address in that case; nothing from it is ever used or returned.)
 */

import { resolveSafeTarget, isBlockedIp, SafeFetchError } from '../net/ssrfGuard.js';

export const POLICY_REASON = Object.freeze({
  METHOD: 'method_not_allowed',
  SCHEME: 'scheme_not_allowed',
  RESOURCE_TYPE: 'resource_type_blocked',
  CROSS_SITE_NAVIGATION: 'cross_site_navigation',
  REQUEST_CAP: 'request_cap_exceeded',
  BYTE_CAP: 'byte_cap_exceeded',
  CLOSED: 'render_finished',
});

const BLOCKED_TYPES = new Set(['image', 'media', 'font', 'websocket', 'eventsource', 'texttrack', 'manifest', 'other', 'ping', 'cspviolationreport', 'prefetch', 'signedexchange']);
const hostKey = (u) => { try { const x = new URL(u); return `${x.protocol}//${x.hostname.toLowerCase()}:${x.port || (x.protocol === 'https:' ? 443 : 80)}`; } catch { return null; } };
const bareHost = (u) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; } };

export class RenderPolicyViolation extends Error {
  constructor(message, details = {}) { super(message); this.name = 'RenderPolicyViolation'; this.code = 'RENDER_POLICY_VIOLATION'; this.details = details; }
}

export function createNavigationPolicy({ siteUrl, guard = resolveSafeTarget, isBlockedAddress = isBlockedIp, maxRequests = 150, maxBytes = 8 * 1024 * 1024, maxBlockedLog = 25 } = {}) {
  const siteHost = bareHost(siteUrl);
  const allowedHosts = new Map(); // host key -> Promise<{ ok, reason }>
  const counts = { total: 0, allowed: 0, blocked: 0 };
  const blockedByReason = {};
  const blockedSample = [];
  const thirdPartyHosts = new Set();
  let bytes = 0; let closed = false; let violation = null;

  const block = (url, reason, resourceType) => {
    counts.blocked += 1; blockedByReason[reason] = (blockedByReason[reason] || 0) + 1;
    if (blockedSample.length < maxBlockedLog) blockedSample.push({ url: String(url).slice(0, 200), reason, resourceType });
    return { allow: false, reason };
  };

  async function hostAllowed(url) {
    const key = hostKey(url);
    if (!key) return { ok: false, reason: 'invalid_url' };
    if (!allowedHosts.has(key)) {
      allowedHosts.set(key, guard(url).then(() => ({ ok: true }), (e) => ({ ok: false, reason: e instanceof SafeFetchError ? e.code : 'host_check_failed' })));
    }
    return allowedHosts.get(key);
  }

  return {
    /** @param {{ url: string, method?: string, resourceType?: string, isNavigation?: boolean }} req */
    async check({ url, method = 'GET', resourceType = 'other', isNavigation = false }) {
      counts.total += 1;
      if (closed) return block(url, POLICY_REASON.CLOSED, resourceType);
      if (counts.total > maxRequests) return block(url, POLICY_REASON.REQUEST_CAP, resourceType);
      if (bytes > maxBytes) return block(url, POLICY_REASON.BYTE_CAP, resourceType);
      if (String(method).toUpperCase() !== 'GET') return block(url, POLICY_REASON.METHOD, resourceType);

      let parsed;
      try { parsed = new URL(url); } catch { return block(url, 'invalid_url', resourceType); }
      const document = isNavigation || resourceType === 'document';
      if (parsed.protocol === 'data:' || parsed.protocol === 'blob:') {
        if (document) return block(url, POLICY_REASON.SCHEME, resourceType);
        counts.allowed += 1; return { allow: true };
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return block(url, POLICY_REASON.SCHEME, resourceType);
      if (!document && BLOCKED_TYPES.has(resourceType)) return block(url, POLICY_REASON.RESOURCE_TYPE, resourceType);
      if (document && bareHost(url) !== siteHost) return block(url, POLICY_REASON.CROSS_SITE_NAVIGATION, resourceType);

      const host = await hostAllowed(url);
      if (!host.ok) return block(url, host.reason, resourceType);
      if (bareHost(url) !== siteHost) thirdPartyHosts.add(parsed.hostname.toLowerCase());
      counts.allowed += 1;
      return { allow: true };
    },

    /**
     * Where the page ENDED (after client-side redirects). Not a request: not counted, not subject to the caps; only the site/scheme/host rules apply.
     * Chrome's own error pages (chrome-error://) mean a navigation was blocked or failed: the DOM is no longer the audited page.
     */
    async checkFinalUrl(url) {
      let parsed;
      try { parsed = new URL(url); } catch { return { allow: false, reason: 'invalid_url' }; }
      if (parsed.protocol === 'chrome-error:') return { allow: false, reason: 'navigation_blocked_or_failed' };
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { allow: false, reason: POLICY_REASON.SCHEME };
      if (bareHost(url) !== siteHost) return { allow: false, reason: POLICY_REASON.CROSS_SITE_NAVIGATION };
      const host = await hostAllowed(url);
      return host.ok ? { allow: true } : { allow: false, reason: host.reason };
    },

    addBytes(n) { bytes += Math.max(0, Number(n) || 0); },

    /** Post-hoc DNS-rebinding defence: the address the browser actually connected to must be public. */
    recordResponse({ url, remoteAddress }) {
      if (!remoteAddress || violation) return;
      const ip = String(remoteAddress).replace(/^\[|\]$/g, '');
      if (isBlockedAddress(ip)) violation = new RenderPolicyViolation('A request connected to a non-public address; the render was discarded.', { url: String(url).slice(0, 200), remoteAddress: ip });
    },

    assertClean() { if (violation) throw violation; },
    close() { closed = true; },

    summary() {
      return {
        total: counts.total, allowed: counts.allowed, blocked: counts.blocked, blockedByReason: { ...blockedByReason },
        blockedSample: [...blockedSample], thirdPartyHosts: [...thirdPartyHosts].slice(0, 25), bytes, byteCapHit: bytes > maxBytes, requestCapHit: counts.total > maxRequests,
      };
    },
  };
}

export default { createNavigationPolicy, POLICY_REASON, RenderPolicyViolation };
