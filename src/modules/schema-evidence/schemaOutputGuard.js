/**
 * schemaOutputGuard — the deterministic backstop between "the model wrote some JSON-LD" and
 * "ODITO shows it to a customer".
 *
 * The prompt tells the model to omit what it cannot prove; this module makes that true
 * regardless of what the model did. It rewrites the generated markup so that every factual
 * value is one of:
 *   - taken from the site's own existing markup,
 *   - verified (a logo / image that was actually fetched and measured), or
 *   - removed (and reported, so the user is told what is missing rather than shown a guess).
 *
 * It never invents a replacement value and never overwrites a trustworthy existing value with a
 * weaker one. `checkSchemaAgainstEvidence` is the read-only form of the same rules, used by
 * SchemaValidator so a value that slipped through still fails validation.
 */

import { serializeJsonLdForScript } from './breadcrumbHierarchy.js';
import {
  asArray, flattenJsonLd, isAbsoluteHttpUrl, isArticleNode, isBreadcrumbNode, isOrganizationNode,
  parseSchemaDate, resolveHttpUrl, sameSite, typeSatisfies, typesOf,
} from './schemaGraph.js';

const FACT_FIELDS = ['telephone', 'email', 'address', 'contactPoint', 'faxNumber', 'foundingDate', 'founder', 'founders', 'legalName',
  'numberOfEmployees', 'vatID', 'taxID', 'duns', 'leiCode', 'openingHours', 'openingHoursSpecification', 'geo', 'hasMap',
  'priceRange', 'areaServed', 'aggregateRating', 'review', 'award', 'slogan'];

const stable = (v) => JSON.stringify(v, (_k, val) => (val && typeof val === 'object' && !Array.isArray(val) ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => (a < b ? -1 : 1))) : val));
const jsonEq = (a, b) => stable(a) === stable(b);
const trimSlash = (u) => (typeof u === 'string' ? u.replace(/\/+$/, '') : u);

const verifiedLogoUrls = (ev) => {
  const v = ev?.organization?.logo?.verified;
  return new Set([v?.url, v?.finalUrl].filter(Boolean).map(trimSlash));
};

function logoUrlOf(logo, nodes) {
  const first = asArray(logo)[0];
  if (typeof first === 'string') return first;
  if (first && typeof first === 'object') {
    if (first.url || first.contentUrl) return first.url || first.contentUrl;
    if (first['@id']) { const n = nodes.find((x) => x['@id'] === first['@id']); return n?.url || n?.contentUrl || null; }
  }
  return null;
}

// ── sanitising rewrite ────────────────────────────────────────────────────────

/**
 * @param {*} parsed  generated JSON-LD (root object, array, or @graph) — NOT mutated
 * @param {object} evidence  schemaEvidence (after applyImageProbes)
 * @returns {{ schema: *, removed: {node: string, field: string, reason: string}[], notes: string[], dropped: string[] }}
 */
