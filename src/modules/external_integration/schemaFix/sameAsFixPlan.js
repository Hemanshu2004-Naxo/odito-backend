/**
 * sameAsFixPlan — turns the URLs the owner SELECTED (after reviewing discovered candidates or typing their own) plus the live
 * Rank Math state into the exact, minimal list of sameAs changes Odito may apply. Pure: no I/O, no clock, so every rule is
 * testable and the fingerprint is stable for identical inputs.
 *
 * Principles (the reason is next to each rule):
 *   - the Organization is edited where it is configured (Rank Math's "additional profiles"); a second Organization object is
 *     never injected, and an entity published by a theme or another plugin is not edited by guessing
 *   - ONLY URLs the owner approved are written, each validated by the same policy as discovery; nothing is invented, no
 *     example/placeholder URL is accepted, an empty list is never written "to silence" the finding
 *   - existing values are PRESERVED: a value already published (by Rank Math's Facebook/Twitter fields, by the additional
 *     profiles, or by the entity itself) is reported as present, never overwritten, never duplicated
 *   - removing a value is possible only for the profiles Odito itself can manage (the additional-profiles bucket) and only when
 *     the owner explicitly selected that removal
 *   - what cannot be written safely (another SEO plugin, a theme-generated entity, two Organizations, a person-type site) is
 *     returned as `unsupported` with source-specific manual instructions — never as an Apply button
 */

import crypto from 'crypto';
import { profileKey } from '../../schema-evidence/sameAs/profileUrl.js';

export const SAMEAS_FIX_TYPE = 'organization_same_as';
export const SAMEAS_ISSUE_KEY = 'sameas_array';
/** Part of the fingerprint: an approval given under older rules can never be applied under newer ones. */
export const SAMEAS_PLAN_VERSION = 1;
/**
 * The field name recorded on the task's external write. Deliberately NOT the legacy 'same_as': TaskVerificationService waits for a crawl
 * newer than the write for a typed fix (like organization_schema), while the older owner-typed write keeps its own behaviour.
 */
export const SAMEAS_TASK_FIELD = SAMEAS_FIX_TYPE;

export const SAMEAS_TARGETS = Object.freeze({
  rank_math: {
    kind: 'seo_plugin_settings',
    label: 'Rank Math → Titles & Meta → Local SEO → Additional profiles',
    storage: 'rank-math-options-titles.social_additional_profiles',
  },
});

const reason = (code, message) => ({ code, message });

/**
 * Where the owner changes this by hand, per source. The same text is shown for an unsupported source and next to the recommended
 * JSON-LD, so a manual path is never worse than the automatic one.
 */
export function manualInstructions(provider, { entityId, shared } = {}) {
  const common = `Add the profile URLs to the Organization${entityId ? ` (${entityId})` : ''} that already exists — do not add a second Organization.`;
  const where = {
    rank_math: 'In WordPress go to Rank Math → Titles & Meta → Local SEO and add each URL under "Additional profiles" (one per line).',
    yoast: 'In WordPress go to Yoast SEO → Settings → Site representation → Social profiles (or "Additional social profiles") and add each URL.',
    aioseo: 'In WordPress go to All in One SEO → Social Networks → Social Profiles and add each URL.',
    seopress: 'In WordPress go to SEOPress → Social Networks → Knowledge Graph and add each profile URL.',
    none: 'No supported SEO plugin was detected. If your theme outputs the Organization markup, add a "sameAs" array to that Organization in the theme\'s schema/header template; with a schema or page-builder plugin, use its Organization settings.',
    multiple: 'More than one SEO plugin is active. Deactivate the one you do not use, then add the profiles in the remaining plugin\'s Organization / social profile settings.',
  }[provider] || 'Your Organization markup is produced by a theme or plugin Odito cannot edit. Open the template or plugin that outputs it and add the URLs to the existing Organization\'s "sameAs" array.';
  return [where, common, shared ? 'This Organization is published site-wide, so one change fixes it on every page.' : 'This Organization is specific to this page; change it where this page\'s markup is produced.'];
}

const keyOf = (u) => profileKey(u);

/**
 * @param {object} p
 * @param {{url: string, comparisonKey: string, identityKey?: string, platform?: string, platformLabel?: string, origin?: string, candidateId?: string|null}[]} p.selection
 *        profiles to ADD — already validated by profileUrl.validateProfileList (the service never plans from unvalidated text)
 * @param {string[]} [p.removals]  exact stored values the owner chose to REMOVE
 * @param {object} p.entity        resolveSameAsEntity(...) for the finding's page
 * @param {object} p.site          live Rank Math organization settings (bridge.getSiteSchema().organization)
 * @param {string} p.provider      the Bridge's live SEO provider
 * @param {{projectId: *, connectionId: *, pageUrl: string}} [p.context]
 * @param {{siteSchemaSupported?: boolean}} [p.capabilities]
 * @param {{code: string, message: string}|null} [p.unavailable]  why the live WordPress state cannot be read at all (not connected, Bridge missing):
 *        the plan is then `unsupported` with manual instructions — the recommendation is never blocked by a missing integration
 */
