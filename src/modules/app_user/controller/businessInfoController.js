import SeoProject from '../model/SeoProject.js';
import BusinessProfileMetadata from '../model/BusinessProfileMetadata.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import { ValidationFailure } from '../../dataforseo-api/shared/targetDomain.js';
import { isIndustryValue } from '../../../config/industries.js';
import { syncTrackedLocation } from '../../keyword_research/service/trackedLocationSync.js';
import { PLACES_ERROR, PlacesError, autocompletePlaces, getPlaceForLocation } from '../../../services/googlePlacesService.js';

/**
 * Project Settings → Business Information. Runs AFTER auth + validateProjectAccess(): `req.project` is a project the user owns, and the
 * project id never comes from the body. The body can only carry the fields named here; ownership / billing / status fields are not
 * reachable through it, and nothing in it is spread into the update.
 *
 * "Verified" is deliberately narrow. Saving a location sets `verified_business.confirmedByUser` ("the customer says the business is here").
 * That is NOT Google Business Profile ownership: the connection is read from BusinessProfileMetadata and reported separately.
 */

const bad = (field, message) => new ValidationFailure(field, message);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Text field: undefined = leave alone; null / '' = clear; otherwise trimmed and length-checked. */
function text(body, key, label, max) {
  if (!(key in body)) return undefined;
  const v = body[key];
  if (v === null || v === '') return null;
  if (typeof v !== 'string') throw bad(key, `${label} must be text.`);
  const t = v.trim().replace(/\s+/g, ' ');
  if (t.length > max) throw bad(key, `${label} cannot be longer than ${max} characters.`);
  return t || null;
}

