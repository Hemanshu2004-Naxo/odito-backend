import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDomain, geoRelation, projectTerms, sectorMatch, siteKind, RULES_VERSION } from '../service/relevanceClassifier.js';
import { extractSiteFacts } from '../service/siteFacts.js';
import { lookupRegistry, REGISTRY_VERSION, REGISTRY_SIZE } from '../config/domainRegistry.js';

// Krishna Eye Centre, Nashik (the example in the product brief).
const PROFILE = Object.freeze({
  industry: 'healthcare', subIndustry: 'eye hospital', businessType: null, services: ['cataract surgery', 'LASIK', 'retina treatment'],
  gbp: { trusted: true, category: 'Eye care center', secondary: ['Ophthalmologist'] }, scope: 'local',
  city: 'Nashik', state: 'Maharashtra', countryIso2: 'IN', coords: { lat: 19.9975, lng: 73.7898 },
});

const page = ({ title = '', description = '', h1 = '', ld = null, body = '', tel = false } = {}) => extractSiteFacts(`<!doctype html><html lang="en"><head><title>${title}</title>
  <meta name="description" content="${description}">${ld ? `<script type="application/ld+json">${JSON.stringify(ld)}</script>` : ''}</head>
  <body><h1>${h1}</h1><p>${body}</p>${tel ? '<a href="tel:+912531234567">Call</a>' : ''}</body></html>`, { finalUrl: 'https://x.test/' });

const hospital = (address, extra = {}) => ({ '@context': 'https://schema.org', '@type': 'Hospital', name: 'Some Hospital', telephone: '+91 253 123 4567', address: { '@type': 'PostalAddress', ...address }, ...extra });
const classify = (domain, facts, profile = PROFILE) => classifyDomain({ domain, facts, profile });
const has = (r, code) => r.reasons.some((x) => x.code === code);

describe('the registry: explicit domains, never a suffix', () => {
  test('exact and subdomain matches only; versioned and non-trivial', () => {
    assert.equal(lookupRegistry('nih.gov').kind, 'government');
    assert.equal(lookupRegistry('www.practo.com').kind, 'directory');
    assert.equal(lookupRegistry('blog.practo.com').domain, 'practo.com');
    assert.equal(lookupRegistry('notpracto.com'), null, 'a different domain that merely ends with the same letters');
    assert.equal(lookupRegistry('practo.com.evil.org'), null);
    assert.ok(REGISTRY_VERSION && REGISTRY_SIZE > 30);
  });
  test('a government-looking or .org suffix alone is never in the registry', () => {
    for (const d of ['somedept.gov.in', 'college.edu', 'charity.org', 'hospital.ac.in', 'eyecare.org']) assert.equal(lookupRegistry(d), null, d);
  });
  test('real hospitals are not listed, even famous ones', () => {
    for (const d of ['clevelandclinic.org', 'mayoclinic.org', 'asgeyehospital.com', 'aiims.edu', 'apollohospitals.com']) assert.equal(lookupRegistry(d), null, d);
  });
});

describe('the six domains of the product brief (Krishna Eye Centre, Nashik)', () => {
  test('nih.gov, aao.org, practo.com, eyewiki.org -> informational/directory, from the registry, with an explanation', () => {
    for (const [d, kind] of [['nih.gov', 'government'], ['aao.org', 'association'], ['practo.com', 'directory'], ['eyewiki.org', 'publisher']]) {
      const r = classify(d, null);
      assert.equal(r.class, 'informational_directory', d);
      assert.equal(r.signals.registryKind, kind, d);
      assert.equal(r.level, 'high');
      assert.ok(has(r, 'registry'), d);
      assert.ok(r.reasons.find((x) => x.code === 'registry').text.length > 20);
      assert.ok(has(r, 'keyword_overlap_only'), 'says why shared keywords are not enough');
      assert.equal(r.rulesVersion, RULES_VERSION);
      assert.equal(r.registryVersion, REGISTRY_VERSION);
    }
  });

  test('clevelandclinic.org: a real hospital, same sector, another country -> indirect', () => {
    const facts = page({ title: 'Cleveland Clinic: Eye Institute - eye hospital and cataract surgery', h1: 'World-class eye care', body: 'LASIK retina cataract treatment appointments', ld: hospital({ streetAddress: '9500 Euclid Ave', addressLocality: 'Cleveland', addressRegion: 'OH', addressCountry: 'US' }) });
    const r = classify('clevelandclinic.org', facts);
    assert.equal(r.class, 'indirect_competitor');
    assert.equal(r.signals.geo, 'different_country');
    assert.ok(has(r, 'other_market'));
  });

  test('asgeyehospital.com: an eye hospital in Nashik -> direct', () => {
    const facts = page({ title: 'ASG Eye Hospital Nashik - Cataract, LASIK and Retina', description: 'Leading eye hospital in Nashik', h1: 'Eye hospital in Nashik', body: 'book appointment cataract surgery lasik', ld: hospital({ streetAddress: 'Gangapur Road', addressLocality: 'Nashik', addressRegion: 'Maharashtra', addressCountry: 'IN' }) });
    const r = classify('asgeyehospital.com', facts);
    assert.equal(r.class, 'direct_competitor');
    assert.equal(r.signals.geo, 'same_city');
    assert.equal(r.signals.sector, 'high');
    assert.ok(r.confidence >= 0.8);
    assert.ok(r.reasons.map((x) => x.source).includes('project'));
    assert.ok(r.signals.sectorTerms.length >= 2);
  });
});

