import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  analyzeBreadcrumbs, analyzeOrganizations, findDuplicateEntities, flattenJsonLd, logoCandidatesFromSchema,
  parseSchemaDate, pickDisplayUrl, resolveHttpUrl, samePathIgnoringTrailingSlash, stripTrackingParams, typeSatisfies, typesOf,
} from './schemaGraph.js';
import { ORIGIN, HOME, REAL_LOGO, ORG_ID, graphWithOrganization, organization } from './__fixtures__/clinicSite.js';

describe('typesOf / typeSatisfies — @type is a string OR an array, and subtypes count', () => {
  test('normalises string, array and junk', () => {
    assert.deepEqual(typesOf({ '@type': 'Organization' }), ['Organization']);
    assert.deepEqual(typesOf({ '@type': ['Hospital', 'Organization'] }), ['Hospital', 'Organization']);
    assert.deepEqual(typesOf({ '@type': ['Hospital', '', 5, null] }), ['Hospital']);
    assert.deepEqual(typesOf({}), []);
    assert.deepEqual(typesOf(null), []);
  });

  test('specific subtypes satisfy Organization; unrelated types do not', () => {
    for (const t of ['Organization', 'Hospital', 'MedicalClinic', 'Optician', 'Dentist', 'LocalBusiness', 'Corporation', 'Restaurant', 'FastFoodRestaurant', 'NGO']) {
      assert.equal(typeSatisfies(t, 'Organization'), true, t);
    }
    for (const t of ['Person', 'WebSite', 'WebPage', 'Place', 'ImageObject', 'Article', 'Optometric']) {
      assert.equal(typeSatisfies(t, 'Organization'), false, t);
    }
    assert.equal(typeSatisfies('BlogPosting', 'Article'), true);
    assert.equal(typeSatisfies('NewsArticle', 'Article'), true);
  });
});

describe('flattenJsonLd — root, arrays, @graph (context on the parent) and JSON strings', () => {
  test('reads a @graph whose @context is only on the parent', () => {
    const nodes = flattenJsonLd(graphWithOrganization());
    assert.deepEqual(nodes.map((n) => typesOf(n)[0]), ['Place', 'Hospital', 'WebSite', 'AboutPage']);
  });

  test('root object, array of objects and nested arrays', () => {
    assert.equal(flattenJsonLd({ '@type': 'Organization' }).length, 1);
    assert.equal(flattenJsonLd([{ '@type': 'A' }, [{ '@type': 'B' }]]).length, 2);
    assert.equal(flattenJsonLd({ '@graph': [{ '@type': 'A' }, { '@id': 'ref-only' }] }).length, 1);
  });

  test('accepts a JSON string and ignores garbage', () => {
    assert.equal(flattenJsonLd('{"@type":"Organization"}').length, 1);
    assert.deepEqual(flattenJsonLd('not json'), []);
    assert.deepEqual(flattenJsonLd(null), []);
    assert.deepEqual(flattenJsonLd(undefined), []);
  });

  test('is depth-bounded', () => {
    let deep = { '@type': 'X' };
    for (let i = 0; i < 20; i++) deep = { '@graph': [deep] };
    assert.deepEqual(flattenJsonLd(deep), []);
  });
});

describe('analyzeOrganizations', () => {
  test('["Hospital","Organization"] inside @graph is found and chosen as primary', () => {
    const r = analyzeOrganizations(flattenJsonLd(graphWithOrganization()), { siteUrl: HOME });
    assert.equal(r.primary['@id'], ORG_ID);
    assert.equal(r.count, 1);
    assert.equal(r.conflicting, false);
  });

  test('a bare subtype is an Organization', () => {
    const nodes = flattenJsonLd([organization({ '@type': 'Hospital' })]);
    assert.equal(analyzeOrganizations(nodes, { siteUrl: HOME }).primary['@id'], ORG_ID);
  });

  test('an organization on another site is never the primary', () => {
    const partner = organization({ '@id': 'https://partner.example/#org', url: 'https://partner.example/', name: 'Partner' });
    const r = analyzeOrganizations(flattenJsonLd([partner]), { siteUrl: HOME });
    assert.equal(r.primary, null);
    assert.equal(r.foreign.length, 1);
  });

  test('the site entity wins over a partner, and a stable #organization id is preferred', () => {
    const partner = organization({ '@id': 'https://partner.example/#org', url: 'https://partner.example/' });
    const other = organization({ '@id': `${ORIGIN}/#something-else`, '@type': 'Organization' });
    const r = analyzeOrganizations(flattenJsonLd([partner, other, organization()]), { siteUrl: HOME });
    assert.equal(r.primary['@id'], ORG_ID);
  });

  test('duplicates and conflicting entities are reported, never silently merged', () => {
    const dup = analyzeOrganizations(flattenJsonLd([organization(), organization()]), { siteUrl: HOME });
    assert.deepEqual(dup.duplicateIds, [{ id: ORG_ID, count: 2 }]);
    const conflict = analyzeOrganizations(flattenJsonLd([organization(), organization({ '@id': `${ORIGIN}/#org-2` })]), { siteUrl: HOME });
    assert.equal(conflict.conflicting, true);
    assert.equal(conflict.count, 2);
  });

  test('Person / WebSite / Place are not organizations', () => {
    const r = analyzeOrganizations(flattenJsonLd([{ '@type': 'Person', name: 'A' }, { '@type': 'WebSite', name: 'W' }, { '@type': 'Place' }]), { siteUrl: HOME });
    assert.equal(r.primary, null);
  });
});

