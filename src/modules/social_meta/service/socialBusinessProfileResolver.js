import SeoProject from '../../app_user/model/SeoProject.js';
import GoogleConnection from '../../app_user/model/GoogleConnection.js';
import BusinessProfileMetadata from '../../app_user/model/BusinessProfileMetadata.js';
import BusinessProfileMedia from '../../app_user/model/BusinessProfileMedia.js';
import { resolveProjectBrandAssets } from '../../../services/brandAssetService.js';
import { getActiveFacebookAccount, getActiveInstagramAccount } from './facebookAccountService.js';
import { findProfile, toEditableProfile } from './socialBusinessProfileService.js';
import { listActiveProducts } from './socialProductService.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * socialBusinessProfileResolver — builds the ONE normalized business profile
 * Social Media AI works from, at request time, out of data Odito already owns.
 * Nothing it returns is persisted as a whole.
 *
 * Layer 1 (read, never copied):
 *   BusinessProfileMetadata / BusinessProfileMedia (Google Business Profile,
 *   synced by the existing GBP flow), SeoProject (+ verified_business,
 *   extracted_metadata), SocialAccount (connected Facebook / Instagram),
 *   brandAssetService (logo).
 * Layer 2 (user-entered): SocialBusinessProfile — business model, services, strategy, the Brand Kit
 *   (colours, fonts, identity, messaging, uploaded logo) and the explicit `overrides`; plus the Product
 *   Catalog (SocialProduct), which has no automatic source at all: Odito never invents products from
 *   Google or the website.
 *
 * Every business FACT comes back as { value, source, lastUpdated[, detail] }
 * so the UI can show where it came from. Precedence (first filled value wins):
 *   1. social_override           (user typed it for Social AI)
 *   2. google_business_profile   (BusinessProfileMetadata)
 *   3. verified_business         (Places snapshot taken at onboarding)
 *   4. seo_project               (SeoProject fields)
 *   5. website_extraction        (SeoProject.extracted_metadata)
 * with a per-field order where the spec differs (see each field below). A value
 * nobody has is { value: null, source: 'unavailable' } — never invented.
 *
 * When a user override WINS over a lower source that also has a value, the fact carries
 * `underlying: { value, source }` — what Social AI would use without the override — so the UI can say
 * "you changed this; Google says X". The override never touches the underlying data.
 *
 * Google data is used only while the project's Google connection could still
 * own it: an active or expired (reconnectable) connection with a selected
 * location that is the SAME location the metadata was synced from. A revoked
 * or missing connection, or a location change that has not been re-synced yet,
 * makes the Google layer unavailable rather than showing another business.
 *
 * Security: GoogleConnection is read with an explicit field list that excludes
 * the token fields, and no Google account/location id is returned.
 */

/** A Google sync older than this is reported as 'stale'. Product-tunable; used only for the freshness label. */
export const GBP_STALE_AFTER_DAYS = 7;
const BRAND_RESOLVE_TIMEOUT_MS = 6000;
const PHOTO_LIMIT = 12;
const DAY_MS = 24 * 60 * 60 * 1000;

export const SOURCES = Object.freeze({
  OVERRIDE: 'social_override',
  GOOGLE: 'google_business_profile',
  VERIFIED: 'verified_business',
  PROJECT: 'seo_project',
  WEBSITE: 'website_extraction',
  UNAVAILABLE: 'unavailable',
});

const iso = (d) => (d ? new Date(d).toISOString() : null);

function isFilled(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}

const field = (value, source, lastUpdated = null, detail = null) => ({
  value,
  source,
  lastUpdated: iso(lastUpdated),
  ...(detail ? { detail } : {}),
});
const unavailable = (detail = null) => field(null, SOURCES.UNAVAILABLE, null, detail);

/** First candidate with a real value wins. Candidates: { value, source, at, detail }. */
function pick(candidates, unavailableDetail = null) {
  for (let i = 0; i < candidates.length; i += 1) {
    const c = candidates[i];
    if (!isFilled(c.value)) continue;
    const fact = field(c.value, c.source, c.at ?? null, c.detail ?? null);
    if (c.source === SOURCES.OVERRIDE) {
      const lower = candidates.slice(i + 1).find((x) => isFilled(x.value));
      if (lower) fact.underlying = { value: lower.value, source: lower.source };
    }
    return fact;
  }
  return unavailable(unavailableDetail);
}

const trimmed = (v) => (typeof v === 'string' ? v.trim() : v);

async function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// ── Google layer ────────────────────────────────────────────────────────────

/** Connection fields we may read: NO refresh_token / access_token. */
const CONNECTION_SAFE_FIELDS = 'status service_type business_account_id business_location_id last_sync_at google_email';

