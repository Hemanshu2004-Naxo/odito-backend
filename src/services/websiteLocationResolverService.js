/**
 * WebsiteLocationResolverService
 *
 * Inspects extracted website metadata and address strings to determine
 * the business's physical location for Local SEO targeting.
 *
 * Used exclusively by the /api/seo/resolve-website-location onboarding endpoint.
 * Called when Google Places failed and the user chose Local SEO — the system
 * needs a city before it can resolve a DataForSEO location_code.
 *
 * Resolution order (first match wins):
 *  1. Schema.org LocalBusiness / JSON-LD address
 *  2. Contact info address from extracted metadata (contact_info.address)
 *  3. Plain address string passed by the caller (from website extraction)
 *
 * ISOLATION CONTRACT:
 *  - Never imported by ranking, SERP, Maps, or location resolver modules.
 *  - Never writes to any database collection.
 *  - Returns null on failure; never throws.
 */

import { extractCityFromAddress, extractCountryCode } from './dataforseoLocationService.js';
import { resolveLocalLocationCode } from './localLocationResolver.js';

// ── Schema.org address extraction ─────────────────────────────────────────────

function extractSchemaAddress(schema) {
  if (!schema) return null;

  // Support both a single root object and a @graph array
  const roots = Array.isArray(schema['@graph'])
    ? schema['@graph']
    : [schema];

  for (const node of roots) {
    if (!node) continue;
    const addrObj = node.address;
    if (!addrObj) continue;

    if (typeof addrObj === 'string' && addrObj.trim()) {
      return addrObj.trim();
    }

    if (typeof addrObj === 'object') {
      const parts = [
        addrObj.streetAddress,
        addrObj.addressLocality,
        addrObj.addressRegion,
        addrObj.postalCode,
        addrObj.addressCountry,
      ].filter(Boolean);
      if (parts.length > 0) return parts.join(', ');
    }
  }

  return null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Attempt to resolve a city/country from extracted website data.
 *
 * @param {string|null} address           - Plain address string returned by the website extractor
 * @param {Object|null} extractedMetadata - Metadata stored during website manual fallback
 *   Expected shape: { schema_org: {…}, contact_info: { address: string } }
 *
 * @returns {Promise<{
 *   city:        string,
 *   state:       null,
 *   country:     string|null,
 *   address:     string,
 *   confidence:  string,
 *   source:      string,
 *   locationCode: number|null
 * }|null>}
 */
export async function resolveLocationFromWebsiteData({ address, extractedMetadata }) {
  const candidates = [];

  // Source 1: Schema.org LocalBusiness address (highest confidence)
  if (extractedMetadata?.schema_org) {
    const schemaAddr = extractSchemaAddress(extractedMetadata.schema_org);
    if (schemaAddr) {
      candidates.push({ text: schemaAddr, source: 'schema.org', confidence: 'high' });
    }
  }

  // Source 2: Contact info address captured from the contact/footer page
  if (extractedMetadata?.contact_info?.address) {
    candidates.push({
      text: extractedMetadata.contact_info.address,
      source: 'contact_page',
      confidence: 'medium',
    });
  }

  // Source 3: Plain address string (from website extraction top-level address field)
  if (address) {
    candidates.push({ text: address, source: 'address', confidence: 'medium' });
  }

  for (const { text, source, confidence } of candidates) {
    const city = extractCityFromAddress(text);
    if (!city) continue;

    const country = extractCountryCode(text) || null;

    try {
      const resolution = await resolveLocalLocationCode({
        verifiedBusiness: { city, address: text, location: {} },
        country,
        address: text,
      });

      console.log(
        `[LOCAL_LOCATION] Website Location Found` +
        ` | city=${city}` +
        ` | country=${country ?? 'null'}` +
        ` | source=${source}` +
        ` | locationCode=${resolution.locationCode}`
      );

      return {
        city,
        state:       null,
        country,
        address:     text,
        confidence,
        source,
        locationCode: resolution.locationCode,
      };
    } catch (err) {
      // City was found but DataForSEO location list call failed — return city without code.
      // The backend will resolve the code again during keyword generation.
      console.warn(
        `[LOCAL_LOCATION] City found but locationCode resolution failed` +
        ` | city=${city} | ${err.message}`
      );
      return {
        city,
        state:       null,
        country,
        address:     text,
        confidence,
        source,
        locationCode: null,
      };
    }
  }

  console.log('[LOCAL_LOCATION] Website Location Not Found');
  return null;
}