describe('resolveHttpUrl — relative, protocol-relative, encoding and unsafe input', () => {
  test('resolves relative and protocol-relative references', () => {
    assert.equal(resolveHttpUrl('/img/logo.png', 'https://clinic.example/about/'), 'https://clinic.example/img/logo.png');
    assert.equal(resolveHttpUrl('logo.png', 'https://clinic.example/about/'), 'https://clinic.example/about/logo.png');
    assert.equal(resolveHttpUrl('//cdn.example.net/l.png', 'https://clinic.example/'), 'https://cdn.example.net/l.png');
  });

  test('preserves percent-encoding and path case (no blanket decoding)', () => {
    assert.equal(resolveHttpUrl('https://clinic.example/Docs/Caf%C3%A9%2FMenu.PNG', HOME), 'https://clinic.example/Docs/Caf%C3%A9%2FMenu.PNG');
  });

  test('drops the fragment but keeps legitimate query parameters', () => {
    assert.equal(resolveHttpUrl('https://clinic.example/p/?id=7&source=nav#top', HOME), 'https://clinic.example/p/?id=7&source=nav');
  });

  test('rejects unsafe or malformed values', () => {
    for (const bad of ['javascript:alert(1)', 'data:image/png;base64,AAAA', 'file:///etc/passwd', 'ftp://x.test/l.png', 'http://u:p@x.test/', '', '   ', 'has space.png', '<img src=x>', null, undefined, 42]) {
      assert.equal(resolveHttpUrl(bad, HOME), null, String(bad));
    }
  });
});

describe('stripTrackingParams — selective, never by substring', () => {
  test('removes known tracking parameters only', () => {
    assert.equal(stripTrackingParams('https://clinic.example/p/?utm_source=a&utm_medium=b&fbclid=1&gclid=2&id=7'), 'https://clinic.example/p/?id=7');
  });
  test('keeps parameters that merely CONTAIN words like source/medium/campaign', () => {
    const u = 'https://clinic.example/shop/?resource=12&medium_size=1&campaign_id=9&source=catalog';
    assert.equal(stripTrackingParams(u), u);
  });
});

describe('pickDisplayUrl — crawl identity key vs the URL published in markup', () => {
  test('uses the canonical (with its trailing slash) when it is same-site', () => {
    const d = pickDisplayUrl({ canonical: 'https://clinic.example/about-us/', pageUrl: 'https://clinic.example/about-us' });
    assert.equal(d.url, 'https://clinic.example/about-us/');
    assert.equal(d.trusted, true);
    assert.equal(d.source, 'canonical_tag');
    assert.equal(d.selfReferencing, true);
  });

  test('resolves a relative canonical against the page', () => {
    assert.equal(pickDisplayUrl({ canonical: '/about-us/', pageUrl: 'https://clinic.example/about-us' }).url, 'https://clinic.example/about-us/');
  });

  test('a canonical on another site is not trusted; the crawl key is returned flagged as unconfirmed', () => {
    const d = pickDisplayUrl({ canonical: 'https://evil.example/x/', pageUrl: 'https://clinic.example/about-us' });
    assert.equal(d.url, 'https://clinic.example/about-us');
    assert.equal(d.trusted, false);
    assert.equal(d.source, 'crawl_url');
  });

  test('no canonical at all', () => {
    const d = pickDisplayUrl({ canonical: undefined, pageUrl: 'https://clinic.example/about-us' });
    assert.deepEqual([d.trusted, d.source], [false, 'crawl_url']);
  });

  test('a canonical pointing at a different page is reported as not self-referencing, not silently equated', () => {
    const d = pickDisplayUrl({ canonical: 'https://clinic.example/other/', pageUrl: 'https://clinic.example/about-us' });
    assert.equal(d.selfReferencing, false);
  });

  test('tracking parameters are stripped from the canonical, legitimate ones kept', () => {
    assert.equal(pickDisplayUrl({ canonical: 'https://clinic.example/p/?page=2&utm_source=x', pageUrl: 'https://clinic.example/p?page=2' }).url, 'https://clinic.example/p/?page=2');
  });

  test('trailing-slash comparison ignores only the slash', () => {
    assert.equal(samePathIgnoringTrailingSlash('https://clinic.example/a/', 'https://clinic.example/a'), true);
    assert.equal(samePathIgnoringTrailingSlash('https://clinic.example/a/', 'https://clinic.example/A'), false);
    assert.equal(samePathIgnoringTrailingSlash('https://clinic.example/a/?x=1', 'https://clinic.example/a/'), false);
  });
});

