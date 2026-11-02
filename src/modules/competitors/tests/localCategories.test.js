import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ALLOWED_TYPES, MAX_QUERIES, applyCorrection, classifyPlace, suggestCategories } from '../config/localCategories.js';

const eye = { industry: 'healthcare', subIndustry: 'eye hospital', services: ['cataract surgery', 'LASIK'], gbp: { trusted: true, category: 'Eye care center', secondary: ['Ophthalmologist', 'Eye clinic'] } };

describe('suggestCategories: the project\'s OWN words drive the searches', () => {
  test('an eye hospital: its own words become the text searches, and verified Google types the broader one', () => {
    const s = suggestCategories(eye);
    assert.equal(s.specificity, 'specific');
    assert.deepEqual(s.queries, ['eye hospital', 'Eye care center', 'Ophthalmologist']);
    assert.ok(s.queries.length <= MAX_QUERIES);
    assert.ok(s.types.includes('hospital') && s.types.includes('doctor'));
    assert.ok(s.types.every((t) => ALLOWED_TYPES.has(t)), 'only verified Google type names');
    assert.ok(s.words.includes('cataract surgery'), 'services are kept as words for judging results');
  });

  test('a Business Profile that is not trusted contributes no words', () => {
    const s = suggestCategories({ ...eye, gbp: { trusted: false, category: 'Hospital', secondary: [] } });
    assert.deepEqual(s.queries, ['eye hospital']);
  });

  test('healthcare in general falls back to a BROAD net, marked as such; unrelated sectors do not get healthcare types', () => {
    const broad = suggestCategories({ industry: 'healthcare', subIndustry: null, services: [], gbp: { trusted: false } });
    assert.equal(broad.specificity, 'broad');
    assert.deepEqual(broad.queries, []);
    assert.ok(broad.types.includes('hospital'));
    const legal = suggestCategories({ industry: 'legal', subIndustry: 'law firm', gbp: { trusted: false } });
    assert.deepEqual(legal.types, ['lawyer']);
  });

  test('nothing to go on gives "none" (the page asks the user, it does not search everything nearby)', () => {
    for (const p of [{}, { industry: 'other' }, { industry: null, subIndustry: '  ', services: [], gbp: {} }, null]) assert.equal(suggestCategories(p).specificity, 'none');
  });

  test('every type any rule can produce is in the verified allow-list (so Google never gets an unknown value)', () => {
    const phrases = ['eye hospital', 'hospital', 'clinic', 'doctor', 'dentist', 'pharmacy', 'diagnostic lab', 'physiotherapy', 'restaurant', 'cafe', 'bakery', 'salon', 'beauty parlour', 'spa', 'law firm', 'real estate', 'insurance', 'travel agency', 'hotel', 'school', 'college', 'car garage', 'plumber', 'electrician', 'veterinary', 'marketing agency'];
    for (const phrase of phrases) {
      const s = suggestCategories({ subIndustry: phrase });
      assert.ok(s.types.length > 0, `${phrase} maps to something`);
      for (const t of s.types) assert.ok(ALLOWED_TYPES.has(t), `${phrase} -> ${t}`);
    }
  });
});

describe('applyCorrection: what the user may change', () => {
  const base = suggestCategories(eye);
  test('their own queries replace the suggestion; invalid and too-short ones are dropped; at most three', () => {
    const c = applyCorrection(base, { queries: ['  dental clinic ', 'x', '', 5, 'dental clinic', 'orthodontist', 'implants', 'braces'] });
    assert.deepEqual(c.queries, ['dental clinic', 'orthodontist', 'implants']);
    assert.equal(c.corrected, true);
    assert.deepEqual(c.types, base.types, 'types untouched when only queries were corrected');
  });
  test('only ALLOWED types survive: an invented one can never reach Google', () => {
    const c = applyCorrection(base, { types: ['dentist', 'not_a_real_type', '../../etc', 'hospital', 7] });
    assert.deepEqual(c.types, ['dentist', 'hospital']);
  });
  test('no correction leaves it as suggested', () => {
    const c = applyCorrection(base, {});
    assert.deepEqual([c.queries, c.types, c.corrected], [base.queries, base.types, false]);
  });
  test('correcting everything away leaves "none"', () => {
    assert.equal(applyCorrection(base, { queries: [], types: ['nope'] }).specificity, 'none');
  });
});

describe('classifyPlace: category match, never distance', () => {
  const m = suggestCategories(eye);
  test('its Google category is one of ours AND its name uses our words: direct', () => {
    assert.equal(classifyPlace({ name: 'ASG Eye Hospital', types: ['hospital', 'health'], primaryType: 'hospital', primaryTypeLabel: 'Eye hospital' }, m), 'direct');
  });
  test('only the category matches (a general hospital) or only the words match: related', () => {
    assert.equal(classifyPlace({ name: 'City General Hospital', types: ['hospital'], primaryType: 'hospital' }, m), 'related');
    assert.equal(classifyPlace({ name: 'Sunrise Eye Hospital', types: ['establishment'], primaryTypeLabel: 'Eye hospital' }, m), 'related');
  });
  test('nothing connects it: unclassified (a bank next door is not a competitor because it is near)', () => {
    assert.equal(classifyPlace({ name: 'State Bank', types: ['bank'], primaryType: 'bank', primaryTypeLabel: 'Bank' }, m), 'unclassified');
  });
});
