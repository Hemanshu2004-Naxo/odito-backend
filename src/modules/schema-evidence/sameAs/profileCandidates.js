/**
 * profileCandidates — turns raw sightings (links on pages, sameAs already declared in JSON-LD, crawl-stored social links,
 * connected-account profiles) into a ranked, honest list of candidate organization profiles. Pure.
 *
 * Nothing here invents a URL: every candidate is a value that was SEEN somewhere, with the page it was seen on, how it was found,
 * and why it is (or is not) trusted. The reliability order of the brief is encoded as scores:
 *
 *   1. declared in the site's own Organization JSON-LD        strongest — the owner already published it
 *   2. organization-level link in the header / footer / navigation (repeated on several pages = stronger)
 *   3. a "follow us" block on a home / contact / about page, or a link found only on other same-site pages
 *   4. a profile of a connected Odito integration             verified by the OWNER's OAuth connection, but not the same as a link
 *
 * Confidence is a ranking aid for the SCREEN, never a licence to write: only a 'high' candidate is pre-selected, a weak or
 * ambiguous one is never selected for the user, and the user's explicit approval of the exact URLs is what authorises a write.
 * Whether a profile URL answers is deliberately not checked (the server does not request arbitrary external URLs): every
 * candidate says `reachability: 'not_checked'`.
 */

import crypto from 'crypto';
import { evaluateProfileUrl, handleMatchesOrganization } from './profileUrl.js';

export const MAX_CANDIDATES = 24;
const CHROME = new Set(['header', 'footer', 'nav']);
const CHROME_LIKE = new Set(['header', 'footer', 'nav', 'sidebar']);

export const pageRoleOf = (url) => {
  try {
    const u = new URL(url);
    const p = u.pathname.replace(/\/+$/, '').toLowerCase() || '/';
    if (p === '/' && !u.search) return 'home';
    if (/(^|\/)(contact|contact-us|contactus|get-in-touch|reach-us|connect)(\/|$)/.test(p)) return 'contact';
    if (/(^|\/)(about|about-us|aboutus|who-we-are|our-story|company|our-company|team|our-team)(\/|$)/.test(p)) return 'about';
    return 'other';
  } catch { return 'other'; }
};

const idOf = (identityKey) => crypto.createHash('sha1').update(identityKey).digest('hex').slice(0, 12);

const ORDER = { suggested: 0, needs_confirmation: 1, weak: 2, already_present: 3 };
const PLATFORM_ORDER = ['linkedin', 'facebook', 'instagram', 'x', 'youtube', 'pinterest', 'tiktok', 'threads', 'github', 'google_business'];

/**
 * @param {object} input
 * @param {{url: string, links?: object[], schema?: {organizations: object[], persons: object[]}}[]} input.pages   live-parsed pages
 * @param {{platform?: string, url: string, sourceUrl?: string}[]} [input.crawlLinks]  links the crawler stored (seo_social_links)
 * @param {{url: string, label?: string, detail?: string}[]} [input.integrationProfiles]
 * @param {string[]} [input.existingSameAs]    values the TARGET Organization entity already publishes
 * @param {string} input.siteUrl
 * @param {string[]} [input.organizationNames]
 * @returns {{ candidates: object[], rejected: object[], ignored: Record<string, number>, conflicts: object[] }}
 */
