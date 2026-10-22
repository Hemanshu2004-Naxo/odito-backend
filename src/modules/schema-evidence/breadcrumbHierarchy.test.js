import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BREADCRUMB_LIMITS, breadcrumbEvidenceHash, breadcrumbUrlKey, generateBreadcrumbListJsonLd, sameTrail,
  serializeJsonLdForScript, validateBreadcrumbHierarchy, validateBreadcrumbUrl,
} from './breadcrumbHierarchy.js';

const ORIGIN = 'https://clinic.example';
const PAGE = `${ORIGIN}/blog`;            // crawl key (no trailing slash)
const CANON = `${ORIGIN}/blog/`;           // verified canonical
const ctx = (over = {}) => ({ canonicalUrl: CANON, canonicalTrusted: true, pageUrl: PAGE, ...over });
const trail = (...pairs) => ({ items: pairs.map(([name, url]) => ({ name, url })) });
const GOOD = trail(['Home', `${ORIGIN}/`], ['Blog', CANON]);
const codes = (r) => r.errors.map((e) => e.code);

describe('validateBreadcrumbHierarchy — valid input', () => {
  test('a two-item hierarchy: positions are generated from the order', () => {
    const r = validateBreadcrumbHierarchy(GOOD, ctx());
    assert.equal(r.ok, true);
    assert.deepEqual(r.items, [{ position: 1, name: 'Home', url: `${ORIGIN}/` }, { position: 2, name: 'Blog', url: CANON }]);
    assert.deepEqual(r.currentPage, { url: CANON, source: 'canonical_tag' });
    assert.deepEqual(r.warnings, []);
  });

  test('a multi-item hierarchy', () => {
    const r = validateBreadcrumbHierarchy(trail(['Home', `${ORIGIN}/`], ['Services', `${ORIGIN}/services/`], ['Cataract', `${ORIGIN}/services/cataract/`], ['Blog', CANON]), ctx());
    assert.equal(r.ok, true);
    assert.deepEqual(r.items.map((i) => i.position), [1, 2, 3, 4]);
  });

  test('names are trimmed and whitespace-collapsed; the user\'s URL is not re-written', () => {
    const r = validateBreadcrumbHierarchy(trail(['  Home   page ', `${ORIGIN}/`], ['Blog', CANON]), ctx());
    assert.equal(r.items[0].name, 'Home page');
    assert.equal(r.items[1].url, CANON);
  });

  test('the final URL may differ from the canonical ONLY by the trailing slash (not rewritten, just accepted)', () => {
    const r = validateBreadcrumbHierarchy(trail(['Home', `${ORIGIN}/`], ['Blog', PAGE]), ctx());
    assert.equal(r.ok, true);
    assert.equal(r.items[1].url, PAGE, 'the URL the owner typed is kept as typed');
  });

  test('a client-supplied position that agrees with the order is accepted', () => {
    const r = validateBreadcrumbHierarchy({ items: [{ name: 'Home', url: `${ORIGIN}/`, position: 1 }, { name: 'Blog', url: CANON, position: 2 }] }, ctx());
    assert.equal(r.ok, true);
  });
});

