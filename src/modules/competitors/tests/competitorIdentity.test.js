import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { matchKey, distanceMeters } from '../service/competitorIdentity.js';

describe('matchKey: only a name AND a specific address can identify a business with no website and no place', () => {
  test('case, punctuation, accents and "&" do not matter', () => {
    assert.equal(matchKey('Sunrise Eye & ENT Clinic', '12, Main Rd., Nashik'), matchKey('SUNRISE EYE and ent clinic', '12 main rd nashik'));
    assert.equal(matchKey('Café Ñandú', '5 Park Street Kolkata'), matchKey('cafe nandu', '5 park street, kolkata'));
  });
  test('a name alone, or a name with only a city, is not enough (null): nothing is ever merged on a name alone', () => {
    assert.equal(matchKey('Sunrise Eye Clinic', null), null);
    assert.equal(matchKey('Sunrise Eye Clinic', 'Nashik'), null);
    assert.equal(matchKey('', '12 Main Rd Nashik'), null);
  });
  test('the same name at a different address is a different business', () => {
    assert.notEqual(matchKey('Sunrise Eye Clinic', '12 Main Rd Nashik'), matchKey('Sunrise Eye Clinic', '98 College Rd Nashik'));
  });
});

describe('distanceMeters (haversine)', () => {
  test('known distances', () => {
    assert.equal(distanceMeters({ lat: 20, lng: 73 }, { lat: 20, lng: 73 }), 0);
    // 0.045 degrees of latitude is about 5 km anywhere
    const d = distanceMeters({ lat: 20.0, lng: 73.78 }, { lat: 20.045, lng: 73.78 });
    assert.ok(d > 4900 && d < 5100, String(d));
    // Nashik to Mumbai: about 140 km in a straight line (the road is longer, ~165 km)
    const nm = distanceMeters({ lat: 19.9975, lng: 73.7898 }, { lat: 19.076, lng: 72.8777 });
    assert.ok(nm > 135_000 && nm < 145_000, String(nm));
  });
  test('an invalid coordinate gives null, never a made-up distance', () => {
    assert.equal(distanceMeters({ lat: null, lng: 1 }, { lat: 1, lng: 1 }), null);
    assert.equal(distanceMeters({ lat: 91, lng: 0 }, { lat: 0, lng: 0 }), null);
    assert.equal(distanceMeters({ lat: 'x', lng: 0 }, { lat: 0, lng: 0 }), null);
    assert.equal(distanceMeters(undefined, { lat: 0, lng: 0 }), null);
  });
});