export function sanitizeGeneratedSchema(parsed, evidence) {
  let schema = JSON.parse(JSON.stringify(parsed));
  const removed = []; const notes = []; const dropped = [];
  if (!evidence) return { schema, removed, notes, dropped };
  const toRemove = new Set();

  const nodes = flattenJsonLd(schema);
  const org = evidence.organization;
  const verified = verifiedLogoUrls(evidence);
  const strip = (node, field, reason) => { delete node[field]; removed.push({ node: typesOf(node).join('/'), field, reason }); };

  for (const node of nodes) {
    if (isOrganizationNode(node) && evidence.kinds.includes('organization')) {
      // identity: reuse the site's own entity id and types; never mint a second entity
      const existingId = org.id;
      const home = org.homepageUrl;
      if (existingId) node['@id'] = existingId;
      else if (home && !(typeof node['@id'] === 'string' && sameSite(node['@id'], home))) node['@id'] = `${home}#organization`;
      const intent = org.intent;
      const modelWantedPhysical = typesOf(node).some((t) => typeSatisfies(t, 'LocalBusiness'));
      if (intent?.types?.length) {
        // The intent decided the type from evidence (existing markup, a verified address, a verified Business Profile);
        // whatever the model wrote is replaced by it, so the type can neither be inflated (an unproven Hospital) nor
        // flattened (a specific type reduced to Organization).
        node['@type'] = intent.types.length === 1 ? intent.types[0] : intent.types;
        if (modelWantedPhysical && intent.type === 'Organization') {
          notes.push('LocalBusiness: no verified physical location (address, Place markup or a Business Profile that matches this site) was found, so this is published as an Organization. Provide your verified street address (and phone, opening hours) to publish it as a LocalBusiness.');
        }
      } else if (org.primary?.types?.length > 1 || (org.primary?.types?.length === 1 && org.primary.types[0] !== 'Organization')) node['@type'] = org.primary.types.length === 1 ? org.primary.types[0] : org.primary.types;

      if (org.name?.verified && node.name !== org.name.value) node.name = org.name.value;
      if (org.url) node.url = org.url;
      else if (home && !(typeof node.url === 'string' && sameSite(node.url, home))) node.url = home;

      // logo: only a fetched-and-confirmed image survives
      const lv = evidence.organization.logo.verified;
      const generatedLogoUrl = node.logo != null ? logoUrlOf(node.logo, nodes) : null;
      if (node.logo != null) {
        const resolved = resolveHttpUrl(generatedLogoUrl, home || undefined);
        if (!resolved || !verified.has(trimSlash(resolved))) {
          strip(node, 'logo', 'The logo URL could not be verified as a working image, so it was removed rather than published.');
        } else if (typeof node.logo === 'string') node.logo = resolved; // published as an absolute URL
        else if (node.logo && typeof node.logo === 'object' && !Array.isArray(node.logo) && node.logo.url) node.logo.url = resolved;
      }
      if (lv && (node.logo == null)) {
        node.logo = { '@type': 'ImageObject', url: lv.url, ...(lv.width && lv.height ? { width: lv.width, height: lv.height } : {}) };
      } else if (lv && node.logo && typeof node.logo === 'object' && !Array.isArray(node.logo)) {
        // dimensions are measured, never the model's numbers
        if (lv.width && lv.height) { node.logo.width = lv.width; node.logo.height = lv.height; } else { delete node.logo.width; delete node.logo.height; }
      }
      if (!lv && org.logo.status !== 'none') notes.push(`Logo: ${logoStatusText(org.logo.status)}`);
      if (!lv && org.logo.status === 'none') notes.push('Logo: no logo could be found on the site — provide the URL of your logo image.');

      // facts (phone, address, hours, geo, profiles, ...): the SITE's published value, or nothing. A value the model
      // wrote is never trusted; where the site already publishes one, that value is what is kept — so an incomplete
      // copy of an existing address/telephone can never silently replace (or drop) the real one.
      const existing = org.contact || {};
      for (const f of [...FACT_FIELDS, 'sameAs']) {
        const siteValue = existing[f];
        if (siteValue != null) {
          if (node[f] != null && !jsonEq(node[f], siteValue)) removed.push({ node: typesOf(node).join('/'), field: f, reason: "The site already publishes a different value, so the site's own value was kept." });
          node[f] = JSON.parse(JSON.stringify(siteValue));
        } else if (node[f] != null) {
          strip(node, f, f === 'sameAs'
            ? 'Profile URLs that are not already on the site were removed — enter your real profiles in the sameAs setting.'
            : 'Not found on the site, so ODITO did not publish it. Provide the real value to add it.');
        }
      }

      // A LocalBusiness is a claim of a physical location: without a verified address it is not valid LocalBusiness
      // markup. When an intent decided the type, the address was already part of that decision (missing -> the intent is
      // `needs_input`, not markup), so this fallback applies only without an intent, or when the intent itself is
      // waiting for the address. It never touches an existing entity and never removes a specific type that is present.
      const intentAllowsFallback = !intent || intent.action === 'needs_input';
      if (intentAllowsFallback && !org.present && node.address == null && typesOf(node).some((t) => typeSatisfies(t, 'LocalBusiness'))) {
        node['@type'] = 'Organization';
        notes.push('LocalBusiness: no address was found on your site, so this is published as an Organization. Provide your verified street address (and phone, opening hours) to publish it as a LocalBusiness.');
      }
      for (const f of Object.keys(node)) if (node[f] === '' || node[f] === null || (Array.isArray(node[f]) && !node[f].length)) delete node[f];
    }

    if (isArticleNode(node) && evidence.kinds.includes('article')) {
      const a = evidence.article;
      if (a.headline) node.headline = a.headline.value; else strip(node, 'headline', 'No headline found on the page.');
      for (const f of ['datePublished', 'dateModified']) {
        if (a[f]) node[f] = a[f].value;
        else if (node[f] != null) strip(node, f, 'No trustworthy date was found on the page.');
      }
      if (a.author) {
        if (!(node.author && typeof node.author === 'object' && (node.author['@id'] || node.author.name === a.author.name))) node.author = { '@type': 'Person', name: a.author.name };
      } else if (node.author != null) strip(node, 'author', 'No author was found on the page, so none was published.');
      if (a.image.verified) node.image = a.image.verified.url; else if (node.image != null) strip(node, 'image', 'The image could not be verified as a working image.');
      if (a.mainEntityOfPage) node.mainEntityOfPage = { '@type': 'WebPage', '@id': a.mainEntityOfPage }; else if (node.mainEntityOfPage != null) strip(node, 'mainEntityOfPage', 'The page has no same-site canonical URL to anchor it to.');
      if (a.existingType?.length) node['@type'] = a.existingType.length === 1 ? a.existingType[0] : a.existingType;
      if (node.publisher && typeof node.publisher === 'object') {
        if (org.id) node.publisher = { '@id': org.id };
        else if (node.publisher.logo != null && !verified.has(trimSlash(resolveHttpUrl(logoUrlOf(node.publisher.logo, nodes), org.homepageUrl || undefined) || ''))) {
          delete node.publisher.logo; removed.push({ node: 'publisher', field: 'logo', reason: 'Unverified logo removed.' });
        }
      }
      for (const m of a.missing) notes.push(`Article ${m}: not found on the page — it was omitted.`);
    }

    if (isBreadcrumbNode(node) && evidence.kinds.includes('breadcrumb')) {
      const h = evidence.breadcrumb.hierarchy;
      if (h.status !== 'existing' && h.status !== 'user_provided') { toRemove.add(node); dropped.push('BreadcrumbList'); continue; }
      const allowed = new Map(h.items.map((i) => [trimSlash(i.url), i]));
      const items = [];
      for (const el of asArray(node.itemListElement)) {
        const rawUrl = typeof el?.item === 'string' ? el.item : (el?.item?.['@id'] || el?.item?.url);
        const url = resolveHttpUrl(rawUrl, evidence.url.display || undefined);
        const ref = url ? allowed.get(trimSlash(url)) : null;
        if (!ref) { removed.push({ node: 'BreadcrumbList', field: 'itemListElement', reason: `"${el?.name || rawUrl || 'item'}" is not part of the site's verified hierarchy.` }); continue; }
        items.push({ '@type': 'ListItem', position: items.length + 1, name: ref.name || el.name, item: ref.url });
      }
      node.itemListElement = items;
      if (items.length < 2) { toRemove.add(node); dropped.push('BreadcrumbList'); }
    }
  }

  // one organization per page: a second Organization-typed node can only be a duplicate of the first
  const generatedOrgs = nodes.filter((n) => isOrganizationNode(n) && !toRemove.has(n));
  if (evidence.kinds.includes('organization') && generatedOrgs.length > 1) {
    generatedOrgs.slice(1).forEach((n) => { toRemove.add(n); removed.push({ node: typesOf(n).join('/'), field: '(entity)', reason: 'Duplicate Organization entity removed — the page describes the organization once.' }); });
  }

  if (toRemove.size) {
    const keep = (n) => !toRemove.has(n);
    if (Array.isArray(schema)) schema = schema.filter(keep);
    else if (Array.isArray(schema?.['@graph'])) schema['@graph'] = schema['@graph'].filter(keep);
    else if (toRemove.has(schema)) schema = null;
  }
  if (dropped.length) {
    notes.push('Breadcrumbs: the parent pages for this page could not be verified from the crawl, so no BreadcrumbList was generated. Enable breadcrumbs in your SEO plugin (it builds the trail from your real hierarchy) or provide the page hierarchy.');
  }
  return { schema, removed, notes, dropped };
}

