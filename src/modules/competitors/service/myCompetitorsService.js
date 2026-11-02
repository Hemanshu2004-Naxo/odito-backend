import ProjectCompetitor, { MY_COMPETITORS_MAX } from '../model/ProjectCompetitor.js';
import { ValidationFailure } from '../../dataforseo-api/shared/targetDomain.js';
import { diffIndexes } from '../model/indexSpec.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import { getEnrichmentConfig } from '../config/enrichmentConfig.js';
import { toEnrichmentDto } from './enrichmentMetrics.js';
import { markNoWebsite, queueEnrichment } from './enrichmentStore.js';
import { matchKey } from './competitorIdentity.js';
import { requestAssessments } from './assessmentStore.js';

/**
 * A competitor the user SAVED gets its business relevance assessed too (one public homepage, no provider money). Best effort: a failure
 * here is logged and never stops the competitor from being saved.
 */
async function queueRelevance(projectId, domain) {
  if (!domain) return;
  try { await requestAssessments({ projectId, domains: [domain] }); }
  catch (err) { LoggerUtil.warn('My competitors: could not queue the relevance assessment', { projectId: String(projectId), code: err?.code ?? null }); }
}

/**
 * My Competitors: the competitors a user chose for one project. Every query is scoped by `project_id`; the caller has already proved
 * (validateProjectAccess) that the user owns that project. Nothing here talks to a provider, so nothing here costs money.
 *
 * Capacity is enforced by the database, not by counting: each entry takes one `slot` (0..MY_COMPETITORS_MAX-1) under a unique
 * (project_id, slot) index. create() picks a free slot and inserts; if a concurrent add took that slot first the insert fails on
 * the slot index and create() looks again. A project therefore cannot exceed MY_COMPETITORS_MAX entries, a failed insert holds no slot,
 * and a removed entry frees its slot. Works on a standalone MongoDB (no transactions, no replica set).
 *
 * Failure kinds stay distinct: COMPETITOR_EXISTS (same website / place already there, 409), COMPETITOR_LIMIT_REACHED (full, 409),
 * COMPETITOR_BUSY (too many simultaneous adds for this project, 503, safe to retry).
 */
export { MY_COMPETITORS_MAX };

const SLOT_ATTEMPTS = 12;

/** Google allows caching a place's latitude / longitude for 30 days; after that they are not used (nor shown). */
export const COORDS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const branchDto = (b, now) => {
  const fresh = b.coords_fetched_at && now - new Date(b.coords_fetched_at).getTime() <= COORDS_MAX_AGE_MS && typeof b.lat === 'number' && typeof b.lng === 'number';
  return { placeId: b.place_id, address: b.address ?? null, lat: fresh ? b.lat : null, lng: fresh ? b.lng : null };
};

export const toDto = (doc, { now = Date.now() } = {}) => ({
  id: String(doc._id),
  name: doc.name,
  domain: doc.domain ?? null,
  address: doc.address ?? null,
  placeId: doc.place_id ?? null,
  source: doc.source,
  notes: doc.notes ?? null,
  aliases: doc.aliases ?? [],
  // Every way this business was found or added (not only the first): adding it again from another source adds an entry here.
  provenance: (doc.provenance ?? []).map((p) => ({ kind: p.kind, at: p.at })),
  branches: (doc.branches ?? []).map((b) => branchDto(b, now)),
  enrichment: toEnrichmentDto(doc, { now, staleAfterMs: getEnrichmentConfig().staleAfterMs }),
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
});

const exists = () => new ValidationFailure('domain', 'This competitor is already in your list.', 'COMPETITOR_EXISTS');
const notFound = () => new ValidationFailure('id', 'This competitor was not found.', 'COMPETITOR_NOT_FOUND');
const full = () => new ValidationFailure('name', `You can have at most ${MY_COMPETITORS_MAX} competitors. Remove one first.`, 'COMPETITOR_LIMIT_REACHED');
const busy = () => new ValidationFailure('name', 'Several competitors are being added at once. Please try again.', 'COMPETITOR_BUSY');
const isDuplicateKey = (err) => err?.code === 11000;
/** Which unique index a duplicate-key error came from. */
const violatedIndex = (err) => (err?.keyPattern?.slot !== undefined ? 'slot' : 'other');

