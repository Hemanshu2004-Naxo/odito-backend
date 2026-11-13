import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { matchSerpResultDomain } from './serpDomainMatcher.js';

const m = (trackedDomain, resultHostname, policy) => matchSerpResultDomain({ trackedDomain, resultHostname, policy });

describe('matchSerpResultDomain', () => {
  test('www / non-www / URL forms of the same site', () => {
    for (const [t, r] of [['example.com', 'www.example.com'], ['www.example.com', 'example.com'], ['https://example.com/page', 'https://www.example.com/x'], ['EXAMPLE.com.', 'example.com:443']]) {
      const res = m(t, r);
      assert.equal(res.matched, true, `${t} ~ ${r}`);
      assert.equal(res.matchType, 'exact_hostname');
      assert.equal(res.trackedDomain, 'example.com');
    }
    assert.equal(m('example.com', 'www.example.com').resultDomain, 'example.com');
  });

  test('look-alike domains never match', () => {
    for (const r of ['fakeexample.com', 'example.com.fake.org', 'myexample.com', 'example.co', 'example.com-evil.net', 'notexample.com']) {
      assert.equal(m('example.com', r).matched, false, r);
      assert.equal(m('example.com', r, 'registrable').matched, false, `registrable ${r}`);
    }
  });

  test('subdomain policy: child matches, parent of a tracked subdomain does not', () => {
    assert.deepEqual(m('example.com', 'blog.example.com').matchType, 'subdomain');
    assert.equal(m('example.com', 'a.b.example.com').matched, true);
    assert.equal(m('blog.example.com', 'example.com').matched, false);
    assert.equal(m('blog.example.com', 'shop.example.com').matched, false);
  });

  test('hostname policy is exact only; registrable policy spans subdomains but not country domains', () => {
    assert.equal(m('example.com', 'blog.example.com', 'hostname').matched, false);
    assert.equal(m('example.com', 'www.example.com', 'hostname').matched, true);
    const reg = m('blog.example.com', 'shop.example.com', 'registrable');
    assert.equal(reg.matched, true);
    assert.equal(reg.matchType, 'registrable_domain');
    assert.equal(m('example.com', 'example.co.uk', 'registrable').matched, false);
    assert.equal(m('example.co.uk', 'shop.example.co.uk').matched, true);
    assert.equal(m('a.github.io', 'b.github.io', 'registrable').matched, false); // private suffix: different sites
  });

  test('internationalised domain names compare by punycode', () => {
    assert.equal(m('bücher.example', 'www.xn--bcher-kva.example').matched, true);
  });

  test('unusable input never matches', () => {
    for (const [t, r] of [['', 'example.com'], ['example.com', ''], [null, null], ['localhost', 'localhost']]) assert.equal(m(t, r).matched, false);
  });
});