function logoStatusText(status) {
  switch (status) {
    case 'existing_broken': return "the logo your site declares returns an error or is not an image — fix or replace that file; ODITO did not publish it.";
    case 'all_broken': return 'every logo candidate found returned an error or was not an image — upload a logo and provide its URL.';
    case 'unverified': return 'a logo candidate was found but could not be verified right now (timeout, blocked or unreachable) — it was omitted.';
    default: return 'no verified logo — it was omitted.';
  }
}

// ── read-only checks (SchemaValidator) ────────────────────────────────────────

/** Rules the sanitised output must satisfy. Returns hard `errors` and soft `warnings`. */
export function checkSchemaAgainstEvidence(parsed, evidence) {
  const errors = []; const warnings = [];
  if (!evidence) return { errors, warnings };
  const nodes = flattenJsonLd(parsed);
  const verified = verifiedLogoUrls(evidence);
  const org = evidence.organization;

  const orgNodes = nodes.filter(isOrganizationNode);
  if (evidence.kinds.includes('organization')) {
    if (orgNodes.length > 1) {
      const ids = new Set(orgNodes.map((n) => n['@id'] || '(none)'));
      if (ids.size < orgNodes.length || orgNodes.length > 1) errors.push(`Schema: ${orgNodes.length} Organization entities were generated — a page must describe the site's organization once.`);
    }
    if (org.id) for (const n of orgNodes) if (n['@id'] && n['@id'] !== org.id) errors.push(`Schema: Organization @id "${n['@id']}" conflicts with the site's existing entity "${org.id}".`);
    const intent = org.intent;
    if (intent?.types?.length) {
      for (const n of orgNodes) {
        const generated = typesOf(n);
        // Must satisfy the intended type (a specific type may also satisfy it through its parents)...
        if (!generated.some((t) => typeSatisfies(t, intent.type))) errors.push(`Schema: the entity is typed ${generated.join(' + ') || '(none)'} but the schema intent for this page is ${intent.type}.`);
        // ...and must not claim a MORE specific type than the evidence supports.
        const unsupported = generated.filter((t) => t !== 'Organization' && !intent.types.includes(t));
        if (unsupported.length) errors.push(`Schema: type ${unsupported.join(', ')} is not supported by the verified evidence (expected ${intent.types.join(' + ')}).`);
      }
      if (intent.action === 'needs_input' && orgNodes.some((n) => n.address == null && typesOf(n).some((t) => typeSatisfies(t, 'LocalBusiness')))) {
        errors.push(`Schema: a ${intent.type} was generated without a verified address.`);
      }
    }
    for (const n of orgNodes) {
      if (n.logo != null) {
        const raw = logoUrlOf(n.logo, nodes);
        const u = resolveHttpUrl(raw, org.homepageUrl || undefined);
        if (!isAbsoluteHttpUrl(raw)) errors.push('Schema: logo is not a valid absolute http(s) URL.');
        else if (!verified.has(trimSlash(u))) errors.push(`Schema: logo URL ${u} was not verified as a working image.`);
      }
      for (const f of FACT_FIELDS) {
        if (n[f] != null && !(f in (org.contact || {}) && jsonEq(n[f], org.contact[f]))) errors.push(`Schema: "${f}" is not present on the site and cannot be published without the owner's input.`);
      }
      if (n.url != null) {
        const u = isAbsoluteHttpUrl(n.url) ? resolveHttpUrl(n.url) : null;
        if (!u) errors.push('Schema: Organization url is not a valid absolute http(s) URL.');
        else if (org.homepageUrl && !sameSite(u, org.homepageUrl)) errors.push(`Schema: Organization url ${u} is not on the audited site.`);
      }
      for (const s of asArray(n.sameAs)) {
        if (!isAbsoluteHttpUrl(s)) errors.push(`Schema: sameAs entry ${JSON.stringify(s)} is not a valid http(s) URL.`);
      }
    }
  }

  if (evidence.kinds.includes('article')) {
    for (const n of nodes.filter(isArticleNode)) {
      if (!evidence.article.applicable) errors.push(`Schema: ${evidence.article.reason}`);
      for (const f of ['datePublished', 'dateModified']) {
        if (n[f] == null) continue;
        const p = parseSchemaDate(String(n[f]));
        if (!p.valid) errors.push(`Schema: ${f} "${n[f]}" is not a valid ISO 8601 date (${p.reason}).`);
        else if (evidence.article[f]?.value !== p.value) errors.push(`Schema: ${f} "${n[f]}" does not match a date found on the page.`);
      }
      if (n.author != null && !evidence.article.author) errors.push('Schema: author was generated but no author is present on the page.');
      if (n.image != null && !(evidence.article.image.verified && asArray(n.image).every((i) => trimSlash(typeof i === 'string' ? i : i?.url) === trimSlash(evidence.article.image.verified.url)))) errors.push('Schema: image was not verified as a working image.');
    }
  }

  if (evidence.kinds.includes('breadcrumb')) {
    const lists = nodes.filter(isBreadcrumbNode);
    if (lists.length > 1) errors.push('Schema: more than one BreadcrumbList was generated.');
    for (const l of lists) {
      if (!['existing', 'user_provided'].includes(evidence.breadcrumb.hierarchy.status)) errors.push('Schema: a BreadcrumbList was generated although the page hierarchy could not be verified.');
    }
  }
  return { errors, warnings };
}

