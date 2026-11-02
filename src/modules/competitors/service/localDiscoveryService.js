import ProjectCompetitor from '../model/ProjectCompetitor.js';
import CompetitorLocalUsage from '../model/CompetitorLocalUsage.js';
import { normalizeDomainInput } from '../../dataforseo-api/shared/targetDomain.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import { PLACES_ERROR, PlacesError, searchBusinesses, searchPlacesAround } from '../../../services/googlePlacesService.js';
import { DEFAULT_RADIUS_KM, RADII_KM, getLocalConfig } from '../config/localConfig.js';
import { ALLOWED_TYPES, applyCorrection, classifyPlace, suggestCategories } from '../config/localCategories.js';
import { distanceMeters } from './competitorIdentity.js';
import { loadProjectProfile } from './projectProfile.js';
import { ProviderBudgetExceeded, reserveProviderCall } from './enrichmentStore.js';

/**
 * Local Competitors: real businesses around the project's own location, from Google Places (the existing server-side integration and key;
 * the key never leaves the server). A search is ONE explicit user action that makes 1-4 billed Google requests:
 *   - one Nearby Search over the project's Google category types (a hard circle), and
 *   - up to three Text Searches using the project's OWN words for what it is ("eye hospital"), biased to the same circle.
 * Each request is reserved from the project's daily budget BEFORE it is made. Results are filtered by true distance, de-duplicated by
 * Google place, stripped of the project's own business and of permanently closed places, and marked when already in My competitors.
 * Nothing from Google is stored here: the results exist only in this response.
 */

export class LocalSearchError extends Error {
  constructor(code, message, extra = {}) { super(message); this.name = 'LocalSearchError'; this.code = code; Object.assign(this, extra); }
}

/** Google failure -> a safe code (never Google's message or a credential). The raw detail is logged by the Places layer, not returned. */
const PLACES_HTTP = Object.freeze({
  [PLACES_ERROR.NOT_CONFIGURED]: [503, 'Local search is not set up on this server yet.'],
  [PLACES_ERROR.KEY_INVALID]: [503, 'Local search is not available right now.'],
  [PLACES_ERROR.ACCESS_DENIED]: [503, 'Local search is not available right now.'],
  [PLACES_ERROR.BILLING_REQUIRED]: [503, 'Local search is not available right now.'],
  [PLACES_ERROR.RATE_LIMITED]: [429, 'Google is busy. Please try again in a minute.'],
  [PLACES_ERROR.TIMEOUT]: [504, 'Google took too long to answer. Please try again.'],
  [PLACES_ERROR.UNAVAILABLE]: [502, 'Google could not be reached. Please try again.'],
  [PLACES_ERROR.INVALID_REQUEST]: [502, 'Local search could not be completed.'],
  [PLACES_ERROR.BAD_RESPONSE]: [502, 'Google returned an unexpected answer. Please try again.'],
});
export const placesFailure = (err) => {
  const code = err instanceof PlacesError ? err.code : PLACES_ERROR.UNAVAILABLE;
  const [status, message] = PLACES_HTTP[code] ?? PLACES_HTTP[PLACES_ERROR.UNAVAILABLE];
  return new LocalSearchError(code, message, { httpStatus: status });
};

const defaultDeps = () => ({
  config: getLocalConfig(),
  loadProfile: loadProjectProfile,
  searchAround: searchPlacesAround,
  geocode: async (text) => { const [first] = await searchBusinesses(text, '', { maxResults: 1 }); return first && Number.isFinite(first.lat) && Number.isFinite(first.lng) ? { lat: first.lat, lng: first.lng } : null; },
  reserve: (projectId, cap) => reserveProviderCall(projectId, cap, Date.now(), CompetitorLocalUsage),
  findAdded,
  now: () => new Date(),
});