describe('validateBreadcrumbHierarchy — count and shape', () => {
  test('fewer than two items, or no list at all', () => {
    assert.deepEqual(codes(validateBreadcrumbHierarchy(trail(['Blog', CANON]), ctx())), ['too_few_items']);
    assert.deepEqual(codes(validateBreadcrumbHierarchy({ items: [] }, ctx())), ['too_few_items']);
    for (const bad of [null, undefined, {}, [], 'x', { items: 'x' }, { items: {} }]) {
      assert.deepEqual(codes(validateBreadcrumbHierarchy(bad, ctx())), ['items_required'], JSON.stringify(bad));
    }
  });

  test('too many items', () => {
    const items = Array.from({ length: BREADCRUMB_LIMITS.maxItems + 1 }, (_, i) => ({ name: `P${i}`, url: `${ORIGIN}/p${i}/` }));
    assert.deepEqual(codes(validateBreadcrumbHierarchy({ items }, ctx())), ['too_many_items']);
    assert.equal(validateBreadcrumbHierarchy({ items: items.slice(0, BREADCRUMB_LIMITS.maxItems - 1).concat([{ name: 'B', url: CANON }]) }, ctx()).ok, true);
  });

  test('missing names / URLs are reported on the right item and field', () => {
    const r = validateBreadcrumbHierarchy({ items: [{ name: '', url: `${ORIGIN}/` }, { name: 'Blog', url: '' }] }, ctx());
    assert.deepEqual(r.errors.map((e) => [e.index, e.field, e.code]), [[0, 'name', 'name_required'], [1, 'url', 'url_required']]);
    assert.deepEqual(codes(validateBreadcrumbHierarchy({ items: [{ url: `${ORIGIN}/` }, { name: 'B' }] }, ctx())), ['name_required', 'url_required']);
    assert.ok(codes(validateBreadcrumbHierarchy({ items: [null, 5] }, ctx())).every((c) => c === 'invalid_item'));
  });

  test('a name that is only whitespace is empty', () => {
    assert.ok(codes(validateBreadcrumbHierarchy({ items: [{ name: '   ', url: `${ORIGIN}/` }, { name: 'Blog', url: CANON }] }, ctx())).includes('name_required'));
  });

  test('field lengths are limited', () => {
    const long = 'x'.repeat(BREADCRUMB_LIMITS.maxNameLength + 1);
    assert.ok(codes(validateBreadcrumbHierarchy({ items: [{ name: long, url: `${ORIGIN}/` }, { name: 'Blog', url: CANON }] }, ctx())).includes('name_too_long'));
    const url = `${ORIGIN}/${'a'.repeat(BREADCRUMB_LIMITS.maxUrlLength)}`;
    assert.ok(codes(validateBreadcrumbHierarchy({ items: [{ name: 'Home', url }, { name: 'Blog', url: CANON }] }, ctx())).includes('url_too_long'));
  });

  test('the total payload is bounded', () => {
    const items = Array.from({ length: BREADCRUMB_LIMITS.maxItems }, (_, i) => ({ name: 'n', url: `${ORIGIN}/${i}`, junk: 'z'.repeat(5000) }));
    assert.deepEqual(codes(validateBreadcrumbHierarchy({ items }, ctx())), ['payload_too_large']);
  });

  test('control characters in a name are refused', () => {
    assert.ok(codes(validateBreadcrumbHierarchy({ items: [{ name: 'Ho\u0000me', url: `${ORIGIN}/` }, { name: 'Blog', url: CANON }] }, ctx())).includes('name_invalid'));
  });
});

