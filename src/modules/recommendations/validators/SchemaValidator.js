/**
 * SchemaValidator — GROUP 4 (Schema)
 *
 * Validates recommendations for Schema.org / JSON-LD issues.
 *
 * Key rules:
 *   - the JSON-LD must be valid JSON — read from implementationCode when that
 *     is JSON-LD (bare or in a <script> block), otherwise from recommendedVersion
 *     (which the schema prompt defines as "the actual JSON-LD object").
 *     implementationCode is a framework snippet and may legitimately be PHP/JSX
 *     wrapping the JSON-LD; that alone is not a reason to reject a valid schema.
 *   - JSON-LD is read as a graph: a root object, an array of objects, or a root with
 *     @graph. A parent's @context is inherited by its @graph nodes (it is NOT required on
 *     every node), and every entity is judged by its OWN @type — never "whatever node
 *     happens to be first".
 *   - @context must be schema.org; every entity needs an @type
 *   - Required properties per schema type must be present (on the entities the issue is about)
 *   - No placeholder values inside the JSON
 *   - URL-valued properties (url, logo, sameAs, breadcrumb item) must be real absolute http(s)
 *     URLs. Syntax is checked here; whether a logo/image URL actually WORKS is a network fact,
 *     established by schema-evidence/ and enforced through `rc.schemaEvidence` when present.
 *   - One organization per page, one BreadcrumbList, no duplicate @id
 */

import { BaseValidator } from './BaseValidator.js';
import { normalizeSchemaUrlValue, normalizeBreadcrumbEnableValue } from '../../tasks/service/valueNormalization.js';
import {
  asArray, breadcrumbProblems, isAbsoluteHttpUrl, isArticleNode, isBreadcrumbNode, isOrganizationNode, resolveHttpUrl, typeSatisfies, typesOf,
} from '../../schema-evidence/schemaGraph.js';
import { checkSchemaAgainstEvidence } from '../../schema-evidence/schemaOutputGuard.js';

// Required top-level properties per @type
const REQUIRED_PROPS_BY_TYPE = {
  Organization:   ['name', 'url'],
  LocalBusiness:  ['name', 'address'],
  Person:         ['name'],
  Article:        ['headline', 'author'],
  BlogPosting:    ['headline', 'author'],
  FAQPage:        ['mainEntity'],
  BreadcrumbList: ['itemListElement'],
  Product:        ['name'],
  Service:        ['name'],
  WebPage:        ['name'],
  WebSite:        ['name', 'url'],
  Event:          ['name', 'startDate'],
};

const ORGANIZATION_ISSUES = new Set(['organization_schema', 'primary_organization_schema', 'aiso-a1', 'geo-s5']);
const ARTICLE_ISSUES = new Set(['article_schema', 'geo-s2']);
const BREADCRUMB_ISSUES = new Set(['breadcrumblist_schema']);

const BREADCRUMB_PROBLEM_TEXT = {
  empty_list: 'BreadcrumbList has no items',
  missing_name: 'a breadcrumb item has no name',
  missing_url: 'a breadcrumb item (other than the last) has no URL',
  relative_or_invalid_url: 'a breadcrumb item URL is relative or not a valid absolute URL',
  unsupported_url: 'a breadcrumb item URL uses an unsupported protocol',
  cross_site_url: 'a breadcrumb item URL is on a different site',
  duplicate_url: 'two breadcrumb items point to the same URL',
  position_not_sequential: 'breadcrumb positions must be 1, 2, 3, … in order',
};

/**
 * The JSON-LD object inside a snippet: the whole text, the body of a
 * <script type="application/ld+json"> block, or the first balanced {...} that
 * parses and looks like JSON-LD (@context/@type/@graph) — e.g. inside a PHP or
 * JSX wrapper. Returns null when no JSON-LD can be found.
 */
