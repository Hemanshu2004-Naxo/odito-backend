import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSerpResultUrl, resolveSerpItem, isGoogleHost } from './serpUrlResolver.js';

const enc = encodeURIComponent;

describe('resolveSerpResultUrl', () => {
  test('direct website URL', () => {
    const r = resolveSerpResultUrl('https://www.asgeyehospital.co.in:443/pune/');
    assert.equal(r.resolutionStatus, 'resolved');
    assert.equal(r.resolutionMethod, 'direct');
    assert.equal(r.hostname, 'asgeyehospital.co.in');
    assert.equal(r.registrableDomain, 'asgeyehospital.co.in');
    assert.equal(r.originalUrl, 'https://www.asgeyehospital.co.in:443/pune/');
    assert.equal(r.resolvedUrl, 'https://www.asgeyehospital.co.in/pune/');
  });

  test('Google /goto with an encoded destination', () => {
    const r = resolveSerpResultUrl(`https://google.com/goto?url=${enc('https://www.example.com/clinic?a=1&b=2')}`);
    assert.equal(r.resolutionStatus, 'resolved');
    assert.equal(r.resolutionMethod, 'redirect_parameter');
    assert.equal(r.hostname, 'example.com');
    assert.equal(r.resolvedUrl, 'https://www.example.com/clinic?a=1&b=2');
    assert.match(r.originalUrl, /google\.com\/goto/);
  });

  test('Google /url?q= on a country domain', () => {
    const r = resolveSerpResultUrl(`https://www.google.co.in/url?q=${enc('https://shop.example.co.uk/x')}&sa=U`);
    assert.equal(r.hostname, 'shop.example.co.uk');
    assert.equal(r.registrableDomain, 'example.co.uk');
  });

  test('Google redirect without a usable destination is unresolved, never google.com as the site', () => {
    for (const u of ['https://google.com/goto', 'https://google.com/goto?foo=bar', 'https://google.com/goto?url=notaurl']) {
      const r = resolveSerpResultUrl(u);
      assert.equal(r.resolutionStatus, 'unresolved', u);
      assert.equal(r.hostname, null);
      assert.equal(r.resolvedUrl, null);
    }
  });

  test('nested redirect resolves within the depth limit and fails beyond it', () => {
    const inner = 'https://example.com/final';
    const two = `https://google.com/url?q=${enc(`https://google.com/goto?url=${enc(inner)}`)}`;
    assert.equal(resolveSerpResultUrl(two).hostname, 'example.com');
    let u = inner;
    for (let i = 0; i < 5; i++) u = `https://google.com/goto?url=${enc(u)}`;
    const deep = resolveSerpResultUrl(u);
    assert.equal(deep.resolutionStatus, 'unresolved');
    assert.match(deep.resolutionError, /nesting/);
  });

  test('malformed and empty input', () => {
    assert.equal(resolveSerpResultUrl('http://').resolutionStatus, 'invalid');
    assert.equal(resolveSerpResultUrl('not a url').resolutionStatus, 'invalid');
    assert.equal(resolveSerpResultUrl('').resolutionStatus, 'unavailable');
    assert.equal(resolveSerpResultUrl(null).resolutionStatus, 'unavailable');
    assert.equal(resolveSerpResultUrl(`https://google.com/goto?url=${enc('https://exa mple.com%zz')}`).resolutionStatus, 'invalid');
  });

  test('unsafe schemes and unsafe destinations are rejected', () => {
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'ftp://example.com/x', 'data:text/html,hi']) {
      assert.equal(resolveSerpResultUrl(bad).resolutionStatus, 'unsupported', bad);
      assert.equal(resolveSerpResultUrl(`https://google.com/goto?url=${enc(bad)}`).resolutionStatus, 'unsupported', `goto ${bad}`);
    }
    for (const host of ['http://127.0.0.1/admin', 'http://localhost:3000', 'http://169.254.169.254/latest', 'http://10.0.0.5/', 'http://[::1]/', 'http://0x7f000001/', 'http://intranet.local/']) {
      const r = resolveSerpResultUrl(`https://google.com/goto?url=${enc(host)}`);
      assert.equal(r.resolutionStatus, 'invalid', host);
      assert.equal(r.hostname, null);
    }
    assert.equal(resolveSerpResultUrl('https://user:pw@example.com/').resolutionStatus, 'invalid');
  });

  test('hostname normalisation: case, trailing dot, default port, IDN', () => {
    assert.equal(resolveSerpResultUrl('HTTPS://WWW.Example.COM.:443/').hostname, 'example.com');
    assert.equal(resolveSerpResultUrl('http://bücher.example/x').hostname, 'xn--bcher-kva.example');
  });

  test('registrable domain follows the Public Suffix List', () => {
    assert.equal(resolveSerpResultUrl('https://a.b.example.co.uk/').registrableDomain, 'example.co.uk');
    assert.equal(resolveSerpResultUrl('https://foo.github.io/').registrableDomain, 'foo.github.io');
  });

  test('a provider-supplied direct URL may replace a destination-less redirect', () => {
    const r = resolveSerpResultUrl('https://google.com/goto?x=1', { providerUrl: 'https://www.example.com/p' });
    assert.equal(r.resolutionStatus, 'resolved');
    assert.equal(r.resolutionMethod, 'provider_resolved');
    assert.equal(r.hostname, 'example.com');
    assert.equal(resolveSerpResultUrl('https://google.com/goto', { providerUrl: 'https://google.com/other' }).resolutionStatus, 'unresolved');
  });

  test('isGoogleHost is not fooled by look-alikes', () => {
    assert.equal(isGoogleHost('www.google.co.in'), true);
    assert.equal(isGoogleHost('google.com.evil.org'), false);
    assert.equal(isGoogleHost('notgoogle.com'), false);
  });
});

describe('resolveSerpItem', () => {
  test('the reported case: goto url, domain google.com, title of a business -> unresolved, title never used', () => {
    const r = resolveSerpItem({ type: 'organic', title: 'ASG Eye Hospital', domain: 'google.com', url: 'https://google.com/goto?url=' });
    assert.equal(r.resolutionStatus, 'unresolved');
    assert.equal(r.hostname, null);
  });

  test('goto with a destination resolves; a real item.domain is used only when no URL resolves', () => {
    assert.equal(resolveSerpItem({ url: `https://google.com/goto?url=${enc('https://asgeyehospital.com/')}`, domain: 'google.com' }).hostname, 'asgeyehospital.com');
    const d = resolveSerpItem({ url: 'https://google.com/goto', domain: 'www.asgeyehospital.com' });
    assert.equal(d.resolutionMethod, 'provider_resolved');
    assert.equal(d.hostname, 'asgeyehospital.com');
    assert.equal(d.resolvedUrl, null);
  });
});
