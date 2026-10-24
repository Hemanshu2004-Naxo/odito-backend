import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { countMentions, mentions, findMentions, assessNameReliability, normalizeForMatching } from '../services/brandMatchingService.js';
import { normalizeUrl, isTargetHost, deriveTargetHost, toCitation, extractCitations } from '../services/citationNormalizationService.js';

describe('brand matching', () => {
  test('case-insensitive, punctuation- and whitespace-tolerant', () => {
    assert.ok(mentions('We recommend ASG EYE HOSPITAL for LASIK.', 'ASG Eye Hospital'));
    assert.ok(mentions('asg-eye   hospital, Ahmedabad', 'ASG Eye Hospital'));
    assert.ok(mentions("Joe's Pizza is great", 'Joes Pizza'));
    assert.ok(mentions('Tom & Jerry Ltd opened', 'Tom and Jerry'));
  });

  test('boundary-aware: no substring false positives', () => {
    assert.equal(countMentions('Apollonia is a name', 'Apollo'), 0);
    assert.equal(countMentions('Pineapollo', 'Apollo'), 0);
    assert.equal(countMentions('the cat sat', 'at'), 0);
    assert.equal(countMentions('Apollo Hospitals and apollo.', 'Apollo'), 2);
  });

  test('Unicode: diacritics and non-Latin scripts', () => {
    assert.ok(mentions('Visit Café Münchën today', 'Cafe Munchen'));
    assert.ok(mentions('Привет, ООО Ромашка работает', 'Ромашка'));
    assert.ok(mentions('東京クリニックは人気です', '東京クリニック'));
    assert.equal(countMentions('Ромашковый', 'Ромашка'), 0);
  });

  test('repeated mentions are counted; empty inputs are safe', () => {
    assert.equal(countMentions('Acme and Acme and ACME', 'acme'), 3);
    assert.equal(countMentions('', 'Acme'), 0);
    assert.equal(countMentions('Acme', ''), 0);
    assert.equal(countMentions(null, 'Acme'), 0);
    assert.equal(normalizeForMatching(undefined), '');
  });

  test('findMentions reports known names with counts and ignores unlisted ones', () => {
    assert.deepEqual(findMentions('Sankara Eye Care beats Sankara; Vasan is also there', ['Sankara Eye Care', 'Vasan Eye Care', 'Sankara']), [
      { name: 'Sankara Eye Care', count: 1 }, { name: 'Sankara', count: 2 },
    ]);
  });

  test('name reliability flags short, generic and industry-overlapping names', () => {
    assert.equal(assessNameReliability('AB').reliable, false);
    assert.equal(assessNameReliability('The Hospital').reason, 'generic_words');
    assert.equal(assessNameReliability('Eye Care', ['Eye care']).reason, 'overlaps_industry_terms');
    assert.equal(assessNameReliability('ASG Eye Hospital', ['Eye care']).reliable, true);
    assert.equal(assessNameReliability('').reliable, false);
  });
});

describe('citation normalization', () => {
  test('lower-cases the host, drops www, fragment, default port and trailing slash, unifies scheme', () => {
    assert.equal(normalizeUrl('HTTP://WWW.Example.COM:80/Pricing/#top').url, 'https://example.com/Pricing');
    assert.equal(normalizeUrl('https://example.com:443/').url, 'https://example.com');
    assert.equal(normalizeUrl('https://example.com:8443/a').url, 'https://example.com:8443/a');
    assert.equal(normalizeUrl('https://example.com//a///b/').url, 'https://example.com/a/b');
  });

  test('removes tracking parameters but keeps meaningful ones, sorted', () => {
    const n = normalizeUrl('https://example.com/p?utm_source=chatgpt.com&b=2&gclid=x&a=1&fbclid=y&msclkid=z&UTM_Medium=m');
    assert.equal(n.url, 'https://example.com/p?a=1&b=2');
  });

  test('invalid input never throws', () => {
    for (const bad of [null, undefined, '', '   ', 'not a url', 'javascript:alert(1)', 'ftp://example.com/x', 'https://user:pw@example.com/', 5, {}]) {
      assert.equal(normalizeUrl(bad).ok, false, String(bad));
    }
  });

  test('target host: exact or genuine subdomain only', () => {
    assert.ok(isTargetHost('example.com', 'example.com'));
    assert.ok(isTargetHost('www.example.com', 'example.com'));
    assert.ok(isTargetHost('blog.example.com', 'example.com'));
    assert.ok(isTargetHost('example.com', 'www.example.com'));
    assert.equal(isTargetHost('example.com.attacker.test', 'example.com'), false);
    assert.equal(isTargetHost('notexample.com', 'example.com'), false);
    assert.equal(isTargetHost('attacker-example.com', 'example.com'), false);
    assert.equal(isTargetHost('example.org', 'example.com'), false);
    assert.equal(isTargetHost('', 'example.com'), false);
    assert.equal(isTargetHost('example.com', null), false);
  });

  test('target host derivation prefers canonical host, then URL, and never throws', () => {
    assert.equal(deriveTargetHost({ canonicalHost: 'www.site.in', mainUrl: 'https://other.com' }), 'site.in');
    assert.equal(deriveTargetHost({ mainUrl: 'https://Site.IN/path' }), 'site.in');
    assert.equal(deriveTargetHost({ mainUrl: 'site.in' }), 'site.in');
    assert.equal(deriveTargetHost({ mainUrl: '::::' }), null);
    assert.equal(deriveTargetHost(), null);
  });

  test('citations: only URL-bearing annotations are kept; invalid URLs are kept as invalid, never as target', () => {
    const cites = extractCitations([
      { title: 'Home', url: 'https://www.asgeye.example/?utm_source=chatgpt.com' },
      { title: 'Other', url: 'https://wikipedia.org/wiki/Eye' },
      { title: 'Evil', url: 'https://asgeye.example.attacker.test/' },
      { title: 'broken', url: 'nonsense' },
      { title: 'no url' },
      null,
      'string',
    ], 'asgeye.example');
    assert.equal(cites.length, 4);
    assert.deepEqual(cites.map((c) => c.isTarget), [true, false, false, false]);
    assert.equal(cites[3].valid, false);
    assert.equal(toCitation({ url: 5 }, 'x.com'), null);
  });
});