// ── applying to a recommendation's sections ───────────────────────────────────

const SCRIPT_RE = /(<script[^>]*type=["']application\/ld\+json["'][^>]*>)([\s\S]*?)(<\/script>)/i;

function rewriteJsonLdText(text, evidence) {
  if (typeof text !== 'string' || !text.trim()) return { text, result: null };
  const m = SCRIPT_RE.exec(text);
  const body = (m ? m[2] : text).trim();
  let parsed;
  try { parsed = JSON.parse(body); } catch { return { text, result: null }; }
  const result = sanitizeGeneratedSchema(parsed, evidence);
  // Re-serialised with <, > and & escaped, so no value (a page name, a description) can ever close the <script> tag.
  const json = result.schema == null ? null : serializeJsonLdForScript(result.schema);
  if (json == null) return { text: m ? text.replace(SCRIPT_RE, '') .trim() : '', result };
  return { text: m ? text.replace(SCRIPT_RE, `$1\n${json.replace(/\$/g, '$$$$')}\n$3`) : json, result };
}

/**
 * Sanitises the JSON-LD in `implementationExample.content` and `recommendedVersion` (the two
 * places the schema prompt writes it) and appends a short, factual "what ODITO left out" note to
 * recommendedFix. Returns the sections unchanged when there is no evidence or nothing to do.
 */
export function applyGuardToSections(sections, evidence) {
  if (!sections || !evidence) return { sections, report: null };
  const out = { ...sections, implementationExample: sections.implementationExample ? { ...sections.implementationExample } : sections.implementationExample };
  const reports = [];

  if (out.implementationExample?.content) {
    const r = rewriteJsonLdText(out.implementationExample.content, evidence);
    if (r.result) { out.implementationExample.content = r.text || out.implementationExample.content; reports.push(r.result); if (r.result.schema == null) out.implementationExample.content = breadcrumbUnknownNote(); }
  }
  if (out.recommendedVersion) {
    const r = rewriteJsonLdText(out.recommendedVersion, evidence);
    if (r.result) { out.recommendedVersion = r.text || breadcrumbUnknownNote(); reports.push(r.result); }
  }
  if (!reports.length) return { sections: out, report: null };

  const removed = reports.flatMap((r) => r.removed);
  const notes = [...new Set(reports.flatMap((r) => r.notes))];
  const uniqueRemoved = removed.filter((x, i) => removed.findIndex((y) => y.node === x.node && y.field === x.field) === i);
  const lines = [...notes, ...uniqueRemoved.map((r) => `${r.node} ${r.field}: ${r.reason}`)];
  if (lines.length && typeof out.recommendedFix === 'string') {
    out.recommendedFix = `${out.recommendedFix}\n\nODITO verification notes (values left out because they could not be proven from your site):\n${lines.map((l) => `- ${l}`).join('\n')}`;
  }
  return { sections: out, report: { removed: uniqueRemoved, notes } };
}

function breadcrumbUnknownNote() {
  return '<!-- ODITO: the parent pages for this page could not be verified from the crawl, so no BreadcrumbList is shown. Enable breadcrumbs in your SEO plugin (it builds the trail from your real hierarchy) or provide the page hierarchy. -->';
}

export default { sanitizeGeneratedSchema, checkSchemaAgainstEvidence, applyGuardToSections };