export function planSameAsFix({ selection = [], removals = [], entity, site, provider, unavailable = null, context = {}, capabilities = {} }) {
  const out = (status, why = {}, extra = {}) => finish({
    status, code: why.code || null, message: why.message || null,
    changes: [], preserved: [], alreadyPresent: [], blocked: [], warnings: [], notWritten: [],
    target: provider === 'rank_math' ? SAMEAS_TARGETS.rank_math : null,
    manual: null, ...extra,
  }, { entity, site, context, capabilities, selection, removals });
  const unsupported = (why) => out('unsupported', why, { target: null, manual: { provider: provider || 'none', steps: manualInstructions(provider || 'none', { entityId: entity?.entity?.id, shared: entity?.scope?.shared }) } });

  if (!entity || entity.state === 'no_entity') {
    return out('validation_failed', reason('NO_ORGANIZATION_ENTITY', 'No Organization entity was found on this site\'s crawled pages, so there is nothing to attach profiles to. Re-run the audit, then try again.'));
  }
  if (unavailable) return unsupported(reason(unavailable.code, unavailable.message));
  if (provider !== 'rank_math') {
    return unsupported(reason('PROVIDER_NOT_SUPPORTED', provider === 'multiple'
      ? 'More than one SEO plugin is active on this WordPress site, so Odito cannot tell which one publishes the Organization.'
      : `Organization sameAs can only be changed through Rank Math. ${provider && provider !== 'none' ? `This site uses ${provider}.` : 'No supported SEO plugin was detected.'}`));
  }
  if (!capabilities.siteSchemaSupported) {
    return out('blocked', reason('BRIDGE_UPDATE_REQUIRED', 'Writing Organization sameAs requires Odito SEO Bridge 1.4.0 or newer. Update the plugin on this WordPress site, then try again.'),
      { blocked: [{ field: 'sameAs', code: 'BRIDGE_UPDATE_REQUIRED', message: 'Update the Odito SEO Bridge plugin.' }] });
  }
  if (site?.kind !== 'company') {
    return unsupported(reason('SITE_IS_PERSON', site?.kind === 'person'
      ? 'This site is configured in Rank Math as a person, not a company, so it publishes no Organization entity to add profiles to.'
      : 'Rank Math does not report whether this site is a company or a person (update the Odito SEO Bridge), so the Organization is not changed.'));
  }
  if (entity.state === 'multiple_entities') {
    return unsupported(reason('DUPLICATE_ENTITIES', 'The site publishes more than one Organization entity. Odito will not guess which one to edit or merge them. Resolve the duplicate first, then add the profiles to the one that remains.'));
  }
  // Rank Math always publishes its entity with @id <home>#organization. Another @id (or none) was written by a theme or another
  // plugin: editing Rank Math's settings would NOT change that entity (and a new value would sit on a different one).
  if (!entity.entity.hasHomeOrganizationId) {
    return unsupported(reason('ORGANIZATION_SOURCE_UNKNOWN', `The Organization (${entity.entity.id || 'no @id'}) is published by something other than Rank Math — a theme, a page builder or another plugin. Changing Rank Math's settings would not edit it. Add the profiles at the source that generates it.`));
  }

  const adds = [];
  const preserved = [];
  const alreadyPresent = [];
  const blocked = [];
  const warnings = [];

  const protectedKeys = new Set((site.protectedSameAs || []).map(keyOf).filter(Boolean));
  const additional = site.additionalSameAs || [];
  const additionalByKey = new Map(additional.map((u) => [keyOf(u), u]));
  const renderedKeys = new Set((entity.existing?.valid || []).map((v) => v.comparisonKey));

  // ── additions ────────────────────────────────────────────────────────────
  const seen = new Set();
  for (const item of selection) {
    const itemKey = keyOf(item?.url);
    if (!itemKey || seen.has(itemKey)) continue;
    seen.add(itemKey);
    if (protectedKeys.has(itemKey) || additionalByKey.has(itemKey) || renderedKeys.has(itemKey)) {
      alreadyPresent.push({ url: item.url, platformLabel: item.platformLabel || null });
      continue;
    }
    adds.push({
      field: 'sameAs', kind: 'add', before: '', after: item.url, source: item.origin || 'owner_approved',
      platform: item.platform || null, platformLabel: item.platformLabel || null, candidateId: item.candidateId || null,
    });
    // A second, different profile on a network the Organization already lists: allowed (an organization can have two accounts),
    // but said out loud so it is a decision, not an accident.
    const sameNetwork = (entity.existing?.valid || []).find((v) => v.platform && v.platform === item.platform && v.identityKey !== item.identityKey);
    if (sameNetwork) warnings.push({ code: 'SECOND_PROFILE_ON_NETWORK', message: `The Organization already lists a different ${item.platformLabel} profile (${sameNetwork.value}). Both will be published.` });
  }

  // ── removals (explicitly selected, only from the bucket Odito can manage) ─────────────────────────────────
  const removes = [];
  for (const value of removals) {
    const k = keyOf(value);
    if (!k) { blocked.push({ field: 'sameAs', code: 'REMOVE_INVALID', message: `"${value}" is not a URL.` }); continue; }
    if (protectedKeys.has(k)) { blocked.push({ field: 'sameAs', code: 'PROTECTED_PROFILE', message: `${value} comes from Rank Math's Facebook / Twitter settings. Odito never changes those; edit them in Rank Math → Titles & Meta.` }); continue; }
    const stored = additionalByKey.get(k);
    if (!stored) { blocked.push({ field: 'sameAs', code: 'REMOVE_NOT_MANAGED', message: `${value} is not in the additional profiles list Odito manages, so it cannot be removed from here.` }); continue; }
    if (adds.some((a) => keyOf(a.after) === k)) continue;
    removes.push({ field: 'sameAs', kind: 'remove', before: stored, after: '', source: 'owner_approved' });
  }

  const removedKeys = new Set(removes.map((r) => keyOf(r.before)));
  for (const value of [...(site.protectedSameAs || []), ...additional]) {
    if (!removedKeys.has(keyOf(value))) preserved.push({ field: 'sameAs', value, reason: protectedKeys.has(keyOf(value)) ? 'Comes from Rank Math\'s Facebook / Twitter settings; Odito never changes it.' : 'Already published; kept.' });
  }

  const changes = [...adds, ...removes];
  const label = 'Organization sameAs profile';
  const enriched = changes.map((c) => ({ ...c, label, rankMathOption: SAMEAS_TARGETS.rank_math.storage }));

  if (!enriched.length && !blocked.length) {
    if (!selection.length && !removals.length) {
      return out('nothing_to_change', reason('NO_PROFILES_SELECTED', 'No profile links were selected, so nothing is written. sameAs is optional: Odito never adds an empty list or an example link to clear this finding.'), { preserved, alreadyPresent, warnings });
    }
    return out('nothing_to_change', reason('ALREADY_PRESENT', 'Every selected profile is already published in the Organization\'s sameAs; nothing needs to change.'), { preserved, alreadyPresent, warnings });
  }
  if (!enriched.length) return out('blocked', blocked[0] ? reason(blocked[0].code, blocked[0].message) : {}, { preserved, alreadyPresent, blocked, warnings });
  return out('ready', {}, { changes: enriched, preserved, alreadyPresent, blocked, warnings });
}