/**
 * The unique indexes ARE the guarantees (no duplicates, no 101st entry). Mongoose's own auto-build runs in the background and only logs
 * a failure (for example when old data already breaks uniqueness, or an index with the same name but other options exists), which would
 * leave the feature silently unprotected. So the feature does not trust it:
 *   - ensureIndexes() builds the indexes itself (createIndexes: also where autoIndex is off, a no-op when they already exist) and then
 *     READS them back and compares them with the shared spec (model/indexSpec.js). Only when they match is the feature "ready".
 *   - create and update await it; if it fails they answer 503 COMPETITORS_UNAVAILABLE and write nothing. Reads and deletes are unaffected.
 *   - a failure is logged once per attempt as a structured error and is not retried for INDEX_RETRY_MS, so a persistent problem does not
 *     make every request hit the database. After that the next write tries again: once the data / index problem is fixed, no restart is needed.
 *   - warmMyCompetitorIndexes() runs the same check once at startup (not awaited, so nothing else waits for it).
 */
let indexState = { promise: null, ready: false, failedAt: 0, error: null };
let indexRetryMs = 30_000;

const unavailable = () => new ValidationFailure('name', 'My Competitors is temporarily unavailable for changes. Please try again later.', 'COMPETITORS_UNAVAILABLE');

export function ensureIndexes() {
  if (indexState.ready) return Promise.resolve(true);
  if (indexState.promise) return indexState.promise;
  if (indexState.error && Date.now() - indexState.failedAt < indexRetryMs) return Promise.reject(unavailable());
  const attempt = (async () => {
    await ProjectCompetitor.createIndexes();
    const diff = diffIndexes(await ProjectCompetitor.collection.indexes());
    if (!diff.ok) {
      const e = new Error('project_competitors indexes do not match the required definition');
      e.details = { missing: diff.missing, wrong: diff.wrong, conflicting: diff.conflicting };
      throw e;
    }
  })().then(
    () => { indexState = { promise: null, ready: true, failedAt: 0, error: null }; return true; },
    (err) => {
      indexState = { promise: null, ready: false, failedAt: Date.now(), error: err };
      LoggerUtil.error('My competitors: required indexes are not in place, so writes are disabled until they are', err, {
        collection: 'project_competitors', mongoCode: err.code ?? null, codeName: err.codeName ?? null, details: err.details ?? null, retryAfterMs: indexRetryMs,
      });
      throw unavailable();
    },
  );
  indexState.promise = attempt;
  return attempt;
}

/** For a health check or the inspection tooling: is the feature able to accept writes right now? */
export const getIndexReadiness = () => ({ ready: indexState.ready, lastFailureAt: indexState.failedAt || null, lastFailure: indexState.error ? String(indexState.error.message) : null });

/** Startup: build and verify the indexes without making anything else wait. Never throws (the failure is logged and writes stay refused). */
export async function warmMyCompetitorIndexes() {
  try {
    await ensureIndexes();
    LoggerUtil.info('My competitors: indexes verified, writes are available', { collection: 'project_competitors' });
    return true;
  } catch {
    return false;
  }
}

/** Test hook only: forget what is known about the indexes (and shorten the retry delay). */
export function __resetIndexStateForTests({ retryMs = 30_000 } = {}) {
  indexState = { promise: null, ready: false, failedAt: 0, error: null };
  indexRetryMs = retryMs;
}

/** Own domain can never be its own competitor. */
function assertNotOwnDomain(domain, projectDomain) {
  if (domain && projectDomain && domain === projectDomain) {
    throw new ValidationFailure('domain', 'This is your own website, so it cannot be your competitor.', 'OWN_DOMAIN');
  }
}

export async function listCompetitors(projectId) {
  const docs = await ProjectCompetitor.find({ project_id: projectId }).sort({ createdAt: -1, _id: -1 }).lean();
  return docs.map(toDto);
}

/**
 * Saves a new competitor and queues its SEO enrichment (when it has a website); it returns at once, the sweeper does the work.
 * `userId` and `coords` ({ lat, lng } from a Local Competitors result) are optional.
 */
export async function createCompetitor({ projectId, data, projectDomain = null, userId = null, coords = null, now = new Date() }) {
  assertNotOwnDomain(data.domain, projectDomain);
  await ensureIndexes();
  const hasCoords = Number.isFinite(coords?.lat) && Number.isFinite(coords?.lng);
  const identity = {
    provenance: [{ kind: data.source, ref: data.place_id ?? data.domain ?? null, at: now, user_id: userId }],
    ...(data.place_id ? { branches: [{ place_id: data.place_id, address: data.address ?? null, lat: hasCoords ? coords.lat : null, lng: hasCoords ? coords.lng : null, coords_fetched_at: hasCoords ? now : null, added_at: now }] } : {}),
    enrichment: data.domain ? { status: 'pending', requested_at: now, next_attempt_at: now, attempts: 0 } : { status: 'no_website' },
  };
  for (let attempt = 0; attempt < SLOT_ATTEMPTS; attempt += 1) {
    const taken = new Set(await ProjectCompetitor.distinct('slot', { project_id: projectId }));
    const free = [];
    for (let s = 0; s < MY_COMPETITORS_MAX; s += 1) if (!taken.has(s)) free.push(s);
    if (free.length === 0) throw full();
    // A random free slot, not the lowest: simultaneous adds then rarely pick the same one.
    const slot = free[Math.floor(Math.random() * free.length)];
    try {
      const doc = await ProjectCompetitor.create({ project_id: projectId, slot, ...data, ...identity });
      await queueRelevance(projectId, data.domain);
      return toDto(doc.toObject());
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      if (violatedIndex(err) !== 'slot') throw exists();
      // Another add took this slot an instant ago: look again.
    }
  }
  throw busy();
}

