import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import SeoProject from '../../../../app_user/model/SeoProject.js';
import { validateProfileFields } from '../../../../app_user/controller/seoProjectController.js';
import { getProfile, updateProfile, buildProfileUpdate } from '../controllers/profileController.js';
import { buildBusinessProfile } from '../../services/businessProfileService.js';
import { generateQuestionSet } from '../services/questionGenerationService.js';
import { connectTestDb, disconnectTestDb, dropTestCollections } from '../../tests/testDb.js';

let up = false;
before(async () => { up = await connectTestDb(); });
after(async () => { if (up) await dropTestCollections(['seoprojects', 'socialbusinessprofiles']); await disconnectTestDb(); });
beforeEach(async () => { if (up) await dropTestCollections(['seoprojects']); });

const oid = () => new mongoose.Types.ObjectId();
const res = () => { const r = { statusCode: 200, body: null, status(c) { r.statusCode = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
const noAi = { provider: { isAvailable: () => false }, config: { useOpenAi: false, maxOutputTokens: 100, minAcceptRatio: 0.6 } };
const makeProject = (over = {}) => SeoProject.create({
  user_id: oid(), project_name: `p-${Math.random().toString(36).slice(2, 8)}`, main_url: 'https://www.asgeye.example', keywords: ['lasik'],
  business_type: 'Service-based', seo_scope: 'local', language: 'en', ...over,
});

describe('project creation / update: industry and profile fields (validation is pure)', () => {
  test('a taxonomy industry is accepted; a business type or free text is refused instead of being stored as an industry', () => {
    assert.deepEqual(validateProfileFields({ industry: 'healthcare', sub_industry: ' eye hospital ' }).values, { industry: 'healthcare', sub_industry: 'eye hospital' });
    assert.equal(validateProfileFields({ industry: 'Service-based' }).code, 'INVALID_INDUSTRY');
    assert.equal(validateProfileFields({ industry: 'Healthcare stuff' }).code, 'INVALID_INDUSTRY');
    assert.equal(validateProfileFields({ location_source: 'guessed' }).code, 'INVALID_LOCATION_SOURCE');
  });
  test('only fields present in the body are returned (an update never resets an omitted field); empty clears explicitly', () => {
    assert.deepEqual(validateProfileFields({ project_name: 'x' }).values, {});
    assert.deepEqual(validateProfileFields({ industry: '', target_city: null }).values, { industry: null, target_city: null });
  });
});

describe('profile persistence (isolated MongoDB)', () => {
  test('industry, sub-industry, target city and its source survive save and reload', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const p = await makeProject({ industry: 'healthcare', sub_industry: 'eye hospital', target_city: 'Mumbai', location_source: 'user_entered', location: 'mumbai' });
    const back = await SeoProject.findById(p._id).lean();
    assert.deepEqual([back.industry, back.sub_industry, back.target_city, back.location_source], ['healthcare', 'eye hospital', 'Mumbai', 'user_entered']);
    const profile = await buildBusinessProfile(String(p._id), { loadSocialProfile: async () => null });
    assert.equal(profile.business.industryKey, 'healthcare');
    assert.equal(profile.business.subIndustry, 'eye hospital');
    assert.equal(profile.market.city, 'Mumbai');
  });

  test('legacy projects without the new fields stay readable', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const p = await makeProject({ industry: 'Service-based', location: 'mumbai', verified_business: { city: 'Ahmedabad' } });
    const profile = await buildBusinessProfile(String(p._id), { loadSocialProfile: async () => null });
    assert.equal(profile.business.industry, null);
    assert.equal(profile.market.city, 'mumbai');
    assert.ok(profile.warnings.includes('location_conflict'));
  });
});

describe('profile API: GET / PUT', () => {
  test('GET shows stored values, suggestions, what questions will use, and what is missing or contradictory', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const p = await makeProject({ industry: 'Service-based', location: 'mumbai', verified_business: { city: 'Ahmedabad' } });
    const r = res();
    await getProfile({ project: p.toObject() }, r);
    const d = r.body.data;
    assert.equal(d.project.industry, null);
    assert.equal(d.project.legacyIndustryText, 'Service-based');
    assert.ok(d.completeness.missingProfile.includes('industry'));
    assert.ok(d.completeness.missingProfile.includes('sub_industry'));
    assert.deepEqual(d.completeness.conflicts[0].values, ['mumbai', 'Ahmedabad']);
    assert.equal(d.completeness.ready, false);
    assert.ok(d.industries.some((i) => i.value === 'healthcare'));
  });

  test('PUT saves the confirmed profile (only fields sent), resolves the conflict, and the next questions use it', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const p = await makeProject({ industry: 'Service-based', location: 'mumbai', verified_business: { city: 'Ahmedabad' }, description: 'keep me' });
    const r = res();
    await updateProfile({ project: p.toObject(), body: {
      industry: 'healthcare', subIndustry: 'eye hospital', targetCity: 'Mumbai',
      services: ['Cataract surgery', 'cataract surgery', 'Retina care'], customerProblems: ['blurred vision'],
    } }, r);
    assert.equal(r.statusCode, 200);
    const stored = await SeoProject.findById(p._id).lean();
    assert.deepEqual([stored.industry, stored.sub_industry, stored.target_city, stored.location_source], ['healthcare', 'eye hospital', 'Mumbai', 'user_entered']);
    assert.deepEqual(stored.visibility_profile.services, ['Cataract surgery', 'Retina care']);
    assert.equal(stored.description, 'keep me'); // untouched
    assert.equal(r.body.data.completeness.ready, true);
    assert.deepEqual(r.body.data.resolved.targetCities, ['Mumbai']);

    const profile = await buildBusinessProfile(String(p._id), { loadSocialProfile: async () => null });
    const set = await generateQuestionSet(profile, noAi);
    assert.ok(set.questions.some((q) => q.text === 'Which eye hospitals in Mumbai offer Cataract surgery?'));
    assert.ok(!set.questions.some((q) => /Ahmedabad|providers providers|Service-based/i.test(q.text)));
  });

  test('PUT refuses unsafe, over-long, wrong-type and non-taxonomy values with per-field errors, and saves nothing', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const p = await makeProject({ industry: 'healthcare' });
    const r = res();
    await updateProfile({ project: p.toObject(), body: { industry: 'Service-based', services: ['visit www.spam.example'], targetCity: 'x'.repeat(150), customerTypes: 'not a list' } }, r);
    assert.equal(r.statusCode, 422);
    assert.deepEqual(Object.keys(r.body.details.fields).sort(), ['customerTypes', 'industry', 'services', 'targetCity']);
    assert.equal((await SeoProject.findById(p._id).lean()).industry, 'healthcare');
  });

  test('PUT with nothing to change is a 400; null clears a list explicitly', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const p = await makeProject({ visibility_profile: { services: ['A service'] } });
    const empty = res();
    await updateProfile({ project: p.toObject(), body: { unknown: 1 } }, empty);
    assert.equal(empty.statusCode, 400);
    const cleared = res();
    await updateProfile({ project: p.toObject(), body: { services: null } }, cleared);
    assert.deepEqual((await SeoProject.findById(p._id).lean()).visibility_profile.services, []);
  });

  test('another user\'s project cannot be written through a forged req.project user', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const p = await makeProject({ industry: 'healthcare' });
    const r = res();
    await updateProfile({ project: { ...p.toObject(), user_id: oid() }, body: { subIndustry: 'hijack' } }, r);
    assert.equal(r.statusCode, 404);
    assert.equal((await SeoProject.findById(p._id).lean()).sub_industry, null);
  });

  test('buildProfileUpdate maps camelCase fields to storage and marks a typed city as user-entered', () => {
    const { set, errors } = buildProfileUpdate({ targetCity: 'Pune', serviceAreas: ['Kothrud'], language: 'HI' });
    assert.deepEqual(errors, {});
    assert.deepEqual(set, { target_city: 'Pune', location_source: 'user_entered', 'visibility_profile.service_areas': ['Kothrud'], 'visibility_profile.language': 'hi' });
  });
});