function extractJsonLd(text, checkValidJson) {
  if (!text || typeof text !== 'string') return null;

  const whole = checkValidJson(text, 'schema');
  if (whole.ok) return whole.parsed;

  const looksLikeJsonLd = (v) => v && typeof v === 'object' && ('@context' in v || '@type' in v || '@graph' in v);

  const scriptRe = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (let m = scriptRe.exec(text); m; m = scriptRe.exec(text)) {
    try { const v = JSON.parse(m[1].trim()); if (looksLikeJsonLd(Array.isArray(v) ? v[0] : v)) return v; } catch { /* keep looking */ }
  }

  // Balanced-brace scan (string-aware) — bounded, so hostile input can't make it slow.
  let attempts = 0;
  for (let start = text.indexOf('{'); start !== -1 && attempts < 20; start = text.indexOf('{', start + 1)) {
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) { end = i; break; }
    }
    if (end === -1) continue;
    attempts++;
    try { const v = JSON.parse(text.slice(start, end + 1)); if (looksLikeJsonLd(v)) return v; } catch { /* not JSON */ }
  }
  return null;
}

/**
 * Every entity in a JSON-LD value with the @context that applies to it: its own, else the one
 * inherited from the containing object (a @graph's parent declares @context once for all of its nodes).
 */
function collectEntities(value, inheritedContext = undefined, out = [], depth = 0) {
  if (value == null || typeof value !== 'object' || depth > 6) return out;
  if (Array.isArray(value)) { value.forEach((v) => collectEntities(v, inheritedContext, out, depth + 1)); return out; }
  const context = value['@context'] ?? inheritedContext;
  if (value['@graph'] != null) {
    collectEntities(value['@graph'], context, out, depth + 1);
    if (value['@type'] != null) out.push({ node: value, context });
    return out;
  }
  out.push({ node: value, context });
  return out;
}

function contextString(ctx) {
  if (ctx == null) return null;
  if (typeof ctx === 'string') return ctx;
  if (Array.isArray(ctx)) return ctx.find((c) => typeof c === 'string' && c.includes('schema.org')) || (typeof ctx[0] === 'string' ? ctx[0] : null);
  if (typeof ctx === 'object') return typeof ctx['@vocab'] === 'string' ? ctx['@vocab'] : null;
  return null;
}

function relevantEntities(issueId, entities) {
  const id = String(issueId || '').toLowerCase();
  const pick = (pred) => entities.filter((e) => pred(e.node));
  if (ORGANIZATION_ISSUES.has(id)) return { kind: 'Organization', list: pick(isOrganizationNode) };
  if (ARTICLE_ISSUES.has(id)) return { kind: 'Article', list: pick(isArticleNode) };
  if (BREADCRUMB_ISSUES.has(id)) return { kind: 'BreadcrumbList', list: pick(isBreadcrumbNode) };
  return { kind: null, list: entities.slice(0, 1) };
}

function requiredPropsFor(node) {
  // A physical-location subtype (Hospital, Dentist ...) is judged as a LocalBusiness even when it also lists Organization.
  if (typesOf(node).some((t) => typeSatisfies(t, 'LocalBusiness'))) return { type: 'LocalBusiness', required: REQUIRED_PROPS_BY_TYPE.LocalBusiness };
  for (const t of typesOf(node)) if (REQUIRED_PROPS_BY_TYPE[t]) return { type: t, required: REQUIRED_PROPS_BY_TYPE[t] };
  if (isOrganizationNode(node)) return { type: 'Organization', required: REQUIRED_PROPS_BY_TYPE.Organization };
  if (isArticleNode(node)) return { type: 'Article', required: REQUIRED_PROPS_BY_TYPE.Article };
  return { type: typesOf(node)[0] || null, required: [] };
}

function logoValue(node) {
  const first = asArray(node.logo)[0];
  if (typeof first === 'string') return first;
  if (first && typeof first === 'object') return first.url || first.contentUrl || null;
  return null;
}

export class SchemaValidator extends BaseValidator {

