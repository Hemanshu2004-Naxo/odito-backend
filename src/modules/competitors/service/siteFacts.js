import * as cheerio from 'cheerio';
import { safeFetch } from '../../ai-investigation/net/ssrfGuard.js';

/**
 * What a website says about itself, read from its HOMEPAGE only (never a crawl): title, description, headings, structured data (JSON-LD
 * schema.org types, name, postal address, telephone, geo) and a short text sample. Used by the relevance classifier as evidence.
 *
 * extractSiteFacts is pure (HTML in, facts out). fetchSiteFacts does the one request through the SSRF-safe fetcher: private and internal
 * addresses are refused, redirects are validated hop by hop, and the size and time are capped.
 */

export const FACTS_VERSION = 1;
const TEXT_SAMPLE_CHARS = 2500;
// Real homepages can be large (a WordPress page with inline scripts and styles easily passes 1.5 MB), so the download cap is generous; only the
// first 1.5M characters are parsed and only a few hundred bytes of facts are kept.
const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

const asArray = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
const typesOf = (node) => asArray(node?.['@type']).filter((t) => typeof t === 'string');

/** Every JSON-LD node in the page (flattening @graph), tolerant of broken blocks. */
function jsonLdNodes($) {
  const nodes = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    let data;
    try { data = JSON.parse($(el).contents().text()); } catch { return; }
    const walk = (n, depth = 0) => {
      if (!n || typeof n !== 'object' || depth > 4) return;
      if (Array.isArray(n)) { n.forEach((x) => walk(x, depth + 1)); return; }
      nodes.push(n);
      if (n['@graph']) walk(n['@graph'], depth + 1);
    };
    walk(data);
  });
  return nodes.slice(0, 60);
}

const addressOf = (node) => {
  const a = node?.address;
  if (!a) return null;
  if (typeof a === 'string') return { street: clip(a, 200), locality: null, region: null, country: null, postal: null };
  const country = typeof a.addressCountry === 'string' ? a.addressCountry : a.addressCountry?.name ?? null;
  return { street: clip(a.streetAddress, 200) || null, locality: clip(a.addressLocality, 100) || null, region: clip(a.addressRegion, 100) || null, country: clip(country, 100) || null, postal: clip(a.postalCode, 20) || null };
};

const num = (v) => { const n = typeof v === 'string' ? Number.parseFloat(v) : v; return Number.isFinite(n) ? n : null; };

/** @returns {object} facts (see below); `fetched: true` always for this function. */
export function extractSiteFacts(html, { finalUrl = null } = {}) {
  const $ = cheerio.load(String(html ?? '').slice(0, 1_500_000));
  const nodes = jsonLdNodes($);
  const schemaTypes = [...new Set(nodes.flatMap(typesOf))].slice(0, 25);
  const business = nodes.find((n) => typesOf(n).some((t) => /Hospital|Clinic|MedicalBusiness|Physician|Dentist|LocalBusiness|Optician|Pharmacy|HealthAndBeautyBusiness|Store|Restaurant|Organization/.test(t)) && (n.address || n.telephone || n.geo));
  const orgNames = [...new Set(nodes.filter((n) => typesOf(n).some((t) => /Organization|Business|Hospital|Clinic|Physician|Dentist|Store/.test(t))).map((n) => clip(n.name, 120)).filter(Boolean))].slice(0, 5);
  $('script, style, noscript, svg, iframe').remove();
  const text = clip($('body').text(), 20_000);
  const geo = business?.geo ? { lat: num(business.geo.latitude), lng: num(business.geo.longitude) } : null;
  return {
    fetched: true,
    version: FACTS_VERSION,
    finalUrl,
    title: clip($('title').first().text(), 200) || null,
    description: clip($('meta[name="description"]').attr('content') ?? $('meta[property="og:description"]').attr('content'), 400) || null,
    siteName: clip($('meta[property="og:site_name"]').attr('content'), 120) || null,
    ogType: clip($('meta[property="og:type"]').attr('content'), 40) || null,
    lang: clip($('html').attr('lang'), 12) || null,
    h1: $('h1').slice(0, 3).map((_, e) => clip($(e).text(), 160)).get().filter(Boolean),
    h2: $('h2').slice(0, 8).map((_, e) => clip($(e).text(), 120)).get().filter(Boolean),
    schemaTypes,
    orgNames,
    address: business ? addressOf(business) : null,
    phone: business?.telephone ? clip(business.telephone, 40) : null,
    geo: geo && geo.lat !== null && geo.lng !== null ? geo : null,
    hasTelLink: $('a[href^="tel:"]').length > 0,
    hasArticleMarkup: $('article').length > 0 || /article/i.test($('meta[property="og:type"]').attr('content') ?? ''),
    textSample: text.slice(0, TEXT_SAMPLE_CHARS).toLowerCase(),
  };
}

/** One safe request for the homepage. Never throws: a failure is `{ fetched: false, error }` so the classifier can say "could not read it". */
export async function fetchSiteFacts(domain, { fetcher = safeFetch } = {}) {
  try {
    const res = await fetcher(`https://${domain}/`, { timeoutMs: 8000, maxBytes: 4_000_000, maxRedirects: 3 });
    if (res.status >= 400) return { fetched: false, version: FACTS_VERSION, error: `HTTP_${res.status}` };
    const ct = String(res.headers?.['content-type'] ?? '');
    if (ct && !/html|xml|text/i.test(ct)) return { fetched: false, version: FACTS_VERSION, error: 'NOT_HTML' };
    return extractSiteFacts(res.body, { finalUrl: res.finalUrl });
  } catch (err) {
    // A short, safe code only (SafeFetchError codes such as SSRF_BLOCKED / TIMEOUT / NETWORK), never the message.
    return { fetched: false, version: FACTS_VERSION, error: typeof err?.code === 'string' && err.code.length <= 40 ? err.code : 'FETCH_FAILED' };
  }
}
