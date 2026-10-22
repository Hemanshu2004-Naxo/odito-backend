/**
 * schemaEvidence — what ODITO can actually PROVE about a page's Organization, breadcrumb
 * trail and article, built only from data the crawler stored for that page.
 *
 * The recommendation pipeline used to hand the model a page URL and a title and ask it for
 * "name, url, logo, contactPoint". Anything it could not know (a logo URL, a phone number,
 * a parent page) it invented, and the validator only checked that the JSON parsed. This
 * module is the other half of that contract: a structured, three-way account of every value
 * that may appear in generated schema —
 *
 *   verified      observed on the site AND (for URLs that matter) fetched and confirmed
 *   observed      seen on the site but not confirmed (e.g. a declared width/height)
 *   missing       nothing found; the generator must omit it and ask the owner
 *
 * `buildSchemaEvidence` is pure (no I/O). Image URLs are verified by schemaEvidenceService
 * (network, SSRF-safe, in the Python worker) and folded back in by `applyImageProbes`.
 */

import crypto from 'crypto';
import { breadcrumbUrlKey, sameTrail } from './breadcrumbHierarchy.js';
import {
  analyzeBreadcrumbs, analyzeOrganizations, asArray, findDuplicateEntities, flattenJsonLd,
  hasType, isArticleNode, isOrganizationNode, logoCandidatesFromSchema, nodeById,
  parseSchemaDate, pickDisplayUrl, resolveHttpUrl, sameSite, typesOf,
} from './schemaGraph.js';
import { INTENTS, collectVerifiedFacts, intentFingerprintMaterial, intentNameFor, pickName, resolveSchemaIntent } from './schemaIntent.js';
import { organizationDelta } from './organizationMarkup.js';
import { assessOrganizationAddress, collectAddressCandidates, summarizeAddressAssessment } from './organizationAddress.js';

export const SCHEMA_EVIDENCE_VERSION = 1;

/** Issue ids (legacy rule ids and V2 hub ids) whose recommendation emits Organization / Article / BreadcrumbList markup. */
const ORGANIZATION_ISSUES = new Set(['organization_schema', 'primary_organization_schema', 'schema_markup', 'aiso-a1', 'geo-s5']);
const ARTICLE_ISSUES = new Set(['article_schema', 'geo-s2']);
const BREADCRUMB_ISSUES = new Set(['breadcrumblist_schema']);

export function evidenceKindsFor(issueId) {
  const id = String(issueId || '').toLowerCase();
  const kinds = [];
  if (ORGANIZATION_ISSUES.has(id)) kinds.push('organization');
  if (ARTICLE_ISSUES.has(id)) kinds.push('article');
  if (BREADCRUMB_ISSUES.has(id)) kinds.push('breadcrumb');
  return kinds;
}

const first = (v) => (Array.isArray(v) ? v[0] : v);
const stableJson = (v) => JSON.stringify(v, (_k, val) => (val && typeof val === 'object' && !Array.isArray(val) ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => (a < b ? -1 : 1))) : val));
const metaOne = (meta, key) => {
  const v = first(meta?.[key]);
  return typeof v === 'string' && v.trim() ? v.trim() : null;
};
const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

const CONTACT_FIELDS = ['telephone', 'email', 'address', 'contactPoint', 'sameAs', 'faxNumber'];

/** Only values the site itself publishes in its Organization markup — never inferred, never page-text-guessed. */
function existingContact(primary) {
  const out = {};
  if (!primary) return out;
  for (const f of CONTACT_FIELDS) {
    const v = primary[f];
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
    out[f] = v;
  }
  return out;
}

const LOGO_FILE_HINT = /(^|[^a-z0-9])logo([^a-z0-9]|$)/i;