export function buildCandidates({ pages = [], crawlLinks = [], integrationProfiles = [], existingSameAs = [], siteUrl, organizationNames = [] }) {
  const siteHost = (() => { try { return new URL(siteUrl).hostname; } catch { return ''; } })();
  const groups = new Map(); // identityKey -> aggregate
  const rejected = new Map(); // comparison text -> record
  const ignored = {};
  const bump = (code) => { ignored[code] = (ignored[code] || 0) + 1; };

  const group = (r) => {
    if (!groups.has(r.identityKey)) {
      groups.set(r.identityKey, { evaluated: r, sightings: [], declared: false, declaredOn: new Set(), integration: null, forms: new Set() });
    }
    const g = groups.get(r.identityKey);
    g.forms.add(r.url);
    return g;
  };

  const reject = (raw, r, sighting) => {
    // Share buttons, tracking pixels, logins and the like are noise: counted, not listed. Personal/third-party/ambiguous things are
    // listed, because the user might wonder why a visible link did not become a suggestion.
    const listed = ['PERSONAL_PROFILE', 'THIRD_PARTY_CONTEXT', 'NOT_A_PROFILE', 'POST_LINK', 'UNSUPPORTED_PLATFORM'].includes(r.code);
    if (!listed || r.code === 'UNSUPPORTED_PLATFORM') { bump(r.code); return; }
    const key = String(raw).slice(0, 300);
    const prior = rejected.get(key) || { url: key, code: r.code, message: r.message, platform: r.platform || null, pages: new Set() };
    if (sighting?.pageUrl) prior.pages.add(sighting.pageUrl);
    rejected.set(key, prior);
  };

  // ── 1. sameAs declared in the site's own Organization JSON-LD (any page parsed live) ─────────────────────────────
  for (const page of pages) {
    for (const org of page.schema?.organizations || []) {
      for (const value of org.sameAs || []) {
        const r = evaluateProfileUrl(value, { siteUrl, source: 'schema' });
        if (!r.ok) { if (r.code !== 'UNSUPPORTED_PLATFORM') bump(`SCHEMA_${r.code}`); continue; }
        const g = group(r);
        g.declared = true; g.declaredOn.add(org.id || page.url);
        g.sightings.push({ method: 'organization_schema', pageUrl: page.url, placement: 'schema', detail: org.id || null });
      }
    }
  }

  // ── 2./3. links on live-fetched same-site pages ───────────────────────────────────────────────────────────────
  for (const page of pages) {
    const role = pageRoleOf(page.url);
    for (const link of page.links || []) {
      const r = evaluateProfileUrl(link.href, { siteUrl, source: 'discovered' });
      const sighting = { method: 'page_link', pageUrl: page.url, pageRole: role, placement: link.placement, followBlock: !!link.followBlock, label: link.label || link.text || null };
      if (!r.ok) { reject(link.href, r, sighting); continue; }
      if (link.shareBlock) { bump('SHARE_LINK'); continue; }
      if (link.personBlock) {
        reject(link.href, { code: 'THIRD_PARTY_CONTEXT', message: 'This link sits inside a team-member, testimonial, author, comment or client block, so it most likely belongs to a person or another business, not to the organization.', platform: r.platform }, sighting);
        continue;
      }
      group(r).sightings.push(sighting);
    }
  }

  // ── crawl-stored social links (sourceUrl = page it was found on) ─────────────────────────────────────────────
  for (const link of crawlLinks) {
    const r = evaluateProfileUrl(link.url, { siteUrl, source: 'discovered' });
    if (!r.ok) { reject(link.url, r, { pageUrl: link.sourceUrl }); continue; }
    group(r).sightings.push({ method: 'crawl_social_link', pageUrl: link.sourceUrl || null, pageRole: link.sourceUrl ? pageRoleOf(link.sourceUrl) : 'other', placement: 'crawl', label: null });
  }

  // ── 4. connected integrations ───────────────────────────────────────────────────────────────────────────────
  for (const profile of integrationProfiles) {
    const r = evaluateProfileUrl(profile.url, { siteUrl, source: 'integration' });
    if (!r.ok) { bump(`INTEGRATION_${r.code}`); continue; }
    const g = group(r);
    g.integration = { label: profile.label || null, detail: profile.detail || null };
    g.sightings.push({ method: 'connected_integration', pageUrl: null, placement: 'integration', detail: profile.detail || null });
  }

  const presentKeys = new Set();
  for (const value of existingSameAs) {
    const r = evaluateProfileUrl(value, { siteUrl, source: 'schema' });
    if (r.ok) { presentKeys.add(r.identityKey); presentKeys.add(r.comparisonKey); }
  }

  // ── score ───────────────────────────────────────────────────────────────────────────────────────────────────
  const candidates = [];
  for (const g of groups.values()) {
    const r = g.evaluated;
    const alreadyPresent = presentKeys.has(r.identityKey) || presentKeys.has(r.comparisonKey);
    const reasons = [];
    let score = 0;

    const pageSightings = g.sightings.filter((s) => s.method === 'page_link' || s.method === 'crawl_social_link');
    const chromePages = new Set(pageSightings.filter((s) => CHROME.has(s.placement)).map((s) => s.pageUrl));
    const chromeLikePages = new Set(pageSightings.filter((s) => CHROME_LIKE.has(s.placement)).map((s) => s.pageUrl));
    const homeChrome = pageSightings.some((s) => CHROME.has(s.placement) && s.pageRole === 'home');
    const followOnKeyPage = pageSightings.some((s) => s.placement === 'content' && s.followBlock && ['home', 'contact', 'about'].includes(s.pageRole));
    const crawlPages = new Set(pageSightings.filter((s) => s.method === 'crawl_social_link').map((s) => s.pageUrl));
    const otherPages = new Set(pageSightings.map((s) => s.pageUrl));

    if (g.declared) { score += 100; reasons.push('Already declared in the Organization structured data this site publishes.'); }
    if (g.integration) { score += 60; reasons.push('Belongs to an account connected to this project in Odito.'); }
    if (homeChrome) { score += 55; reasons.push('Linked from the header or footer of the home page.'); }
    else if (chromePages.size) { score += 40; reasons.push('Linked from the header or footer of a page on this site.'); }
    else if (chromeLikePages.size) { score += 25; reasons.push('Linked from a sidebar widget.'); }
    if (chromePages.size >= 2) { score += 20; reasons.push(`The same link appears in the site chrome on ${chromePages.size} pages.`); }
    if (!chromePages.size && followOnKeyPage) { score += 35; reasons.push('Listed in a "follow us" block on the home, contact or about page.'); }
    if (!chromePages.size && !chromeLikePages.size && !followOnKeyPage && pageSightings.some((s) => s.placement === 'content')) { score += 10; reasons.push('Linked from page content only.'); }
    if (crawlPages.size && !chromePages.size && !followOnKeyPage) { score += 20 + (crawlPages.size >= 2 ? 10 : 0); reasons.push(`Found in the stored crawl on ${crawlPages.size} page${crawlPages.size === 1 ? '' : 's'}.`); }
    if (r.kind === 'organization') { score += 15; reasons.push('The address itself is an organization/company page.'); }
    if (handleMatchesOrganization(r.handle, { names: organizationNames, siteHost })) { score += 15; reasons.push('The profile name matches the organization name.'); }
    if (r.kind === 'ambiguous') score -= 20;

    const warnings = [...r.warnings];
    candidates.push({ g, r, alreadyPresent, score, reasons, warnings, otherPages });
  }

  // Two different profiles of the SAME network that nothing declares: Odito cannot tell which one is the organization's.
  const byPlatform = new Map();
  for (const c of candidates) {
    if (c.alreadyPresent || c.g.declared) continue;
    byPlatform.set(c.r.platform, [...(byPlatform.get(c.r.platform) || []), c]);
  }
  const conflicts = [];
  const markConflict = (platform, list) => {
    conflicts.push({ platform, urls: list.map((c) => c.r.url) });
    for (const c of list) {
      c.conflict = true;
      c.warnings.push({ code: 'PLATFORM_CONFLICT', message: `More than one ${c.r.platformLabel} profile was found. Pick the one that is the organization's.` });
    }
  };
  for (const [platform, list] of byPlatform) {
    if (platform === 'other') continue;
    // A profile that exists ONLY as a connected account (its address is usually the numeric-ID form) does not make the profile the SITE
    // links ambiguous: they are most likely the same page. It is kept, flagged, and never pre-selected; the site-linked one keeps its rank.
    const integrationOnly = list.filter((c) => c.g.integration && c.g.sightings.every((x) => x.method === 'connected_integration'));
    const siteBased = list.filter((c) => !integrationOnly.includes(c));
    if (siteBased.length >= 2) markConflict(platform, siteBased);
    else if (!siteBased.length && integrationOnly.length >= 2) markConflict(platform, integrationOnly);
    if (siteBased.length) {
      for (const c of integrationOnly) {
        c.warnings.push({ code: 'SITE_LINKS_ANOTHER_ADDRESS', message: `Your site links ${siteBased[0].r.platformLabel} at ${siteBased[0].r.url}. This connected page may be the same one under its ID address — add only one of them.` });
      }
    }
  }

  const out = candidates.map((c) => {
    const { g, r } = c;
    let confidence = c.score >= 70 ? 'high' : c.score >= 40 ? 'medium' : 'low';
    if ((r.kind === 'ambiguous' || c.conflict) && confidence === 'high') confidence = 'medium';
    const status = c.alreadyPresent ? 'already_present' : confidence === 'high' ? 'suggested' : confidence === 'medium' ? 'needs_confirmation' : 'weak';
    const verification = g.declared ? 'declared_in_schema' : g.integration ? 'integration_connected' : c.otherPages.size ? 'linked_from_site' : 'unverified';
    return {
      id: idOf(r.identityKey),
      url: [...g.forms][0],
      alternateForms: [...g.forms].slice(1),
      comparisonKey: r.comparisonKey,
      identityKey: r.identityKey,
      platform: r.platform, platformLabel: r.platformLabel, kind: r.kind, handle: r.handle,
      confidence, score: Math.max(0, Math.min(100, Math.round(c.score))), status,
      preselected: status === 'suggested',
      verification,
      // The server never requests a third-party URL to "validate" it, so reachability is unknown by design.
      reachability: 'not_checked',
      reasons: c.reasons,
      warnings: c.warnings,
      sources: g.sightings.slice(0, 12).map((s) => ({ method: s.method, pageUrl: s.pageUrl || null, placement: s.placement || null, detail: s.detail || s.label || null })),
      normalized: r.normalized,
      integration: g.integration || null,
    };
  });

  out.sort((a, b) => (ORDER[a.status] - ORDER[b.status])
    || (b.score - a.score)
    || ((PLATFORM_ORDER.indexOf(a.platform) + 1 || 99) - (PLATFORM_ORDER.indexOf(b.platform) + 1 || 99))
    || a.url.localeCompare(b.url));

  return {
    candidates: out.slice(0, MAX_CANDIDATES),
    rejected: [...rejected.values()].slice(0, 20).map((x) => ({ url: x.url, code: x.code, message: x.message, platform: x.platform, pages: [...x.pages].slice(0, 3) })),
    ignored,
    conflicts,
  };
}

export default { buildCandidates, pageRoleOf, MAX_CANDIDATES };