describe('the rules', () => {
  test('a hospital in the same state but another city is INDIRECT for a local project, and DIRECT for a national one', () => {
    const facts = page({ title: 'Pune Eye Hospital - eye hospital', h1: 'Eye hospital', body: 'cataract lasik', ld: hospital({ addressLocality: 'Pune', addressRegion: 'Maharashtra', addressCountry: 'India' }) });
    const local = classify('puneeye.in', facts);
    assert.equal(local.class, 'indirect_competitor');
    assert.equal(local.signals.geo, 'same_state');
    const national = classify('puneeye.in', facts, { ...PROFILE, scope: 'national' });
    assert.equal(national.class, 'direct_competitor');
    assert.ok(has(national, 'scope'));
  });

  test('a business in an unrelated sector is not relevant', () => {
    const facts = page({ title: 'Nashik Auto Garage - car repair and servicing', h1: 'Car repair', body: 'wheel alignment tyres engine oil service ' + 'x '.repeat(80), ld: { '@type': 'AutoRepair', name: 'Garage', address: { addressLocality: 'Nashik', addressCountry: 'IN' }, telephone: '1' } });
    const r = classify('nashikgarage.in', facts);
    assert.equal(r.class, 'not_relevant');
    assert.ok(has(r, 'different_sector'));
  });

  test('a government organisation, declared in its own markup (not in the registry) -> informational, from the schema', () => {
    const facts = page({ title: 'Directorate of Health Services', body: 'eye care programmes ' + 'x '.repeat(80), ld: { '@type': 'GovernmentOrganization', name: 'Directorate' } });
    const r = classify('health.example-state.gov.in', facts);
    assert.equal(r.class, 'informational_directory');
    assert.equal(r.signals.kindSource, 'schema');
    assert.ok(has(r, 'tld_corroborates'), 'the suffix is mentioned as consistent but was not used to decide');
  });

  test('a news publisher declared in markup -> informational', () => {
    const r = classify('eyenews.example.com', page({ title: 'Eye News', body: 'articles ' + 'x '.repeat(80), ld: { '@type': 'NewsMediaOrganization', name: 'Eye News' } }));
    assert.equal(r.class, 'informational_directory');
  });

  test('a SUFFIX ALONE never classifies: a .gov.in site with nothing else is needs_review', () => {
    const r = classify('somedept.gov.in', page({ title: 'Welcome', body: 'hello ' + 'x '.repeat(80) }));
    assert.equal(r.class, 'needs_review');
    assert.ok(has(r, 'tld_not_enough'));
  });

  test('an unreadable website is needs_review and says so', () => {
    const r = classify('unreachable.example', { fetched: false, error: 'TIMEOUT' });
    assert.equal(r.class, 'needs_review');
    assert.ok(has(r, 'site_unreadable'));
    assert.match(r.reasons[0].text, /TIMEOUT/);
  });

  test('conflicting strong signals (business AND government markup) -> needs_review, never a guess', () => {
    const facts = page({ title: 'Eye hospital', body: 'x '.repeat(80), ld: [{ '@type': 'Hospital', name: 'A', address: { addressLocality: 'Nashik' }, telephone: '1' }, { '@type': 'GovernmentOrganization', name: 'A' }] });
    const r = classify('mixed.example', facts);
    assert.equal(r.class, 'needs_review');
    assert.ok(has(r, 'conflicting_signals'));
  });

  test('weak evidence alone is not enough to call a site a directory', () => {
    const facts = page({ title: 'Find a doctor - directory of clinics', body: 'listings ' + 'x '.repeat(80) });
    const r = classify('findclinics.example', facts);
    assert.equal(r.class, 'needs_review');
    assert.ok(has(r, 'weak_evidence'));
  });

  test('same sector but its location is unknown, for a local project -> needs_review (it cannot be confirmed as serving your area)', () => {
    const facts = page({ title: 'Eye hospital - cataract and lasik', h1: 'Eye hospital', body: 'book appointment cataract lasik', tel: true });
    const r = classify('noaddress.example', facts);
    assert.equal(r.class, 'needs_review');
    assert.ok(has(r, 'needs_location'));
  });

  test('a project with nothing to compare with (no sub-industry, services or category) is needs_review for businesses, with the reason', () => {
    const bare = { ...PROFILE, subIndustry: null, services: [], gbp: { trusted: false }, industry: null, businessType: null };
    const facts = page({ title: 'Some Clinic', h1: 'Clinic', body: 'x '.repeat(80), ld: hospital({ addressLocality: 'Nashik', addressCountry: 'IN' }) });
    const r = classify('someclinic.example', facts, bare);
    assert.equal(r.class, 'needs_review');
    assert.ok(has(r, 'no_project_terms'));
  });

  test('a Business Profile that is NOT trusted (its website is not the project\'s) contributes no terms', () => {
    const untrusted = { ...PROFILE, subIndustry: null, services: [], businessType: null, gbp: { trusted: false, category: 'Eye care center', secondary: [] } };
    assert.deepEqual(projectTerms(untrusted), []);
    assert.deepEqual(projectTerms(PROFILE).map((t) => t.source).slice(0, 2), ['sub_industry', 'gbp_category']);
  });

  test('every class comes with at least one reason, and every reason has a source', () => {
    const samples = [classify('nih.gov', null), classify('x.example', { fetched: false, error: 'NETWORK' }), classify('y.example', page({ title: 'Auto garage', body: 'tyres '.repeat(60), ld: { '@type': 'AutoRepair', address: { addressLocality: 'Nashik' }, telephone: '1' } }))];
    for (const r of samples) { assert.ok(r.reasons.length >= 1); for (const x of r.reasons) assert.ok(x.code && x.text && x.source); }
  });

  test('deterministic: the same evidence always gives the same answer', () => {
    const facts = page({ title: 'Eye hospital Nashik', h1: 'Eye hospital', body: 'cataract lasik', ld: hospital({ addressLocality: 'Nashik', addressCountry: 'IN' }) });
    assert.deepEqual(classify('d.example', facts), classify('d.example', facts));
  });
});

