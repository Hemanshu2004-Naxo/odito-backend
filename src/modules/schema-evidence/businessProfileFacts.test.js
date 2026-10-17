import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { hoursToSpecification, loadBusinessProfileFacts, normalizeBusinessProfile, schemaTypeForCategory } from './businessProfileFacts.js';

const meta = (over = {}) => ({
  business_name: 'Clinic Eye Centre', category: 'Hospital', phone: '+91 11 4000 0000', website: 'https://www.clinic.example/', address: '2-A Trust House, Parel, Mumbai',
  latitude: 18.99, longitude: 72.84, business_status: 'OPEN',
  regular_hours: { periods: [{ openDay: 'MONDAY', openTime: { hours: 9 }, closeDay: 'MONDAY', closeTime: { hours: 18, minutes: 30 } }] },
  ...over,
});

describe('normalizeBusinessProfile — trusted ONLY when it belongs to this website', () => {
  test('same host (www and trailing slash ignored) and OPEN -> trusted, with facts', () => {
    const p = normalizeBusinessProfile(meta(), { siteUrl: 'https://clinic.example' });
    assert.equal(p.trusted, true);
    assert.equal(p.schemaType, 'Hospital');
    assert.equal(p.telephone, '+91 11 4000 0000');
    assert.equal(p.address, '2-A Trust House, Parel, Mumbai');
    assert.deepEqual(p.openingHoursSpecification, [{ '@type': 'OpeningHoursSpecification', dayOfWeek: 'Monday', opens: '09:00', closes: '18:30' }]);
  });

  test('REGRESSION: a profile whose website is a DIFFERENT domain is not trusted (wrong phone/brand would be published)', () => {
    const p = normalizeBusinessProfile(meta({ website: 'https://other-hospital.example/' }), { siteUrl: 'https://clinic.example' });
    assert.equal(p.available, true);
    assert.equal(p.trusted, false);
    assert.equal(p.reason, 'profile_website_is_a_different_site');
  });

  test('no website on the profile, a closed business, or no profile at all -> not trusted', () => {
    assert.equal(normalizeBusinessProfile(meta({ website: null }), { siteUrl: 'https://clinic.example' }).reason, 'profile_has_no_website');
    assert.equal(normalizeBusinessProfile(meta({ business_status: 'CLOSED_PERMANENTLY' }), { siteUrl: 'https://clinic.example' }).reason, 'business_not_open');
    assert.deepEqual(normalizeBusinessProfile(null, { siteUrl: 'https://clinic.example' }), { available: false, trusted: false, reason: 'no_profile' });
  });

  test('category -> type is a vetted table; an unknown category maps to nothing (never a guessed specific type)', () => {
    assert.equal(schemaTypeForCategory(' Dentist '), 'Dentist');
    assert.equal(schemaTypeForCategory('Medical clinic'), 'MedicalClinic');
    assert.equal(schemaTypeForCategory('Eye care center'), null);
    assert.equal(schemaTypeForCategory(undefined), null);
  });

  test('odd opening-hours shapes are omitted, not guessed', () => {
    assert.equal(hoursToSpecification(null), null);
    assert.equal(hoursToSpecification({ periods: [{ openDay: 'MONDAY', openTime: { hours: 22 }, closeDay: 'TUESDAY', closeTime: { hours: 2 } }] }), null);
    assert.equal(hoursToSpecification({ periods: [{ openDay: 'FUNDAY', openTime: { hours: 1 }, closeDay: 'FUNDAY', closeTime: { hours: 2 } }] }), null);
  });

  test('the loader never throws: a failing model means "no profile"', async () => {
    const model = { findOne: () => { throw new Error('boom'); } };
    const p = await loadBusinessProfileFacts('p', 'https://clinic.example', { model });
    assert.equal(p.available, false);
    const ok = await loadBusinessProfileFacts('p', 'https://clinic.example', { model: { findOne: () => ({ lean: async () => meta() }) } });
    assert.equal(ok.trusted, true);
  });
});