/** <img> elements the page itself marks as a logo (file name or alt text contains the word "logo"). Hints, never proof. */
function htmlLogoHints(images, pageUrl, limit = 4) {
  const out = [];
  const seen = new Set();
  for (const img of asArray(images)) {
    const src = typeof img?.src === 'string' ? img.src : null;
    if (!src || /^data:/i.test(src)) continue;
    const url = resolveHttpUrl(src, pageUrl);
    if (!url || seen.has(url)) continue;
    let file = '';
    try { file = decodeURIComponent(new URL(url).pathname.split('/').pop() || ''); } catch { file = ''; }
    const alt = typeof img.alt === 'string' ? img.alt : '';
    if (!LOGO_FILE_HINT.test(file) && !LOGO_FILE_HINT.test(alt)) continue;
    if (/\b(client|partner|brand|sponsor|customer|affiliate|award|badge)s?\b/i.test(`${file} ${alt}`)) continue;
    seen.add(url);
    out.push({ url, source: 'html_img', declaredWidth: null, declaredHeight: null });
    if (out.length >= limit) break;
  }
  return out;
}

function articleApplicability({ nodes, meta, pageUrl, pageType, wordCount, h1 }) {
  const existing = nodes.find(isArticleNode);
  if (existing) return { applicable: true, reason: 'The page already declares Article markup.' };
  if (/^article$/i.test(metaOne(meta, 'og:type') || '')) return { applicable: true, reason: 'og:type is "article".' };
  if (metaOne(meta, 'article:published_time')) return { applicable: true, reason: 'The page declares article:published_time.' };

  const type = String(pageType || '').toLowerCase();
  if (type === 'article' || type === 'blog') {
    let segments = 0;
    try { segments = new URL(pageUrl).pathname.split('/').filter(Boolean).length; } catch { /* ignore */ }
    if (segments >= 2 && (wordCount || 0) >= 300 && h1) {
      return { applicable: true, reason: `Classified as ${type} with a single post-style path, a heading and ${wordCount} words.` };
    }
    return { applicable: false, reason: 'The URL looks like a blog/article section but the page has no publication date, article og:type, existing Article markup, or post-like path and length — it may be an index page.' };
  }
  return { applicable: false, reason: `The page is classified as "${pageType || 'unknown'}", not an article.` };
}

/**
 * @param {object}   p
 * @param {string}   p.issueId
 * @param {string}   p.pageUrl                crawl URL of the page (identity key, see pickDisplayUrl)
 * @param {object|null} p.pageData            seo_page_data document (may be null when the page was not stored)
 * @param {object}   [p.headingsByTag]
 * @param {string}   [p.pageType]
 */
