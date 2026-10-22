import { BaseResolver } from './BaseResolver.js';
import { getFaqDetection } from '../../tasks/service/faqSchema.js';
import { getRatingDetection } from '../../tasks/service/aggregateRatingSchema.js';
import { analyzeOrganizations, flattenJsonLd, typeSatisfies, typesOf } from '../../schema-evidence/schemaGraph.js';

/**
 * SchemaResolver
 *
 * Handles all structured data / JSON-LD issue types from both pipelines:
 *   on-page schema issues + AI visibility schema rules.
 */
export class SchemaResolver extends BaseResolver {
  resolve(issueId, _displayType, extracted, _issueDoc) {
    const { pageData, issuesByCode, visibilityData, issuesByRuleId } = extracted;

    const onPageIssue = issuesByCode?.[issueId];
    const aiIssue = issuesByRuleId?.[issueId];
    const detectedFromDoc = onPageIssue?.detected_value ?? aiIssue?.detected_value ?? null;

    // Gather all structured data from either pipeline
    const structuredData = pageData?.structured_data
      || visibilityData?.structured_data
      || [];

    switch (issueId) {

      // ─── Technical Check: structured_data (check.id from technicalChecks.service.js) ──
      // Falls through to schema_markup — detects existing JSON-LD or shows absent state.
      case 'structured_data':
      // ─── On-Page Schema ────────────────────────────────────────────────
      case 'schema_markup': {
        const existing = _findSchemas(structuredData);
        if (existing.length > 0) {
          return {
            currentState: this._codeState(_prettyJson(existing[0]), 'json'),
            expectedState: this._expectedState('JSON-LD schema appropriate for page type (Article, Organization, Service, Product, etc.)'),
          };
        }
        return {
          currentState: this._absentState('JSON-LD schema'),
          expectedState: this._expectedState('JSON-LD schema appropriate for page type'),
        };
      }

      case 'organization_schema':
      case 'primary_organization_schema': {
        // The site's own entity in ANY form: root object, array, @graph node, "@type" as a string or an
        // array (["Hospital","Organization"]), or a subtype such as Hospital/MedicalClinic. Comparing
        // @type to a string used to report such a page as "no Organization", which produced a duplicate
        // entity (with an invented logo URL) as the "fix".
        const orgSchema = _findPrimaryOrganization(structuredData, pageData?.url);
        // The detection already decided WHICH entity the finding is about (Organization vs LocalBusiness vs "the site
        // already has one"). It travels with the issue context so the expected state, and later the recommendation, speak
        // about the same entity instead of a hard-coded "Organization". Informational: the recommendation re-derives the
        // intent from verified evidence and never trusts this hint for a fact.
        const detectedSchemaIntent = onPageIssue?.context?.schema_intent || null;
        const local = detectedSchemaIntent === 'local_business_schema';
        const contextExtras = detectedSchemaIntent ? { contextExtras: { detectedSchemaIntent } } : {};
        if (orgSchema) {
          return {
            currentState: this._codeState(_prettyJson(orgSchema), 'json'),
            expectedState: this._expectedState(local
              ? 'LocalBusiness (or a more specific subtype) schema with name, url, address, telephone, opening hours, @id'
              : 'Organization schema with name, url, logo, address, telephone, sameAs, @id'),
            ...contextExtras,
          };
        }
        return {
          currentState: this._absentState(local ? 'LocalBusiness schema' : 'Organization schema'),
          expectedState: this._expectedState(local
            ? 'LocalBusiness (or a more specific subtype) schema with name, url, verified address, @id'
            : 'Complete Organization schema with name, url, logo, sameAs, @id'),
          ...contextExtras,
        };
      }

      case 'sameas_array': {
        const orgSchema = _findPrimaryOrganization(structuredData, pageData?.url);
        if (orgSchema) {
          const existingSameAs = orgSchema.sameAs;
          const hasSameAs = existingSameAs && (Array.isArray(existingSameAs) ? existingSameAs.length > 0 : Boolean(existingSameAs));
          return {
            currentState: hasSameAs
              ? this._codeState(_prettyJson(orgSchema), 'json')
              : this._codeState(_prettyJson({ ...orgSchema, sameAs: '(missing)' }), 'json'),
            expectedState: this._expectedState('Organization schema includes a sameAs array with 2+ social profile URLs (LinkedIn, Twitter/X, Facebook, etc.)'),
          };
        }
        return {
          currentState: this._absentState('sameAs array in Organization schema'),
          expectedState: this._expectedState('Organization schema with a sameAs array containing 2+ verified social profile URLs'),
        };
      }

      case 'article_schema': {
        const articleSchema = _findSchemaByType(structuredData, ['Article', 'NewsArticle', 'BlogPosting']);
        if (articleSchema) {
          return {
            currentState: this._codeState(_prettyJson(articleSchema), 'json'),
            expectedState: this._expectedState('Article schema with headline, author, datePublished, dateModified, image'),
          };
        }
        return {
          currentState: this._absentState('Article schema'),
          expectedState: this._expectedState('Article schema with headline, author, datePublished'),
        };
      }

      case 'faq_schema':
      case 'faq_schema_matches_content': {
        const faqSchema = _findSchemaByType(structuredData, ['FAQPage']);
        // faq_schema only: the issue fires because FAQ CONTENT was found without
        // FAQPage schema, so "schema not detected" alone is misleading. Surface
        // the detected Q/A pairs (or the extraction failure) alongside it so the
        // UI can show both facts separately and the recommendation service can
        // build the schema from exactly these pairs.
        const faqExtras = issueId === 'faq_schema'
          ? { contextExtras: { faqDetection: getFaqDetection({ pageData, issueDoc: onPageIssue }) } }
          : {};
        if (issueId === 'faq_schema_matches_content' && faqSchema) {
          // Show table of schema questions vs. detected heading questions
          const schemaQs = (faqSchema.mainEntity || []).map(q => q.name || '');
          const headingQs = (visibilityData?.heading_metrics?.h2_list || [])
            .filter(h => h.includes('?'));
          const rows = schemaQs.map((q, i) => ({
            schema_question: q,
            page_heading: headingQs[i] || '(no match)',
            matches: headingQs[i]
              ? q.toLowerCase().includes(headingQs[i].toLowerCase().replace('?', ''))
              : false,
          }));
          return {
            currentState: this._tableState(
              ['Schema Question', 'Page Heading', 'Matches'],
              rows
            ),
            expectedState: this._expectedState('FAQ schema questions match visible page headings'),
          };
        }
        if (faqSchema) {
          return {
            currentState: this._codeState(_prettyJson(faqSchema), 'json'),
            expectedState: this._expectedState('FAQPage schema with mainEntity array of Question/Answer pairs'),
            ...faqExtras,
          };
        }
        return {
          currentState: this._absentState('FAQPage schema'),
          expectedState: this._expectedState('FAQPage JSON-LD schema matching visible FAQ content'),
          ...faqExtras,
        };
      }

      case 'breadcrumblist_schema': {
        const bcSchema = _findSchemaByType(structuredData, ['BreadcrumbList']);
        if (bcSchema) {
          return {
            currentState: this._codeState(_prettyJson(bcSchema), 'json'),
            expectedState: this._expectedState('Complete BreadcrumbList schema matching page URL hierarchy'),
          };
        }
        return {
          currentState: this._absentState('BreadcrumbList schema'),
          expectedState: this._expectedState('BreadcrumbList schema reflecting the page navigation path'),
        };
      }

      // ─── AI Visibility — Schema Validation ────────────────────────────
      case 'schema_valid_jsonld': {
        const raw = typeof detectedFromDoc === 'string'
          ? detectedFromDoc
          : _prettyJson(detectedFromDoc || structuredData[0]);
        return {
          currentState: this._codeState(raw, 'json'),
          expectedState: this._expectedState('All JSON-LD blocks parse without errors'),
        };
      }

      case 'correct_type': {
        const detectedType = typeof detectedFromDoc === 'string'
          ? detectedFromDoc
          : (structuredData[0]?.['@type'] || 'Not detected');
        return {
          currentState: this._textState(detectedType, null, null, null),
          expectedState: this._expectedState('Correct @type for this page (e.g., Organization, Article, Service)'),
        };
      }

      case 'context_exactly_schema_org': {
        const ctx = typeof detectedFromDoc === 'string'
          ? detectedFromDoc
          : (structuredData[0]?.['@context'] || 'Not detected');
        return {
          currentState: this._textState(ctx, null, null, null),
          expectedState: this._expectedState('@context must be exactly "https://schema.org"'),
        };
      }

      case 'name_field_matches_brand': {
        const detectedName = typeof detectedFromDoc === 'string'
          ? detectedFromDoc
          : (structuredData[0]?.name || 'Not detected');
        return {
          currentState: this._textState(detectedName, null, null, null),
          expectedState: this._expectedState('Schema name field matches the canonical brand name'),
        };
      }

      case 'url_points_to_canonical_homepage': {
        const detectedUrl = typeof detectedFromDoc === 'string'
          ? detectedFromDoc
          : (structuredData[0]?.url || 'Not detected');
        return {
          currentState: this._textState(detectedUrl, null, null, null),
          expectedState: this._expectedState('Schema url field points to the canonical homepage'),
        };
      }

      case 'logo_url_returns_200': {
        const logoUrl = typeof detectedFromDoc === 'string'
          ? detectedFromDoc
          : (structuredData[0]?.logo?.url || structuredData[0]?.logo || 'Not detected');
        return {
          currentState: this._textState(String(logoUrl), null, null, null),
          expectedState: this._expectedState('Logo URL returns HTTP 200'),
        };
      }

      case 'no_plugin_duplicate_schemas': {
        const types = structuredData.map(s => s['@type']).filter(Boolean);
        return {
          currentState: this._listState(types),
          expectedState: this._expectedState('Each @type appears only once — no duplicate schemas from plugins'),
        };
      }

      case 'consistent_id_across_pages': {
        const ids = Array.isArray(detectedFromDoc) ? detectedFromDoc : _toStringArray(detectedFromDoc);
        return {
          currentState: this._listState(ids),
          expectedState: this._expectedState('Organization @id is identical across all pages'),
        };
      }

      case 'child_schemas_reference_main_id': {
        const children = Array.isArray(detectedFromDoc) ? detectedFromDoc : [];
        const rows = children.map(s => ({
          type: s['@type'] || 'Unknown',
          has_parent_id: s['isPartOf'] || s['publisher'] ? 'Yes' : 'No',
        }));
        return {
          currentState: this._tableState(['Schema Type', 'References Parent @id'], rows),
          expectedState: this._expectedState('All child schemas reference the parent Organization @id'),
        };
      }

      case 'opening_hours_specification': {
        const existing = _findSchemaByType(structuredData, ['OpeningHoursSpecification']);
        if (existing) {
          return {
            currentState: this._codeState(_prettyJson(existing), 'json'),
            expectedState: this._expectedState('OpeningHoursSpecification with dayOfWeek, opens, closes'),
          };
        }
        return {
          currentState: this._absentState('OpeningHoursSpecification schema'),
          expectedState: this._expectedState('OpeningHoursSpecification inside LocalBusiness schema'),
        };
      }

      case 'event_schema': {
        return {
          currentState: this._absentState('Event schema'),
          expectedState: this._expectedState('Event schema for event content (name, startDate, location, url)'),
        };
      }

      case 'aggregate_rating_schema': {
        return {
          currentState: this._absentState('AggregateRating schema'),
          expectedState: this._expectedState('AggregateRating inside Product or Service schema (ratingValue, reviewCount)'),
          // The rating figures actually shown on the page, the schema already on
          // it, the entity the rating belongs to, and the schema that would be
          // generated — all derived from crawl data, none hardcoded.
          contextExtras: { ratingDetection: getRatingDetection({ pageData, issueDoc: onPageIssue }) },
        };
      }

      case 'invalid_schema_type': {
        const ctx = onPageIssue?.context || {};
        const invalidType  = ctx.invalid_type  || String(detectedFromDoc || 'Unknown');
        const pageType     = ctx.page_type     || 'unknown';
        const suggested    = ctx.suggested     || 'WebPage';
        const detectedTypes = ctx.detected_types || [invalidType];
        return {
          currentState: this._tableState(
            ['Schema Found', 'Page Type', 'Status'],
            [{
              'Schema Found': invalidType,
              'Page Type':    _titleCase(pageType),
              'Status':       `${invalidType} is not valid on ${_titleCase(pageType)} pages`,
            }]
          ),
          expectedState: this._expectedState(
            `Remove ${invalidType} schema and replace with appropriate type for ${_titleCase(pageType)} pages (e.g., ${suggested})`
          ),
        };
      }

      case 'schema_type_conflict': {
        const ctx = onPageIssue?.context || {};
        const conflictingTypes = ctx.conflicting_types || [];
        const family    = ctx.family    || 'content';
        const pageType  = ctx.page_type || 'unknown';
        const rows = (conflictingTypes.length > 0 ? conflictingTypes : [String(detectedFromDoc || 'Unknown')]).map((t, i) => ({
          'Schema Type':    t,
          'Family':         _titleCase(family),
          'Action':         i === 0 ? 'Keep (most specific)' : 'Remove',
        }));
        return {
          currentState: this._tableState(['Schema Type', 'Family', 'Action'], rows),
          expectedState: this._expectedState(
            `Use only one ${family} schema type per page — keep the most specific, remove the rest`
          ),
        };
      }

      case 'product_schema': {
        const productSchema = _findSchemaByType(structuredData, ['Product']);
        if (productSchema) {
          return {
            currentState: this._codeState(_prettyJson(productSchema), 'json'),
            expectedState: this._expectedState('Product schema with name, description, brand, and Offers (price, priceCurrency, availability)'),
          };
        }
        return {
          currentState: this._absentState('Product schema'),
          expectedState: this._expectedState('Product JSON-LD with name, description, brand, and nested Offer schema (price, priceCurrency, availability)'),
        };
      }

      case 'service_product_schema_with_offers': {
        const svcSchema = _findSchemaByType(structuredData, ['Service', 'Product']);
        if (svcSchema) {
          return {
            currentState: this._codeState(_prettyJson(svcSchema), 'json'),
            expectedState: this._expectedState('Service or Product schema includes Offers with price'),
          };
        }
        return {
          currentState: this._absentState('Offers in Service/Product schema'),
          expectedState: this._expectedState('Service/Product schema with Offers (price, priceCurrency, availability)'),
        };
      }

      case 'geo_coordinates_in_schema': {
        const orgSchema = _findSchemaByType(structuredData, ['Organization', 'LocalBusiness']);
        const hasGeo = orgSchema?.geo;
        return {
          currentState: hasGeo
            ? this._codeState(_prettyJson(orgSchema.geo), 'json')
            : this._absentState('GeoCoordinates in schema'),
          expectedState: this._expectedState('GeoCoordinates with latitude and longitude in LocalBusiness schema'),
        };
      }

      default: {
        const existing = structuredData[0];
        if (existing) {
          return {
            currentState: this._codeState(_prettyJson(existing), 'json'),
            expectedState: this._expectedState(aiIssue?.expected_value || onPageIssue?.expected_value || 'See issue description'),
          };
        }
        return {
          currentState: this._absentState('schema'),
          expectedState: this._expectedState('See issue description'),
        };
      }
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function _findSchemas(data) {
  if (!data || !Array.isArray(data)) return [];
  return data;
}

// First entity whose @type (a string OR an array) is, or descends from, one of `types` -
// searching arrays and @graph the same way the crawler stores them.
function _findSchemaByType(data, types) {
  return flattenJsonLd(data).find((n) => typesOf(n).some((t) => types.some((x) => typeSatisfies(t, x)))) || null;
}

// The site's primary Organization/LocalBusiness entity (see schemaGraph.analyzeOrganizations):
// a node whose own url is on another site is never picked.
function _findPrimaryOrganization(data, pageUrl) {
  let siteUrl;
  try { siteUrl = pageUrl ? new URL(pageUrl).origin + '/' : undefined; } catch { siteUrl = undefined; }
  return analyzeOrganizations(flattenJsonLd(data), { siteUrl }).primary;
}

function _prettyJson(obj) {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(obj);
  }
}

function _toStringArray(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val.map(String);
  return [String(val)];
}

function _titleCase(str) {
  if (!str) return 'Unknown';
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

export default new SchemaResolver();