/** Which of these Google places / websites are already in the project's competitors? placeId -> competitor id (by place first, then by website). */
async function findAdded(projectId, places) {
  const ids = places.map((p) => p.placeId);
  const domains = places.map((p) => p.websiteDomain).filter(Boolean);
  if (!ids.length) return new Map();
  const docs = await ProjectCompetitor.find({ project_id: projectId, $or: [{ place_id: { $in: ids } }, { 'branches.place_id': { $in: ids } }, ...(domains.length ? [{ domain: { $in: domains } }] : [])] })
    .select('place_id branches.place_id domain').lean();
  const byPlace = new Map(); const byDomain = new Map();
  for (const d of docs) {
    for (const id of [d.place_id, ...(d.branches ?? []).map((b) => b.place_id)]) if (id) byPlace.set(id, String(d._id));
    if (d.domain) byDomain.set(d.domain, String(d._id));
  }
  return new Map(places.map((p) => [p.placeId, byPlace.get(p.placeId) ?? (p.websiteDomain ? byDomain.get(p.websiteDomain) : null) ?? null]));
}

const parseRadius = (v) => {
  const km = v === undefined || v === null || v === '' ? DEFAULT_RADIUS_KM : Number(v);
  if (!RADII_KM.includes(km)) throw new LocalSearchError('INVALID_RADIUS', `Choose a radius of ${RADII_KM.join(', ')} km.`, { httpStatus: 400 });
  return km;
};

/** What the page needs before the user searches: the radii, the centre (or why there is none), and the suggested categories. No Google request. */
export async function getLocalOptions({ projectId }, deps = {}) {
  const d = { ...defaultDeps(), ...deps };
  const profile = await d.loadProfile(projectId);
  if (!profile) throw new LocalSearchError('PROJECT_UNAVAILABLE', 'This project was not found.', { httpStatus: 404 });
  const suggestion = suggestCategories(profile);
  let centre = null; let issue = null;
  if (profile.coords) centre = { lat: profile.coords.lat, lng: profile.coords.lng, source: 'verified_business' };
  else issue = profile.address ? 'LOCATION_NEEDS_CONFIRMATION' : 'LOCATION_REQUIRED';
  return {
    enabled: d.config.enabled,
    radiiKm: [...RADII_KM], defaultRadiusKm: DEFAULT_RADIUS_KM,
    center: centre, centerIssue: issue, address: profile.address ?? null,
    business: { name: null, city: profile.city ?? null },
    categories: { specificity: suggestion.specificity, queries: suggestion.queries, types: suggestion.types, allowedTypes: [...ALLOWED_TYPES].sort() },
    dailyLimit: d.config.projectDailyPlacesCalls,
  };
}

/**
 * One search. See the module comment. `queries` / `types` are the user's correction of the suggested categories (validated: only allowed
 * types and short text survive). `geocode: true` is the user's confirmation that an address may be looked up when there is no saved position.
 */