export function buildSchemaEvidence({ issueId, pageUrl, pageData, headingsByTag = {}, pageType = null, userBreadcrumb = null, site = null, profile = null, addressSources = null }) {
  const kinds = evidenceKindsFor(issueId);
  const data = pageData || {};
  const meta = data.meta_tags || {};
  const nodes = flattenJsonLd(data.structured_data);

  const display = pickDisplayUrl({ canonical: first(data.canonical), pageUrl });
  const baseForRelative = display.url || pageUrl;
  let siteUrl = null;
  try { siteUrl = new URL(pageUrl).origin + '/'; } catch { siteUrl = null; }

  const orgs = analyzeOrganizations(nodes, { siteUrl: siteUrl || undefined });
  const primary = orgs.primary;
  const website = nodes.find((n) => typesOf(n).includes('WebSite') && (!n.url || !siteUrl || sameSite(resolveHttpUrl(n.url, siteUrl) || '', siteUrl)));

  // ── Organization ──────────────────────────────────────────────────────────
  const nameFromSchema = clean(primary?.name);
  const nameFromWebsite = clean(website?.name);
  const nameFromOg = metaOne(meta, 'og:site_name');
  const name = nameFromSchema ? { value: nameFromSchema, source: 'existing_organization_schema', verified: true }
    : nameFromWebsite ? { value: nameFromWebsite, source: 'existing_website_schema', verified: true }
      : nameFromOg ? { value: nameFromOg, source: 'og:site_name', verified: true }
        : null;

  const logoCandidates = [
    ...logoCandidatesFromSchema(nodes, primary, baseForRelative).map((c) => ({ ...c, trust: 'existing_schema' })),
  ];
  if (kinds.includes('organization')) {
    const have = new Set(logoCandidates.map((c) => c.url));
    for (const h of htmlLogoHints(data.images, baseForRelative)) {
      if (!have.has(h.url)) logoCandidates.push({ ...h, trust: 'html_hint' });
    }
  }

  const organization = {
    present: !!primary,
    primary: primary ? {
      id: typeof primary['@id'] === 'string' ? primary['@id'] : null,
      types: typesOf(primary),
      node: primary,
    } : null,
    id: typeof primary?.['@id'] === 'string' ? primary['@id'] : null,
    url: (() => { const u = resolveHttpUrl(primary?.url, siteUrl || undefined); return u && siteUrl && sameSite(u, siteUrl) ? u : null; })(),
    homepageUrl: siteUrl,
    name,
    duplicateIds: orgs.duplicateIds,
    conflictingEntities: orgs.conflicting,
    entityCount: orgs.count,
    foreignEntityCount: orgs.foreign.length,
    contact: existingContact(primary),
    logo: { candidates: logoCandidates, verified: null, status: logoCandidates.length ? 'unverified' : 'none', existing: !!primary?.logo },
  };
  if (kinds.includes('organization')) enrichOrganizationWithIntent(organization, { pageUrl, pageType, site, profile, nodes, addressSources });

  // ── Breadcrumb ────────────────────────────────────────────────────────────
  const crumbs = analyzeBreadcrumbs(nodes, { pageUrl: baseForRelative });
  const goodList = crumbs.lists.find((l) => !l.problems.length && l.items.length >= 2) || null;
  const pageLabel = clean(first(headingsByTag?.h1)) || clean(data.title);
  const existingItems = goodList ? goodList.items.map((i) => ({ position: i.position, name: i.name, url: i.url })) : [];

  // The owner-confirmed hierarchy counts only while its LAST item is still this page's canonical URL
  // (a canonical that changed since the submission makes the saved trail stale, never silently reused).
  let user = null;
  if (userBreadcrumb?.items?.length >= 2) {
    const last = userBreadcrumb.items[userBreadcrumb.items.length - 1];
    const stale = !display.url || breadcrumbUrlKey(last.url) !== breadcrumbUrlKey(display.url);
    user = { items: userBreadcrumb.items, evidenceHash: userBreadcrumb.evidenceHash || null, submittedAt: userBreadcrumb.submittedAt || null, regeneratedAt: userBreadcrumb.regeneratedAt || null, canonicalSource: userBreadcrumb.canonicalSource || null, stale };
  }
  const usableUser = user && !user.stale ? user : null;

  // status:
  //   existing       the page already outputs a valid trail (and the owner supplied nothing different) -> unchanged behaviour
  //   user_provided  no BreadcrumbList on the page; the owner's confirmed hierarchy is the evidence
  //   conflict       a BreadcrumbList already exists AND the owner's hierarchy differs / the existing one is invalid:
  //                  generating another would create a duplicate entity, so nothing is generated
  //   unknown        nothing verified -> ask the owner
  let hierarchy;
  let conflict = null;
  if (goodList && (!usableUser || sameTrail(existingItems, usableUser.items))) {
    hierarchy = { status: 'existing', items: existingItems };
  } else if (goodList && usableUser) {
    hierarchy = { status: 'conflict', items: [] };
    conflict = { kind: 'existing_valid_differs', existingItems };
  } else if (usableUser && crumbs.count > 0) {
    hierarchy = { status: 'conflict', items: [] };
    conflict = { kind: 'existing_invalid', existingProblems: crumbs.lists.flatMap((l) => l.problems) };
  } else if (usableUser) {
    hierarchy = { status: 'user_provided', items: usableUser.items };
  } else {
    hierarchy = { status: 'unknown', items: [], current: display.url ? { name: pageLabel, url: display.url } : null };
  }
  const breadcrumb = {
    existing: crumbs.lists.map((l) => ({ id: l.id, itemCount: l.items.length, problems: l.problems })),
    duplicateLists: crumbs.duplicateLists,
    hierarchy,
    conflict,
    userProvided: user,
    needsInput: hierarchy.status === 'unknown',
  };

  // ── Article ───────────────────────────────────────────────────────────────
  const h1 = clean(first(headingsByTag?.h1));
  const applic = articleApplicability({ nodes, meta, pageUrl, pageType, wordCount: data.word_count, h1 });
  const existingArticle = nodes.find(isArticleNode) || null;
  const dateProblems = [];
  const dateOf = (existingValue, metaKey, field) => {
    const candidates = [
      existingValue != null ? { raw: existingValue, source: 'existing_article_schema' } : null,
      metaOne(meta, metaKey) ? { raw: metaOne(meta, metaKey), source: metaKey } : null,
    ].filter(Boolean);
    for (const c of candidates) {
      const p = parseSchemaDate(typeof c.raw === 'string' ? c.raw : String(c.raw));
      if (p.valid) return { value: p.value, hasTimezone: p.hasTimezone, source: c.source, epochMs: p.epochMs };
      dateProblems.push({ field, source: c.source, reason: p.reason });
    }
    return null;
  };
  const datePublished = dateOf(existingArticle?.datePublished, 'article:published_time', 'datePublished');
  const dateModified = dateOf(existingArticle?.dateModified, 'article:modified_time', 'dateModified')
    || dateOf(null, 'og:updated_time', 'dateModified');
  if (datePublished && dateModified && dateModified.epochMs < datePublished.epochMs) {
    dateProblems.push({ field: 'dateModified', source: dateModified.source, reason: 'modified_before_published' });
  }

  let authorName = null; let authorSource = null;
  const artAuthor = existingArticle?.author;
  for (const a of asArray(artAuthor)) {
    const target = a && typeof a === 'object' && !a.name && a['@id'] ? nodeById(nodes, a['@id']) : a;
    const n = typeof a === 'string' ? clean(a) : clean(target?.name);
    if (n) { authorName = n; authorSource = 'existing_article_schema'; break; }
  }
  if (!authorName && metaOne(meta, 'author')) { authorName = metaOne(meta, 'author'); authorSource = 'meta:author'; }

  const articleImageCandidates = [];
  const pushImg = (raw, source) => {
    const url = resolveHttpUrl(typeof raw === 'string' ? raw : raw?.url, baseForRelative);
    if (url && !articleImageCandidates.some((c) => c.url === url)) articleImageCandidates.push({ url, source, trust: source === 'existing_article_schema' ? 'existing_schema' : 'page_meta' });
  };
  if (kinds.includes('article')) {
    asArray(existingArticle?.image).forEach((i) => pushImg(i, 'existing_article_schema'));
    pushImg(metaOne(meta, 'og:image'), 'og:image');
  }

  const headline = clean(existingArticle?.headline) ? { value: clean(existingArticle.headline), source: 'existing_article_schema' }
    : h1 ? { value: h1, source: 'h1' } : clean(data.title) ? { value: clean(data.title), source: 'title' } : null;

  const article = {
    applicable: applic.applicable,
    reason: applic.reason,
    existing: !!existingArticle,
    existingType: existingArticle ? typesOf(existingArticle) : [],
    type: /^blog$/i.test(String(pageType || '')) || typesOf(existingArticle).includes('BlogPosting') ? 'BlogPosting' : 'Article',
    headline,
    datePublished: datePublished ? { value: datePublished.value, hasTimezone: datePublished.hasTimezone, source: datePublished.source } : null,
    dateModified: dateModified ? { value: dateModified.value, hasTimezone: dateModified.hasTimezone, source: dateModified.source } : null,
    author: authorName ? { name: authorName, source: authorSource } : null,
    image: { candidates: articleImageCandidates, verified: null, status: articleImageCandidates.length ? 'unverified' : 'none' },
    mainEntityOfPage: display.trusted ? display.url : null,
    dateProblems,
  };
  article.missing = [
    !article.headline && 'headline',
    !article.datePublished && 'datePublished',
    !article.author && 'author',
    article.image.status === 'none' && 'image',
  ].filter(Boolean);

  const duplicates = findDuplicateEntities(nodes);

  const evidence = {
    version: SCHEMA_EVIDENCE_VERSION,
    kinds,
    issueId,
    pageUrl,
    pageDataAvailable: !!pageData,
    pageType,
    url: { display: display.url, source: display.source, trusted: display.trusted, selfReferencing: display.selfReferencing, crawlKey: pageUrl },
    organization,
    breadcrumb,
    article,
    duplicates,
    nodeCount: nodes.length,
  };
  evidence.fingerprintKey = fingerprintKeyOf(evidence);
  return evidence;
}

