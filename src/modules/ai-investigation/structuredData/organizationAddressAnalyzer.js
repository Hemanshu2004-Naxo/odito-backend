/**
 * organizationAddressAnalyzer — "the Organization entity has no (complete) address".
 *
 * Reuses Odito's EXISTING address machinery instead of letting a model draft markup:
 *   schema-evidence/organizationAddress.js   candidates with provenance + trust, assessment, conflict handling
 *   recommendations/service/organizationAddressContract.js   the validated, minimal change contract (placeholders, traceability, no other property touched)
 *   schema-evidence/organizationAddressStore.js   the address the USER confirmed (a user assertion, never an external verification)
 *
 * What it produces is a server-derived analysis plus a SERVER-OWNED proposal:
 *   - address unknown / unconfirmed / conflicting  -> NO publishable payload; a structured explanation of what is missing and why it blocks
 *   - address confirmed and complete               -> the exact property to add to the EXISTING entity (same @id, nothing else changed),
 *                                                     validated on the document it would live in (@context at the right level, one node per @id,
 *                                                     no placeholders). Never a second Organization node.
 * Whatever a model wrote for this finding is discarded by the contract (see `ownsProposal`).
 *
 * Three different things are kept apart and labelled in the output: Odito's audit rule (flags a missing address), schema.org validity
 * (`address` is an optional property), and search-engine guidance (recommended, not required).
 */

import { EVIDENCE_STATUS } from '../evidence/evidenceLedger.js';
import { buildSchemaEvidence, evidenceKindsFor } from '../../schema-evidence/schemaEvidence.js';
import { buildOrganizationAddressContract } from '../../recommendations/service/organizationAddressContract.js';
import { REQUIRED_FOR_PUBLISH, ADDRESS_FIELDS, isTrusted, formatAddress, TRUST, normalizePostalAddress } from '../../schema-evidence/organizationAddress.js';
import { addressHashOf } from '../../schema-evidence/organizationAddressStore.js';
import { analyzeOrganizations, flattenJsonLd } from '../../schema-evidence/schemaGraph.js';
import { looksLikePlaceholder } from '../../recommendations/service/organizationAddressContract.js';
import { looksLikeAddressPlaceholder } from '../../schema-evidence/organizationAddress.js';

const TRUST_LABEL = {
  [TRUST.USER_CONFIRMED]: 'Confirmed by you (a user assertion — not independently verified)',
  [TRUST.SITE_MARKUP]: "Published in this site's own markup",
  [TRUST.VERIFIED_INTEGRATION]: 'From an integration verified to belong to this website',
  [TRUST.OWNER_PROVIDED]: 'Entered by the owner elsewhere in Odito',
  [TRUST.UNVERIFIED]: 'Unverified — a suggestion only, not used as evidence',
};

export const GUIDANCE = Object.freeze({
  auditRule: "Odito's audit rule flags an Organization entity that has no address.",
  schemaOrg: 'On schema.org, `address` is a valid but OPTIONAL property of Organization: an entity without it is still valid markup.',
  searchEngines: "Google's organization structured-data guidance lists `address` as a recommended property, not a required one (check the current documentation for your use case).",
});

const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; } };
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

/** Finds the top-level document that contains `node` (by identity), so the change can be validated where it would live. */
function documentContaining(documents, node) {
  const seen = new Set();
  const has = (value) => {
    if (!value || typeof value !== 'object' || seen.has(value)) return false;
    if (value === node) return true;
    seen.add(value);
    return (Array.isArray(value) ? value : Object.values(value)).some(has);
  };
  return documents.find(has) || null;
}

function replaceNodeAddress(doc, entityId, address) {
  const copy = clone(doc);
  let touched = 0;
  const visit = (v) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach(visit);
    if (v['@id'] === entityId && v['@type']) { v.address = clone(address); touched += 1; }
    Object.values(v).forEach(visit);
  };
  visit(copy);
  return { doc: copy, touched };
}

const nodesWithId = (doc, id) => flattenJsonLd(doc).filter((n) => n['@id'] === id);
const hasContext = (doc) => !!(doc && typeof doc === 'object' && !Array.isArray(doc) && doc['@context']);

