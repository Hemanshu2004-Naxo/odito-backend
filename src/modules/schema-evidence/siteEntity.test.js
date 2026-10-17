import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSiteEntity, collectSiteEntity } from './siteEntity.js';
import { ORIGIN, ORG_ID } from './__fixtures__/clinicSite.js';
import { ADDRESS, PLACE_ID, hospitalGraph, hospitalSitePages, page } from './__fixtures__/hospitalSite.js';

describe('analyzeSiteEntity — the business entity of the WHOLE site', () => {
  test('REGRESSION: `/?post_type=events` shares the homepage path but is NOT the homepage', () => {
    const ent = (id) => [{ '@type': ['Hospital', 'Organization'], '@id': `${ORIGIN}/#${id}`, name: 'C', url: `${ORIGIN}/` }];
    const site = analyzeSiteEntity([page('/?post_type=events', ent('events')), page('/', ent('home'))]);
    assert.equal(site.homeUrl, `${ORIGIN}/`);
    assert.equal(site.primary.id, `${ORIGIN}/#home`);
  });

  test('finds the homepage entity, its @id, specific type and the Place address behind a location @id reference', () => {
    const site = analyzeSiteEntity(hospitalSitePages());
    assert.equal(site.found, true);
    assert.equal(site.primary.pageUrl, `${ORIGIN}/`);
    assert.equal(site.primary.id, ORG_ID);
    assert.deepEqual(site.primary.types, ['Hospital', 'Organization']);
    assert.equal(site.primary.physical, true);
    assert.deepEqual(site.specificTypes, ['Hospital']);
    assert.equal(site.place.id, PLACE_ID);
    assert.deepEqual(site.place.address, ADDRESS);
    assert.equal(site.hasAddressEvidence, true);
    assert.deepEqual(site.conflictingIds, []);
    assert.equal(site.entityPageUrls.length, 3);
  });

  test('invalid-only types (Optometric) are NOT an entity: gallery/service pages contribute nothing', () => {
    const site = analyzeSiteEntity(hospitalSitePages().filter((p) => ['/gallery', '/lasik'].some((x) => p.url.endsWith(x))));
    assert.equal(site.found, false);
    assert.equal(site.primary, null);
  });

  test('handles array @type, a JSON-LD array of nodes; ignores malformed pages', () => {
    const pages = [
      { url: `${ORIGIN}/x`, structured_data: [{ '@type': ['LocalBusiness', 'Store'], name: 'S', url: `${ORIGIN}/`, address: 'Main St 1' }] },
      { url: 5, structured_data: null }, null, { url: `${ORIGIN}/y` },
    ];
    const site = analyzeSiteEntity(pages);
    assert.equal(site.found, true);
    assert.equal(site.primary.physical, true);
    assert.equal(site.hasAddressEvidence, true);
  });

  test('no homepage crawled: a physical entity is preferred, and distinct @ids are reported as conflicting', () => {
    const site = analyzeSiteEntity([
      page('/deep/contact', hospitalGraph({ '@id': `${ORIGIN}/#other` })),
      page('/about', [{ '@type': 'Organization', '@id': `${ORIGIN}/#org`, name: 'O', url: `${ORIGIN}/` }]),
    ]);
    assert.equal(site.homeUrl, null);
    assert.equal(site.primary.physical, true);
    assert.deepEqual([...site.conflictingIds].sort(), [`${ORIGIN}/#org`, `${ORIGIN}/#other`].sort());
  });

  test("an entity whose url is another website is not this site's entity", () => {
    const site = analyzeSiteEntity([page('/', [{ '@type': 'Organization', name: 'Partner', url: 'https://partner.example/' }])]);
    assert.equal(site.found, false);
  });

  test('no pages / no database -> nothing found, never throws', async () => {
    assert.equal(analyzeSiteEntity([]).found, false);
    assert.equal(analyzeSiteEntity(undefined).found, false);
    assert.equal((await collectSiteEntity('507f1f77bcf86cd799439011', { db: null })).found, false);
    const broken = { collection: () => { throw new Error('db down'); } };
    assert.equal((await collectSiteEntity('507f1f77bcf86cd799439011', { db: broken })).found, false);
  });

  test("collectSiteEntity queries only the given project's pages", async () => {
    let seen;
    const db = { collection: (name) => ({ find: (q) => { seen = { name, q }; return { limit: () => ({ toArray: async () => hospitalSitePages() }) }; } }) };
    const site = await collectSiteEntity('507f1f77bcf86cd799439011', { db });
    assert.equal(seen.name, 'seo_page_data');
    assert.equal(String(seen.q.projectId), '507f1f77bcf86cd799439011');
    assert.equal(site.found, true);
  });
});