/**
 * Decides WHICH entity to recommend (see schemaIntent.js) and folds the site-level / Business Profile facts into the
 * organization evidence, so the guard, validator, prompt and UI all work from the same decision.
 *
 *   organization.intent        the decision (type, action, reasons, missing facts, reuse)
 *   organization.contact       the facts that MAY be published: this page's own, then the site entity's, then a
 *                              verified Business Profile's (page value always wins)
 *   organization.factSources   field -> where each published fact came from
 *   organization.name          falls back to the site entity / trusted profile when the page has none
 *   organization.id            falls back to the site entity's @id (reused, never re-minted)
 */
function enrichOrganizationWithIntent(organization, { pageUrl, pageType, site, profile, nodes = [], addressSources = null }) {
  // Where could this entity's address come from, and is any of it safe to publish? (organizationAddress.js)
  const candidates = collectAddressCandidates({
    pageNodes: nodes, primary: organization.primary?.node || null, site, profile,
    project: addressSources?.project || null, owner: addressSources?.owner || null, confirmed: addressSources?.confirmed || null,
  });
  const address = assessOrganizationAddress({
    primary: organization.primary?.node || null, candidates,
    entityHealth: { conflictingEntities: organization.conflictingEntities, duplicateIds: organization.duplicateIds },
  });
  organization.address = address;

  const intent = resolveSchemaIntent({ pageUrl, pageType, organization, site, profile, address });
  const physical = intent.types.some((t) => hasType({ '@type': t }, 'LocalBusiness'));
  const facts = collectVerifiedFacts({ organization, site, profile, physical });

  organization.pageId = organization.id;
  if (!organization.id && intent.id) organization.id = intent.id;
  organization.name = pickName(organization, site, profile) || organization.name;
  organization.factSources = Object.fromEntries(Object.entries(facts).map(([k, v]) => [k, v.source]));
  organization.contact = { ...Object.fromEntries(Object.entries(facts).map(([k, v]) => [k, v.value])), ...organization.contact };
  // The finding is about a missing/incomplete address: the assessed address (existing parts kept, gaps filled only from
  // verified evidence) is the entity's address fact. It replaces an INCOMPLETE existing value, which already is part of it.
  if (intent.addressDemand && intent.action === 'generate' && address.proposal) {
    organization.contact.address = JSON.parse(JSON.stringify(address.proposal.value));
    organization.factSources = { ...organization.factSources, address: address.proposal.sources[0] };
  }
  organization.site = site ? {
    found: !!site.found,
    primary: site.primary ? { pageUrl: site.primary.pageUrl, id: site.primary.id, types: site.primary.types, physical: site.primary.physical } : null,
    entityPages: (site.entityPageUrls || []).length,
    hasAddressEvidence: !!site.hasAddressEvidence,
    conflictingIds: site.conflictingIds || [],
    pagesScanned: site.pagesScanned || 0,
  } : null;
  organization.businessProfile = profile ? { available: !!profile.available, trusted: !!profile.trusted, reason: profile.reason || null, categoryLabel: profile.categoryLabel || null, schemaType: profile.schemaType || null } : null;
  organization.intent = intent;
  finalizeOrganizationIntent({ organization });
}