/**
 * Edits a competitor. Changing its website re-queues enrichment (the old numbers describe another site, so they are dropped); clearing it
 * marks the entry `no_website`. Other edits never touch enrichment. Identity fields (place, slot, source, provenance) are not editable here.
 */
export async function updateCompetitor({ projectId, id, patch, projectDomain = null }) {
  assertNotOwnDomain(patch.domain, projectDomain);
  await ensureIndexes();
  let before = null;
  if ('domain' in patch) before = await ProjectCompetitor.findOne({ _id: id, project_id: projectId }).select('domain').lean();
  try {
    let doc = await ProjectCompetitor.findOneAndUpdate(
      { _id: id, project_id: projectId },
      { $set: patch },
      { new: true, runValidators: true },
    ).lean();
    if (!doc) throw notFound();
    if (before && (before.domain ?? null) !== (doc.domain ?? null)) {
      doc = (doc.domain
        ? await queueEnrichment({ id: doc._id, projectId, wipe: true })
        : await markNoWebsite({ id: doc._id, projectId })) ?? doc;
      await queueRelevance(projectId, doc.domain);
    }
    return toDto(doc);
  } catch (err) {
    if (isDuplicateKey(err)) throw exists();
    throw err;
  }
}

/** One competitor with everything stored about it (the details view). Never calls a provider. */
export async function getCompetitor({ projectId, id }) {
  const doc = await ProjectCompetitor.findOne({ _id: id, project_id: projectId }).lean();
  if (!doc) throw notFound();
  return { ...toDto(doc), sharedKeywordList: sharedKeywordList(doc) };
}

/**
 * The shared keywords (the keywords the project AND this competitor both rank for) with each side's position, for the details view only
 * (the list view carries just the count). null when the section has no values; the reason is in enrichment.sections.shared.
 */
export function sharedKeywordList(doc) {
  const s = doc?.enrichment?.sections?.shared;
  if (s?.status !== 'ok' || !s.data) return null;
  const pos = (p) => (p ? { position: p.rank_group ?? null, url: p.url ?? null, traffic: p.etv ?? null } : null);
  return {
    total: s.data.shared_keywords,
    shown: s.data.stored_keywords,
    truncated: Boolean(s.data.truncated),
    fetchedAt: s.fetched_at ?? null,
    market: doc.enrichment?.market ? { location: doc.enrichment.market.location ?? null, language: doc.enrichment.market.language ?? null } : null,
    keywords: (s.data.keywords ?? []).map((k) => ({ keyword: k.keyword, searchVolume: k.search_volume ?? null, cpc: k.cpc ?? null, project: pos(k.project), competitor: pos(k.competitor) })),
  };
}

/**
 * A manual refresh of a competitor's SEO metrics: queues it again, to be fetched by the background sweeper (this call buys nothing).
 * Refused with distinct codes: no website, a run in progress, or too soon after the last finished run (cool-down). A run that failed, or
 * that never produced data, may be retried at once. An already queued competitor is returned as is.
 */
export async function refreshEnrichment({ projectId, id, now = new Date() }) {
  const doc = await ProjectCompetitor.findOne({ _id: id, project_id: projectId }).lean();
  if (!doc) throw notFound();
  if (!doc.domain) throw new ValidationFailure('domain', 'Add a website to this competitor to get its SEO metrics.', 'NO_WEBSITE');
  const e = doc.enrichment ?? null;
  const cfg = getEnrichmentConfig();
  if (e?.status === 'pending') return toDto(doc);
  if (e?.status === 'processing' && e.lease_until && new Date(e.lease_until) > now) {
    throw new ValidationFailure('id', 'This competitor is being updated right now.', 'ENRICHMENT_IN_PROGRESS');
  }
  const hadSuccess = Boolean(e?.last_success_at);
  const waitMs = e?.finished_at && hadSuccess && e.status !== 'failed' ? cfg.refreshCooldownMs - (now.getTime() - new Date(e.finished_at).getTime()) : 0;
  if (waitMs > 0) {
    const err = new ValidationFailure('id', 'This competitor was updated recently. Please try again later.', 'REFRESH_COOLDOWN');
    err.retryAfterSeconds = Math.ceil(waitMs / 1000);
    throw err;
  }
  const queued = await queueEnrichment({ id: doc._id, projectId, now });
  if (!queued) throw new ValidationFailure('id', 'This competitor is being updated right now.', 'ENRICHMENT_IN_PROGRESS');
  return toDto(queued);
}