function finish(plan, { entity, site, context = {}, capabilities = {}, selection = [], removals = [] }) {
  const material = JSON.stringify({
    v: SAMEAS_PLAN_VERSION, t: SAMEAS_FIX_TYPE,
    ctx: [String(context.projectId ?? ''), String(context.connectionId ?? ''), String(context.pageUrl ?? '')],
    s: plan.status, c: plan.code,
    ch: plan.changes.map((c) => [c.field, c.kind, c.before, c.after]),
    ap: plan.alreadyPresent.map((a) => a.url),
    b: plan.blocked.map((b) => [b.field, b.code]),
    live: [site?.kind || '', [...(site?.protectedSameAs || [])].map((u) => keyOf(u) || u).sort(), [...(site?.additionalSameAs || [])].map((u) => keyOf(u) || u).sort()],
    ent: [entity?.state || '', entity?.entity?.id || '', entity?.scope?.shared ? 1 : 0, [...(entity?.existing?.valid || [])].map((v) => v.comparisonKey).sort()],
    sel: selection.map((s) => keyOf(s.url)).sort(), rm: removals.map(keyOf).sort(),
    cap: !!capabilities?.siteSchemaSupported,
  });
  return { ...plan, fingerprint: crypto.createHash('sha256').update(material).digest('hex') };
}

export default { planSameAsFix, manualInstructions, SAMEAS_FIX_TYPE, SAMEAS_ISSUE_KEY, SAMEAS_PLAN_VERSION, SAMEAS_TASK_FIELD, SAMEAS_TARGETS };
