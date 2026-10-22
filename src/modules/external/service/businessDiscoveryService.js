import axios from 'axios';
import * as cheerio from 'cheerio';

const FETCH_TIMEOUT_MS = 8000;
const REQUEST_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
  'Accept-Language': 'en-US,en;q=0.9'
};

const EMPTY_DATA = {
  businessName: '',
  location: '',
  city: '',
  state: '',
  country: '',
  source: 'manual',
  confidence: 'none'
};

const IDENTITY_SCHEMA_TYPES = [
  'Organization', 'LocalBusiness', 'Corporation', 'Store', 'Restaurant',
  'ProfessionalService', 'Person', 'WebSite', 'MedicalBusiness',
  'HealthAndBeautyBusiness', 'FoodEstablishment', 'Hotel', 'LodgingBusiness',
  'AutomotiveBusiness', 'EntertainmentBusiness', 'FinancialService',
  'HomeAndConstructionBusiness', 'LegalService', 'SportsActivityLocation'
];

function normalizeUrl(url) {
  url = url.trim();
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }
  return url;
}

function extractFromJsonLd($) {
  let businessName = '';
  let location = '';
  let city = '';
  let state = '';
  let country = '';

  $('script[type="application/ld+json"]').each((_, el) => {
    if (businessName && location) return;

    try {
      const raw = $(el).html() || $(el).text();
      if (!raw || !raw.trim()) return;

      const data = JSON.parse(raw.trim());
      const schemas = Array.isArray(data) ? data : [data];

      for (const schema of schemas) {
        if (!schema || typeof schema !== 'object') continue;

        const type = schema['@type'];
        const types = Array.isArray(type) ? type : (type ? [type] : []);
        const isIdentity = types.some(t =>
          t && IDENTITY_SCHEMA_TYPES.some(it => t.includes(it))
        );

        if (!isIdentity) continue;

        if (!businessName && schema.name) {
          businessName = String(schema.name).trim();
        }

        if (!location && schema.address) {
          const addr = schema.address;
          if (typeof addr === 'string') {
            location = addr.trim();
          } else if (typeof addr === 'object') {
            city = String(addr.addressLocality || '').trim();
            state = String(addr.addressRegion || '').trim();
            country = String(addr.addressCountry || '').trim();
            location = [city, state].filter(Boolean).join(', ');
          }
        }

        if (businessName && location) break;
      }
    } catch {}
  });

  return { businessName, location, city, state, country };
}

function extractFromMeta($) {
  // og:site_name is the most reliable meta tag for brand name
  const ogSiteName = $('meta[property="og:site_name"]').attr('content');
  if (ogSiteName && ogSiteName.trim()) {
    return ogSiteName.trim();
  }

  // application-name
  const appName = $('meta[name="application-name"]').attr('content');
  if (appName && appName.trim()) {
    return appName.trim();
  }

  return '';
}

function extractFromTitle($) {
  const title = $('title').text().trim();
  if (!title) return '';

  // "Brand | Page" or "Page - Brand" → take shortest part (usually the brand)
  const parts = title.split(/\s*[\|\-–—]\s*/);
  if (parts.length >= 2) {
    const sorted = [...parts].sort((a, b) => a.length - b.length);
    const candidate = sorted[0].trim();
    if (candidate.length >= 2 && candidate.length <= 50) {
      return candidate;
    }
  }

  // Single segment title
  if (title.length <= 60) return title;
  return '';
}

function extractFromAddress($) {
  const addressEl = $('address').first().text().trim();
  if (!addressEl) return { location: '', city: '' };

  const lines = addressEl.split(/[\n,]+/).map(l => l.trim()).filter(l => l.length > 2);
  if (lines.length >= 2) {
    return {
      location: lines.slice(-2).join(', '),
      city: lines[lines.length - 2] || ''
    };
  }
  if (lines.length === 1) {
    return { location: lines[0], city: lines[0] };
  }
  return { location: '', city: '' };
}

/**
 * Lightweight business discovery from a URL.
 * Uses cheerio to parse HTML; no Python worker required.
 * Always resolves (never rejects) — returns EMPTY_DATA on any failure.
 *
 * @param {string} url - The website URL to inspect
 * @returns {{ success: true, data: { businessName, location, city, state, country, source, confidence } }}
 */
export async function discoverBusinessFromUrl(url) {
  try {
    const normalizedUrl = normalizeUrl(url);

    const response = await axios.get(normalizedUrl, {
      timeout: FETCH_TIMEOUT_MS,
      headers: REQUEST_HEADERS,
      maxRedirects: 5
    });

    const $ = cheerio.load(response.data);

    // --- Business Name (priority order) ---
    let businessName = '';
    let source = 'manual';
    let confidence = 'none';

    // 1. JSON-LD identity schema name (highest confidence)
    const schemaData = extractFromJsonLd($);
    if (schemaData.businessName) {
      businessName = schemaData.businessName;
      source = 'schema';
      confidence = 'high';
    }

    // 2. og:site_name / application-name
    if (!businessName) {
      const metaName = extractFromMeta($);
      if (metaName) {
        businessName = metaName;
        source = 'meta';
        confidence = 'medium';
      }
    }

    // 3. Title tag (cleaned)
    if (!businessName) {
      const titleName = extractFromTitle($);
      if (titleName) {
        businessName = titleName;
        source = 'title';
        confidence = 'low';
      }
    }

    // 4. H1 as last resort
    if (!businessName) {
      const h1 = $('h1').first().text().trim();
      if (h1 && h1.length >= 2 && h1.length <= 80) {
        businessName = h1;
        source = 'h1';
        confidence = 'low';
      }
    }

    // --- Location (priority order) ---
    let location = schemaData.location || '';
    let city = schemaData.city || '';
    let state = schemaData.state || '';
    let country = schemaData.country || '';

    if (!location) {
      const addrData = extractFromAddress($);
      location = addrData.location;
      city = addrData.city;
    }

    return {
      success: true,
      data: { businessName, location, city, state, country, source, confidence }
    };

  } catch (error) {
    console.error('[DISCOVERY] Failed to discover business for:', url, '-', error.message);
    return { success: true, data: { ...EMPTY_DATA } };
  }
}