function describeGoogle(connection, metadata, now) {
  const serviceEnabled = !!connection?.service_type?.includes('business_profile');
  const locationSelected = !!(connection?.business_account_id && connection?.business_location_id);
  const connectionStatus = connection ? connection.status : 'not_connected';
  // metadata belongs to the CURRENT selected location only
  const locationMatches = !!metadata && locationSelected && metadata.business_location_id === connection.business_location_id;
  const reconnectable = connectionStatus === 'active' || connectionStatus === 'expired';
  const usable = !!(metadata && reconnectable && serviceEnabled && locationSelected && locationMatches);

  const detailsSyncedAt = metadata?.details_last_synced_at || null;
  const metadataSyncedAt = metadata?.metadata_last_synced_at || null;
  const reviewsSyncedAt = metadata?.reviews_last_synced_at || null;
  const connectionLastSyncAt = connection?.last_sync_at || null;
  const newest = [detailsSyncedAt, metadataSyncedAt].filter(Boolean).map((d) => new Date(d).getTime());
  let status = 'unknown';
  if (usable && newest.length) {
    status = (now.getTime() - Math.max(...newest)) > GBP_STALE_AFTER_DAYS * DAY_MS ? 'stale' : 'fresh';
  }

  return {
    usable,
    googleStatus: {
      connected: connectionStatus === 'active',
      connectionStatus,
      serviceEnabled,
      locationSelected,
      hasSyncedData: !!metadata,
      // data synced for a previously selected location that has not been re-synced since the change
      dataMatchesSelectedLocation: metadata ? locationMatches : null,
      googleEmail: connection?.google_email || null,
      lastSyncAt: iso(connectionLastSyncAt),
    },
    freshness: {
      status,
      staleAfterDays: GBP_STALE_AFTER_DAYS,
      metadataSyncedAt: iso(metadataSyncedAt),
      detailsSyncedAt: iso(detailsSyncedAt),
      reviewsSyncedAt: iso(reviewsSyncedAt),
      connectionLastSyncAt: iso(connectionLastSyncAt),
    },
  };
}

function mediaItem(m) {
  return {
    category: m.category,
    format: m.media_format,
    url: m.google_url || m.thumbnail_url || null,
    thumbnailUrl: m.thumbnail_url || null,
    width: m.width_px || null,
    height: m.height_px || null,
    isCustomerMedia: !!m.is_customer_media,
  };
}

const BRAND_SOURCE_TO_SOURCE = { google_logo: SOURCES.GOOGLE, website_logo: SOURCES.WEBSITE, website_favicon: SOURCES.WEBSITE };

/**
 * Logo precedence: the logo the user uploaded -> Google logo -> website logo / favicon (the shared brandAssetService
 * order, unchanged) -> unavailable. The uploaded logo is a stored reference (no network), so it also applies when a
 * caller skipped logo resolution because it only needs the facts.
 */
async function resolveLogo(project, brandResolver, userLogo) {
  if (userLogo?.url) return field(userLogo.url, SOURCES.OVERRIDE, userLogo.updatedAt || null, 'user_upload');
  try {
    const asset = await withTimeout(brandResolver(project), BRAND_RESOLVE_TIMEOUT_MS);
    const source = BRAND_SOURCE_TO_SOURCE[asset?.source];
    if (!asset?.brandLogo || !source) return unavailable(asset?.fallbackType || 'no_logo_found');
    return field(asset.brandLogo, source, null, asset.fallbackType);
  } catch (error) {
    LoggerUtil.warn('[SOCIAL_BUSINESS_PROFILE] Logo resolution failed', { message: error.message });
    return unavailable(error.message === 'timeout' ? 'logo_resolution_timed_out' : 'logo_resolution_failed');
  }
}

function socialBlock(facebook, instagram) {
  return {
    facebook: facebook
      ? { connected: true, name: facebook.platformAccountName || null, category: facebook.metadata?.category || null, picture: facebook.metadata?.picture || null }
      : { connected: false },
    instagram: instagram
      ? { connected: true, username: instagram.metadata?.username || instagram.platformAccountName || null, picture: instagram.metadata?.profilePicture || null }
      : { connected: false },
  };
}

// ── main entry ──────────────────────────────────────────────────────────────

/**
 * @param {string} projectId  already authorised by validateProjectAccess()
 * @param {object} [options]
 * @param {Date}   [options.now]
 * @param {Function} [options.brandResolver]  defaults to the shared brandAssetService resolver
 * @param {boolean}  [options.includeLogo=true]  false skips logo resolution entirely
 * @returns {Promise<{ resolvedProfile: object, editableProfile: object, googleStatus: object } | null>}
 *          null when the project does not exist
 */