describe('logoCandidatesFromSchema', () => {
  test('reads the logo ImageObject and never uses an @id as an image URL', () => {
    const nodes = flattenJsonLd(graphWithOrganization());
    const c = logoCandidatesFromSchema(nodes, nodes.find((n) => n['@id'] === ORG_ID), HOME);
    assert.deepEqual(c.map((x) => x.url), [REAL_LOGO]);
    assert.equal(c[0].source, 'organization.logo');
    assert.equal(c[0].declaredWidth, 178);
  });

  test('a logo that is only an @id reference to a missing node yields no candidate', () => {
    const org = organization({ logo: { '@id': `${ORIGIN}/#logo` } });
    assert.deepEqual(logoCandidatesFromSchema([org], org, HOME), []);
  });

  test('logo as a string, relative and protocol-relative', () => {
    assert.deepEqual(logoCandidatesFromSchema([], organization({ logo: '/l.svg' }), HOME).map((x) => x.url), [`${ORIGIN}/l.svg`]);
    assert.deepEqual(logoCandidatesFromSchema([], organization({ logo: '//cdn.example.net/l.webp' }), HOME).map((x) => x.url), ['https://cdn.example.net/l.webp']);
  });

  test('publisher.logo on an article and a #logo node are found, de-duplicated', () => {
    const article = { '@type': 'Article', publisher: { '@type': 'Organization', logo: { url: REAL_LOGO } } };
    const logoNode = { '@type': 'ImageObject', '@id': `${ORIGIN}/#logo`, url: REAL_LOGO };
    const c = logoCandidatesFromSchema([article, logoNode], null, HOME);
    assert.deepEqual(c.map((x) => x.url), [REAL_LOGO]);
  });
});

describe('analyzeBreadcrumbs', () => {
  const crumb = (items, id) => ({ '@type': 'BreadcrumbList', ...(id ? { '@id': id } : {}), itemListElement: items });
  const li = (position, name, item) => ({ '@type': 'ListItem', position, name, ...(item ? { item } : {}) });
  const run = (nodes) => analyzeBreadcrumbs(nodes, { pageUrl: `${ORIGIN}/about-us/` });

  test('a valid trail has no problems', () => {
    const r = run([crumb([li(1, 'Home', HOME), li(2, 'About', `${ORIGIN}/about-us/`)])]);
    assert.deepEqual(r.lists[0].problems, []);
  });

  test('the last item may omit its URL, an intermediate item may not', () => {
    assert.deepEqual(run([crumb([li(1, 'Home', HOME), li(2, 'About')])]).lists[0].problems, []);
    assert.deepEqual(run([crumb([li(1, 'Home'), li(2, 'About', `${ORIGIN}/about-us/`)])]).lists[0].problems, ['missing_url']);
  });

  test('positions must be 1..n in order', () => {
    assert.ok(run([crumb([li(0, 'Home', HOME), li(1, 'About', `${ORIGIN}/about-us/`)])]).lists[0].problems.includes('position_not_sequential'));
    assert.ok(run([crumb([li(2, 'Home', HOME), li(1, 'About', `${ORIGIN}/about-us/`)])]).lists[0].problems.includes('position_not_sequential'));
    assert.ok(run([crumb([{ '@type': 'ListItem', name: 'Home', item: HOME }])]).lists[0].problems.includes('position_not_sequential'));
  });

  test('empty list, empty names, invalid / relative / cross-site / duplicate URLs', () => {
    assert.deepEqual(run([crumb([])]).lists[0].problems, ['empty_list']);
    assert.ok(run([crumb([li(1, '', HOME), li(2, 'About', `${ORIGIN}/about-us/`)])]).lists[0].problems.includes('missing_name'));
    assert.ok(run([crumb([li(1, 'Home', 'not a url'), li(2, 'About', `${ORIGIN}/about-us/`)])]).lists[0].problems.includes('relative_or_invalid_url'));
    assert.ok(run([crumb([li(1, 'Home', '/'), li(2, 'About', `${ORIGIN}/about-us/`)])]).lists[0].problems.includes('relative_or_invalid_url'));
    assert.ok(run([crumb([li(1, 'Home', 'https://other.example/'), li(2, 'About', `${ORIGIN}/about-us/`)])]).lists[0].problems.includes('cross_site_url'));
    assert.ok(run([crumb([li(1, 'A', `${ORIGIN}/x/`), li(2, 'B', `${ORIGIN}/x`)])]).lists[0].problems.includes('duplicate_url'));
    assert.ok(run([crumb([li(1, 'A', 'javascript:alert(1)'), li(2, 'B', `${ORIGIN}/x`)])]).lists[0].problems.includes('unsupported_url'));
  });

  test('item may be an object with @id / url (common in Rank Math/Yoast output)', () => {
    const r = run([crumb([{ '@type': 'ListItem', position: 1, item: { '@id': HOME, name: 'Home' } }, li(2, 'About', `${ORIGIN}/about-us/`)])]);
    assert.deepEqual(r.lists[0].problems, []);
    assert.equal(r.lists[0].items[0].name, 'Home');
  });

  test('two BreadcrumbLists are flagged as duplicates', () => {
    const one = crumb([li(1, 'Home', HOME), li(2, 'About', `${ORIGIN}/about-us/`)]);
    assert.equal(run([one, one]).duplicateLists, true);
  });
});