/**
 * A page that already declares a valid entity: is there anything verifiable to ADD or FIX on it?
 *   yes -> action `generate` (mode `extend_existing`): the existing entity, completed with verified facts only
 *   no  -> action `reuse`: nothing to change, nothing duplicated
 * Recomputed after image probing too (a verified logo can turn "reuse" into "add the logo"), so it is idempotent.
 */
export function finalizeOrganizationIntent(ev) {
  const i = ev.organization?.intent;
  if (!i || !i.existingEntity || i.action === 'needs_input') return ev;
  const delta = organizationDelta(ev);
  i.delta = delta;
  if (delta.length) { i.action = 'generate'; i.intent = intentNameFor(i.type); i.mode = 'extend_existing'; }
  else { i.action = 'reuse'; i.intent = INTENTS.ALREADY_PRESENT; i.mode = 'reuse'; }
  return ev;
}

/** Every URL that still needs fetching, in priority order (Organization logos, then the article image). */
export function imageUrlsToVerify(evidence) {
  const urls = [];
  if (evidence.kinds.includes('organization')) urls.push(...evidence.organization.logo.candidates.map((c) => c.url));
  if (evidence.kinds.includes('article') && evidence.article.applicable) urls.push(...evidence.article.image.candidates.map((c) => c.url));
  return [...new Set(urls)];
}