  validate(sections, rc) {
    const errors   = [];
    const warnings = [];

    this._validateCoreSections(sections, errors);
    // Placeholders are checked in what is PUBLISHED (the JSON-LD / value), never in the prose around it:
    // recommendedFix is guidance to the owner and legitimately says things like "add your phone number".
    this._checkNoPlaceholders({ recommendedVersion: sections.recommendedVersion, implementationExample: sections.implementationExample }, errors);

    const issueId  = rc?.identity?.issueId || '';
    const implCode = sections.implementationExample?.content || sections.recommendedVersion || '';

    let satisfiesConstraint = true;

    // ── sameas_array / breadcrumblist_schema: single-VALUE fixes, validated
    // against valueNormalization.js's own normalizers so this validator's
    // pass/fail decision can never drift from what TaskHistoryService later
    // derives as the actual write value — the same "one shared source of
    // truth" principle already applied to canonical and robots. Returns
    // early: these never go through the generic full-JSON-LD checks below,
    // which would incorrectly reject a bare URL or "enabled"/"not provided
    // in context" as invalid JSON.
    if (issueId === 'sameas_array' || issueId === 'breadcrumblist_schema') {
      const recommended = sections.recommendedVersion || '';
      if (!recommended) {
        errors.push(`${issueId}: recommendedVersion is empty`);
        return { valid: false, errors, warnings, satisfiesConstraint: false };
      }
      if (issueId === 'sameas_array') {
        // "not provided in context" (the codebase's existing
        // ANTI_HALLUCINATION_STRICT convention) is a VALID, honest, complete
        // answer here — Claude correctly declining to guess a URL it cannot
        // verify — never a validation failure worth retrying. Only a
        // response that's neither a real URL NOR that exact phrase is
        // actually wrong (e.g. free-form prose, a guessed-looking URL that
        // still fails strict parsing, HTML).
        const isRefusal = recommended.trim().toLowerCase() === 'not provided in context';
        const isValidUrl = !!normalizeSchemaUrlValue(recommended);
        if (!isRefusal && !isValidUrl) {
          warnings.push(`sameas_array: recommendedVersion must be a plain absolute URL or the exact phrase "not provided in context", not: "${recommended}"`);
          satisfiesConstraint = false;
        }
      } else {
        if (!normalizeBreadcrumbEnableValue(recommended)) {
          warnings.push(`breadcrumblist_schema: recommendedVersion must be exactly "enabled", not: "${recommended}"`);
          satisfiesConstraint = false;
        }
        // The illustrative BreadcrumbList in implementationCode (if any) must not carry parents ODITO
        // could not verify or a URL that differs from the page's canonical.
        const status = rc?.schemaEvidence?.breadcrumb?.hierarchy?.status;
        const jsonLd = (status === 'user_provided' || status === 'existing')
          ? extractJsonLd(sections.implementationExample?.content, (str, f) => this._checkValidJson(str, f))
          : null;
        if (jsonLd) {
          // A real, deterministic BreadcrumbList: validate it as the JSON-LD document it is (this also runs the evidence check).
          this._validateJsonLd(jsonLd, sections, rc, issueId, errors, warnings);
        } else {
          const ev = this.validateEvidence(sections, rc);
          errors.push(...ev.errors);
          warnings.push(...ev.warnings);
        }
        if (errors.length) satisfiesConstraint = false;
      }
      return { valid: errors.length === 0, errors, warnings, satisfiesConstraint };
    }

    // ── No code produced ──────────────────────────────────────────────────
    if (!implCode || implCode.trim().length < 20) {
      errors.push('Schema: implementationCode is missing or too short to be valid JSON-LD');
      satisfiesConstraint = false;
      return { valid: false, errors, warnings, satisfiesConstraint };
    }

    // ── JSON parse ────────────────────────────────────────────────────────
    // Prefer the snippet's own JSON-LD; fall back to recommendedVersion (the
    // schema prompt's "actual JSON-LD object"). Only when NEITHER holds valid
    // JSON-LD is the output unusable.
    let parsed = extractJsonLd(implCode, (s, f) => this._checkValidJson(s, f));
    if (!parsed) {
      const fromRecommended = extractJsonLd(sections.recommendedVersion, (s, f) => this._checkValidJson(s, f));
      if (fromRecommended) {
        parsed = fromRecommended;
        warnings.push('Schema: implementationCode is not plain JSON-LD (e.g. PHP/JSX wrapper) — validated the JSON-LD in recommendedVersion instead');
      }
    }
    if (!parsed) {
      const { message } = this._checkValidJson(implCode, 'implementationCode');
      errors.push(message);
      satisfiesConstraint = false;
      return { valid: false, errors, warnings, satisfiesConstraint };
    }

    const entities = this._validateJsonLd(parsed, sections, rc, issueId, errors, warnings);
    if (!entities) return { valid: false, errors, warnings, satisfiesConstraint: false };

    // ── FAQ schema: mainEntity must be an array of Questions ─────────────
    if (issueId === 'faq_schema' || issueId === 'faq_schema_matches_content') {
      const faqObj = entities.map((e) => e.node).find((n) => typesOf(n).includes('FAQPage'));
      if (faqObj) {
        const mainEntity = faqObj.mainEntity;
        if (!Array.isArray(mainEntity) || mainEntity.length === 0) {
          errors.push('FAQPage: mainEntity must be a non-empty array of Question objects');
        } else {
          const invalidQuestions = mainEntity.filter(q => q['@type'] !== 'Question' || !q.name || !q.acceptedAnswer);
          if (invalidQuestions.length > 0) {
            warnings.push(`FAQPage: ${invalidQuestions.length} question(s) missing name or acceptedAnswer`);
          }
        }
      }
    }

    satisfiesConstraint = errors.length === 0;
    return {
      valid: errors.length === 0,
      errors,
      warnings,
      satisfiesConstraint,
    };
  }

