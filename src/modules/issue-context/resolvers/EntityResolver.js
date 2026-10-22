import { BaseResolver } from './BaseResolver.js';

/**
 * EntityResolver
 *
 * Handles entity, NAP, citation, and author issue types
 * from the AI Visibility pipeline (and on-page EEAT issues).
 */
export class EntityResolver extends BaseResolver {
  resolve(issueId, _displayType, extracted, _issueDoc) {
    const { pageData, issuesByCode, visibilityData, issuesByRuleId } = extracted;

    const onPageIssue = issuesByCode?.[issueId];
    const aiIssue = issuesByRuleId?.[issueId];
    const detectedFromDoc = onPageIssue?.detected_value ?? aiIssue?.detected_value ?? null;

    // Entity signals from normalized signals or AI visibility metadata
    const signals = visibilityData?.normalized_signals || visibilityData?.ai_visibility || {};
    const structuredData = visibilityData?.structured_data || pageData?.structured_data || [];

    switch (issueId) {

      // ─── NAP Consistency ──────────────────────────────────────────────
      case 'business_name_identical': {
        const variants = Array.isArray(detectedFromDoc)
          ? detectedFromDoc
          : _extractNapField(structuredData, 'name', detectedFromDoc);
        const rows = variants.map((v, i) => ({
          source: `Source ${i + 1}`,
          value: String(v),
          matches_first: i === 0 ? 'Canonical' : String(v) === String(variants[0]) ? 'Yes' : 'No',
        }));
        return {
          currentState: this._tableState(['Source', 'Business Name', 'Consistent'], rows),
          expectedState: this._expectedState('Identical business name across all schema, footer, and contact sources'),
        };
      }

      case 'address_identical': {
        const variants = Array.isArray(detectedFromDoc)
          ? detectedFromDoc
          : _extractNapField(structuredData, 'address', detectedFromDoc);
        const rows = variants.map((v, i) => ({
          source: `Source ${i + 1}`,
          value: _addressToString(v),
          matches_first: i === 0 ? 'Canonical' : _addressToString(v) === _addressToString(variants[0]) ? 'Yes' : 'No',
        }));
        return {
          currentState: this._tableState(['Source', 'Address', 'Consistent'], rows),
          expectedState: this._expectedState('Identical address across all schema, footer, and contact sources'),
        };
      }

      case 'nap_matches_footer_contact': {
        const schemaName = structuredData[0]?.name || '—';
        const footerContact = signals?.footer_contact || detectedFromDoc || {};
        const rows = [
          { field: 'Name', schema: schemaName, footer: footerContact.name || '—' },
          { field: 'Address', schema: _addressToString(structuredData[0]?.address), footer: footerContact.address || '—' },
          { field: 'Phone', schema: structuredData[0]?.telephone || '—', footer: footerContact.phone || '—' },
        ];
        return {
          currentState: this._tableState(['Field', 'Schema Value', 'Footer Value'], rows),
          expectedState: this._expectedState('Schema NAP (name, address, phone) exactly matches footer contact information'),
        };
      }

      case 'phone_e164_format': {
        const phone = typeof detectedFromDoc === 'string'
          ? detectedFromDoc
          : (structuredData[0]?.telephone || signals?.phone || 'Not detected');
        return {
          currentState: this._textState(String(phone), null, null, null),
          expectedState: this._expectedState('Phone in E.164 format: +1XXXXXXXXXX'),
        };
      }

      // ─── Entity ───────────────────────────────────────────────────────
      case 'no_entity_fragmentation': {
        const entities = Array.isArray(detectedFromDoc) ? detectedFromDoc : [];
        const items = entities.map(e =>
          typeof e === 'object' ? `${e['@type'] || 'Entity'}: ${e.name || e['@id'] || JSON.stringify(e)}` : String(e)
        );
        return {
          currentState: this._listState(items),
          expectedState: this._expectedState('Single consistent entity representation across all pages'),
        };
      }

      case 'only_one_primary_entity': {
        const types = Array.isArray(detectedFromDoc)
          ? detectedFromDoc
          : structuredData.map(s => s['@type']).filter(Boolean);
        return {
          currentState: this._listState(types.map(String)),
          expectedState: this._expectedState('One primary entity type consistently used across the site'),
        };
      }

      case 'sameas_array_links_active': {
        const links = Array.isArray(detectedFromDoc)
          ? detectedFromDoc
          : (structuredData[0]?.sameAs || []);
        const items = links.map(l =>
          typeof l === 'object' ? `${l.url || String(l)} — ${l.status || 'unknown'}` : String(l)
        );
        return {
          currentState: this._listState(items),
          expectedState: this._expectedState('All sameAs links are active (return 200 HTTP)'),
        };
      }

      case 'about_contact_privacy_terms_pages': {
        const missing = Array.isArray(detectedFromDoc) ? detectedFromDoc : [];
        return {
          currentState: this._listState(missing.map(String)),
          expectedState: this._expectedState('About, Contact, Privacy Policy, and Terms pages all exist'),
        };
      }

      case 'area_served_defined': {
        return {
          currentState: this._absentState('areaServed in schema'),
          expectedState: this._expectedState('areaServed field in Service or LocalBusiness schema with geographic coverage'),
        };
      }

      // ─── Author / EEAT ────────────────────────────────────────────────
      case 'visible_author_name':
      case 'author_name_bio': {
        return {
          currentState: this._absentState('visible author name'),
          expectedState: this._expectedState('Named author visibly attributed to content on the page'),
        };
      }

      case 'author_bio_with_credentials': {
        const bio = typeof detectedFromDoc === 'string' ? detectedFromDoc : signals?.author_bio || '';
        if (bio) {
          return {
            currentState: this._textState(bio, this._charLength(bio), 'characters', null),
            expectedState: this._expectedState('Author bio includes role, credentials, and years of experience'),
          };
        }
        return {
          currentState: this._absentState('author bio'),
          expectedState: this._expectedState('Author bio with professional credentials and role'),
        };
      }

      case 'author_photo': {
        return {
          currentState: this._absentState('author photo'),
          expectedState: this._expectedState('Author photo associated with the author name on the page'),
        };
      }

      case 'dedicated_author_page': {
        return {
          currentState: this._absentState('dedicated author profile page'),
          expectedState: this._expectedState('A dedicated /author/ or /team/author-name page with full bio'),
        };
      }

      case 'person_schema_linked':
      case 'person_schema_linked_to_organization': {
        const personSchema = structuredData.find(s => s['@type'] === 'Person');
        if (personSchema) {
          return {
            currentState: this._codeState(_prettyJson(personSchema), 'json'),
            expectedState: this._expectedState('Person schema includes real human name, worksFor linking to Organization @id, jobTitle, and sameAs social profiles'),
          };
        }
        return {
          currentState: this._absentState('Person schema'),
          expectedState: this._expectedState('Person schema with real human name, worksFor referencing Organization @id, and jobTitle'),
        };
      }

      case 'business_registration_details': {
        return {
          currentState: this._absentState('business registration or ABN number'),
          expectedState: this._expectedState('Business registration number or ABN visible on site'),
        };
      }

      case 'google_maps_embed_correct': {
        return {
          currentState: this._absentState('Google Maps embed'),
          expectedState: this._expectedState('Google Maps embed showing correct business location'),
        };
      }

      default: {
        return {
          currentState: this._textState(
            detectedFromDoc != null ? String(detectedFromDoc) : null,
            null, null, null
          ),
          expectedState: this._expectedState(aiIssue?.expected_value || onPageIssue?.expected_value || 'See issue description'),
        };
      }
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function _extractNapField(schemas, field, fallback) {
  if (fallback) return Array.isArray(fallback) ? fallback : [fallback];
  return schemas.map(s => s[field]).filter(Boolean);
}

function _addressToString(addr) {
  if (!addr) return '—';
  if (typeof addr === 'string') return addr;
  const parts = [
    addr.streetAddress,
    addr.addressLocality,
    addr.addressRegion,
    addr.postalCode,
    addr.addressCountry,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : JSON.stringify(addr);
}

function _prettyJson(obj) {
  try { return JSON.stringify(obj, null, 2); } catch { return String(obj); }
}

export default new EntityResolver();
