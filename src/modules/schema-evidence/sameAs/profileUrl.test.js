import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateProfileUrl, validateProfileList, handleMatchesOrganization } from './profileUrl.js';

const SITE = 'https://www.sapphiredigitalagency.com/';
const ok = (raw, opts) => { const r = evaluateProfileUrl(raw, { siteUrl: SITE, source: 'discovered', ...opts }); assert.equal(r.ok, true, `${raw} -> ${JSON.stringify(r)}`); return r; };
const bad = (raw, code, opts) => { const r = evaluateProfileUrl(raw, { siteUrl: SITE, source: 'discovered', ...opts }); assert.equal(r.ok, false, `${raw} should be rejected`); assert.equal(r.code, code, `${raw} -> ${r.code}`); return r; };

test('recognises the three real Sapphire footer profiles and normalises them', () => {
  const fb = ok('https://www.facebook.com/sapphiredigitalmarketingagency');
  assert.equal(fb.platform, 'facebook'); assert.equal(fb.kind, 'account');
  const li = ok('https://www.linkedin.com/company/sapphire-digital-marketing-agency');
  assert.equal(li.kind, 'organization');
  const ig = ok('https://www.instagram.com/sapphiredigitalagency/');
  assert.equal(ig.url, 'https://www.instagram.com/sapphiredigitalagency');
  assert.equal(ig.kind, 'account');
});

test('one profile written differently is one identity (scheme, host alias, trailing slash, case, sub-pages)', () => {
  const a = ok('https://twitter.com/Acme_Co');
  const b = ok('https://x.com/acme_co/');
  assert.equal(a.identityKey, b.identityKey);
  assert.equal(ok('https://m.facebook.com/AcmeCo/about').identityKey, ok('https://www.facebook.com/acmeco').identityKey);
  assert.equal(ok('http://www.linkedin.com/company/acme/').url, 'https://www.linkedin.com/company/acme');
  assert.equal(ok('http://www.linkedin.com/company/acme/').normalized.upgradedHttp, true);
});

test('tracking parameters are removed but identity-bearing parameters are kept', () => {
  const t = ok('https://www.instagram.com/acme?utm_source=site&igshid=abc123&fbclid=zzz');
  assert.equal(t.url, 'https://www.instagram.com/acme'); assert.equal(t.normalized.strippedTracking, true);
  const p = ok('https://www.facebook.com/profile.php?id=100012345678&fbclid=x&utm_medium=footer');
  assert.equal(p.url, 'https://www.facebook.com/profile.php?id=100012345678');
  assert.equal(p.kind, 'ambiguous');
});

test('share buttons, login links, tracking endpoints, posts and resources are never profiles', () => {
  bad('https://www.facebook.com/sharer/sharer.php?u=https://x.com', 'SHARE_LINK');
  bad('https://www.facebook.com/tr?id=123&ev=PageView', 'TRACKING_ENDPOINT');
  bad('https://twitter.com/intent/tweet?text=hi', 'SHARE_LINK');
  bad('https://www.linkedin.com/sharing/share-offsite/?url=x', 'SHARE_LINK');
  bad('https://www.linkedin.com/login', 'LOGIN_LINK');
  bad('https://www.instagram.com/p/Cabc123/', 'POST_LINK');
  bad('https://www.facebook.com/acme/posts/123', 'POST_LINK');
  bad('https://twitter.com/acme/status/1', 'POST_LINK');
  bad('https://www.youtube.com/watch?v=abc', 'POST_LINK');
  bad('https://youtu.be/abc', 'POST_LINK');
  bad('https://www.google-analytics.com/collect?v=1', 'TRACKING_ENDPOINT');
  bad('https://www.addtoany.com/add_to/facebook', 'SHARE_LINK');
  bad('https://wa.me/919999999999', 'CONTACT_CHANNEL');
  bad('https://bit.ly/3abc', 'SHORT_LINK');
  bad('https://www.facebook.com/images/logo.png', 'RESOURCE_URL');
});

test('personal LinkedIn profiles are rejected, company pages accepted', () => {
  bad('https://www.linkedin.com/in/jane-doe', 'PERSONAL_PROFILE');
  assert.equal(ok('https://in.linkedin.com/company/acme/about').url, 'https://www.linkedin.com/company/acme');
  assert.equal(ok('https://www.linkedin.com/school/acme-univ').kind, 'organization');
});

