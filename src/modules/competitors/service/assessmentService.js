import CompetitorDomainProfile from '../model/CompetitorDomainProfile.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import { lookupRegistry, REGISTRY_VERSION } from '../config/domainRegistry.js';
import { classifyDomain, RULES_VERSION } from './relevanceClassifier.js';
import { fetchSiteFacts } from './siteFacts.js';
import { loadProjectProfile } from './projectProfile.js';
import { failRun, saveAutoResult } from './assessmentStore.js';

/**
 * Runs ONE claimed assessment: judge the domain from the registry first (free, no request), otherwise from its homepage (one SSRF-safe
 * request, shared across projects through the facts cache), against the project's own profile. Saves only the `auto` result.
 * Costs no provider money: it never calls DataForSEO or Google.
 */

const FACTS_OK_MS = 30 * 24 * 60 * 60_000;
const FACTS_FAILED_MS = 6 * 60 * 60_000;

/** The small, safe summary of the facts that is stored with the assessment (and shown as evidence). */
export function summarizeFacts(facts) {
  if (!facts) return null;
  if (!facts.fetched) return { fetched: false, error: facts.error ?? null };
  return { fetched: true, title: facts.title ?? null, schemaTypes: (facts.schemaTypes ?? []).slice(0, 8), locality: facts.address?.locality ?? null, country: facts.address?.country ?? null };
}

const defaultDeps = () => ({
  loadProfile: loadProjectProfile,
  readFacts: async (domain, now) => (await CompetitorDomainProfile.findOne({ domain, expires_at: { $gt: now } }).lean())?.facts ?? null,
  writeFacts: async (domain, facts, now) => {
    const ttl = facts.fetched ? FACTS_OK_MS : FACTS_FAILED_MS;
    await CompetitorDomainProfile.updateOne({ domain }, { $set: { facts, fetched_at: now, expires_at: new Date(now.getTime() + ttl) } }, { upsert: true });
  },
  fetchFacts: fetchSiteFacts,
  save: saveAutoResult,
  fail: failRun,
  now: () => new Date(),
  maxAttempts: 3,
});

/** @returns {Promise<{ outcome: string }>} never throws */
export async function assessClaimed(claim, owner, deps = {}) {
  const d = { ...defaultDeps(), ...deps };
  const id = claim._id;
  const log = (message, extra = {}) => LoggerUtil.info(message, { projectId: String(claim.project_id), domain: claim.domain, ...extra });
  try {
    const profile = await d.loadProfile(claim.project_id);
    if (!profile) { await d.fail({ id, owner, errorCode: 'PROJECT_UNAVAILABLE', now: d.now() }); return { outcome: 'project_unavailable' }; }
    if (profile.ownDomain && claim.domain === profile.ownDomain) { await d.fail({ id, owner, errorCode: 'OWN_DOMAIN', now: d.now() }); return { outcome: 'own_domain' }; }

    const registry = lookupRegistry(claim.domain);
    let facts = null; let factsSource = 'none';
    if (!registry) {
      const at = d.now();
      // A user's "check this site again" reads the website itself; otherwise facts another check (or project) already read are reused.
      facts = claim.force_refetch ? null : await d.readFacts(claim.domain, at);
      if (facts) factsSource = 'cache';
      else { facts = await d.fetchFacts(claim.domain); factsSource = 'fetched'; await d.writeFacts(claim.domain, facts, at).catch(() => {}); }
    }
    const result = classifyDomain({ domain: claim.domain, facts, profile, registry });
    const auto = {
      class: result.class, confidence: result.confidence, level: result.level, reasons: result.reasons, signals: result.signals,
      facts: summarizeFacts(facts), rules_version: RULES_VERSION, registry_version: REGISTRY_VERSION,
      fetch_failed: Boolean(facts && !facts.fetched), assessed_at: d.now(),
    };
    if (!(await d.save({ id, owner, auto, now: d.now() }))) return { outcome: 'lease_lost' };
    log('Competitor assessment: done', { class: result.class, level: result.level, factsSource });
    return { outcome: result.class };
  } catch (err) {
    LoggerUtil.error('Competitor assessment: unexpected error', err, { projectId: String(claim.project_id), domain: claim.domain });
    const retry = (claim.attempts ?? 1) < d.maxAttempts;
    await d.fail({ id, owner, retryAt: retry ? new Date(d.now().getTime() + 5 * 60_000) : null, errorCode: 'ASSESSMENT_ERROR', now: d.now() }).catch(() => {});
    return { outcome: 'error' };
  }
}