describe('geography', () => {
  test('city, nearby (by coordinates), state, country, other country, unknown', () => {
    const f = (address, geo) => ({ fetched: true, address, geo });
    assert.equal(geoRelation(PROFILE, f({ locality: 'Nashik' })).relation, 'same_city');
    assert.equal(geoRelation(PROFILE, f({ street: 'Plot 4, Gangapur Road, Nashik', locality: null, region: 'MH', country: 'IN' })).relation, 'same_city');
    assert.equal(geoRelation(PROFILE, f({ locality: 'Deolali', region: 'Maharashtra', country: 'India' }, { lat: 19.95, lng: 73.83 })).relation, 'nearby'); // about 6 km away
    assert.equal(geoRelation(PROFILE, f({ locality: 'Sinnar', region: 'Maharashtra', country: 'India' }, { lat: 19.85, lng: 73.99 })).relation, 'same_state', 'about 27 km: beyond the 25 km "nearby" limit');
    assert.equal(geoRelation(PROFILE, f({ locality: 'Pune', region: 'Maharashtra', country: 'IN' })).relation, 'same_state');
    assert.equal(geoRelation(PROFILE, f({ locality: 'Delhi', region: 'Delhi', country: 'IN' })).relation, 'same_country');
    assert.equal(geoRelation(PROFILE, f({ locality: 'Leeds', country: 'GB' })).relation, 'different_country');
    assert.equal(geoRelation(PROFILE, { fetched: true, address: null, geo: null }).relation, 'unknown');
  });
  test('a site that publishes only its COUNTRY is not placed outside your city: its city is unknown (found on a real hospital website)', () => {
    const only = { fetched: true, address: { locality: null, region: null, street: null, country: 'IN' }, geo: null };
    const g = geoRelation(PROFILE, only);
    assert.equal(g.relation, 'unknown');
    assert.ok(g.text.includes('only its country (IN)'), g.text);
    // ...but a different country is still a fact on its own
    assert.equal(geoRelation(PROFILE, { fetched: true, address: { country: 'GB' } }).relation, 'different_country');
  });

  test('such a hospital that matches the project closely is NOT downgraded to indirect: it needs a person to confirm where it is', () => {
    const facts = page({ title: 'ASG Eye Hospital - Cataract and LASIK', h1: 'Eye hospital', body: 'book appointment cataract surgery lasik retina', ld: { '@type': 'MedicalOrganization', name: 'ASG', telephone: '1', address: { addressCountry: 'IN' } } });
    const r = classify('asg.example', facts);
    assert.equal(r.class, 'needs_review');
    assert.ok(has(r, 'needs_location'));
    assert.equal(r.signals.geo, 'unknown');
  });

  test('a similar city name is not a match (word-boundary)', () => {
    assert.notEqual(geoRelation(PROFILE, { fetched: true, address: { locality: 'Nashikabad', country: 'IN' } }).relation, 'same_city');
  });
});