const resultFor = (probes, url) => probes.find((p) => p.url === url) || null;

/**
 * Folds probe results (python_workers api/image_probe.ImageProbe.to_dict()) back into the evidence.
 *
 * A logo is "verified" only when a probe fetched it successfully and it is an image by its bytes.
 * Declared width/height are kept as `declared*` and NEVER promoted to dimensions — only the
 * probe's measured size is used. A candidate that could not be probed (timeout, blocked, worker
 * down) stays unverified; it is not reported as broken, and it is not used.
 */
export function applyImageProbes(evidence, probes = []) {
  const ev = JSON.parse(JSON.stringify({ ...evidence, organization: { ...evidence.organization, primary: undefined } }));
  ev.organization.primary = evidence.organization.primary;

  for (const c of ev.organization.logo.candidates) c.probe = resultFor(probes, c.url);
  for (const c of ev.article.image.candidates) c.probe = resultFor(probes, c.url);

  const pick = (cands) => cands.find((c) => c.probe?.ok) || null;

  // Logo
  const logoOk = pick(ev.organization.logo.candidates);
  const existingCands = ev.organization.logo.candidates.filter((c) => c.trust === 'existing_schema');
  const existingBroken = existingCands.length > 0 && existingCands.every((c) => c.probe && !c.probe.ok && c.probe.conclusive);
  if (logoOk) {
    ev.organization.logo.verified = {
      // The site's own declared URL is kept as-is when it works; a weaker (HTML-hint) candidate that
      // redirected is published at the address it actually resolved to.
      url: logoOk.trust === 'existing_schema' ? logoOk.url : (logoOk.probe.final_url || logoOk.url),
      finalUrl: logoOk.probe.final_url || logoOk.url,
      source: logoOk.source,
      trust: logoOk.trust,
      width: logoOk.probe.width ?? null,
      height: logoOk.probe.height ?? null,
      format: logoOk.probe.format || null,
      contentType: logoOk.probe.content_type || null,
      confidence: logoOk.trust === 'existing_schema' ? 'high' : 'medium',
    };
    ev.organization.logo.status = logoOk.trust === 'existing_schema' ? 'verified' : (existingBroken ? 'replaces_broken_existing' : 'verified_html_hint');
  } else if (existingBroken) {
    ev.organization.logo.status = 'existing_broken';
  } else if (ev.organization.logo.candidates.length && ev.organization.logo.candidates.every((c) => c.probe && !c.probe.ok && c.probe.conclusive)) {
    ev.organization.logo.status = 'all_broken';
  } else if (ev.organization.logo.candidates.length) {
    ev.organization.logo.status = 'unverified';
  } else {
    ev.organization.logo.status = 'none';
  }

  // Article image
  const imgOk = pick(ev.article.image.candidates);
  if (imgOk) {
    ev.article.image.verified = { url: imgOk.url, source: imgOk.source, width: imgOk.probe.width ?? null, height: imgOk.probe.height ?? null, format: imgOk.probe.format || null };
    ev.article.image.status = 'verified';
  } else if (ev.article.image.candidates.length) {
    ev.article.image.status = ev.article.image.candidates.every((c) => c.probe && !c.probe.ok && c.probe.conclusive) ? 'all_broken' : 'unverified';
  }
  ev.article.missing = [
    !ev.article.headline && 'headline',
    !ev.article.datePublished && 'datePublished',
    !ev.article.author && 'author',
    ev.article.image.status !== 'verified' && 'image',
  ].filter(Boolean);

  finalizeOrganizationIntent(ev);
  ev.fingerprintKey = fingerprintKeyOf(ev);
  return ev;
}

/** Everything about the address assessment that can change what is recommended: its state, the proposal and each candidate. */
function addressFingerprintMaterial(a) {
  if (!a) return null;
  return [a.state, a.reason || null, a.existing?.state, a.proposal?.formatted || null, (a.candidates || []).map((c) => [c.source, c.trust, c.formatted]).sort((x, y) => (String(x) < String(y) ? -1 : 1))];
}