describe('validateBreadcrumbUrl — what is rejected, and never "fixed"', () => {
  const bad = (raw, code) => assert.equal(validateBreadcrumbUrl(raw, { pageUrl: CANON }).error?.code, code, String(raw));

  test('malformed, relative and unsupported-scheme URLs', () => {
    bad('not a url', 'url_invalid');
    bad('/blog/', 'url_invalid');
    bad('//clinic.example/blog/', 'url_invalid');
    bad('clinic.example/blog/', 'url_invalid');
    bad('javascript:alert(1)', 'url_scheme_unsupported');
    bad('data:text/html,<b>x</b>', 'url_scheme_unsupported');
    bad('ftp://clinic.example/blog/', 'url_scheme_unsupported');
    bad('file:///etc/passwd', 'url_scheme_unsupported');
    bad('mailto:a@b.co', 'url_scheme_unsupported');
  });

  test('embedded credentials', () => {
    bad('https://user:pw@clinic.example/blog/', 'url_credentials');
    bad('https://user@clinic.example/blog/', 'url_credentials');
  });

  test('invalid or internal hostnames', () => {
    bad('https://localhost/blog/', 'url_host_invalid');
    bad('https://intranet/blog/', 'url_host_invalid');
    bad('https://127.0.0.1/blog/', 'url_host_invalid');
    bad('https://10.0.0.5/blog/', 'url_host_invalid');
    bad('https://169.254.169.254/latest/', 'url_host_invalid');
    bad('https://metadata.google.internal/x', 'url_host_invalid');
    bad('https://a_b.local/x', 'url_host_invalid');
  });

  test('a host on another website', () => {
    bad('https://other.example/blog/', 'url_cross_site');
  });

  test('characters that would be stripped or escaped, spaces, fragments', () => {
    bad('https://clinic.example/a b/', 'url_invalid');
    bad('https://clinic.example/a"b', 'url_invalid');
    bad('https://clinic.example/a\\b', 'url_invalid');
    bad('https://clinic.example/a<b>', 'url_invalid');
    bad('https://clinic.example/blog/#top', 'url_fragment');
  });

  test('a path the URL parser would rewrite is refused instead of silently corrected', () => {
    bad('https://clinic.example/a/../blog/', 'url_path_rewritten');
    bad('https://clinic.example/./blog/', 'url_path_rewritten');
  });

  test('encoded paths, path case and query strings are kept exactly', () => {
    for (const u of ['https://clinic.example/caf%C3%A9/Menu/', 'https://clinic.example/a%2Fb/', 'https://clinic.example/Blog/Post-One/', 'https://clinic.example/shop/?cat=3&page=2', 'https://clinic.example/p/?utm_source=x']) {
      assert.equal(validateBreadcrumbUrl(u, { pageUrl: CANON }).url, u, u);
    }
  });

  test('only scheme and host are normalised (lower-cased)', () => {
    assert.equal(validateBreadcrumbUrl('HTTPS://CLINIC.example/Blog/', { pageUrl: CANON }).url, 'https://clinic.example/Blog/');
  });

  test('a public IP-literal site and an explicit port are acceptable when they are the audited site', () => {
    assert.equal(validateBreadcrumbUrl('https://93.184.216.34/blog/', { pageUrl: 'https://93.184.216.34/blog/' }).url, 'https://93.184.216.34/blog/');
    assert.equal(validateBreadcrumbUrl('https://clinic.example:8443/blog/', { pageUrl: 'https://clinic.example:8443/blog/' }).url, 'https://clinic.example:8443/blog/');
  });
});

describe('validateBreadcrumbHierarchy — duplicates and positions', () => {
  test('duplicate URLs, including ones only the trailing slash distinguishes', () => {
    const exact = validateBreadcrumbHierarchy(trail(['Home', `${ORIGIN}/`], ['Home again', `${ORIGIN}/`], ['Blog', CANON]), ctx());
    assert.deepEqual(exact.errors.map((e) => [e.code, e.index]), [['duplicate_url', 1]]);
    const slash = validateBreadcrumbHierarchy(trail(['A', `${ORIGIN}/services`], ['B', `${ORIGIN}/services/`], ['Blog', CANON]), ctx());
    assert.deepEqual(slash.errors.map((e) => [e.code, e.index]), [['duplicate_url', 1]]);
  });

  test('differences in path case or query are NOT duplicates', () => {
    assert.equal(validateBreadcrumbHierarchy(trail(['A', `${ORIGIN}/Services/`], ['B', `${ORIGIN}/services/`], ['Blog', CANON]), ctx()).ok, true);
    assert.equal(validateBreadcrumbHierarchy(trail(['A', `${ORIGIN}/s/?a=1`], ['B', `${ORIGIN}/s/?a=2`], ['Blog', CANON]), ctx()).ok, true);
  });

  test('positions: duplicates, gaps, wrong order, non-integers are rejected', () => {
    const run = (positions) => validateBreadcrumbHierarchy({ items: [
      { name: 'Home', url: `${ORIGIN}/`, position: positions[0] }, { name: 'Services', url: `${ORIGIN}/s/`, position: positions[1] }, { name: 'Blog', url: CANON, position: positions[2] },
    ] }, ctx());
    assert.ok(codes(run([1, 1, 3])).includes('position_duplicate'));
    assert.ok(codes(run([1, 3, 3])).includes('position_duplicate'));
    assert.ok(codes(run([1, 2, 4])).includes('position_not_consecutive'));
    assert.ok(codes(run([2, 3, 4])).includes('position_not_consecutive'));
    assert.ok(codes(run([3, 2, 1])).includes('position_not_consecutive'));
    assert.ok(codes(run([1, 2.5, 3])).includes('position_not_consecutive'));
    assert.ok(codes(run([1, '2', 3])).includes('position_not_consecutive'));
    assert.equal(run([1, 2, 3]).ok, true);
    assert.equal(run([undefined, null, undefined]).ok, true);
  });
});

