/**
 * TEST DATA ONLY — every name, domain and address below is fictional (".example" is a reserved TLD). Nothing here is
 * a real business, and none of these values may appear in production code or fixtures for a real site.
 *
 * Shaped like the markup a Yoast-style site emits for the finding under test: one @graph with a plain Organization
 * (@id <home>#organization, logo as an ImageObject node referenced by @id, NO address), a WebSite and a WebPage.
 */

export const ORIGIN = 'https://eye-hospital.example';
export const HOME = `${ORIGIN}/`;
export const ORG_ID = `${ORIGIN}/#organization`;
export const LOGO_ID = `${ORIGIN}/#/schema/logo/image/`;
export const LOGO_URL = `${ORIGIN}/wp-content/uploads/2025/09/logo.png`;

/** A complete, structured address that exists only in these tests. */
export const TEST_ADDRESS = Object.freeze({
  streetAddress: '14 Lakeview Road',
  addressLocality: 'Rivertown',
  addressRegion: 'Karnataka',
  postalCode: '560001',
  addressCountry: 'IN',
});
export const TEST_ADDRESS_NODE = Object.freeze({ '@type': 'PostalAddress', ...TEST_ADDRESS });

/** A second, DIFFERENT fictional address (for conflict / branch tests). */
export const OTHER_ADDRESS = Object.freeze({
  streetAddress: '9 Harbour Street',
  addressLocality: 'Portville',
  addressRegion: 'Goa',
  postalCode: '403001',
  addressCountry: 'IN',
});

export const organizationNode = (over = {}) => ({
  '@type': 'Organization',
  '@id': ORG_ID,
  name: 'Eye Hospital Test Site',
  url: HOME,
  logo: { '@id': LOGO_ID },
  sameAs: [`${ORIGIN}/social/test-profile`],
  ...over,
});

export const logoNode = () => ({ '@type': 'ImageObject', '@id': LOGO_ID, url: LOGO_URL, contentUrl: LOGO_URL, width: 264, height: 62, caption: 'Eye Hospital Test Site' });
export const websiteNode = () => ({ '@type': 'WebSite', '@id': `${ORIGIN}/#website`, url: HOME, name: 'Eye Hospital Test Site', publisher: { '@id': ORG_ID } });
export const webPageNode = (path = '/') => ({ '@type': 'WebPage', '@id': `${ORIGIN}${path}#webpage`, url: `${ORIGIN}${path}`, isPartOf: { '@id': `${ORIGIN}/#website` }, about: { '@id': ORG_ID }, dateModified: '2026-09-01T10:00:00+00:00' });

/** A crawler-stored structured_data value (root @graph). */
export const yoastGraph = (orgOver = {}, extraNodes = []) => [{
  '@context': 'https://schema.org',
  '@graph': [webPageNode(), websiteNode(), organizationNode(orgOver), logoNode(), ...extraNodes],
}];

export const pageDoc = (path, structured_data, over = {}) => ({
  url: `${ORIGIN}${path === '/' ? '' : path}`.replace(/\/$/, '') || ORIGIN,
  title: `Eye Hospital Test Site ${path}`, structured_data, meta_tags: {}, images: [], word_count: 500, page_type: { name: path === '/' ? 'homepage' : 'generic' }, ...over,
});

/** The homepage as crawled: the url key has no trailing slash. */
export const homePageDoc = (structured_data = yoastGraph(), over = {}) => ({ ...pageDoc('/', structured_data, over), url: ORIGIN });

export const probeOk = (url) => ({ url, ok: true, conclusive: true, status: 200, format: 'png', width: 264, height: 62, content_type: 'image/png', final_url: url });