export function fingerprintKeyOf(ev) {
  const intent = ev.organization?.intent;
  const material = JSON.stringify({
    v: SCHEMA_EVIDENCE_VERSION,
    u: ev.url?.display, t: ev.url?.trusted,
    o: ev.organization?.id, n: ev.organization?.name?.value, p: ev.organization?.present,
    l: ev.organization?.logo?.status, lu: ev.organization?.logo?.verified?.url,
    b: ev.breadcrumb?.hierarchy?.status, bi: (ev.breadcrumb?.hierarchy?.items || []).map((i) => [i.name, i.url]),
    bu: ev.breadcrumb?.userProvided ? [ev.breadcrumb.userProvided.evidenceHash, ev.breadcrumb.userProvided.stale] : null,
    bc: ev.breadcrumb?.conflict?.kind || null,
    a: ev.article?.applicable, am: ev.article?.missing, ai: ev.article?.image?.verified?.url,
    ah: ev.article?.headline?.value, ap: ev.article?.datePublished?.value,
    // Only present for organization evidence, so breadcrumb/article cache keys are exactly what they were before.
    // The intent (type, action, reuse, missing) and the published facts are part of the key: a different intent
    // or a newly available fact can never be served an older recommendation.
    ...(intent ? { si: intentFingerprintMaterial(intent), sc: stableJson(ev.organization.contact), ad: addressFingerprintMaterial(ev.organization.address) } : {}),
  });
  return crypto.createHash('sha256').update(material).digest('hex').slice(0, 16);
}

/**
 * The verified facts as a small, serialisable list the validator and the output guard compare
 * generated markup against.
 */
export function allowedOrganizationUrls(evidence) {
  const set = new Set();
  const add = (u) => { if (u) { set.add(u); set.add(u.replace(/\/+$/, '')); } };
  add(evidence.organization.homepageUrl);
  add(evidence.organization.url);
  add(evidence.organization.logo.verified?.url);
  add(evidence.organization.logo.verified?.finalUrl);
  for (const v of asArray(evidence.organization.contact.sameAs)) add(typeof v === 'string' ? v : null);
  return set;
}


/**
 * The small, serialisable slice of the evidence the UI needs (e.g. which breadcrumb state to show, which
 * canonical URL the last item must match). Deliberately excludes raw schema nodes, probe results and anything
 * the browser has no use for.
 */
export function summarizeSchemaEvidence(evidence) {
  if (!evidence) return null;
  const b = evidence.breadcrumb;
  const o = evidence.organization;
  return {
    kinds: evidence.kinds,
    url: { display: evidence.url.display, trusted: evidence.url.trusted, source: evidence.url.source, crawlKey: evidence.url.crawlKey },
    organization: evidence.kinds.includes('organization') && o.intent ? {
      present: o.present,
      intent: o.intent,
      name: o.name ? { value: o.name.value, source: o.name.source } : null,
      factSources: o.factSources || {},
      site: o.site || null,
      businessProfile: o.businessProfile || null,
      address: summarizeAddressAssessment(o.address),
      logo: { status: o.logo.status, verifiedUrl: o.logo.verified?.url || null },
    } : null,
    breadcrumb: evidence.kinds.includes('breadcrumb') ? {
      status: b.hierarchy.status,
      needsInput: b.needsInput,
      items: b.hierarchy.items,
      current: b.hierarchy.current || null,
      existingTrails: b.existing,
      duplicateLists: b.duplicateLists,
      conflict: b.conflict,
      userProvided: b.userProvided ? {
        items: b.userProvided.items, stale: b.userProvided.stale, submittedAt: b.userProvided.submittedAt, regeneratedAt: b.userProvided.regeneratedAt,
      } : null,
    } : null,
  };
}

export { hasType, isOrganizationNode };
export default { buildSchemaEvidence, summarizeSchemaEvidence, applyImageProbes, imageUrlsToVerify, evidenceKindsFor, allowedOrganizationUrls, SCHEMA_EVIDENCE_VERSION };
