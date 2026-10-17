/**
 * Fixtures modelled on the structured data a real Rank Math site emits (observed on
 * krishnaeyecentre.com during the schema audit, hostnames anonymised): one @graph, an entity
 * typed ["Hospital","Organization"], the logo as an ImageObject node referenced by @id, a
 * crawl key with no trailing slash while the canonical has one.
 */

export const ORIGIN = 'https://clinic.example';
export const HOME = `${ORIGIN}/`;
export const REAL_LOGO = `${ORIGIN}/wp-content/uploads/2019/05/clinic-logo.png`;
export const INVENTED_LOGO = `${ORIGIN}/wp-content/uploads/logo.png`; // what the model invented: 404 on the real site
export const ABOUT_CANONICAL = `${ORIGIN}/about-us/`;
export const ABOUT_CRAWL_KEY = `${ORIGIN}/about-us`;

export const ORG_ID = `${ORIGIN}/#organization`;

export const organization = (over = {}) => ({
  '@type': ['Hospital', 'Organization'],
  '@id': ORG_ID,
  name: 'Clinic Eye Centre',
  url: HOME,
  telephone: '+918447637606',
  address: { '@type': 'PostalAddress', streetAddress: '2-A Trust House', addressLocality: 'Parel', addressCountry: 'India' },
  logo: { '@type': 'ImageObject', '@id': `${ORIGIN}/#logo`, url: REAL_LOGO, width: '178', height: '59' },
  ...over,
});

/** The page's crawler-stored structured_data: root @graph, @context on the parent only. */
export const graphWithOrganization = (orgOver = {}) => [{
  '@context': 'https://schema.org',
  '@graph': [
    { '@type': 'Place', '@id': `${ORIGIN}/#place` },
    organization(orgOver),
    { '@type': 'WebSite', '@id': `${ORIGIN}/#website`, url: ORIGIN, name: 'Clinic Eye Centre' },
    { '@type': 'AboutPage', '@id': `${ABOUT_CANONICAL}#webpage`, url: ABOUT_CANONICAL },
  ],
}];

/** seo_page_data for the About page. */
export const aboutPageData = (over = {}) => ({
  url: ABOUT_CRAWL_KEY,
  canonical: ABOUT_CANONICAL,
  title: 'About Us - Clinic Eye Centre',
  structured_data: graphWithOrganization(),
  meta_tags: {},
  images: [
    { src: `${ORIGIN}/wp-content/uploads/2024/10/clinic-logo-1.jpg`, alt: '' },
    { src: `${ORIGIN}/wp-content/uploads/2020/02/team-photo.jpg`, alt: 'The team' },
  ],
  word_count: 520,
  ...over,
});

export const probeOk = (url, over = {}) => ({ url, ok: true, status: 'ok', http_status: 200, final_url: url, content_type: 'image/png', format: 'png', width: 178, height: 59, bytes_read: 4200, redirects: 0, conclusive: true, reason: null, ...over });
export const probe404 = (url) => ({ url, ok: false, status: 'http_error', http_status: 404, final_url: url, content_type: 'text/html', format: null, width: null, height: null, bytes_read: 0, redirects: 0, conclusive: true, reason: 'HTTP 404' });
export const probeHtml200 = (url) => ({ url, ok: false, status: 'not_image', http_status: 200, final_url: url, content_type: 'text/html', format: null, width: null, height: null, bytes_read: 900, redirects: 0, conclusive: true, reason: 'The URL answered successfully but the response is not an image file' });
export const probeTimeout = (url) => ({ url, ok: false, status: 'timeout', http_status: null, final_url: null, content_type: null, format: null, width: null, height: null, bytes_read: 0, redirects: 0, conclusive: false, reason: 'The server did not respond in time' });
