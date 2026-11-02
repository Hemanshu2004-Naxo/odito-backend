import CompetitorAssessment, { ASSESSMENT_CLASSES, ASSESSMENT_UNIQUE_INDEX } from '../model/CompetitorAssessment.js';
import { ValidationFailure } from '../../dataforseo-api/shared/targetDomain.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import { REGISTRY_VERSION } from '../config/domainRegistry.js';
import { RULES_VERSION } from './relevanceClassifier.js';

/**
 * The assessment queue and the user's overrides, on project_competitor_assessments. Same mechanics as the enrichment queue: every
 * take-over is one conditional update, and every write a worker makes is guarded by its lease. The override is written by ONE function
 * (setOverride) and read by none of the worker functions, so automatic reassessment cannot overwrite a user's decision.
 */

export const MAX_DOMAINS_PER_REQUEST = 50;
const FRESH_MS = 30 * 24 * 60 * 60_000; // a finished assessment is trusted for a month...
const RETRY_UNREADABLE_MS = 6 * 60 * 60_000; // ...unless the site could not be read: then six hours

/** The unique (project, domain) index is what keeps one assessment per domain: refuse to work without it (same fail-closed gate idea as My Competitors). */
let gate = { promise: null, ready: false, failedAt: 0, error: null };
const GATE_RETRY_MS = 30_000;
export function ensureAssessmentIndexes() {
  if (gate.ready) return Promise.resolve(true);
  if (gate.promise) return gate.promise;
  if (gate.error && Date.now() - gate.failedAt < GATE_RETRY_MS) return Promise.reject(unavailable());
  gate.promise = (async () => {
    await CompetitorAssessment.createIndexes();
    const found = (await CompetitorAssessment.collection.indexes()).find((i) => i.name === ASSESSMENT_UNIQUE_INDEX);
    if (!found?.unique) throw new Error('the unique assessment index is not in place');
  })().then(
    () => { gate = { promise: null, ready: true, failedAt: 0, error: null }; return true; },
    (err) => {
      gate = { promise: null, ready: false, failedAt: Date.now(), error: err };
      LoggerUtil.error('Competitor assessments: the unique index is not in place, so assessments are disabled until it is', err, { collection: 'project_competitor_assessments', mongoCode: err.code ?? null });
      throw unavailable();
    },
  );
  return gate.promise;
}
const unavailable = () => new ValidationFailure('domains', 'Relevance assessment is temporarily unavailable. Please try again later.', 'ASSESSMENTS_UNAVAILABLE');
export const __resetAssessmentGateForTests = () => { gate = { promise: null, ready: false, failedAt: 0, error: null }; };

/** Does this stored assessment need to be (re)done? Pure. */
export function isStale(doc, now = Date.now()) {
  if (!doc) return true;
  if (doc.status === 'pending' || doc.status === 'processing') return false; // already queued
  if (doc.status === 'failed' || !doc.auto) return true;
  if (doc.auto.rules_version !== RULES_VERSION || doc.auto.registry_version !== REGISTRY_VERSION) return true;
  const age = now - new Date(doc.auto.assessed_at).getTime();
  return age > (doc.auto.fetch_failed ? RETRY_UNREADABLE_MS : FRESH_MS);
}

/**
 * Queues an assessment for every domain that has none or a stale one (`force`: also a fresh one). Domains already queued or running are
 * left alone. Never touches an `override`. Resolves to the current documents for the domains asked about.
 */
export async function requestAssessments({ projectId, domains, force = false, now = new Date() }) {
  await ensureAssessmentIndexes();
  const unique = [...new Set(domains)];
  const existing = await CompetitorAssessment.find({ project_id: projectId, domain: { $in: unique } }).lean();
  const byDomain = new Map(existing.map((d) => [d.domain, d]));
  const ops = [];
  for (const domain of unique) {
    const doc = byDomain.get(domain);
    const queued = doc && (doc.status === 'pending' || doc.status === 'processing');
    if (queued) continue;
    if (!doc) {
      ops.push({ updateOne: { filter: { project_id: projectId, domain }, update: { $setOnInsert: { status: 'pending', requested_at: now, next_attempt_at: now, attempts: 0, override: null } }, upsert: true } });
    } else if (force || isStale(doc, now.getTime())) {
      ops.push({ updateOne: { filter: { project_id: projectId, domain, status: { $nin: ['pending', 'processing'] } }, update: { $set: { status: 'pending', requested_at: now, next_attempt_at: now, attempts: 0, lease_owner: null, lease_until: null, last_error_code: null, ...(force ? { force_refetch: true } : {}) } } } });
    }
  }
  if (ops.length) await CompetitorAssessment.bulkWrite(ops, { ordered: false });
  return listAssessments({ projectId, domains: unique });
}