/** Checks the document AFTER the change: the only thing that is allowed to differ is the entity's address. */
export function validatePostChangeDocument({ before, entityId, address }) {
  const checks = [];
  if (!before) return { valid: false, checks: [{ name: 'document_located', passed: false, detail: 'The JSON-LD document holding the entity could not be located.' }] };
  const { doc: after, touched } = replaceNodeAddress(before, entityId, address);
  checks.push({ name: 'entity_found_once', passed: touched === 1, detail: touched === 1 ? `Exactly one node with @id ${entityId} is changed.` : `${touched} nodes carry @id ${entityId}; the change would not be unambiguous.` });
  checks.push({ name: 'context_present', passed: hasContext(after) || flattenJsonLd(after).every((n) => !!n['@context']), detail: hasContext(after) ? '@context is set at the document level.' : 'The document has no @context.' });
  const orgNodes = flattenJsonLd(after).filter((n) => [].concat(n['@type'] || []).some((t) => /Organization|LocalBusiness/.test(String(t))));
  const sameId = orgNodes.filter((n) => n['@id'] === entityId);
  checks.push({ name: 'no_second_organization_entity', passed: sameId.length === 1 && orgNodes.length === flattenJsonLd(before).filter((n) => [].concat(n['@type'] || []).some((t) => /Organization|LocalBusiness/.test(String(t)))).length, detail: 'The number of Organization nodes is unchanged and the @id stays unique.' });
  const beforeNode = nodesWithId(before, entityId)[0]; const afterNode = nodesWithId(after, entityId)[0];
  const strip = (n) => { const { address: _a, ...rest } = n || {}; return JSON.stringify(rest); };
  checks.push({ name: 'only_address_changed', passed: !!beforeNode && !!afterNode && strip(beforeNode) === strip(afterNode), detail: 'Every other property of the entity is identical before and after.' });
  const postal = normalizePostalAddress(address);
  checks.push({ name: 'valid_postal_address', passed: !!postal?.structured && postal.complete && address?.['@type'] === 'PostalAddress', detail: postal?.complete ? 'A PostalAddress with the minimum required fields.' : 'The address is not a complete PostalAddress.' });
  const placeholders = ADDRESS_FIELDS.filter((f) => looksLikePlaceholder(String(address?.[f] ?? '')) || looksLikeAddressPlaceholder(String(address?.[f] ?? '')));
  checks.push({ name: 'no_placeholders', passed: placeholders.length === 0, detail: placeholders.length ? `Placeholder-like value in ${placeholders.join(', ')}.` : 'No placeholder text in any field.' });
  return { valid: checks.every((c) => c.passed), checks, afterEntity: afterNode ? clone(afterNode) : null };
}

const BLOCKER = (code, message, action, category = 'information') => ({ code, message, action, category });