  /**
   * The structural checks shared by every JSON-LD recommendation: entities (root / array / @graph, with the
   * parent's @context inherited), @context, @type, required properties on the entities the issue is about,
   * placeholders, URL syntax, duplicates, and the verified-evidence rules. Pushes findings into errors/warnings;
   * returns the entities, or null when there is nothing to validate.
   */
  _validateJsonLd(parsed, sections, rc, issueId, errors, warnings) {
    // ── entities (root object / array / @graph) ───────────────────────────
    const entities = collectEntities(parsed);
    if (!entities.length) {
      errors.push('Schema: parsed JSON is empty');
      return null;
    }

    // ── @context: each entity's own, or the one inherited from its @graph parent ──
    const reported = new Set();
    for (const { node, context } of entities) {
      const ctx = contextString(context);
      if (!ctx) {
        if (!reported.has('missing')) { errors.push('Schema: missing @context'); reported.add('missing'); }
      } else if (!ctx.includes('schema.org')) {
        if (!reported.has(ctx)) { errors.push(`Schema: @context must be "https://schema.org" — got "${ctx}"`); reported.add(ctx); }
      }
      // ── @type: every entity needs one ──
      const type = node['@type'];
      const hasType = Array.isArray(type) ? type.some((t) => typeof t === 'string' && t.trim()) : (typeof type === 'string' && type.trim() !== '');
      if (!hasType && !reported.has('type')) { errors.push('Schema: missing @type'); reported.add('type'); }
    }

    // ── Required properties, on the entities this issue is about ──────────
    const { kind, list: relevant } = relevantEntities(issueId, entities);
    if (kind && !relevant.length) {
      errors.push(`Schema: no ${kind} entity was generated`);
    }
    for (const { node } of relevant) {
      const { type, required } = requiredPropsFor(node);
      const missingRequired = required.filter((prop) => !node[prop]);
      if (missingRequired.length > 0) {
        const msg = `Schema ${type}: missing required properties — ${missingRequired.join(', ')}`;
        if (missingRequired.length >= required.length) errors.push(msg);
        else warnings.push(msg);
      }
    }

    // ── No placeholder values inside JSON ─────────────────────────────────
    const schemaStr = JSON.stringify(parsed);
    if (this._hasPlaceholders(schemaStr)) {
      errors.push('Schema JSON contains placeholder values — output not grounded in real data');
    }

    // ── URLs and entity structure ─────────────────────────────────────────
    const baseUrl = rc?.schemaEvidence?.url?.display || rc?.pageContext?.pageUrl || undefined;
    this._checkUrlsAndStructure(entities, baseUrl, issueId, errors, warnings, !!rc?.schemaEvidence);

    // ── Evidence: nothing published that ODITO could not verify ───────────
    const ev = this.validateEvidence(sections, rc, parsed);
    errors.push(...ev.errors);
    warnings.push(...ev.warnings);

    return entities;
  }