function list(body, key, label, maxItems, maxLen) {
  if (!(key in body)) return undefined;
  const v = body[key];
  if (v === null) return [];
  if (!Array.isArray(v)) throw bad(key, `${label} must be a list.`);
  const out = [];
  for (const raw of v) {
    if (typeof raw !== 'string') throw bad(key, `${label} must only contain text.`);
    const t = raw.trim().replace(/\s+/g, ' ');
    if (!t) continue;
    if (t.length > maxLen) throw bad(key, `Each item in ${label} can be at most ${maxLen} characters.`);
    if (!out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  if (out.length > maxItems) throw bad(key, `${label} can have at most ${maxItems} items.`);
  return out;
}

/** Pure: the identity part of the body -> a Mongo $set map (dotted paths). Only keys that were sent are present. */
export function parseIdentity(raw) {
  if (!isObj(raw)) throw bad('identity', 'identity must be an object.');
  const set = {};
  const put = (path, v) => { if (v !== undefined) set[path] = v; };
  put('business_name', text(raw, 'businessName', 'Business name', 200));
  if ('industry' in raw) {
    if (raw.industry === null || raw.industry === '') set.industry = null;
    else if (!isIndustryValue(raw.industry)) throw bad('industry', 'Choose an industry from the list.');
    else set.industry = raw.industry;
  }
  put('sub_industry', text(raw, 'subIndustry', 'Sub-industry', 100));
  put('business_type', text(raw, 'businessType', 'Business type', 200));
  put('primary_category', text(raw, 'primaryCategory', 'Primary category', 100));
  put('secondary_categories', list(raw, 'secondaryCategories', 'Secondary categories', 10, 100));
  const services = list(raw, 'services', 'Services', 30, 100);
  if (services !== undefined) { set['visibility_profile.services'] = services; set['visibility_profile.updated_at'] = new Date(); }
  return set;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Pure: the location part of the body -> a clean object. Throws on anything unsafe. Does not look at the database. */
export function parseLocation(raw) {
  if (!isObj(raw)) throw bad('location', 'location must be an object.');
  // Nothing is saved as the business's place unless the user said so, in this request.
  if (raw.confirmed !== true) throw bad('confirmed', 'Please confirm the business location before saving it.');
  const lat = num(raw.lat); const lng = num(raw.lng);
  if (lat === null || lng === null) throw bad('lat', 'The location needs a latitude and a longitude.');
  if (lat < -90 || lat > 90) throw bad('lat', 'Latitude must be between -90 and 90.');
  if (lng < -180 || lng > 180) throw bad('lng', 'Longitude must be between -180 and 180.');
  if (lat === 0 && lng === 0) throw bad('lat', 'That location (0, 0) is not a real business location.');
  const address = text(raw, 'address', 'Address', 300);
  if (!address) throw bad('address', 'The location needs an address.');
  let countryCode = text(raw, 'countryCode', 'Country code', 2);
  if (countryCode && !/^[A-Za-z]{2}$/.test(countryCode)) throw bad('countryCode', 'Country code must be two letters, for example US.');
  countryCode = countryCode ? countryCode.toUpperCase() : null;
  let placeId = text(raw, 'placeId', 'Place ID', 300);
  if (placeId && !/^[A-Za-z0-9_-]{10,300}$/.test(placeId)) throw bad('placeId', 'That Google Place ID is not valid.');
  placeId = placeId || null;
  return {
    placeId,
    name: text(raw, 'name', 'Name', 200) ?? null,
    address,
    addressLine: text(raw, 'addressLine', 'Address line', 200) ?? null,
    city: text(raw, 'city', 'City', 100) ?? null,
    state: text(raw, 'state', 'State', 100) ?? null,
    country: text(raw, 'country', 'Country', 100) ?? null,
    countryCode,
    postalCode: text(raw, 'postalCode', 'Postal code', 20) ?? null,
    website: text(raw, 'website', 'Website', 300) ?? null,
    lat, lng,
    coordinatesAdjusted: raw.coordinatesAdjusted === true,
  };
}

/**
 * Pure: the verified_business subdocument to store. Details of the SAME listing that the new input leaves out are kept (an autocomplete
 * result that has no postal code must not erase one we already know); a DIFFERENT place starts clean, so another listing's phone or
 * rating is never carried over to the new address.
 */
export function buildVerifiedBusiness(existing, loc, now = new Date()) {
  const same = Boolean(loc.placeId && existing?.placeId && loc.placeId === existing.placeId);
  const keep = (key) => (loc[key] ?? (same ? existing[key] : null)) ?? undefined;
  const vb = {
    address: loc.address,
    location: { lat: loc.lat, lng: loc.lng },
    confirmedByUser: true,
    confirmedAt: now,
    coordinatesAdjusted: loc.coordinatesAdjusted,
  };
  if (loc.placeId) { vb.placeId = loc.placeId; vb.verifiedAt = now; }
  for (const k of ['name', 'addressLine', 'city', 'state', 'country', 'countryCode', 'postalCode', 'website']) { const v = keep(k); if (v !== undefined) vb[k] = v; }
  if (same) { for (const k of ['phone', 'rating']) if (existing[k] !== undefined && existing[k] !== null) vb[k] = existing[k]; }
  return vb;
}

const finiteLoc = (vb) => Number.isFinite(vb?.location?.lat) && Number.isFinite(vb?.location?.lng) && !(vb.location.lat === 0 && vb.location.lng === 0);

/** Pure: project (+ whether a Google Business Profile is connected) -> what the browser gets. */
export function toBusinessInfoDto(project, gbpConnected = false) {
  const vb = project.verified_business ?? {};
  const hasLocation = finiteLoc(vb);
  const status = hasLocation ? (vb.confirmedByUser ? 'confirmed' : 'unconfirmed') : 'missing';
  return {
    identity: {
      businessName: project.business_name ?? vb.name ?? null,
      website: project.main_url ?? null,
      industry: project.industry ?? null,
      subIndustry: project.sub_industry ?? null,
      businessType: project.business_type ?? null,
      primaryCategory: project.primary_category ?? null,
      secondaryCategories: project.secondary_categories ?? [],
      services: project.visibility_profile?.services ?? [],
    },
    location: hasLocation || vb.address ? {
      placeId: vb.placeId ?? null, name: vb.name ?? null, address: vb.address ?? null, addressLine: vb.addressLine ?? null,
      city: vb.city ?? null, state: vb.state ?? null, country: vb.country ?? null, countryCode: vb.countryCode ?? null, postalCode: vb.postalCode ?? null,
      lat: hasLocation ? vb.location.lat : null, lng: hasLocation ? vb.location.lng : null,
    } : null,
    verification: {
      // missing: no coordinates | unconfirmed: coordinates exist (from onboarding) but the user never confirmed them | confirmed: the user did
      status,
      source: !hasLocation ? null : vb.placeId ? 'google_places' : 'manual',
      confirmedAt: vb.confirmedAt ?? null,
      coordinatesAdjusted: Boolean(vb.confirmedByUser && vb.coordinatesAdjusted),
      updatedAt: vb.confirmedAt ?? vb.verifiedAt ?? null,
      // Separate on purpose: choosing a place never makes this true.
      googleBusinessProfileConnected: Boolean(gbpConnected),
    },
    targetLocation: { city: project.target_city ?? null, state: project.target_state ?? null },
  };
}

const MANUAL = ' You can still enter the address and coordinates yourself.';
const PLACES_HTTP = Object.freeze({
  [PLACES_ERROR.NOT_CONFIGURED]: [503, 'Address search is not set up on this server: no Google Places key is configured.' + MANUAL],
  [PLACES_ERROR.KEY_INVALID]: [503, 'Google rejected the Places key configured on this server (invalid key).' + MANUAL],
  [PLACES_ERROR.ACCESS_DENIED]: [503, 'Google refused the address search for this server’s key.' + MANUAL],
  [PLACES_ERROR.BILLING_REQUIRED]: [503, 'Billing is not enabled on the Google Cloud project behind this server’s Places key.' + MANUAL],
  [PLACES_ERROR.RATE_LIMITED]: [429, 'Google’s address search quota is used up or Google is busy. Please try again in a minute.'],
  [PLACES_ERROR.TIMEOUT]: [504, 'Google took too long to answer. Please try again.'],
  [PLACES_ERROR.UNAVAILABLE]: [502, 'Google could not be reached. Please try again.'],
  [PLACES_ERROR.INVALID_REQUEST]: [400, 'That search could not be completed. Check what you typed and try again.'],
  [PLACES_ERROR.BAD_RESPONSE]: [502, 'Google returned an unexpected answer. Please try again.'],
});
// ACCESS_DENIED says which of the two real causes it is, so the person fixing it knows where to look.
const DENIED_HINT = Object.freeze({
  api_not_enabled: 'Google refused the address search: "Places API (New)" is not enabled for the Google Cloud project behind this server’s key.' + MANUAL,
  key_restricted: 'Google refused the address search: this server’s key has an API or network restriction that blocks Places API (New).' + MANUAL,
});

function sendError(res, err, req) {
  if (err instanceof ValidationFailure) return res.status(400).json({ success: false, code: err.code, field: err.field, message: err.message });
  if (err instanceof PlacesError) {
    const [status, base] = PLACES_HTTP[err.code] ?? [502, 'Address search failed. Please try again.'];
    const message = err.code === PLACES_ERROR.ACCESS_DENIED ? (DENIED_HINT[err.hint] ?? base) : base;
    // Upstream status / reason stay in the log; the browser gets a plain message.
    LoggerUtil.warn('Business info: Google Places call failed', { code: err.code, hint: err.hint ?? null, upstreamStatus: err.upstreamStatus, upstreamReason: err.upstreamReason, projectId: String(req.project?._id || '') });
    return res.status(status).json({ success: false, code: err.code, hint: err.hint ?? undefined, message });
  }
  LoggerUtil.error('Business info: unexpected error', err, { userId: String(req.user?._id || ''), projectId: String(req.project?._id || '') });
  return res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' });
}
const ok = (res, data) => { res.set('Cache-Control', 'no-store'); return res.status(200).json({ success: true, data }); };

const gbpConnected = async (projectId) => Boolean(await BusinessProfileMetadata.exists({ project_id: projectId }));

/** GET /projects/:projectId/business-info */
export async function getBusinessInfo(req, res) {
  try {
    const project = await SeoProject.findById(req.project._id).lean();
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Project not found.' });
    return ok(res, toBusinessInfoDto(project, await gbpConnected(project._id)));
  } catch (err) { return sendError(res, err, req); }
}

/** PUT /projects/:projectId/business-info  { identity?: {...}, location?: {..., confirmed: true} }. Anything not sent is left untouched. */
export async function saveBusinessInfo(req, res) {
  try {
    const body = isObj(req.body) ? req.body : {};
    if (!('identity' in body) && !('location' in body)) throw bad('body', 'Send identity and/or location to save.');
    const set = 'identity' in body ? parseIdentity(body.identity) : {};
    const project = await SeoProject.findById(req.project._id).select('verified_business country').lean();
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Project not found.' });

    if ('location' in body) {
      const loc = parseLocation(body.location);
      set.verified_business = buildVerifiedBusiness(project.verified_business, loc);
      set.location_source = loc.placeId ? 'google_places' : 'user_entered';
      // Same rule as project creation: the top-level country follows the address only while it is still unset.
      if (!project.country && loc.countryCode) set.country = loc.countryCode;
    }
    if (Object.keys(set).length === 0) throw bad('body', 'There is nothing to change.');

    // Every key in `set` was built above from a fixed list. The client's body is never spread in.
    await SeoProject.updateOne({ _id: req.project._id }, { $set: set }, { runValidators: true });
    const saved = await SeoProject.findById(req.project._id).lean();
    LoggerUtil.info('Business info saved', { projectId: String(req.project._id), userId: String(req.user?._id || ''), fields: Object.keys(set) });
    const dto = toBusinessInfoDto(saved, await gbpConnected(saved._id));
    // A saved location is where keywords are tracked from: bring the tracked-keyword location along (best effort; the save already succeeded).
    if ('location' in body) dto.trackingLocation = await syncTrackedLocation(req.project._id, req.user._id);
    return ok(res, dto);
  } catch (err) { return sendError(res, err, req); }
}

/** POST /projects/:projectId/business-info/places/autocomplete  { input, sessionToken } -> suggestions only (no coordinates, nothing stored). */
export async function placeSuggestions(req, res) {
  try {
    const { input, sessionToken } = isObj(req.body) ? req.body : {};
    const region = typeof req.project?.country === 'string' ? req.project.country : null;
    return ok(res, { suggestions: await autocompletePlaces({ input, sessionToken, regionCode: region }) });
  } catch (err) { return sendError(res, err, req); }
}

/** POST /projects/:projectId/business-info/places/details  { placeId, sessionToken } -> the picked place. Nothing is saved: the user confirms first. */
export async function placeDetails(req, res) {
  try {
    const { placeId, sessionToken } = isObj(req.body) ? req.body : {};
    return ok(res, { place: await getPlaceForLocation({ placeId, sessionToken }) });
  } catch (err) { return sendError(res, err, req); }
}