export const organizationAddressAnalyzer = {
  id: 'organization_address',
  schemaTypes: ['Organization', 'LocalBusiness'],
  operation: 'address',
  /** The proposal for this finding is built by the server; a model's draft of it is discarded. */
  ownsProposal: true,

  appliesTo: ({ issue, plan }) => plan.family === 'structured_data' && evidenceKindsFor(issue.issueId).includes('organization'),

  async analyze({ ledger, issue, siteUrl, project, deps }) {
    const rawItem = ledger.first('page'); const renItem = ledger.first('rendered_dom');
    const views = [renItem, rawItem].filter((i) => i?.data?.facts);
    if (!views.length) return { status: EVIDENCE_STATUS.UNAVAILABLE, summary: 'No page evidence to analyse the Organization entity from.', data: { analyzerId: 'organization_address', operation: 'address', status: 'unavailable', publishable: false, blockers: [BLOCKER('PAGE_NOT_INSPECTED', 'The live page could not be inspected, so the Organization entity could not be analysed.', 'Retry the investigation when the page is reachable.')], requiresReview: true } };

    const derivedFrom = views.map((v) => v.id);
    const documents = []; const seenDocs = new Set();
    for (const v of views) for (const d of v.data.facts.structuredData?.documents || []) { const k = JSON.stringify(d); if (!seenDocs.has(k)) { seenDocs.add(k); documents.push(d); } }
    const finalUrl = rawItem?.data?.finalUrl || issue.pageUrl;
    const canonical = views.map((v) => v.data.facts.canonicalLinks?.[0]).find(Boolean) || null;
    const generators = [...new Set(views.flatMap((v) => v.data.facts.structuredData?.generators || []))];

    const ctx = (await deps?.loadAddressContext?.(project.id, siteUrl).catch(() => null)) || {};
    const evidence = buildSchemaEvidence({
      issueId: issue.issueId, pageUrl: finalUrl, site: ctx.site || null, profile: ctx.profile || null, addressSources: ctx.addressSources || null,
      pageData: { structured_data: documents, canonical: canonical ? [canonical] : [], meta_tags: {}, title: views[0].data.facts.title, images: [] },
    });
    const org = evidence.organization;
    const entityNode = org.primary?.node || null;
    const entity = {
      present: !!entityNode, id: org.primary?.id || null, types: org.primary?.types || [], countOnPage: org.entityCount, duplicateIds: org.duplicateIds, conflictingEntities: !!org.conflictingEntities,
      homepageUrl: org.homepageUrl, generators, publishedBy: generators.includes('rank_math') ? 'rank_math' : (generators[0] || 'unknown'),
      idIsRankMathOrganization: !!(org.primary?.id && org.homepageUrl && org.primary.id === `${org.homepageUrl}#organization`),
      source: { evidenceId: (renItem?.data?.facts ? renItem : rawItem).id, view: renItem?.data?.facts ? 'rendered DOM' : 'raw HTML' },
    };

    const contract = buildOrganizationAddressContract({ evidence, projectId: project.id, issueId: issue.issueId });
    const assessment = org.address;
    const blockers = [];
    const confirmed = ctx.addressSources?.confirmed || null;

    // candidates, each with where it came from and whether it may be used as evidence
    const candidates = (assessment?.candidates || []).map((c) => {
      const usable = !!(c.structured && c.complete && isTrusted(c.trust));
      return {
        id: c.id, source: c.source, sourceLabel: c.sourceLabel, trust: c.trust, trustLabel: TRUST_LABEL[c.trust] || c.trust, kind: c.kind,
        fields: c.fields, formatted: c.formatted, structured: c.structured, complete: c.complete, missing: c.missing, usable,
        notUsableBecause: usable ? null : (c.detail || (!c.structured ? 'It is free text, not a structured address.' : !c.complete ? `It is missing ${c.missing.join(' and ')}.` : 'Its source is not verified for this website.')),
        note: c.note || null,
      };
    });

    const confirmation = confirmed ? {
      state: 'confirmed_by_user', source: 'user_provided', verifiedExternally: false, fields: confirmed.fields, formatted: formatAddress(confirmed.fields),
      confirmedAt: confirmed.confirmedAt || null, confirmedBy: confirmed.confirmedBy || null, basis: confirmed.basis, revision: confirmed.revision || 1,
      addressHash: confirmed.addressHash || addressHashOf(confirmed.fields), website: confirmed.website || null,
      boundToThisWebsite: !confirmed.website || hostOf(confirmed.website) === hostOf(siteUrl),
      complete: REQUIRED_FOR_PUBLISH.every((f) => confirmed.fields?.[f]),
    } : { state: 'none', source: null, verifiedExternally: false };

    if (!entity.present) blockers.push(BLOCKER('NO_ORGANIZATION_ENTITY', 'No Organization entity was found on this page, so there is nothing to add an address to.', 'Add or enable the Organization entity first.', 'safety'));
    if (entity.conflictingEntities || entity.duplicateIds.length) blockers.push(BLOCKER('DUPLICATE_ORGANIZATION_ENTITY', 'The page outputs more than one Organization entity, so the right one cannot be identified.', 'Remove the duplicate entity first; changing a setting would not remove it.', 'safety'));

    const state = contract?.state || (assessment?.state === 'no_change' ? 'no_change' : 'not_address_finding');
    let proposal = null; let postChange = null;
    if (contract && state === 'ready' && contract.validation?.valid && entity.present) {
      const doc = documentContaining(documents, entityNode);
      postChange = validatePostChangeDocument({ before: doc, entityId: entity.id, address: contract.proposal.value });
      if (!postChange.valid) {
        blockers.push(BLOCKER('PROPOSAL_FAILED_VALIDATION', `The change did not validate on the page's own JSON-LD: ${postChange.checks.filter((c) => !c.passed).map((c) => c.detail).join(' ')}`, 'Review the Organization markup manually.', 'safety'));
      } else {
        proposal = {
          fields: contract.proposal.value && Object.fromEntries(ADDRESS_FIELDS.filter((f) => contract.proposal.value[f]).map((f) => [f, contract.proposal.value[f]])),
          value: contract.proposal.value, formatted: contract.proposal.formatted, status: contract.proposal.status, sources: contract.proposal.sources, fieldSources: contract.proposal.fieldSources,
          addressHash: addressHashOf(contract.proposal.fields || contract.proposal.value), entityId: entity.id, entityAfter: postChange.afterEntity,
          basisLabel: contract.proposal.status === 'confirmed_by_owner' ? 'Confirmed by you (a user assertion — not independently verified)' : 'Verified from a trusted source',
        };
      }
    } else if (contract) {
      if (state === 'ready' && !contract.validation?.valid) blockers.push(BLOCKER('PROPOSAL_FAILED_VALIDATION', `The proposed address did not validate: ${contract.validation.errors.join(' ')}`, 'Confirm the address again with a complete, real value.', 'safety'));
      else if (confirmation.state === 'confirmed_by_user' && ADDRESS_FIELDS.some((f) => looksLikeAddressPlaceholder(String(confirmed?.fields?.[f] ?? '')) || looksLikePlaceholder(String(confirmed?.fields?.[f] ?? '')))) blockers.push(BLOCKER('PROPOSAL_FAILED_VALIDATION', 'The stored address contains placeholder-like text, so it cannot be published.', 'Confirm the address again with a complete, real value.', 'safety'));
      else if (state === 'conflict') blockers.push(BLOCKER('ADDRESS_CONFLICT', 'Different addresses were found and Odito will not choose between them.', 'Confirm which address is the organization\'s.'));
      else if (state === 'needs_review') { if (!blockers.length) blockers.push(BLOCKER('ENTITY_AMBIGUOUS', contract.message || 'The entity could not be identified unambiguously.', 'Resolve the duplicate or ambiguous entity first.', 'safety')); }
      else if (['needs_confirmation', 'unavailable'].includes(state)) {
        const partial = candidates.find((c) => !c.usable && Object.keys(c.fields).length);
        blockers.push(BLOCKER('ADDRESS_UNCONFIRMED', `The business address is unknown: ${contract.message || 'no complete, verified address is available'}${partial ? ` A partial suggestion exists (${partial.sourceLabel}: "${partial.formatted}") but it is not verified for this website and is incomplete (needs ${REQUIRED_FOR_PUBLISH.join(' and ')}).` : ''}`, 'Confirm the business address: street address and city are required; region, postal code and country are optional and are never guessed.'));
      }
    }
    if (confirmation.state === 'confirmed_by_user' && !confirmation.boundToThisWebsite) blockers.push(BLOCKER('CONFIRMATION_FOR_OTHER_WEBSITE', 'The stored address confirmation was given for a different website and is not used.', 'Confirm the address again for this website.', 'safety'));

    const publishable = !!proposal && !blockers.some((b) => b.category === 'safety');
    const rankMathRoute = {
      adapter: 'rank_math_local_seo', applicable: entity.publishedBy === 'rank_math' && entity.idIsRankMathOrganization && !entity.duplicateIds.length && !entity.conflictingEntities,
      reason: entity.publishedBy !== 'rank_math' ? 'The page does not show Rank Math as the source of the Organization markup.'
        : !entity.idIsRankMathOrganization ? `The entity @id (${entity.id || 'none'}) is not the one Rank Math generates (${org.homepageUrl}#organization); Rank Math's settings would add a second entity.`
          : 'The entity looks like the one Rank Math generates (its @id and script class). This is a LIKELY route: the installed Rank Math version and its Local SEO configuration are not confirmed until the WordPress connection is read.',
      confirmed: false,
    };

    const data = {
      analyzerId: 'organization_address', schemaTypes: ['Organization', 'LocalBusiness'], operation: 'address', status: state,
      reasonCode: contract?.reasonCode || assessment?.reason || null, message: contract?.message || assessment?.message || null,
      entity, existingAddress: assessment?.existing ? { state: assessment.existing.state, fields: assessment.existing.fields, missing: assessment.existing.missing } : null,
      guidance: GUIDANCE, minimumRequired: [...REQUIRED_FOR_PUBLISH], candidates, confirmation, proposal, publishable,
      validation: { contract: contract?.validation || null, postChange: postChange ? { valid: postChange.valid, checks: postChange.checks } : null },
      blockers, rankMathRoute, requiresReview: !publishable,
      absenceSupport: { property: 'address', existing: assessment?.existing?.state || null, evidenceId: entity.source.evidenceId },
    };
    return {
      status: EVIDENCE_STATUS.OK, derivedFrom,
      summary: publishable ? `Organization address ready to propose (${proposal.basisLabel}); entity ${entity.id} preserved.`
        : `Organization address ${state === 'no_change' ? 'already present' : 'cannot be proposed yet'}: ${blockers[0]?.code || data.reasonCode || state}.`,
      data,
    };
  },

  /**
   * The server-owned remediation for this finding: replaces whatever the model drafted.
   * @returns {{ status: 'publishable'|'blocked'|'awaiting_information'|'none', codeOrConfiguration: object[], proposedChanges: object[], implementationPlan: object[], blockers: object[], bindings: object }}
   */
  shapeProposal({ analysis, issueStatus }) {
    const a = analysis?.data;
    if (!a) return { status: 'none', codeOrConfiguration: [], proposedChanges: [], implementationPlan: [], blockers: [BLOCKER('ANALYSIS_UNAVAILABLE', 'The Organization entity could not be analysed.', 'Retry the investigation.', 'safety')], bindings: {} };
    if (a.status === 'no_change' || issueStatus === 'already_resolved') return { status: 'none', codeOrConfiguration: [], proposedChanges: [], implementationPlan: [], blockers: [], bindings: {} };
    const bindings = { entityId: a.entity?.id || null, website: a.entity?.homepageUrl || null, addressHash: a.proposal?.addressHash || null, addressStatus: a.proposal?.status || null };

    if (!a.publishable) {
      const awaiting = a.blockers.some((b) => ['ADDRESS_UNCONFIRMED', 'ADDRESS_CONFLICT'].includes(b.code)) && !a.blockers.some((b) => b.category === 'safety');
      return {
        status: awaiting ? 'awaiting_information' : 'blocked', codeOrConfiguration: [], proposedChanges: [], blockers: a.blockers, bindings,
        implementationPlan: awaiting ? [
          { detail: 'Confirm the business address in Odito. Street address and city are required; region, postal code and country are optional and will not be guessed. You are asserting the address is correct; Odito does not verify it independently.', owner: 'site_owner' },
          { detail: 'Re-run the investigation. Odito will then build the exact change for the existing Organization entity and show it for your review. Confirming an address does not approve or apply anything.', owner: 'odito' },
        ] : [{ detail: a.blockers.map((b) => `${b.message} ${b.action}`).join(' '), owner: 'developer' }],
      };
    }
    const fragment = { address: a.proposal.value };
    return {
      status: 'publishable', blockers: [], bindings,
      routeNote: a.rankMathRoute.reason,
      codeOrConfiguration: [{
        language: 'json-fragment', purpose: `Property to add to the EXISTING Organization node (${a.entity.id}). Not a standalone script: publishing it as a separate block would create a competing Organization entity.`,
        content: JSON.stringify(fragment, null, 2), serverOwned: true, notes: [`@context stays on the page's existing JSON-LD document; the entity's @id, type and every other property are unchanged (validated on the document it lives in).`],
      }],
      proposedChanges: [{
        changeType: 'add', target: { url: a.entity.homepageUrl, selector: `Organization node @id ${a.entity.id}`, location: 'existing JSON-LD graph' }, before: null,
        after: JSON.stringify(fragment.address), description: `Add the ${a.proposal.status === 'confirmed_by_owner' ? 'user-confirmed' : 'verified'} PostalAddress (${a.proposal.formatted}) to the existing Organization entity.`,
      }],
      implementationPlan: [
        a.rankMathRoute.applicable
          ? { detail: `Likely route: Rank Math → Titles & Meta → Local SEO, enter the address "${a.proposal.formatted}" (the Local SEO module must be on for Rank Math to publish it). Confirm the exact menu in your installed Rank Math version; Odito has not verified it.`, owner: 'site_owner' }
          : { detail: `Add the address property to the source that generates the Organization entity (${a.entity.publishedBy}); do not add a second Organization block.`, owner: 'developer' },
        { detail: `After saving, re-fetch the page: exactly one Organization node (${a.entity.id}) should carry the address and every other property should be unchanged.`, owner: 'site_owner' },
        { detail: "Re-run Odito's check (re-crawl) to confirm the detector no longer reports a missing address. Odito does not mark it fixed before that.", owner: 'odito' },
      ],
    };
  },

  /** Checklist records for this finding (id, status: passed|failed|blocked|not_run, detail, action). Derived only from the analysis. */
  describeChecks({ analysis }) {
    const a = analysis?.data;
    if (!a) return [];
    const out = [];
    const info = a.blockers.find((b) => ['ADDRESS_UNCONFIRMED', 'ADDRESS_CONFLICT'].includes(b.code));
    out.push(a.proposal
      ? { id: 'address_confirmed_and_complete', status: 'passed', detail: `${a.proposal.basisLabel}: ${a.proposal.formatted}.`, action: null, category: 'information' }
      : info ? { id: 'address_confirmed_and_complete', status: 'blocked', detail: info.message, action: info.action, category: 'information' }
        : { id: 'address_confirmed_and_complete', status: a.status === 'no_change' ? 'not_run' : 'failed', detail: a.status === 'no_change' ? 'The entity already has an address; nothing to confirm.' : (a.message || 'No usable address.'), action: null, category: 'information' });
    const entityOk = a.entity?.present && !a.entity.duplicateIds?.length && !a.entity.conflictingEntities;
    out.push({ id: 'entity_identified_once', status: entityOk ? 'passed' : 'failed', detail: entityOk ? `One Organization entity (${a.entity.id || 'no @id'}) was identified in the ${a.entity.source.view}.` : (a.blockers.find((b) => ['NO_ORGANIZATION_ENTITY', 'DUPLICATE_ORGANIZATION_ENTITY'].includes(b.code))?.message || 'The Organization entity could not be identified.'), action: entityOk ? null : 'Resolve the missing or duplicate Organization entity first.', category: 'safety' });
    const pc = a.validation?.postChange;
    out.push(pc ? { id: 'post_change_document_valid', status: pc.valid ? 'passed' : 'failed', detail: pc.valid ? "The change validates on the page's own JSON-LD document: @context present, one node per @id, only address changed." : pc.checks.filter((c) => !c.passed).map((c) => c.detail).join(' '), action: pc.valid ? null : 'Review the Organization markup manually.', category: 'safety' }
      : { id: 'post_change_document_valid', status: 'not_run', detail: 'No change was built (the address is not confirmed), so there is no document to validate.', action: 'Confirm the address, then re-run.', category: 'information' });
    return out;
  },

  /** Kept for registry symmetry; the model's own Organization markup is never validated or published (see ownsProposal). */
  validateProposal() { return { checks: [], requiresReview: true }; },
};

export default organizationAddressAnalyzer;