/**
 * Adds a business found through Local Competitors or the SEO list WITHOUT duplicating it: it is matched, in this order, by Google place
 * (primary or branch), by website, and - only for a candidate with neither - by exact name + address. A match gets this source added to
 * its provenance (and a new place at the same website added as a branch, a missing website filled in); no match creates a record.
 * Never merged on a name alone: two different places with the same brand name stay two records unless they share a website.
 * @returns {Promise<{ competitor: object, created: boolean }>}
 */
export async function addDiscovered({ projectId, candidate, projectDomain = null, userId = null, now = new Date() }) {
  assertNotOwnDomain(candidate.domain, projectDomain);
  await ensureIndexes();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = await findExisting(projectId, candidate);
    if (existing) return { competitor: toDto(await mergeInto(existing, candidate, { userId, now })), created: false };
    try {
      const competitor = await createCompetitor({
        projectId, projectDomain, userId, now,
        data: { name: candidate.name, domain: candidate.domain ?? null, address: candidate.address ?? null, place_id: candidate.place_id ?? null, source: candidate.source, notes: null },
        coords: candidate.lat != null ? { lat: candidate.lat, lng: candidate.lng } : null,
      });
      return { competitor, created: true };
    } catch (err) {
      // A simultaneous add of the same business created it first: match it on the next pass.
      if (!(err instanceof ValidationFailure) || err.code !== 'COMPETITOR_EXISTS') throw err;
    }
  }
  throw exists();
}

async function findExisting(projectId, c) {
  const or = [];
  if (c.place_id) { or.push({ place_id: c.place_id }); or.push({ 'branches.place_id': c.place_id }); }
  if (c.domain) or.push({ domain: c.domain });
  if (or.length) return ProjectCompetitor.findOne({ project_id: projectId, $or: or }).lean();
  // No place and no website: only an exact normalized name + address match counts.
  const key = matchKey(c.name, c.address);
  if (!key) return null;
  const candidates = await ProjectCompetitor.find({ project_id: projectId, domain: null, place_id: null }).select('name address').lean();
  return candidates.find((d) => matchKey(d.name, d.address) === key) ?? null;
}

async function mergeInto(existing, c, { userId, now }) {
  const set = {}; const push = {};
  const hasKind = (existing.provenance ?? []).some((p) => p.kind === c.source && (p.ref ?? null) === (c.place_id ?? c.domain ?? null));
  if (!hasKind) push.provenance = { kind: c.source, ref: c.place_id ?? c.domain ?? null, at: now, user_id: userId };
  const knownPlaces = new Set([existing.place_id, ...(existing.branches ?? []).map((b) => b.place_id)].filter(Boolean));
  const hasCoords = Number.isFinite(c.lat) && Number.isFinite(c.lng);
  if (c.place_id && !knownPlaces.has(c.place_id)) {
    // The same business at another physical place (they share a website): a branch of the same record, never a second record.
    if (!existing.place_id) set.place_id = c.place_id;
    push.branches = { place_id: c.place_id, address: c.address ?? null, lat: hasCoords ? c.lat : null, lng: hasCoords ? c.lng : null, coords_fetched_at: hasCoords ? now : null, added_at: now };
  } else if (c.place_id && hasCoords) {
    set['branches.$[b].lat'] = c.lat; set['branches.$[b].lng'] = c.lng; set['branches.$[b].coords_fetched_at'] = now;
  }
  const fillsDomain = !existing.domain && c.domain;
  if (fillsDomain) set.domain = c.domain;
  if (!existing.address && c.address) set.address = c.address;
  const update = { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(push).length ? { $push: push } : {}) };
  if (!Object.keys(update).length) return existing;
  const options = { new: true, ...(c.place_id && hasCoords && knownPlaces.has(c.place_id) ? { arrayFilters: [{ 'b.place_id': c.place_id }] } : {}) };
  try {
    const doc = await ProjectCompetitor.findOneAndUpdate({ _id: existing._id }, update, options).lean();
    if (fillsDomain && doc) {
      await queueRelevance(doc.project_id, doc.domain);
      return (await queueEnrichment({ id: doc._id, projectId: doc.project_id, wipe: true })) ?? doc;
    }
    return doc ?? existing;
  } catch (err) {
    if (isDuplicateKey(err)) throw exists();
    throw err;
  }
}

/** Removing a competitor that is already gone succeeds. */
export async function deleteCompetitor({ projectId, id }) {
  await ProjectCompetitor.deleteOne({ _id: id, project_id: projectId });
}
