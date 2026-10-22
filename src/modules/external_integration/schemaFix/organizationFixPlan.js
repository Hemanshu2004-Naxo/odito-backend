/**
 * organizationFixPlan — turns the verified schema INTENT + the live Rank Math state into the exact, minimal list of
 * field changes Odito may apply for an `organization_schema` task. Pure: no I/O, no clock, so every rule is testable
 * and the plan fingerprint is stable for identical inputs.
 *
 * Principles (the reason each exists is in the comment next to the rule):
 *   - the entity is configured in ONE place (Rank Math's Knowledge Graph / Local SEO settings); a second Organization
 *     object is never injected
 *   - only values ODITO verified (evidence) are written; nothing is invented
 *   - existing non-empty values are PRESERVED (reported, not overwritten) — except a logo that is proven broken
 *   - a specific type is never downgraded, and a physical type is not published without an address
 *   - what Odito cannot write yet (address, phone, hours, geo) is listed, not silently dropped
 */

import crypto from 'crypto';
import { typeSatisfies } from '../../schema-evidence/schemaGraph.js';
import { addressToWire, compareFields, formatAddress, wireAddress } from '../../schema-evidence/organizationAddress.js';

export const ORGANIZATION_FIX_TYPE = 'organization_schema';

/**
 * Bumped whenever the planner's rules change what a plan means. It is part of the fingerprint, so an approval given under older
 * rules can never be applied under newer ones.
 */
export const ORGANIZATION_PLAN_VERSION = 3;

/** Rank Math Knowledge Graph setting behind each field (documented here, enforced by the Bridge's allowlist). */
export const ORGANIZATION_FIELDS = Object.freeze({
  name: { label: 'Organization name', rankMathOption: 'rank-math-options-titles.knowledgegraph_name' },
  logo: { label: 'Logo URL', rankMathOption: 'rank-math-options-titles.knowledgegraph_logo' },
  type: { label: 'Business type', rankMathOption: 'rank-math-options-titles.local_business_type' },
  address: { label: 'Business address', rankMathOption: 'rank-math-options-titles.local_address' },
});

const NOT_WRITTEN_FACTS = ['telephone', 'address', 'openingHoursSpecification', 'openingHours', 'geo', 'hasMap', 'contactPoint', 'email', 'priceRange', 'areaServed'];

const trimSlash = (u) => (typeof u === 'string' ? u.trim().replace(/\/+$/, '') : '');
const str = (v) => (typeof v === 'string' ? v.trim() : '');

const reason = (code, message) => ({ code, message });

/**
 * @param {object} p
 * @param {object} p.evidence   schemaEvidence for this task's page (after image probes), organization kind
 * @param {object} p.site       live Rank Math organization settings from the Bridge (getSiteSchema().organization)
 * @param {string} p.provider   the Bridge's live SEO provider
 * @param {{projectId: *, connectionId: *, pageUrl: string}} [p.context]  who/where this plan is for. Part of the fingerprint: an approval
 *        is bound to this project, this WordPress connection and this page, never reusable for another.
 * @param {{organizationAddressSupported?: boolean}} [p.capabilities]  what the connected Bridge reports it can do (address writes: Bridge 1.6.0+)
 * @returns {{
 *   status: 'ready'|'nothing_to_change'|'blocked'|'unsupported'|'validation_failed',
 *   code: string|null, message: string|null,
 *   changes: {field: string, label: string, kind: 'set'|'upgrade'|'replace', before: string, after: string, source: string, rankMathOption: string}[],
 *   preserved: {field: string, current: string, proposed: string, reason: string}[],
 *   blocked: {field: string, code: string, message: string}[],
 *   notWritten: {field: string, message: string}[],
 *   fingerprint: string
 * }}
 */