test('the audited site itself, placeholders and example domains are rejected', () => {
  bad('https://www.sapphiredigitalagency.com/contact-us', 'SELF_SITE');
  bad('https://sapphiredigitalagency.com/', 'SELF_SITE');
  bad('https://www.linkedin.com/company/your-company', 'PLACEHOLDER');
  bad('https://www.facebook.com/yourcompany', 'PLACEHOLDER');
  bad('https://www.example.com/acme', 'PLACEHOLDER');
  bad('https://acme.example/profile', 'PLACEHOLDER');
});

test('malformed, unsafe and non-public addresses are rejected (manual entry)', () => {
  const m = (raw, code) => bad(raw, code, { source: 'manual' });
  m('javascript:alert(1)', 'NOT_HTTP');
  m('//www.linkedin.com/company/acme', 'NOT_HTTP');
  m('www.linkedin.com/company/acme', 'NOT_HTTP');
  m('data:text/html,hi', 'NOT_HTTP');
  m('http://www.linkedin.com/company/acme', 'NOT_HTTPS');
  m('https://localhost/acme', 'INVALID_HOST');
  m('https://127.0.0.1/acme', 'INVALID_HOST');
  m('https://192.168.1.10/acme', 'INVALID_HOST');
  m('https://[::1]/acme', 'INVALID_HOST');
  m('https://user:pw@www.linkedin.com/company/acme', 'CREDENTIALS');
  m('https://www.linkedin.com:8443/company/acme', 'PORT');
  m('https://www.linkedin.com/company/acme\nhttps://evil.com', 'INVALID_CHARACTERS');
  m('', 'EMPTY');
  m(42, 'NOT_A_STRING');
  m(`https://www.linkedin.com/company/${'a'.repeat(2100)}`, 'TOO_LONG');
  m('https://www.linkedin.com/', 'NOT_A_PROFILE');
  m('https://www.instagram.com/', 'NOT_A_PROFILE');
});

test('manual entry accepts an unrecognised HTTPS profile page with a warning; discovery does not', () => {
  const r = evaluateProfileUrl('https://vimeo.com/acmefilms', { siteUrl: SITE, source: 'manual' });
  assert.equal(r.ok, true); assert.equal(r.platform, 'other'); assert.equal(r.kind, 'ambiguous');
  assert.ok(r.warnings.some((w) => w.code === 'UNRECOGNISED_SITE'));
  assert.equal(evaluateProfileUrl('https://vimeo.com/acmefilms', { siteUrl: SITE, source: 'discovered' }).code, 'UNSUPPORTED_PLATFORM');
  assert.equal(evaluateProfileUrl('https://some-blog.net/', { siteUrl: SITE, source: 'manual' }).code, 'NOT_A_PROFILE');
});

test('ambiguous platforms are flagged, directories recognised', () => {
  assert.equal(ok('https://www.facebook.com/people/Acme/100099999').kind, 'ambiguous');
  assert.equal(ok('https://en.wikipedia.org/wiki/Acme_Corporation').kind, 'ambiguous');
  assert.equal(ok('https://www.crunchbase.com/organization/acme').kind, 'organization');
  bad('https://en.wikipedia.org/wiki/Category:Companies', 'NOT_A_PROFILE');
});

test('validateProfileList reports per-line errors and duplicates of the same profile', () => {
  const r = validateProfileList(['https://www.linkedin.com/company/acme', 'https://linkedin.com/company/ACME/', 'javascript:x', 'https://www.facebook.com/acmeco'], { siteUrl: SITE });
  assert.equal(r.valid, false);
  assert.deepEqual(r.errors.map((e) => [e.index, e.code]), [[1, 'DUPLICATE'], [2, 'NOT_HTTP']]);
  const good = validateProfileList(['https://www.linkedin.com/company/acme', 'https://www.facebook.com/acmeco'], { siteUrl: SITE });
  assert.equal(good.valid, true); assert.equal(good.items.length, 2);
  assert.equal(validateProfileList(Array.from({ length: 11 }, (_, i) => `https://www.instagram.com/a${i}`), { siteUrl: SITE }).errors[0].code, 'TOO_MANY');
  assert.equal(validateProfileList('x').valid, false);
});

test('handleMatchesOrganization is a signal for ranking, not a gate', () => {
  const org = { names: ['Sapphire Digital Agency'], siteHost: 'www.sapphiredigitalagency.com' };
  assert.equal(handleMatchesOrganization('sapphire-digital-marketing-agency', org), true);
  assert.equal(handleMatchesOrganization('sapphiredigitalagency', org), true);
  assert.equal(handleMatchesOrganization('janedoe123', org), false);
  assert.equal(handleMatchesOrganization('', org), false);
});