  /**
   * Checks generated JSON-LD against schemaEvidence (see schema-evidence/). Safe to call for any
   * recommendation: with no evidence, or no JSON-LD in the sections, it returns no findings.
   */
  validateEvidence(sections, rc, parsedOverride = null) {
    const evidence = rc?.schemaEvidence;
    if (!evidence) return { errors: [], warnings: [] };
    let parsed = parsedOverride;
    if (!parsed) {
      const check = (s, f) => this._checkValidJson(s, f);
      parsed = extractJsonLd(sections?.implementationExample?.content, check) || extractJsonLd(sections?.recommendedVersion, check);
    }
    if (!parsed) return { errors: [], warnings: [] };
    return checkSchemaAgainstEvidence(parsed, evidence);
  }

  _checkUrlsAndStructure(entities, baseUrl, issueId, errors, warnings, hasEvidence) {
    const nodes = entities.map((e) => e.node);

    // duplicate @id
    const ids = new Map();
    for (const n of nodes) if (typeof n['@id'] === 'string') ids.set(n['@id'], (ids.get(n['@id']) || 0) + 1);
    for (const [id, count] of ids) if (count > 1) errors.push(`Schema: @id "${id}" is used by ${count} entities`);

    const orgNodes = nodes.filter(isOrganizationNode);
    if (orgNodes.length > 1 && ORGANIZATION_ISSUES.has(String(issueId).toLowerCase())) {
      errors.push(`Schema: ${orgNodes.length} Organization entities were generated — describe the organization once`);
    }

    for (const n of orgNodes) {
      if (n.url != null && !isAbsoluteHttpUrl(n.url)) errors.push(`Schema: url ${JSON.stringify(n.url)} is not a valid absolute http(s) URL`);
      if (n.logo != null) {
        const logo = logoValue(n);
        if (!isAbsoluteHttpUrl(logo)) errors.push(`Schema: logo ${JSON.stringify(logo ?? n.logo)} is not a valid absolute http(s) URL`);
        else if (!hasEvidence) warnings.push('Schema: logo URL was not verified as a working image');
      }
      for (const s of asArray(n.sameAs)) {
        if (!isAbsoluteHttpUrl(s)) errors.push(`Schema: sameAs entry ${JSON.stringify(s)} is not a valid http(s) URL`);
      }
    }

    const crumbs = nodes.filter(isBreadcrumbNode);
    if (crumbs.length > 1) errors.push('Schema: more than one BreadcrumbList was generated');
    for (const c of crumbs) {
      const items = asArray(c.itemListElement).map((el, i) => {
        const inner = el && typeof el.item === 'object' && el.item ? el.item : null;
        const rawUrl = typeof el?.item === 'string' ? el.item : (inner?.['@id'] || inner?.url || null);
        const position = el?.position == null ? null : Number(el.position);
        return {
          index: i, position: Number.isFinite(position) ? position : null,
          name: (typeof el?.name === 'string' && el.name.trim()) || (typeof inner?.name === 'string' && inner.name.trim()) || null,
          rawUrl: typeof rawUrl === 'string' ? rawUrl : null, url: resolveHttpUrl(rawUrl, baseUrl),
        };
      });
      for (const code of breadcrumbProblems(items, baseUrl)) errors.push(`Schema BreadcrumbList: ${BREADCRUMB_PROBLEM_TEXT[code] || code}`);
    }
  }
}

export default new SchemaValidator();