export async function resolveSocialBusinessProfile(projectId, { now = new Date(), brandResolver = resolveProjectBrandAssets, includeLogo = true } = {}) {
  const [project, metadata, connection, profileDoc, facebook, instagram, activeProducts] = await Promise.all([
    SeoProject.findOne({ _id: projectId, is_deleted: { $ne: true } }).lean(),
    BusinessProfileMetadata.findOne({ project_id: projectId }).lean(),
    GoogleConnection.findOne({ project_id: projectId, purpose: 'business_profile' }).select(CONNECTION_SAFE_FIELDS).lean(),
    findProfile(projectId),
    getActiveFacebookAccount(projectId).catch(() => null),
    getActiveInstagramAccount(projectId).catch(() => null),
    listActiveProducts(projectId),
  ]);
  if (!project) return null;

  const editable = toEditableProfile(profileDoc);
  const ov = editable.overrides;
  const google = describeGoogle(connection, metadata, now);
  const g = google.usable ? metadata : null; // Google layer, or nothing
  const gMeta = g?.metadata_last_synced_at || null;
  const gDetails = g?.details_last_synced_at || g?.metadata_last_synced_at || null;
  const vb = project.verified_business || {};
  const vbAt = vb.verifiedAt || null;
  const ex = project.extracted_metadata || {};
  const exAt = ex.extracted_at || null;
  const projectAt = project.updated_at || null;
  const overrideAt = profileDoc?.updatedAt || null;

  const O = (value) => ({ value: trimmed(value), source: SOURCES.OVERRIDE, at: overrideAt });
  const G = (value, at = gMeta, detail = null) => ({ value: trimmed(value), source: SOURCES.GOOGLE, at, detail });
  const V = (value) => ({ value: trimmed(value), source: SOURCES.VERIFIED, at: vbAt });
  const P = (value) => ({ value: trimmed(value), source: SOURCES.PROJECT, at: projectAt });
  const W = (value) => ({ value: trimmed(value), source: SOURCES.WEBSITE, at: exAt });

  const name = pick([O(ov.businessName), G(g?.business_name), V(vb.name), P(project.project_name)]);
  const description = pick([O(ov.description), G(g?.description, gDetails), W(ex.description), P(project.description)]);
  const category = pick([
    O(ov.category),
    G(g?.category),
    G(g?.secondary_categories?.[0], gDetails, 'secondary_category'),
    P(project.industry),
    P(project.business_type),
  ]);
  const phone = pick([O(ov.phone), G(g?.phone), V(vb.phone), W(ex.contact_info?.phone)]);
  const website = pick([O(ov.website), G(g?.website), V(vb.website), P(project.main_url)]);
  const address = pick([O(ov.address), G(g?.address), V(vb.address), P(project.location), W(ex.contact_info?.address)]);

  // Structured location: Google's metadata keeps only the street lines, so city / region / country come from
  // the Places snapshot and the project. Postcode is stored nowhere, so it is reported as unavailable.
  const city = pick([O(ov.city), V(vb.city)]);
  const region = pick([O(ov.region), V(vb.state)]);
  const postalCode = pick([O(ov.postalCode)], 'not_stored');
  const country = pick([O(ov.country), V(vb.country), { ...P(project.country), detail: 'iso_code' }]);
  const countryCode = pick([V(vb.countryCode), P(project.country)]);

  // latitude / longitude are taken as a PAIR from one source so they can never come from two different places.
  const pairs = [
    { lat: g?.latitude, lng: g?.longitude, source: SOURCES.GOOGLE, at: gDetails, detail: null },
    { lat: g?.geocoded_latitude, lng: g?.geocoded_longitude, source: SOURCES.GOOGLE, at: g?.geocoded_at || gDetails, detail: 'geocoded_from_address' },
    { lat: vb.location?.lat, lng: vb.location?.lng, source: SOURCES.VERIFIED, at: vbAt, detail: null },
  ];
  const coords = pairs.find((p) => typeof p.lat === 'number' && typeof p.lng === 'number');
  const latitude = coords ? field(coords.lat, coords.source, coords.at, coords.detail) : unavailable();
  const longitude = coords ? field(coords.lng, coords.source, coords.at, coords.detail) : unavailable();

  const serviceArea = pick([O(ov.serviceArea), G(g?.service_area, gDetails)]);
  const regular = g && isFilled(g.regular_hours) ? field(g.regular_hours, SOURCES.GOOGLE, gDetails) : unavailable();
  const special = g && isFilled(g.special_hours) ? field(g.special_hours, SOURCES.GOOGLE, gDetails) : unavailable();
  const mapsUri = g?.maps_uri ? field(g.maps_uri, SOURCES.GOOGLE, gDetails) : unavailable();
  const reviewUri = g?.new_review_uri ? field(g.new_review_uri, SOURCES.GOOGLE, gDetails) : unavailable();
  const secondaryCategories = pick([O(ov.secondaryCategories), G(g?.secondary_categories, gDetails)]);

  // Rating / review count only exist when Google allowed reviews access (reviews_capability === 'available').
  const reviewsOk = g?.reviews_capability?.status === 'available';
  const rating = reviewsOk && typeof g.average_rating === 'number' ? field(g.average_rating, SOURCES.GOOGLE, g.reviews_last_synced_at) : unavailable(g ? (g.reviews_capability?.status || 'unknown') : 'no_google_business_profile');
  const reviewCount = reviewsOk && typeof g.total_review_count === 'number' ? field(g.total_review_count, SOURCES.GOOGLE, g.reviews_last_synced_at) : unavailable(g ? (g.reviews_capability?.status || 'unknown') : 'no_google_business_profile');

  // Media: logo through the shared resolver (never a second resolver); cover / photos from synced GBP media.
  const [logo, coverByCategory, photoPage] = await Promise.all([
    // includeLogo:false is for callers that only need the business FACTS (e.g. AI-strategy change detection): the
    // logo resolver may fetch the website, which a cheap repeated read must never trigger.
    includeLogo || editable.brand.logo ? resolveLogo(project, brandResolver, editable.brand.logo) : Promise.resolve(unavailable('skipped')),
    g ? BusinessProfileMedia.getPrimaryByCategory(project._id, ['COVER']) : Promise.resolve({}),
    g ? BusinessProfileMedia.getPaginated(project._id, { page: 1, limit: PHOTO_LIMIT }) : Promise.resolve({ media: [] }),
  ]);
  const cover = coverByCategory?.COVER ? field(mediaItem(coverByCategory.COVER), SOURCES.GOOGLE, coverByCategory.COVER.last_seen_at) : unavailable(g ? 'no_cover_photo' : 'no_google_business_profile');
  const photos = photoPage.media?.length ? field(photoPage.media.map(mediaItem), SOURCES.GOOGLE, photoPage.media[0].last_seen_at) : unavailable(g ? 'no_synced_photos' : 'no_google_business_profile');

  // The business model is user-entered only (never guessed from Google, the website or the category).
  const businessModel = pick([O(editable.businessModel)]);
  const activeServices = editable.services.filter((svc) => svc.status === 'active');
  // The logo has one resolved home (`media.logo`); the rest of the Brand Kit is returned as `brand`.
  const { logo: _userLogo, ...brandValues } = editable.brand;

  const business = {
    name, description, category, secondaryCategories, phone, website, businessModel,
    language: pick([P(project.language)]),
    location: { address, city, region, postalCode, country, countryCode, latitude, longitude },
    serviceArea,
    hours: { regular, special },
    mapsUri, reviewUri, rating, reviewCount,
  };

  const resolvedProfile = {
    projectId: String(project._id),
    business,
    media: {
      logo, cover, photos,
      // Google-hosted media URLs can expire; they are re-read on every sync and are not copied into Odito storage.
      googleUrlsMayExpire: true,
    },
    social: socialBlock(facebook, instagram),
    strategy: {
      audience: editable.audience,
      toneOfVoice: editable.toneOfVoice,
      goals: editable.goals,
      uniqueSellingPoints: editable.uniqueSellingPoints,
      offers: editable.offers,
      competitors: editable.competitors,
      contentPillars: editable.contentPillars,
      prohibitedPhrases: editable.prohibitedPhrases,
      additionalInstructions: editable.additionalInstructions,
    },
    brand: brandValues,
    // What the business offers. Both are user-entered; only ACTIVE entries are part of the profile the AI sees.
    services: activeServices,
    products: activeProducts,
    meta: {
      hasGoogleBusinessProfile: google.usable,
      googleConnected: google.googleStatus.connected,
      lastGoogleSyncAt: iso(g?.metadata_last_synced_at || connection?.last_sync_at || null),
      freshness: google.freshness,
      catalog: { businessModel: editable.businessModel, serviceCount: activeServices.length, productCount: activeProducts.length },
      sources: {
        businessModel: businessModel.source,
        name: name.source, description: description.source, category: category.source, phone: phone.source, website: website.source,
        address: address.source, city: city.source, region: region.source, country: country.source,
        coordinates: latitude.source, serviceArea: serviceArea.source, hours: regular.source, rating: rating.source, logo: logo.source,
      },
    },
  };

  return { resolvedProfile, editableProfile: editable, googleStatus: google.googleStatus };
}

export default { resolveSocialBusinessProfile, GBP_STALE_AFTER_DAYS, SOURCES };