export function listAssessments({ projectId, domains }) {
  return CompetitorAssessment.find({ project_id: projectId, domain: { $in: [...new Set(domains)] } }).lean();
}

/** Takes ONE assessment that is due (pending, or processing with an expired lease). One conditional update: exactly one caller gets it. */
export function claimNextAssessment({ owner, now = new Date(), leaseMs, projectId = null }) {
  return CompetitorAssessment.findOneAndUpdate(
    {
      ...(projectId ? { project_id: projectId } : {}),
      $or: [{ status: 'pending', next_attempt_at: { $lte: now } }, { status: 'processing', lease_until: { $lt: now } }],
    },
    { $set: { status: 'processing', lease_owner: owner, lease_until: new Date(now.getTime() + leaseMs), started_at: now }, $inc: { attempts: 1 } },
    { new: true, sort: { next_attempt_at: 1 } },
  ).lean();
}

/** Saves the automatic result and ends the run, only while the caller still owns the lease. Writes `auto` and the queue fields ONLY. */
export async function saveAutoResult({ id, owner, auto, now = new Date() }) {
  const res = await CompetitorAssessment.updateOne(
    { _id: id, status: 'processing', lease_owner: owner },
    { $set: { auto, status: 'done', finished_at: now, lease_owner: null, lease_until: null, next_attempt_at: null, last_error_code: null, force_refetch: false } },
  );
  return res.matchedCount === 1;
}

export async function failRun({ id, owner, retryAt = null, errorCode, now = new Date() }) {
  const res = await CompetitorAssessment.updateOne(
    { _id: id, status: 'processing', lease_owner: owner },
    { $set: { status: retryAt ? 'pending' : 'failed', next_attempt_at: retryAt, finished_at: now, lease_owner: null, lease_until: null, last_error_code: errorCode } },
  );
  return res.matchedCount === 1;
}

const validClass = (c) => { if (!ASSESSMENT_CLASSES.includes(c)) throw new ValidationFailure('class', `class must be one of: ${ASSESSMENT_CLASSES.join(', ')}.`); return c; };

/** The user's decision for a domain. Creates the record when the domain was never assessed. Never touches `auto` or the queue. */
export async function setOverride({ projectId, domain, cls, note = null, userId, now = new Date() }) {
  await ensureAssessmentIndexes();
  validClass(cls);
  if (!userId) throw new ValidationFailure('user', 'A user is required to record a decision.');
  const override = { class: cls, note: note || null, user_id: userId, at: now };
  const doc = await CompetitorAssessment.findOneAndUpdate(
    { project_id: projectId, domain },
    { $set: { override }, $setOnInsert: { status: 'done', requested_at: now, finished_at: now, attempts: 0 } },
    { new: true, upsert: true },
  ).lean();
  return doc;
}

/** Removes the user's decision (the automatic class applies again). */
export function clearOverride({ projectId, domain }) {
  return CompetitorAssessment.findOneAndUpdate({ project_id: projectId, domain }, { $set: { override: null } }, { new: true }).lean();
}

/** What the browser gets for one assessment. The effective class is the user's decision when there is one. */
export function toAssessmentDto(doc) {
  const auto = doc.auto ?? null;
  const o = doc.override ?? null;
  const facts = auto?.facts ?? null;
  return {
    domain: doc.domain,
    status: doc.status,
    class: o?.class ?? auto?.class ?? null,
    autoClass: auto?.class ?? null,
    overridden: Boolean(o),
    override: o ? { class: o.class, note: o.note ?? null, at: o.at } : null,
    confidence: auto?.confidence ?? null,
    level: auto?.level ?? null,
    reasons: (auto?.reasons ?? []).map((r) => ({ code: r.code, text: r.text, source: r.source })),
    signals: auto?.signals ? { kind: auto.signals.kind ?? null, sector: auto.signals.sector ?? null, sectorTerms: auto.signals.sectorTerms ?? [], geo: auto.signals.geo ?? null, scope: auto.signals.scope ?? null, registryKind: auto.signals.registryKind ?? null } : null,
    facts: facts ? { fetched: Boolean(facts.fetched), title: facts.title ?? null, schemaTypes: facts.schemaTypes ?? [], locality: facts.locality ?? null, country: facts.country ?? null, error: facts.error ?? null } : null,
    assessedAt: auto?.assessed_at ?? null,
    rulesVersion: auto?.rules_version ?? null,
    // True when the page should ask for it to be done again (never assessed, older than a month, or made with older rules).
    stale: isStale(doc),
    errorCode: doc.last_error_code ?? null,
  };
}