export function planOrganizationFix({ evidence, site, provider, context = {}, capabilities = {} }) {
  const org = evidence?.organization;
  const intent = org?.intent;
  const out = (status, why = {}, extra = {}) => finish({ status, code: why.code || null, message: why.message || null, changes: [], preserved: [], blocked: [], notWritten: [], ...extra }, { evidence, site, context, capabilities });

  if (!intent) return out('validation_failed', reason('NO_SCHEMA_INTENT', 'No schema intent could be determined for this page, so nothing can be applied.'));
  if (provider !== 'rank_math') {
    return out('unsupported', reason('PROVIDER_NOT_SUPPORTED', `Organization settings can only be changed through Rank Math. This site uses ${provider || 'no supported SEO plugin'}.`));
  }
  // A missing ADDRESS holds back only the address (see the address block below): the verified name, logo and type changes of the
  // same fix are independent of it and must not be blocked by an unconfirmed address.
  if (intent.action === 'needs_input' && !intent.addressDemand) {
    return out('validation_failed', reason('EVIDENCE_INCOMPLETE', `A required detail is missing: ${(intent.missing || []).map((m) => m.label).join(', ')}. Provide it, then generate the recommendation again.`));
  }
  if (intent.action === 'reference') {
    return out('nothing_to_change', reason('NO_ENTITY_NEEDED', 'This page needs no organization entity of its own; the site already declares it elsewhere.'));
  }
  if (site.kind !== 'company') {
    return out('unsupported', reason('SITE_IS_PERSON', site.kind === 'person'
      ? 'This site is configured in Rank Math as a person, not a company, so it publishes no Organization entity.'
      : 'Rank Math does not report whether this site is a company or a person (update the Odito SEO Bridge), so the Organization settings are not changed.'));
  }

  // The entity Rank Math publishes always has @id <home>#organization. An existing entity with another @id (or none) was
  // written by a theme or another plugin: editing Rank Math's settings would add a SECOND Organization instead of fixing it.
  const home = org.homepageUrl || '';
  const crawledPrimary = org.site?.primary || org.primary || null;
  const crawledId = org.site?.primary?.id ?? org.primary?.id ?? null;
  if ((org.site?.conflictingIds || []).length > 1 || org.conflictingEntities || (org.duplicateIds || []).length) {
    return out('unsupported', reason('DUPLICATE_ENTITIES', 'The site already outputs more than one organization entity. Resolve the duplicate first; changing a setting would not remove it.'));
  }
  if (crawledPrimary && home && crawledId !== `${home}#organization`) {
    return out('unsupported', reason('ORGANIZATION_SOURCE_UNKNOWN', `An organization entity (${crawledId || 'no @id'}) is published by something other than Rank Math (a theme or another plugin). Editing Rank Math's settings would add a second entity, so Odito does not change it. Edit the source that generates it.`));
  }

  const changes = [];
  const preserved = [];
  const blocked = [];

  // name — verified (page entity -> site entity -> WebSite -> og:site_name)
  const wantName = str(org.name?.value);
  const haveName = str(site.name);
  if (wantName) {
    if (!haveName) changes.push({ field: 'name', kind: 'set', before: '', after: wantName, source: org.name.source });
    else if (haveName !== wantName) preserved.push({ field: 'name', current: haveName, proposed: wantName, reason: 'Rank Math already has a name; Odito does not overwrite an existing value.' });
  }

  // logo — only a fetched-and-confirmed image
  const wantLogo = str(org.logo?.verified?.url);
  const haveLogo = str(site.logo);
  if (wantLogo) {
    if (!haveLogo) changes.push({ field: 'logo', kind: 'set', before: '', after: wantLogo, source: org.logo.verified.source || 'verified_logo' });
    else if (trimSlash(haveLogo) !== trimSlash(wantLogo)) {
      if (org.logo.status === 'replaces_broken_existing') {
        changes.push({ field: 'logo', kind: 'replace', before: haveLogo, after: wantLogo, source: 'verified_logo_replaces_broken' });
      } else {
        preserved.push({ field: 'logo', current: haveLogo, proposed: wantLogo, reason: 'Rank Math already has a logo; Odito does not overwrite an existing value.' });
      }
    }
  }

  // type — the specific schema.org type the intent decided; never a downgrade, never without an address
  const wantType = intent.type;
  const haveType = str(site.type) || 'Organization';
  if (wantType && wantType !== 'Organization') {
    if (typeSatisfies(haveType, wantType)) {
      // already this type, or a more specific one — nothing to do
    } else if (haveType !== 'Organization' && !typeSatisfies(wantType, haveType)) {
      preserved.push({ field: 'type', current: haveType, proposed: wantType, reason: `Rank Math already publishes ${haveType}, which is unrelated to ${wantType}; Odito does not replace a specific type.` });
    } else if (!site.localSeoActive) {
      blocked.push({ field: 'type', code: 'LOCAL_SEO_REQUIRED', message: `Rank Math only publishes a business type such as ${wantType} while its Local SEO module is switched on, and it is off on this site. Enable it in Rank Math → Dashboard → Modules → Local SEO, then apply this fix.` });
    } else if (!site.hasAddress) {
      blocked.push({ field: 'type', code: 'ADDRESS_REQUIRED', message: `${wantType} is a physical location, but no street address is configured in Rank Math → Local SEO. Add the verified address there first; ODITO will not publish a ${wantType} without one.` });
    } else {
      changes.push({ field: 'type', kind: haveType === 'Organization' ? 'upgrade' : 'set', before: str(site.type), after: wantType, source: intent.typeSource || 'schema_intent' });
    }
  }

  // address — only for the finding "the entity has no (complete) address", and only a verified / owner-confirmed one. It is the
  // site's Local SEO address: published by Rank Math (on the Organization entity) only while that module is on.
  const proposal = evidence?.organization?.address?.proposal;
  const addressFinding = !!(intent.addressDemand && intent.action === 'generate' && proposal);
  const display = {};
  if (addressFinding) {
    const want = wireAddress(proposal.fields);
    const have = wireAddress(site.address);
    const wantWire = addressToWire(want);
    const haveWire = addressToWire(have);
    const label = (f) => formatAddress(f);
    if (!capabilities.organizationAddressSupported) {
      blocked.push({ field: 'address', code: 'BRIDGE_UPDATE_REQUIRED', message: 'Writing the business address requires Odito SEO Bridge 1.6.0 or newer. Update the plugin on this WordPress site, then apply this fix.' });
    } else if (!site.localSeoActive) {
      blocked.push({ field: 'address', code: 'LOCAL_SEO_REQUIRED', message: 'Rank Math only publishes a business address while its Local SEO module is switched on, and it is off on this site. Enable it in Rank Math → Dashboard → Modules → Local SEO, then apply this fix.' });
    } else if (!haveWire) {
      changes.push({ field: 'address', kind: 'set', before: '', after: wantWire, source: proposal.status === 'confirmed_by_owner' ? 'owner_confirmed' : (proposal.sources?.[0] || 'verified_address') });
      display.address = { before: '', after: label(want) };
    } else if (haveWire === wantWire) {
      // Rank Math already holds exactly this address; nothing to write.
    } else if (compareFields(have, want).conflicts.length === 0 && Object.keys(want).every((k) => !have[k] || have[k] === want[k])) {
      // Rank Math's address is a part of the approved one (same values, fewer fields): complete it, never contradict it.
      changes.push({ field: 'address', kind: 'complete', before: haveWire, after: wantWire, source: proposal.status === 'confirmed_by_owner' ? 'owner_confirmed' : (proposal.sources?.[0] || 'verified_address') });
      display.address = { before: label(have), after: label(want) };
    } else {
      preserved.push({ field: 'address', current: label(have), proposed: label(want), reason: 'Rank Math already has a different address; Odito does not overwrite an existing value. Review which one is correct in Rank Math → Titles & Meta → Local SEO.' });
    }
  }

  if (intent.addressDemand && intent.action === 'needs_input') {
    const m = intent.missing?.[0];
    blocked.push({
      field: 'address', code: m?.state === 'conflict' ? 'ADDRESS_CONFLICT' : 'ADDRESS_CONFIRMATION_REQUIRED',
      message: m?.why || 'The business address has to be confirmed before it can be applied.',
    });
  }

  const factKeys = Object.keys(intent.facts || {});
  const notWritten = NOT_WRITTEN_FACTS.filter((f) => factKeys.includes(f) && f !== 'address').map((f) => ({ field: f, message: 'Verified for this recommendation but not written by Odito yet — set it in Rank Math → Titles & Meta → Local SEO.' }));
  if (factKeys.includes('address') && !site.hasAddress && !addressFinding) {
    notWritten.push({ field: 'address', message: 'A verified address exists, but Odito does not write the structured Local SEO address yet — enter it in Rank Math → Titles & Meta → Local SEO.' });
  }

  const enriched = changes.map((c) => ({
    ...c, label: ORGANIZATION_FIELDS[c.field].label, rankMathOption: ORGANIZATION_FIELDS[c.field].rankMathOption,
    // Human-readable forms for the screen (the stored before/after of an address is canonical JSON).
    ...(display[c.field] ? { beforeLabel: display[c.field].before, afterLabel: display[c.field].after } : {}),
  }));

  if (!enriched.length && !blocked.length) {
    return out('nothing_to_change', reason('ALREADY_CONFIGURED', 'Rank Math already holds every verified value for this organization; nothing needs to change.'), { preserved, notWritten });
  }
  if (!enriched.length) {
    return out('blocked', blocked[0] ? reason(blocked[0].code, blocked[0].message) : {}, { preserved, blocked, notWritten });
  }
  return out('ready', {}, { changes: enriched, preserved, blocked, notWritten });
}

function finish(plan, { evidence, site, context = {}, capabilities = {} }) {
  const material = JSON.stringify({
    v: ORGANIZATION_PLAN_VERSION,
    t: ORGANIZATION_FIX_TYPE,
    ctx: [String(context.projectId ?? ''), String(context.connectionId ?? ''), String(context.pageUrl ?? '')],
    s: plan.status, c: plan.code,
    ch: plan.changes.map((c) => [c.field, c.kind, c.before, c.after]),
    p: plan.preserved.map((p) => [p.field, p.current, p.proposed]),
    b: plan.blocked.map((b) => [b.field, b.code]),
    live: [site?.name || '', site?.logo || '', site?.type || '', site?.kind || '', !!site?.hasAddress, addressToWire(site?.address), !!site?.localSeoActive],
    cap: !!capabilities?.organizationAddressSupported,
    ev: evidence?.fingerprintKey || null,
  });
  return { ...plan, fingerprint: crypto.createHash('sha256').update(material).digest('hex') };
}

export default { planOrganizationFix, ORGANIZATION_FIELDS, ORGANIZATION_FIX_TYPE };
