import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SeoProject from '../../app_user/model/SeoProject.js';
import GoogleConnection from '../../app_user/model/GoogleConnection.js';
import BusinessProfileMetadata from '../../app_user/model/BusinessProfileMetadata.js';
import BusinessProfileMedia from '../../app_user/model/BusinessProfileMedia.js';
import SocialAccount from '../model/SocialAccount.js';
import SocialBusinessProfile from '../model/SocialBusinessProfile.js';
import { resolveSocialBusinessProfile, GBP_STALE_AFTER_DAYS } from './socialBusinessProfileResolver.js';
import { updateProfile, getEditableProfile, validateProfileUpdate, LIMITS } from './socialBusinessProfileService.js';

/**
 * Real MongoDB (module convention). The logo resolver is injected so no test
 * touches the network. Google data is seeded straight into the EXISTING GBP
 * collections — the same documents the real sync writes — to prove the
 * resolver reads them and that SocialBusinessProfile never copies them.
 */

let mongoAvailable = false;
before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
  } catch {
    mongoAvailable = false;
  }
});
after(async () => {
  if (mongoAvailable) await mongoose.connection.close();
});

const NOW = new Date('2026-10-10T12:00:00.000Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);
const noLogo = async () => ({ brandLogo: null, favicon: null, source: 'initials', resolution: null, fallbackType: 'generated_initials' });
const websiteLogo = async () => ({ brandLogo: 'https://site.example/logo.png', favicon: null, source: 'website_logo', resolution: null, fallbackType: 'website_logo' });

/** The Brand Kit as the API returns it before the user has set anything: every value empty, none invented. */
const EMPTY_BRAND_KIT = {
  primaryColor: null, secondaryColor: null, accentColor: null, fontHeading: null, fontBody: null,
  name: null, description: null, voice: null, personality: [], tagline: null, keyMessages: [], preferredWords: [], additionalInstructions: null, logo: null,
};

describe('SocialBusinessProfile — resolver + service (real MongoDB)', () => {
  let userId, project, pid, created;
  const track = (doc) => { created.push(doc); return doc; };

  async function newProject(extra = {}, owner = userId) {
    const p = await SeoProject.create({
      user_id: owner, project_name: `Biz Profile ${Date.now()} ${Math.random().toString(36).slice(2, 8)}`, main_url: 'https://example.com',
      seo_scope: 'local', keywords: ['biz'], ...extra,
    });
    track(p);
    return p;
  }

  async function seedGoogle(p, { metadata = {}, connection = {}, withMetadata = true } = {}) {
    const conn = await GoogleConnection.create({
      user_id: p.user_id, project_id: p._id, purpose: 'business_profile', service_type: ['business_profile'],
      business_account_id: 'acct-111', business_location_id: 'loc-222',
      refresh_token: 'SECRET-REFRESH-TOKEN', access_token: 'SECRET-ACCESS-TOKEN', google_email: 'owner@example.com', google_name: 'Owner',
      status: 'active', last_sync_at: daysAgo(1), ...connection,
    });
    track(conn);
    if (withMetadata) {
      track(await BusinessProfileMetadata.create({
        user_id: p.user_id, project_id: p._id, business_account_id: 'acct-111', business_location_id: 'loc-222',
        business_name: 'Google Name', category: 'Dentist', secondary_categories: ['Cosmetic dentist'], phone: '+1 555 0100',
        website: 'https://google-site.example', address: '1 Main St', description: 'Google description',
        regular_hours: [{ openDay: 'MONDAY' }], maps_uri: 'https://maps.example/x', new_review_uri: 'https://review.example/x',
        latitude: 10.5, longitude: 20.5, average_rating: 4.6, total_review_count: 120,
        reviews_capability: { status: 'available', reason: null, checked_at: daysAgo(1) },
        metadata_last_synced_at: daysAgo(2), details_last_synced_at: daysAgo(2), reviews_last_synced_at: daysAgo(2),
        ...metadata,
      }));
    }
    return conn;
  }

  const resolve = (id = pid, opts = {}) => resolveSocialBusinessProfile(id, { now: NOW, brandResolver: noLogo, ...opts });

  beforeEach(async () => {
    if (!mongoAvailable) return;
    created = [];
    userId = new mongoose.Types.ObjectId();
    project = await newProject({
      industry: 'Healthcare', business_type: 'Clinic', description: 'Project description', location: 'Project location text', country: 'gb',
      verified_business: { name: 'Verified Name', address: '2 Verified Rd', city: 'Leeds', state: 'West Yorkshire', country: 'United Kingdom', countryCode: 'GB', website: 'https://verified.example', phone: '+44 20 0000', location: { lat: 53.8, lng: -1.5 }, verifiedAt: daysAgo(30) },
      extracted_metadata: { description: 'Website description', contact_info: { phone: '+1 site', address: 'Website address' }, extracted_at: daysAgo(10) },
    });
    pid = project._id.toString();
  });

  afterEach(async () => {
    if (!mongoAvailable) return;
    const ids = created.map((d) => d._id);
    await Promise.all([
      SocialBusinessProfile.deleteMany({ project_id: { $in: created.map((d) => d.project_id || d._id) } }),
      BusinessProfileMedia.deleteMany({ project_id: { $in: created.map((d) => d.project_id || d._id) } }),
      SocialAccount.deleteMany({ project_id: { $in: created.map((d) => d.project_id || d._id) } }),
    ]);
    await Promise.all([
      GoogleConnection.deleteMany({ _id: { $in: ids } }),
      BusinessProfileMetadata.deleteMany({ _id: { $in: ids } }),
      SeoProject.deleteMany({ _id: { $in: ids } }),
    ]);
  });

  // ── precedence ──────────────────────────────────────────────────────────
  test('1: full precedence chain for the business name (override > GBP > verified_business > project)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedGoogle(project);
    assert.deepEqual(pickName(await resolve()), ['Google Name', 'google_business_profile']);

    assert.equal((await updateProfile(pid, userId, { overrides: { businessName: 'Override Name' } })).success, true);
    assert.deepEqual(pickName(await resolve()), ['Override Name', 'social_override']);

    await updateProfile(pid, userId, { overrides: { businessName: null } });
    await GoogleConnection.updateOne({ project_id: project._id }, { $set: { status: 'revoked' } });
    assert.deepEqual(pickName(await resolve()), ['Verified Name', 'verified_business']);

    await SeoProject.updateOne({ _id: project._id }, { $unset: { verified_business: 1 } });
    const bare = await resolve();
    assert.deepEqual(pickName(bare), [project.project_name, 'seo_project']);
  });

  function pickName(r) { return [r.resolvedProfile.business.name.value, r.resolvedProfile.business.name.source]; }

  test('2: description and category follow the documented order', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    // no Google: website extraction beats the project description; project industry beats business_type
    let r = await resolve();
    assert.deepEqual([r.resolvedProfile.business.description.value, r.resolvedProfile.business.description.source], ['Website description', 'website_extraction']);
    assert.deepEqual([r.resolvedProfile.business.category.value, r.resolvedProfile.business.category.source], ['Healthcare', 'seo_project']);

    await SeoProject.updateOne({ _id: project._id }, { $unset: { extracted_metadata: 1, industry: 1 } });
    r = await resolve();
    assert.deepEqual([r.resolvedProfile.business.description.value, r.resolvedProfile.business.description.source], ['Project description', 'seo_project']);
    assert.equal(r.resolvedProfile.business.category.value, 'Clinic', 'business_type is the last category fallback');

    await seedGoogle(project);
    r = await resolve();
    assert.deepEqual([r.resolvedProfile.business.description.value, r.resolvedProfile.business.description.source], ['Google description', 'google_business_profile']);
    assert.equal(r.resolvedProfile.business.category.value, 'Dentist');
    assert.deepEqual(r.resolvedProfile.business.secondaryCategories.value, ['Cosmetic dentist']);

    await BusinessProfileMetadata.updateOne({ project_id: project._id }, { $set: { category: null } });
    r = await resolve();
    assert.deepEqual([r.resolvedProfile.business.category.value, r.resolvedProfile.business.category.detail], ['Cosmetic dentist', 'secondary_category'], 'secondary category is used when there is no primary one');
  });

  test('3: every override beats Google and is labelled social_override; clearing it restores the Google value', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedGoogle(project);
    await updateProfile(pid, userId, { overrides: { businessName: 'O Name', description: 'O desc', category: 'O cat', phone: '+1 999 000', website: 'o-site.example', address: 'O address', serviceArea: ['Leeds', 'York'] } });
    const b = (await resolve()).resolvedProfile.business;
    for (const [f, v] of [['name', 'O Name'], ['description', 'O desc'], ['category', 'O cat'], ['phone', '+1 999 000'], ['website', 'https://o-site.example/']]) {
      assert.deepEqual([b[f].value, b[f].source], [v, 'social_override'], f);
    }
    assert.deepEqual([b.location.address.value, b.location.address.source], ['O address', 'social_override']);
    assert.deepEqual([b.serviceArea.value, b.serviceArea.source], [['Leeds', 'York'], 'social_override']);

    await updateProfile(pid, userId, { overrides: { businessName: null, phone: null } });
    const after = (await resolve()).resolvedProfile.business;
    assert.deepEqual([after.name.value, after.name.source], ['Google Name', 'google_business_profile']);
    assert.deepEqual([after.phone.value, after.phone.source], ['+1 555 0100', 'google_business_profile']);
    assert.equal(after.description.source, 'social_override', 'untouched overrides stay');
  });

  test('4: Google metadata supplies contact, hours, links, rating and review count with their sync time', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedGoogle(project);
    const b = (await resolve()).resolvedProfile.business;
    assert.deepEqual([b.phone.value, b.phone.source], ['+1 555 0100', 'google_business_profile']);
    assert.deepEqual([b.website.value, b.website.source], ['https://google-site.example', 'google_business_profile']);
    assert.deepEqual([b.location.address.value, b.location.address.source], ['1 Main St', 'google_business_profile']);
    assert.deepEqual(b.hours.regular.value, [{ openDay: 'MONDAY' }]);
    assert.equal(b.mapsUri.value, 'https://maps.example/x');
    assert.equal(b.reviewUri.value, 'https://review.example/x');
    assert.deepEqual([b.rating.value, b.reviewCount.value, b.rating.source], [4.6, 120, 'google_business_profile']);
    assert.equal(b.phone.lastUpdated, daysAgo(2).toISOString());
  });

  test('5: with no Google data, verified_business then the project then the website fill the gaps', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const b = (await resolve()).resolvedProfile.business;
    assert.deepEqual([b.phone.value, b.phone.source], ['+44 20 0000', 'verified_business']);
    assert.deepEqual([b.website.value, b.website.source], ['https://verified.example', 'verified_business']);
    assert.deepEqual([b.location.address.value, b.location.address.source], ['2 Verified Rd', 'verified_business']);
    await SeoProject.updateOne({ _id: project._id }, { $unset: { verified_business: 1 } });
    const c = (await resolve()).resolvedProfile.business;
    assert.deepEqual([c.website.value, c.website.source], ['https://example.com', 'seo_project']);
    assert.deepEqual([c.phone.value, c.phone.source], ['+1 site', 'website_extraction']);
    assert.deepEqual([c.location.address.value, c.location.address.source], ['Project location text', 'seo_project']);
  });

  // ── location ────────────────────────────────────────────────────────────
  test('6: structured location comes from verified_business; postcode is honestly unavailable; Google street line is not pretended to be a city', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedGoogle(project);
    const loc = (await resolve()).resolvedProfile.business.location;
    assert.deepEqual([loc.address.source, loc.city.value, loc.city.source], ['google_business_profile', 'Leeds', 'verified_business']);
    assert.deepEqual([loc.region.value, loc.country.value, loc.countryCode.value], ['West Yorkshire', 'United Kingdom', 'GB']);
    assert.deepEqual([loc.postalCode.value, loc.postalCode.source], [null, 'unavailable']);
  });

  test('7: coordinates are taken as a pair from one source (Google, then geocoded-from-Google, then verified_business)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedGoogle(project, { metadata: { latitude: null, longitude: null, geocoded_latitude: 11.1, geocoded_longitude: 22.2, geocoded_at: daysAgo(3) } });
    let loc = (await resolve()).resolvedProfile.business.location;
    assert.deepEqual([loc.latitude.value, loc.longitude.value, loc.latitude.source, loc.latitude.detail], [11.1, 22.2, 'google_business_profile', 'geocoded_from_address']);
    await BusinessProfileMetadata.updateOne({ project_id: project._id }, { $set: { geocoded_latitude: null, geocoded_longitude: null } });
    loc = (await resolve()).resolvedProfile.business.location;
    assert.deepEqual([loc.latitude.value, loc.longitude.value, loc.longitude.source], [53.8, -1.5, 'verified_business']);
    // a half pair is never mixed with another source
    await BusinessProfileMetadata.updateOne({ project_id: project._id }, { $set: { latitude: 9.9, longitude: null } });
    loc = (await resolve()).resolvedProfile.business.location;
    assert.equal(loc.latitude.source, 'verified_business');
  });

  // ── no GBP / missing data ───────────────────────────────────────────────
  test('8: no Google connection — still works from the project, with Google-only fields unavailable', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const r = await resolve();
    assert.equal(r.resolvedProfile.meta.hasGoogleBusinessProfile, false);
    assert.equal(r.resolvedProfile.meta.googleConnected, false);
    assert.equal(r.googleStatus.connectionStatus, 'not_connected');
    const b = r.resolvedProfile.business;
    assert.deepEqual([b.hours.regular.source, b.rating.source, b.mapsUri.source, b.secondaryCategories.source], ['unavailable', 'unavailable', 'unavailable', 'unavailable']);
    assert.equal(b.rating.detail, 'no_google_business_profile');
    assert.deepEqual([r.resolvedProfile.media.cover.source, r.resolvedProfile.media.photos.source], ['unavailable', 'unavailable']);
    assert.equal(b.name.value, 'Verified Name');
  });

  test('9: connected but never synced (no metadata) — Google layer unavailable, status says so', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedGoogle(project, { withMetadata: false });
    const r = await resolve();
    assert.equal(r.googleStatus.connected, true);
    assert.equal(r.googleStatus.hasSyncedData, false);
    assert.equal(r.resolvedProfile.meta.hasGoogleBusinessProfile, false);
    assert.equal(r.resolvedProfile.business.name.source, 'verified_business');
    assert.equal(r.resolvedProfile.meta.freshness.status, 'unknown');
  });

  test('10: an expired connection still shows the last synced data (reconnectable); a revoked one does not', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedGoogle(project, { connection: { status: 'expired' } });
    let r = await resolve();
    assert.equal(r.resolvedProfile.business.name.source, 'google_business_profile');
    assert.deepEqual([r.googleStatus.connected, r.googleStatus.connectionStatus], [false, 'expired']);
    await GoogleConnection.updateOne({ project_id: project._id }, { $set: { status: 'revoked' } });
    r = await resolve();
    assert.equal(r.resolvedProfile.business.name.source, 'verified_business');
    assert.equal(r.googleStatus.connectionStatus, 'revoked');
  });

  test('11: data synced for a PREVIOUS location is not shown as the current business', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedGoogle(project, { connection: { business_location_id: 'loc-NEW' } });
    const r = await resolve();
    assert.equal(r.googleStatus.dataMatchesSelectedLocation, false);
    assert.equal(r.resolvedProfile.meta.hasGoogleBusinessProfile, false);
    assert.notEqual(r.resolvedProfile.business.name.source, 'google_business_profile');
  });

  test('12: rating and review count appear only when Google allowed reviews access', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedGoogle(project, { metadata: { reviews_capability: { status: 'restricted', reason: 'allowlist' }, average_rating: 4.2, total_review_count: 33 } }); // an old rating left over from when access was allowed
    const b = (await resolve()).resolvedProfile.business;
    assert.deepEqual([b.rating.value, b.rating.source, b.rating.detail], [null, 'unavailable', 'restricted']);
    assert.equal(b.name.source, 'google_business_profile', 'the rest of Google data is unaffected');
  });

  test('13: a bare project with only the required fields resolves without throwing; optional fields are unavailable, not invented', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const bare = await newProject();
    const r = await resolve(bare._id.toString());
    const b = r.resolvedProfile.business;
    assert.equal(b.name.source, 'seo_project');
    assert.equal(b.website.value, 'https://example.com');
    for (const f of [b.description, b.category, b.phone, b.location.address, b.location.city, b.location.latitude, b.serviceArea, b.hours.regular]) {
      assert.deepEqual([f.value, f.source], [null, 'unavailable']);
    }
    assert.deepEqual(r.resolvedProfile.strategy.goals, []);
    const { logo: _logo, ...emptyResolvedBrand } = EMPTY_BRAND_KIT; // the logo's one resolved home is media.logo
    assert.deepEqual(r.resolvedProfile.brand, emptyResolvedBrand);
    assert.equal(r.editableProfile.exists, false);
  });

  test('14: an unknown or deleted project resolves to null', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    assert.equal(await resolve(new mongoose.Types.ObjectId().toString()), null);
    await SeoProject.updateOne({ _id: project._id }, { $set: { is_deleted: true } });
    assert.equal(await resolve(), null);
  });

  // ── freshness ───────────────────────────────────────────────────────────
  test('15: freshness uses the real sync timestamps and the explicit threshold only', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedGoogle(project, { metadata: { metadata_last_synced_at: daysAgo(1), details_last_synced_at: daysAgo(1) } });
    let f = (await resolve()).resolvedProfile.meta.freshness;
    assert.equal(f.status, 'fresh');
    assert.equal(f.staleAfterDays, GBP_STALE_AFTER_DAYS);
    assert.equal(f.detailsSyncedAt, daysAgo(1).toISOString());
    await BusinessProfileMetadata.updateOne({ project_id: project._id }, { $set: { metadata_last_synced_at: daysAgo(GBP_STALE_AFTER_DAYS + 1), details_last_synced_at: daysAgo(GBP_STALE_AFTER_DAYS + 1) } });
    f = (await resolve()).resolvedProfile.meta.freshness;
    assert.equal(f.status, 'stale');
  });

  // ── media / logo / social ───────────────────────────────────────────────
  test('16: the logo goes through the shared brand resolver (not a new one); cover and photos come from synced GBP media', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedGoogle(project);
    const mk = (key, category, extra = {}) => ({ user_id: userId, project_id: project._id, business_account_id: 'acct-111', business_location_id: 'loc-222', google_media_key: key, google_resource_name: `r/${key}`, category, media_format: 'PHOTO', google_url: `https://g.example/${key}.jpg`, thumbnail_url: `https://g.example/${key}-t.jpg`, create_time: daysAgo(5), last_seen_at: daysAgo(1), ...extra });
    await BusinessProfileMedia.insertMany([mk('c1', 'COVER'), mk('p1', 'ADDITIONAL'), mk('d1', 'ADDITIONAL', { is_deleted: true })]);
    const calls = [];
    const r = await resolve(pid, { brandResolver: async (p) => { calls.push(String(p._id)); return websiteLogo(); } });
    assert.deepEqual(calls, [pid], 'the shared resolver was called with this project');
    assert.deepEqual([r.resolvedProfile.media.logo.value, r.resolvedProfile.media.logo.source, r.resolvedProfile.media.logo.detail], ['https://site.example/logo.png', 'website_extraction', 'website_logo']);
    assert.equal(r.resolvedProfile.media.cover.value.url, 'https://g.example/c1.jpg');
    assert.equal(r.resolvedProfile.media.photos.value.length, 2, 'soft-deleted media is excluded');
    assert.equal(r.resolvedProfile.media.googleUrlsMayExpire, true);
  });

  test('17: a GBP logo is labelled google_business_profile; initials / a failing or slow resolver gives an unavailable logo, not an error', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    let r = await resolve(pid, { brandResolver: async () => ({ brandLogo: 'https://g.example/logo.jpg', source: 'google_logo', fallbackType: 'google_logo' }) });
    assert.deepEqual([r.resolvedProfile.media.logo.source, r.resolvedProfile.media.logo.detail], ['google_business_profile', 'google_logo']);
    r = await resolve(pid, { brandResolver: noLogo });
    assert.deepEqual([r.resolvedProfile.media.logo.value, r.resolvedProfile.media.logo.source], [null, 'unavailable']);
    r = await resolve(pid, { brandResolver: async () => { throw new Error('boom'); } });
    assert.deepEqual([r.resolvedProfile.media.logo.source, r.resolvedProfile.media.logo.detail], ['unavailable', 'logo_resolution_failed']);
  });

  test('18: connected Facebook / Instagram are reported with safe display fields only', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    track(await SocialAccount.create({
      user_id: userId, project_id: project._id, platform: 'facebook', platformAccountId: 'pg_1', platformAccountName: 'Acme Page', accountType: 'page',
      pageId: 'pg_1', accessToken: 'FB-SECRET-TOKEN', status: 'active', isActive: true, metadata: { category: 'Dentist', picture: 'https://p.example/x.jpg' },
    }));
    const r = await resolve();
    assert.deepEqual(r.resolvedProfile.social.facebook, { connected: true, name: 'Acme Page', category: 'Dentist', picture: 'https://p.example/x.jpg' });
    assert.deepEqual(r.resolvedProfile.social.instagram, { connected: false });
    assert.equal(JSON.stringify(r).includes('FB-SECRET-TOKEN'), false);
  });

  // ── security ────────────────────────────────────────────────────────────
  test('19: the response never contains Google tokens, ciphertext or Google account/location ids', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedGoogle(project);
    const json = JSON.stringify(await resolve());
    for (const secret of ['SECRET-REFRESH-TOKEN', 'SECRET-ACCESS-TOKEN', 'enc:v1', 'refresh_token', 'access_token', 'acct-111', 'loc-222', 'business_location_id', 'business_account_id']) {
      assert.equal(json.includes(secret), false, `must not leak ${secret}`);
    }
  });

  test('20: project isolation — one project never sees another project\'s overrides, Google data or strategy', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const other = await newProject({ verified_business: { name: 'Other Biz' } }, new mongoose.Types.ObjectId());
    await seedGoogle(other, { metadata: { business_name: 'Other Google Name' } });
    await updateProfile(other._id.toString(), other.user_id, { goals: ['Other goal'], overrides: { businessName: 'Other Override' } });
    await updateProfile(pid, userId, { goals: ['My goal'] });

    const mine = await resolve();
    assert.deepEqual(mine.resolvedProfile.strategy.goals, ['My goal']);
    assert.equal(mine.resolvedProfile.business.name.value, 'Verified Name');
    assert.equal(JSON.stringify(mine).includes('Other'), false);
    const theirs = await resolve(other._id.toString());
    assert.deepEqual(theirs.resolvedProfile.strategy.goals, ['Other goal']);
    assert.equal(theirs.resolvedProfile.business.name.value, 'Other Override');
    assert.equal(await SocialBusinessProfile.countDocuments({ project_id: { $in: [project._id, other._id] } }), 2);
  });

  // ── updates / validation ────────────────────────────────────────────────
  test('21: manual fields save, read back, and a partial update leaves the rest alone', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const r = await updateProfile(pid, userId, {
      audience: { primary: 'Young families', secondary: ['Retirees', 'retirees', ' '] },
      toneOfVoice: { primary: 'Warm', secondary: ['Direct'] },
      goals: ['More bookings'], uniqueSellingPoints: ['Open late'], contentPillars: ['Tips'], prohibitedPhrases: ['cheapest'],
      offers: [{ name: 'Free check-up', description: 'First visit free', url: 'offers.example/free' }],
      competitors: [{ name: 'Rival', website: 'https://rival.example' }],
      brand: { primaryColor: '#abc', accentColor: '#112233', fontHeading: 'Poppins' },
      additionalInstructions: 'Never mention prices.',
    });
    assert.equal(r.success, true);
    assert.deepEqual(r.profile.audience, { primary: 'Young families', secondary: ['Retirees'] }, 'blanks and case-duplicates removed');
    assert.deepEqual(r.profile.offers, [{ name: 'Free check-up', description: 'First visit free', url: 'https://offers.example/free' }]);
    assert.deepEqual(r.profile.brand, { ...EMPTY_BRAND_KIT, primaryColor: '#ABC', accentColor: '#112233', fontHeading: 'Poppins' });

    await updateProfile(pid, userId, { goals: ['Replaced'], audience: { primary: 'Everyone' } });
    const again = await getEditableProfile(pid);
    assert.deepEqual(again.goals, ['Replaced']);
    assert.deepEqual(again.audience, { primary: 'Everyone', secondary: ['Retirees'] }, 'audience.secondary untouched by a primary-only update');
    assert.deepEqual(again.uniqueSellingPoints, ['Open late']);
    assert.equal(again.brand.primaryColor, '#ABC');
    assert.equal(again.exists, true);
  });

  test('22: null clears a single value; an empty list clears a list', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await updateProfile(pid, userId, { audience: { primary: 'X' }, goals: ['A'], brand: { primaryColor: '#111111' } });
    await updateProfile(pid, userId, { audience: { primary: null }, goals: [], brand: { primaryColor: null } });
    const p = await getEditableProfile(pid);
    assert.deepEqual([p.audience.primary, p.goals, p.brand.primaryColor], [null, [], null]);
  });

  test('23: Google ids, GBP fields, tokens and Mongo operators cannot be written (UNKNOWN_FIELD) and nothing is saved', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const attempts = [
      { business_location_id: 'evil' }, { business_account_id: 'evil' }, { businessLocationId: 'evil' }, { rating: 5 }, { reviews: [] }, { regularHours: [] },
      { access_token: 'x' }, { refresh_token: 'x' }, { googleConnection: {} }, { media: [] }, { project_id: new mongoose.Types.ObjectId().toString() },
      { $set: { goals: ['x'] } }, JSON.parse('{"__proto__":{"x":1}}'), { 'goals.0': 'x' }, { 'audience.primary': 'x' },
      { overrides: { business_location_id: 'evil' } }, { overrides: { rating: 1 } }, { overrides: { hours: [] } }, { overrides: { $where: 'x' } },
      { brand: { logoUrl: 'https://x.example/logo.png' } }, { audience: { $gt: '' } },
    ];
    for (const body of attempts) {
      const r = await updateProfile(pid, userId, body);
      assert.equal(r.success, false, JSON.stringify(body));
      assert.equal(r.error.code, 'UNKNOWN_FIELD', JSON.stringify(body));
    }
    assert.equal(await SocialBusinessProfile.countDocuments({ project_id: project._id }), 0, 'a rejected request creates nothing');
  });

  test('24: values that look like operators or have the wrong type are rejected, not stored', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const bads = [
      { audience: { primary: { $gt: '' } } }, { goals: { $in: ['a'] } }, { goals: 'one goal' }, { goals: [{ $ne: 1 }] }, { offers: [{ name: { $ne: null } }] },
      { competitors: 'x' }, { overrides: { businessName: ['a'] } }, { additionalInstructions: 42 }, { brand: { primaryColor: { $ne: 1 } } }, 'not an object', [], null,
    ];
    for (const body of bads) {
      const r = await updateProfile(pid, userId, body);
      assert.equal(r.success, false, JSON.stringify(body));
      assert.ok(['INVALID_PROFILE', 'INVALID_BODY', 'UNKNOWN_FIELD'].includes(r.error.code), `${JSON.stringify(body)} -> ${r.error.code}`);
    }
    assert.equal(await SocialBusinessProfile.countDocuments({ project_id: project._id }), 0);
  });

  test('25: size and format limits are enforced server-side', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const rep = (n, s = 'a') => s.repeat(n);
    const invalid = [
      { goals: Array.from({ length: LIMITS.goals.items + 1 }, (_, i) => `goal ${i}`) },
      { goals: [rep(LIMITS.goals.length + 1)] },
      { prohibitedPhrases: Array.from({ length: LIMITS.prohibitedPhrases.items + 1 }, (_, i) => `p${i}`) },
      { contentPillars: Array.from({ length: LIMITS.contentPillars.items + 1 }, (_, i) => `c${i}`) },
      { offers: Array.from({ length: LIMITS.offers.items + 1 }, (_, i) => ({ name: `o${i}` })) },
      { offers: [{ name: '' }] }, { offers: [{ name: 'x', url: 'javascript:alert(1)' }] }, { offers: [{ name: 'x', url: 'https://user:pw@evil.example' }] },
      { offers: [{ name: 'x', extra: 1 }] },
      { competitors: Array.from({ length: LIMITS.competitors.items + 1 }, (_, i) => ({ name: `c${i}` })) },
      { competitors: [{ name: 'x', website: 'ftp://files.example' }] }, { competitors: [{ name: 'x', website: 'nodots' }] },
      { additionalInstructions: rep(LIMITS.additionalInstructions + 1) },
      { audience: { primary: rep(LIMITS.audiencePrimary + 1) } },
      { audience: { secondary: Array.from({ length: LIMITS.secondaryItems + 1 }, (_, i) => `s${i}`) } },
      { brand: { primaryColor: 'red' } }, { brand: { primaryColor: '#12' } }, { brand: { accentColor: 'javascript:1' } },
      { brand: { fontHeading: '<script>' } }, { brand: { fontBody: rep(LIMITS.font + 1) } },
      { overrides: { businessName: rep(LIMITS.overrides.businessName + 1) } }, { overrides: { phone: 'call me' } }, { overrides: { website: 'file:///etc/passwd' } },
      { overrides: { serviceArea: { place: 'x' } } }, { overrides: { serviceArea: Array.from({ length: LIMITS.overrides.serviceAreaItems + 1 }, (_, i) => `p${i}`) } },
      { goals: ['line\u0000break'] }, { overrides: { businessName: 'two\nlines' } },
    ];
    for (const body of invalid) {
      const v = validateProfileUpdate(body);
      assert.ok(v.error, `should reject ${JSON.stringify(body).slice(0, 80)}`);
    }
    assert.ok(validateProfileUpdate({ additionalInstructions: 'multi\nline is fine here' }).set);
    assert.equal(validateProfileUpdate({}).error.code, 'EMPTY_UPDATE');
    assert.equal(validateProfileUpdate({ projectId: 'abc' }).error.code, 'EMPTY_UPDATE', 'projectId alone is not an update');
  });

  test('26: a save never copies Google / project business facts into the document', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedGoogle(project);
    await updateProfile(pid, userId, { goals: ['Grow'], audience: { primary: 'Locals' } });
    const raw = await mongoose.connection.db.collection('socialbusinessprofiles').findOne({ project_id: project._id });
    const keys = Object.keys(raw).sort();
    assert.deepEqual(keys, ['__v', '_id', 'additionalInstructions', 'audience', 'brand', 'businessModel', 'competitors', 'contentPillars', 'createdAt', 'createdBy', 'goals', 'offers', 'overrides', 'project_id', 'prohibitedPhrases', 'services', 'toneOfVoice', 'uniqueSellingPoints', 'updatedAt', 'updatedBy'].sort());
    assert.ok(Object.values(raw.overrides).every((v) => v === null), 'no override is created implicitly from Google data');
    assert.equal(raw.businessModel, null, 'the business model is never guessed');
    const dump = JSON.stringify(raw);
    for (const googleValue of ['Google Name', 'Dentist', '+1 555 0100', '1 Main St', 'loc-222', 'acct-111', 'Verified Name']) {
      assert.equal(dump.includes(googleValue), false, `${googleValue} must not be copied`);
    }
  });

  test('27: saving the Social profile does not touch the GBP collections or the project', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedGoogle(project);
    const before = {
      meta: await BusinessProfileMetadata.findOne({ project_id: project._id }).lean(),
      conn: await GoogleConnection.findOne({ project_id: project._id }).select('status business_location_id updated_at').lean(),
      project: await SeoProject.findById(pid).lean(),
    };
    await updateProfile(pid, userId, { overrides: { businessName: 'Only Social AI', phone: '+1 222 3333' }, goals: ['x'] });
    const after = {
      meta: await BusinessProfileMetadata.findOne({ project_id: project._id }).lean(),
      conn: await GoogleConnection.findOne({ project_id: project._id }).select('status business_location_id updated_at').lean(),
      project: await SeoProject.findById(pid).lean(),
    };
    assert.deepEqual(after, before);
  });

  test('28: two first-time saves at once produce exactly one document and keep both changes', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialBusinessProfile.init();
    const results = await Promise.all([
      updateProfile(pid, userId, { goals: ['from A'] }),
      updateProfile(pid, userId, { contentPillars: ['from B'] }),
    ]);
    assert.ok(results.every((r) => r.success));
    assert.equal(await SocialBusinessProfile.countDocuments({ project_id: project._id }), 1);
    const p = await getEditableProfile(pid);
    assert.deepEqual([p.goals, p.contentPillars], [['from A'], ['from B']]);
  });
});
