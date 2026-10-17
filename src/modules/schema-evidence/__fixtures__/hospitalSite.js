/**
 * A multi-page hospital site shaped like the real crawl that exposed the Organization/LocalBusiness defect
 * (hostnames anonymised): the full ["Hospital","Organization"] entity and a Place (address, geo) on the homepage and a few
 * pages; gallery / appointment / service pages carry only the INVALID type "Optometric".
 */
import { ORIGIN, HOME, ORG_ID, REAL_LOGO } from './clinicSite.js';

export const PLACE_ID = `${ORIGIN}/#place`;
export const ADDRESS = { '@type': 'PostalAddress', streetAddress: '2-A Trust House', addressLocality: 'Parel', addressRegion: 'Mumbai', postalCode: '400012', addressCountry: 'IN' };
export const GEO = { '@type': 'GeoCoordinates', latitude: 18.99, longitude: 72.84 };

export const hospitalGraph = (over = {}) => [{
  '@context': 'https://schema.org',
  '@graph': [
    { '@type': 'Place', '@id': PLACE_ID, address: ADDRESS, geo: GEO, hasMap: 'https://maps.example/clinic' },
    {
      '@type': ['Hospital', 'Organization'], '@id': ORG_ID, name: 'Clinic Eye Centre', url: HOME, telephone: '+918447637606',
      location: { '@id': PLACE_ID }, address: ADDRESS, logo: { '@type': 'ImageObject', url: REAL_LOGO },
      ...over,
    },
    { '@type': 'WebSite', '@id': `${ORIGIN}/#website`, url: ORIGIN, name: 'Clinic Eye Centre' },
  ],
}];

const invalidOnly = [{ '@context': 'https://schema.org', '@type': 'Optometric', name: 'Clinic Eye Centre' }];

export const page = (path, structured_data, over = {}) => ({
  url: `${ORIGIN}${path}`, title: `Clinic Eye Centre ${path}`, structured_data, meta_tags: {}, images: [], word_count: 400, ...over,
});

/** 8 crawled pages: entity pages carry the full graph, generic pages only the invalid type. */
export const hospitalSitePages = () => [
  page('/', hospitalGraph()),
  page('/about-us', hospitalGraph()),
  page('/book-contact', hospitalGraph()),
  page('/gallery', invalidOnly),
  page('/appointment', invalidOnly),
  page('/cataract-surgery', invalidOnly),
  page('/lasik', invalidOnly),
  page('/blog', []),
];