export async function searchLocal({ projectId, radiusKm, queries, types, geocode = false, requestId = null }, deps = {}) {
  const d = { ...defaultDeps(), ...deps };
  if (!d.config.enabled) throw new LocalSearchError('LOCAL_DISABLED', 'Local Competitors is switched off on this server.', { httpStatus: 503 });
  const radius = parseRadius(radiusKm);
  const profile = await d.loadProfile(projectId);
  if (!profile) throw new LocalSearchError('PROJECT_UNAVAILABLE', 'This project was not found.', { httpStatus: 404 });
  const mapping = applyCorrection(suggestCategories(profile), { queries, types });
  if (mapping.specificity === 'none') {
    throw new LocalSearchError('CATEGORY_REQUIRED', 'Odito could not tell what kind of business to look for. Enter a category such as “dental clinic” and search again.', { httpStatus: 422 });
  }
  const budget = async () => { try { await d.reserve(projectId, d.config.projectDailyPlacesCalls); } catch (e) { if (e instanceof ProviderBudgetExceeded) throw new LocalSearchError('LOCAL_BUDGET_EXCEEDED', 'This project reached its daily limit of local searches. Try again tomorrow.', { httpStatus: 429 }); throw e; } };

  // The centre (a lookup, when needed and confirmed, is one billed request of its own).
  let center;
  try {
    if (profile.coords) center = { lat: profile.coords.lat, lng: profile.coords.lng, source: 'verified_business' };
    else if (!profile.address) throw new LocalSearchError('LOCATION_REQUIRED', 'Odito does not know where your business is. Verify your business location in your project settings, then search again.', { httpStatus: 422 });
    else if (!geocode) throw new LocalSearchError('LOCATION_NEEDS_CONFIRMATION', 'Your business has an address but no saved map position. Confirm that Odito may look it up to search around it.', { httpStatus: 422, address: profile.address });
    else {
      await budget();
      const found = await d.geocode(profile.address).catch((e) => { throw placesFailure(e); });
      if (!found) throw new LocalSearchError('LOCATION_REQUIRED', 'Google could not find your business address. Verify your business location in your project settings, then search again.', { httpStatus: 422 });
      center = { lat: found.lat, lng: found.lng, source: 'address_geocoded' };
    }
  } catch (err) { if (err instanceof LocalSearchError) throw err; throw placesFailure(err); }

  const radiusMeters = radius * 1000;
  const plan = [
    ...(mapping.types.length ? [{ kind: 'types', args: { types: mapping.types } }] : []),
    ...mapping.queries.map((q) => ({ kind: 'query', args: { query: q } })),
  ];
  const settled = [];
  for (const step of plan) {
    await budget();
    settled.push(await d.searchAround({ lat: center.lat, lng: center.lng, radiusMeters, requestId, ...step.args }).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error })));
  }
  const failures = settled.filter((s) => !s.ok);
  if (failures.length === settled.length) throw placesFailure(failures[0].error);
  if (failures.length) LoggerUtil.warn('Local competitors: some Google requests failed', { projectId: String(projectId), failed: failures.length, of: settled.length, code: failures[0].error?.code ?? null });

  // Merge, then validate by true distance. A place without coordinates cannot be placed, so it is dropped (and counted), not guessed.
  const merged = new Map(); let capped = false; let noCoords = 0; let outside = 0; let closed = 0; let own = 0;
  for (const s of settled) {
    if (!s.ok) continue;
    capped ||= s.value.capped;
    for (const p of s.value.places) if (!merged.has(p.placeId)) merged.set(p.placeId, p);
  }
  const results = [];
  for (const p of merged.values()) {
    if (p.lat === null || p.lng === null) { noCoords += 1; continue; }
    const distance = distanceMeters(center, { lat: p.lat, lng: p.lng });
    if (distance === null || distance > radiusMeters) { outside += 1; continue; }
    if (p.businessStatus === 'CLOSED_PERMANENTLY') { closed += 1; continue; }
    const websiteDomain = p.website ? normalizeDomainInput(p.website) : null;
    if ((profile.ownPlaceId && p.placeId === profile.ownPlaceId) || (websiteDomain && profile.ownDomain && websiteDomain === profile.ownDomain)) { own += 1; continue; }
    results.push({ ...p, websiteDomain, distanceMeters: distance, relevance: classifyPlace(p, mapping) });
  }
  const added = await d.findAdded(projectId, results);
  const out = results
    .map((r) => ({ ...r, addedCompetitorId: added.get(r.placeId) ?? null }))
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
    .slice(0, d.config.maxResults);

  const warnings = [];
  if (capped) warnings.push('RESULT_CAP');
  if (failures.length) warnings.push('SOME_SEARCHES_FAILED');
  if (mapping.specificity === 'broad') warnings.push('BROAD_CATEGORY');
  return {
    center, radiusKm: radius,
    categories: { specificity: mapping.specificity, queries: mapping.queries, types: mapping.types, corrected: Boolean(mapping.corrected) },
    results: out,
    meta: { googleRequests: plan.length + (center.source === 'address_geocoded' ? 1 : 0), dropped: { noCoordinates: noCoords, outsideRadius: outside, permanentlyClosed: closed, yourOwnBusiness: own }, warnings },
  };
}