describe('validateBreadcrumbHierarchy — the last item is the audited page', () => {
  test('a last URL that is not the verified canonical is refused, explained, and NOT rewritten', () => {
    const r = validateBreadcrumbHierarchy(trail(['Home', `${ORIGIN}/`], ['Blog', `${ORIGIN}/news/`]), ctx());
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].code, 'final_url_mismatch');
    assert.equal(r.errors[0].index, 1);
    assert.equal(r.errors[0].expectedUrl, CANON);
    assert.match(r.errors[0].message, /does not rewrite it/);
    assert.deepEqual(r.items, []);
  });

  test('www vs non-www and http vs https are different URLs', () => {
    assert.equal(validateBreadcrumbHierarchy(trail(['Home', `${ORIGIN}/`], ['Blog', 'https://www.clinic.example/blog/']), ctx()).errors[0].code, 'final_url_mismatch');
    // an https site never publishes an http breadcrumb URL: refused up front (https by default), before it could even be compared
    assert.equal(validateBreadcrumbHierarchy(trail(['Home', `${ORIGIN}/`], ['Blog', 'http://clinic.example/blog/']), ctx()).errors[0].code, 'url_not_https');
  });

  test('an http-only site (the one narrow exception) keeps http URLs', () => {
    const http = 'http://plain.example';
    const r = validateBreadcrumbHierarchy(trail(['Home', `${http}/`], ['Blog', `${http}/blog/`]), { canonicalUrl: `${http}/blog/`, canonicalTrusted: true, pageUrl: `${http}/blog` });
    assert.equal(r.ok, true);
  });

  test('path case and encoding matter', () => {
    const c = ctx({ canonicalUrl: `${ORIGIN}/Caf%C3%A9/` });
    assert.equal(validateBreadcrumbHierarchy(trail(['Home', `${ORIGIN}/`], ['Cafe', `${ORIGIN}/caf%C3%A9/`]), c).errors[0].code, 'final_url_mismatch');
    assert.equal(validateBreadcrumbHierarchy(trail(['Home', `${ORIGIN}/`], ['Cafe', `${ORIGIN}/Caf%C3%A9/`]), c).ok, true);
    assert.equal(validateBreadcrumbHierarchy(trail(['Home', `${ORIGIN}/`], ['Cafe', `${ORIGIN}/Café/`]), c).ok === false, true, 'decoded form is a different string');
  });

  test('query strings matter', () => {
    const c = ctx({ canonicalUrl: `${ORIGIN}/shop/?page=2` });
    assert.equal(validateBreadcrumbHierarchy(trail(['Home', `${ORIGIN}/`], ['Shop', `${ORIGIN}/shop/`]), c).errors[0].code, 'final_url_mismatch');
    assert.equal(validateBreadcrumbHierarchy(trail(['Home', `${ORIGIN}/`], ['Shop', `${ORIGIN}/shop/?page=2`]), c).ok, true);
  });

  test('NO verified canonical: the owner must confirm the audited page URL; it is flagged as unverified, never silently the crawl URL', () => {
    const noCanon = ctx({ canonicalUrl: null, canonicalTrusted: false });
    const ok = validateBreadcrumbHierarchy(trail(['Home', `${ORIGIN}/`], ['Blog', CANON]), noCanon);
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.currentPage, { url: CANON, source: 'user_confirmed' });
    assert.equal(ok.warnings[0].code, 'canonical_unverified');
    const wrong = validateBreadcrumbHierarchy(trail(['Home', `${ORIGIN}/`], ['Blog', `${ORIGIN}/other/`]), noCanon);
    assert.equal(wrong.errors[0].code, 'final_url_mismatch');
    assert.equal(wrong.errors[0].expectedUrl, PAGE);
  });

  test('no canonical and no page URL at all cannot be validated', () => {
    assert.equal(validateBreadcrumbHierarchy(GOOD, { canonicalUrl: null, canonicalTrusted: false, pageUrl: null }).errors[0].code, 'canonical_unavailable');
  });

  test('a canonical that is only "known" but untrusted is not used to approve the final item', () => {
    const r = validateBreadcrumbHierarchy(trail(['Home', `${ORIGIN}/`], ['Blog', `${ORIGIN}/other/`]), ctx({ canonicalTrusted: false, canonicalUrl: `${ORIGIN}/other/` }));
    assert.equal(r.ok, false);
  });

  test('invalid input never yields items', () => {
    for (const bad of [trail(['Home', 'nope'], ['Blog', CANON]), trail(['', `${ORIGIN}/`], ['Blog', CANON]), trail(['Home', `${ORIGIN}/`])]) {
      const r = validateBreadcrumbHierarchy(bad, ctx());
      assert.equal(r.ok, false);
      assert.deepEqual(r.items, []);
      assert.equal(r.currentPage, null);
    }
  });
});