describe('parseSchemaDate — strict ISO 8601, timezone semantics preserved', () => {
  test('a date-time with an offset keeps its offset (not converted to UTC)', () => {
    const p = parseSchemaDate('2024-03-05T09:30:00+05:30');
    assert.equal(p.valid, true);
    assert.equal(p.value, '2024-03-05T09:30:00+05:30');
    assert.equal(p.offsetMinutes, 330);
    assert.equal(p.hasTimezone, true);
    assert.equal(new Date(p.epochMs).toISOString(), '2024-03-05T04:00:00.000Z');
  });

  test('a value with no timezone is reported as such, never assumed UTC', () => {
    const p = parseSchemaDate('2024-03-05T09:30:00');
    assert.equal(p.valid, true);
    assert.equal(p.hasTimezone, false);
    assert.equal(p.offsetMinutes, null);
    assert.equal(p.value, '2024-03-05T09:30:00');
  });

  test('Z, compact offsets, fractions and date-only', () => {
    assert.equal(parseSchemaDate('2024-03-05T09:30:00Z').offsetMinutes, 0);
    assert.equal(parseSchemaDate('2024-03-05T09:30:00+0530').value, '2024-03-05T09:30:00+05:30');
    assert.equal(parseSchemaDate('2024-03-05T09:30:00.123-08:00').value, '2024-03-05T09:30:00.123-08:00');
    const dateOnly = parseSchemaDate('2024-03-05');
    assert.equal(dateOnly.valid, true);
    assert.equal(dateOnly.hasTime, false);
    assert.equal(dateOnly.value, '2024-03-05');
  });

  test('a space separator is normalised to T', () => {
    assert.equal(parseSchemaDate('2024-03-05 09:30:00+01:00').value, '2024-03-05T09:30:00+01:00');
  });

  test('rejects impossible, out-of-range, free-text and non-string values', () => {
    for (const bad of ['2024-02-30', '2023-02-29', '2024-13-01', '2024-00-10', '2024-03-05T25:00:00Z', '2024-03-05T09:61:00Z', 'March 5, 2024', '05/03/2024', '2024-3-5', '', null, undefined, 20240305]) {
      assert.equal(parseSchemaDate(bad).valid, false, String(bad));
    }
    assert.equal(parseSchemaDate('2024-03-05T09:30:00+15:00').valid, false);
  });

  test('2024-02-29 is a valid leap day', () => {
    assert.equal(parseSchemaDate('2024-02-29').valid, true);
  });
});

describe('findDuplicateEntities', () => {
  test('duplicate @id and repeated single-instance types', () => {
    const nodes = flattenJsonLd([organization(), organization(), { '@type': 'BreadcrumbList' }, { '@type': 'BreadcrumbList' }, { '@type': 'BlogPosting' }]);
    const d = findDuplicateEntities(nodes);
    assert.deepEqual(d.duplicateIds, [{ id: ORG_ID, count: 2 }]);
    assert.equal(d.breadcrumbLists, 2);
    assert.equal(d.articles, 1);
  });
});
