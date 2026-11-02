import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCreateBody, parseUpdateBody, LIMITS } from '../validator/myCompetitorInput.js';

const fails = (fn, field) => assert.throws(fn, (e) => e.name === 'ValidationFailure' && (!field || e.field === field));

describe('parseCreateBody', () => {
  test('a name and a website: the website is cleaned', () => {
    const r = parseCreateBody({ name: '  Sunrise   Eye Clinic ', domain: 'https://www.Sunrise-Eye.com/about/' });
    assert.equal(r.name, 'Sunrise Eye Clinic');
    assert.equal(r.domain, 'sunrise-eye.com');
    assert.equal(r.source, 'manual');
  });

  test('a website alone: the name is the domain; `website` is accepted as an alias', () => {
    const r = parseCreateBody({ website: 'Example.COM' });
    assert.deepEqual([r.name, r.domain], ['example.com', 'example.com']);
  });

  test('a name alone is valid (a competitor with no website)', () => {
    const r = parseCreateBody({ name: 'Corner Clinic', address: ' 12 Main Rd ', notes: '' });
    assert.deepEqual([r.name, r.domain, r.address, r.notes], ['Corner Clinic', null, '12 Main Rd', null]);
  });

  test('neither a name nor a website is rejected', () => {
    fails(() => parseCreateBody({}), 'name');
    fails(() => parseCreateBody({ name: '   ', domain: '' }), 'name');
  });

  test('invalid websites are rejected, not guessed', () => {
    for (const domain of ['localhost', '10.0.0.1', 'not a domain', 'single', 42]) fails(() => parseCreateBody({ name: 'X', domain }), 'domain');
  });

  test('lengths, types and the source are enforced', () => {
    fails(() => parseCreateBody({ name: 'a'.repeat(LIMITS.name + 1) }), 'name');
    fails(() => parseCreateBody({ name: 'X', notes: 'n'.repeat(LIMITS.notes + 1) }), 'notes');
    fails(() => parseCreateBody({ name: 5 }), 'name');
    fails(() => parseCreateBody({ name: 'X', source: 'import' }), 'source');
    fails(() => parseCreateBody({ name: 'X', placeId: 'bad id!' }), 'placeId');
    fails(() => parseCreateBody(null), 'body');
    fails(() => parseCreateBody([]), 'body');
    assert.equal(parseCreateBody({ name: 'X', source: 'local', placeId: 'ChIJ_abc-123' }).place_id, 'ChIJ_abc-123');
  });

  test('control characters are removed from free text', () => {
    assert.equal(parseCreateBody({ name: 'A\u0000B\nC' }).name, 'A B C');
  });
});

describe('parseUpdateBody', () => {
  test('only the fields sent are returned; a blank optional field clears it', () => {
    assert.deepEqual(parseUpdateBody({ notes: 'call them' }), { notes: 'call them' });
    assert.deepEqual(parseUpdateBody({ domain: '' }), { domain: null });
    assert.deepEqual(parseUpdateBody({ address: '   ' }), { address: null });
  });

  test('a name cannot be blanked, nothing to change is an error, and source cannot be edited', () => {
    fails(() => parseUpdateBody({ name: '  ' }), 'name');
    fails(() => parseUpdateBody({}), 'body');
    fails(() => parseUpdateBody({ source: 'seo' }), 'body');
  });

  test('a changed website is cleaned and validated', () => {
    assert.deepEqual(parseUpdateBody({ domain: 'HTTPS://www.A.com' }), { domain: 'a.com' });
    fails(() => parseUpdateBody({ domain: 'localhost' }), 'domain');
  });
});

describe('parseDiscoveredBody (a business found in the SEO list or Local Competitors)', async () => {
  const { parseDiscoveredBody } = await import('../validator/myCompetitorInput.js');
  test('an SEO result needs a website, and its name defaults to the domain', () => {
    const r = parseDiscoveredBody({ source: 'seo', domain: 'https://www.AsgEyeHospital.com/x' });
    assert.deepEqual([r.name, r.domain, r.place_id, r.source], ['asgeyehospital.com', 'asgeyehospital.com', null, 'seo']);
    fails(() => parseDiscoveredBody({ source: 'seo', name: 'No site' }), 'domain');
  });
  test('a local result needs its Google place id; coordinates come as a pair', () => {
    const r = parseDiscoveredBody({ source: 'local', name: 'City Eye', placeId: 'ChIJ_abc-1', lat: 20.01, lng: 73.78, address: '1 Main Rd' });
    assert.deepEqual([r.place_id, r.lat, r.lng, r.address, r.domain], ['ChIJ_abc-1', 20.01, 73.78, '1 Main Rd', null]);
    fails(() => parseDiscoveredBody({ source: 'local', name: 'City Eye' }), 'placeId');
    fails(() => parseDiscoveredBody({ source: 'local', placeId: 'P1', name: 'X', lat: 20 }), 'lat');
    fails(() => parseDiscoveredBody({ source: 'local', placeId: 'P1', name: 'X', lat: 91, lng: 0 }), 'lat');
    fails(() => parseDiscoveredBody({ source: 'local', placeId: 'P1', name: 'X', lat: '20', lng: 0 }), 'lat');
  });
  test('only "seo" and "local" are accepted: a discovery cannot claim to be manual, legacy or social', () => {
    for (const source of ['manual', 'legacy', 'social', undefined, 'LOCAL']) fails(() => parseDiscoveredBody({ source, domain: 'a.com', placeId: 'P1', name: 'X' }), 'source');
    fails(() => parseDiscoveredBody(null), 'body');
  });
  test('an invalid website is refused', () => fails(() => parseDiscoveredBody({ source: 'seo', domain: 'localhost' }), 'domain'));
});