describe('site facts and kind', () => {
  test('extractSiteFacts reads title, headings, JSON-LD (including @graph), address, phone and a text sample', () => {
    const f = page({ title: 'T', description: 'D', h1: 'H', body: 'Hello Nashik', ld: { '@graph': [{ '@type': 'WebSite' }, hospital({ streetAddress: 'S', addressLocality: 'Nashik', addressCountry: 'IN' })] } });
    assert.deepEqual([f.title, f.description, f.h1[0]], ['T', 'D', 'H']);
    assert.ok(f.schemaTypes.includes('Hospital') && f.schemaTypes.includes('WebSite'));
    assert.equal(f.address.locality, 'Nashik');
    assert.match(f.phone, /253/);
    assert.match(f.textSample, /hello nashik/);
  });
  test('broken JSON-LD and script text never break extraction or leak into the text sample', () => {
    const f = extractSiteFacts('<html><head><title>X</title><script type="application/ld+json">{ not json</script></head><body><script>var secret="abc"</script><p>visible</p></body></html>');
    assert.equal(f.schemaTypes.length, 0);
    assert.ok(!f.textSample.includes('secret'));
    assert.match(f.textSample, /visible/);
  });
  test('an educational site is a business when the project itself is in education', () => {
    const facts = page({ title: 'ABC School', body: 'admissions ' + 'x '.repeat(80), ld: { '@type': 'EducationalOrganization', name: 'ABC School', address: { addressLocality: 'Nashik' } } });
    assert.equal(siteKind({ domain: 'abc.example', facts, registry: null, profile: { ...PROFILE, industry: 'healthcare' } }).kind, 'education');
    assert.equal(siteKind({ domain: 'abc.example', facts, registry: null, profile: { ...PROFILE, industry: 'education' } }).kind, 'business');
  });
  test('sectorMatch: all words of a term can match across the headline; an unread site is unknown', () => {
    assert.equal(sectorMatch(PROFILE, { fetched: false }).level, 'unknown');
    const f = page({ title: 'Hospital for the eye', h1: 'Best care', body: 'x '.repeat(80) });
    assert.notEqual(sectorMatch(PROFILE, f).level, 'low');
  });
});

describe('fetchSiteFacts: one safe request for the homepage', async () => {
  const { fetchSiteFacts } = await import('../service/siteFacts.js');
  test('asks for a generous size (real homepages are big), few redirects, and a short time', async () => {
    let seen;
    const fetcher = async (url, options) => { seen = { url, options }; return { status: 200, headers: { 'content-type': 'text/html' }, finalUrl: url, body: '<html><head><title>T</title></head><body>hi</body></html>' }; };
    const facts = await fetchSiteFacts('asgeyehospital.com', { fetcher });
    assert.equal(seen.url, 'https://asgeyehospital.com/');
    assert.ok(seen.options.maxBytes >= 3_000_000, 'a 1.5 MB WordPress homepage must not be refused');
    assert.ok(seen.options.maxRedirects <= 3 && seen.options.timeoutMs <= 10_000);
    assert.equal(facts.fetched, true);
  });
  test('a page that is still too large, a block, an error status and a non-page each give a SHORT SAFE CODE and never throw', async () => {
    const boom = (code) => async () => { throw Object.assign(new Error('internal detail at 10.0.0.1 with a secret'), { code }); };
    for (const code of ['TOO_LARGE', 'SSRF_BLOCKED', 'TIMEOUT', 'DNS_FAILED']) {
      const f = await fetchSiteFacts('x.example', { fetcher: boom(code) });
      assert.deepEqual([f.fetched, f.error], [false, code]);
    }
    const weird = await fetchSiteFacts('x.example', { fetcher: boom('a_very_long_code_that_is_not_a_safe_short_code_at_all') });
    assert.equal(weird.error, 'FETCH_FAILED', 'an unexpected code is replaced, not passed on');
    assert.equal((await fetchSiteFacts('x.example', { fetcher: async () => ({ status: 503, headers: {}, body: '' }) })).error, 'HTTP_503');
    assert.equal((await fetchSiteFacts('x.example', { fetcher: async () => ({ status: 200, headers: { 'content-type': 'application/pdf' }, body: '%PDF' }) })).error, 'NOT_HTML');
  });
});