describe('generateBreadcrumbListJsonLd — deterministic output', () => {
  const items = validateBreadcrumbHierarchy(GOOD, ctx()).items;

  test('exactly the specified shape, consecutive positions, names and URLs preserved', () => {
    assert.deepEqual(generateBreadcrumbListJsonLd(items), {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: `${ORIGIN}/` },
        { '@type': 'ListItem', position: 2, name: 'Blog', item: CANON },
      ],
    });
  });

  test('identical input -> byte-identical output', () => {
    assert.equal(serializeJsonLdForScript(generateBreadcrumbListJsonLd(items)), serializeJsonLdForScript(generateBreadcrumbListJsonLd(items)));
  });

  test('a name can never close the <script> tag (and is still the same JSON)', () => {
    const evil = [{ position: 1, name: '</script><script>alert(1)</script>', url: `${ORIGIN}/` }, { position: 2, name: 'A & B  ', url: CANON }];
    const text = serializeJsonLdForScript(generateBreadcrumbListJsonLd(evil));
    assert.ok(!/<\/?script/i.test(text));
    assert.ok(!text.includes('<') && !text.includes('>') && !text.includes('&') && !text.includes(' '));
    assert.deepEqual(JSON.parse(text).itemListElement.map((i) => i.name), ['</script><script>alert(1)</script>', 'A & B  ']);
  });
});

describe('hashing and comparison helpers', () => {
  test('the evidence hash is stable and changes with any name, URL or order', () => {
    const a = [{ position: 1, name: 'Home', url: `${ORIGIN}/` }, { position: 2, name: 'Blog', url: CANON }];
    assert.equal(breadcrumbEvidenceHash(a), breadcrumbEvidenceHash(JSON.parse(JSON.stringify(a))));
    assert.notEqual(breadcrumbEvidenceHash(a), breadcrumbEvidenceHash([{ ...a[0], name: 'Start' }, a[1]]));
    assert.notEqual(breadcrumbEvidenceHash(a), breadcrumbEvidenceHash([a[0], { ...a[1], url: PAGE }]));
    assert.notEqual(breadcrumbEvidenceHash(a), breadcrumbEvidenceHash([{ ...a[1], position: 1 }, { ...a[0], position: 2 }]));
  });

  test('url keys ignore only a trailing slash; sameTrail compares sequences', () => {
    assert.equal(breadcrumbUrlKey(`${ORIGIN}/a/`), breadcrumbUrlKey(`${ORIGIN}/a`));
    assert.notEqual(breadcrumbUrlKey(`${ORIGIN}/a/`), breadcrumbUrlKey(`${ORIGIN}/A/`));
    assert.notEqual(breadcrumbUrlKey(`${ORIGIN}/a?x=1`), breadcrumbUrlKey(`${ORIGIN}/a`));
    assert.equal(breadcrumbUrlKey('nope'), null);
    assert.equal(sameTrail([{ url: `${ORIGIN}/` }, { url: CANON }], [{ url: `${ORIGIN}` }, { url: PAGE }]), true);
    assert.equal(sameTrail([{ url: `${ORIGIN}/` }], [{ url: `${ORIGIN}/` }, { url: CANON }]), false);
    assert.equal(sameTrail([{ url: 'nope' }], [{ url: 'nope' }]), false);
  });
});
