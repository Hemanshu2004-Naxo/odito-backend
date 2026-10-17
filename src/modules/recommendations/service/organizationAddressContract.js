/**
 * organizationAddressContract — the typed, validated recommendation for ONE finding: "this Organization entity has no
 * (complete) `address`".
 *
 * It is built only from the evidence (schema-evidence/organizationAddress.js assessment + the page's own entity), never from
 * model text, and it is validated before it is offered. Three separate operations stay separate:
 *   analysis        what is missing, and the proof (entity JSON-LD, detector-equivalent test)      -> `currentState`, `evidence`
 *   recommendation  the exact property to add and where the value came from                        -> `proposal`, `diff`, `state`
 *   modification    NOT here. Nothing in this module (or in generating a recommendation) touches the website; applying is
 *                   the typed WordPress fix, behind an explicit approval (schemaFix/).
 *
 * `state` -> the action the UI offers:
 *   ready               "Review & Apply"   one verified address, a valid minimal change
 *   needs_confirmation  "Confirm Address"  only suggestions exist (partial / unstructured / branch / low trust)
 *   conflict            "Confirm Address"  several different addresses were found; the owner chooses
 *   unavailable         "Confirm Address"  nothing was found; the owner types it
 *   needs_review        "Review Changes"   the entity is ambiguous, or the proposal failed validation
 */

import { ADDRESS_FIELDS, REQUIRED_FOR_PUBLISH, TRUST, comparable, isTrusted, normalizePostalAddress, summarizeAddressAssessment } from '../../schema-evidence/organizationAddress.js';
import { serializeJsonLdForScript } from '../../schema-evidence/breadcrumbHierarchy.js';

export const ADDRESS_CONTRACT_VERSION = 1;
export const ADDRESS_FIX_KIND = 'organization_address';

export const ACTION_FOR_STATE = Object.freeze({
  ready: 'review_and_apply',
  needs_confirmation: 'confirm_address',
  conflict: 'confirm_address',
  unavailable: 'confirm_address',
  needs_review: 'review_changes',
});

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
const stableStringify = (v) => JSON.stringify(v, (_k, val) => (val && typeof val === 'object' && !Array.isArray(val) ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => (a < b ? -1 : 1))) : val));

/** Text that means "a value goes here" rather than a value. Rejected anywhere in a proposed address. */
// Whole-value tokens, template phrases and bracketed templates. Deliberately NOT "starts with a common word": a real
// address can begin with "City Centre Mall" or "The Mall Road".
const PLACEHOLDER_EXACT = /^(?:n\/?a|na|none|null|undefined|tbd|todo|unknown|xxx+|\?+|-+|\.+|street|city|state|country|address|postal code|zip(?: code)?)$/i;
const PLACEHOLDER_PHRASE = /\b(?:verified (?:street|city|state|region|postal|address|locality)|your (?:street|city|address|state|postal|zip)|add (?:your|the) |enter (?:your|the) |placeholder|lorem ipsum|123 (?:main|example|test)\b|example (?:street|city|road|avenue))/i;
const PLACEHOLDER_TEMPLATE = /^<.*>$|^\[.*\]$|^\{.*\}$/;

export const looksLikePlaceholder = (value) => {
  if (typeof value !== 'string') return false;
  const t = value.trim();
  return PLACEHOLDER_EXACT.test(t) || PLACEHOLDER_PHRASE.test(t) || PLACEHOLDER_TEMPLATE.test(t);
};

// ── Diff ──────────────────────────────────────────────────────────────────────

/** Line diff of two JSON documents (LCS). Small inputs only (an entity is a few dozen lines). */
export function diffJsonLines(beforeObj, afterObj) {
  const a = JSON.stringify(beforeObj, null, 2).split('\n');
  const b = JSON.stringify(afterObj, null, 2).split('\n');
  // Adding a last property turns the previous line's `]`/`}`/value into `],`: a punctuation-only change, not a content change.
  const same = (x, y) => x.replace(/,$/, '') === y.replace(/,$/, '');
  const n = a.length; const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) for (let j = m - 1; j >= 0; j -= 1) dp[i][j] = same(a[i], b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const lines = []; let i = 0; let j = 0;
  while (i < n && j < m) {
    if (same(a[i], b[j])) { lines.push({ type: 'context', text: b[j] }); i += 1; j += 1; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { lines.push({ type: 'remove', text: a[i] }); i += 1; }
    else { lines.push({ type: 'add', text: b[j] }); j += 1; }
  }
  while (i < n) { lines.push({ type: 'remove', text: a[i] }); i += 1; }
  while (j < m) { lines.push({ type: 'add', text: b[j] }); j += 1; }
  return lines;
}

/** The entity as it will be after the change: the existing node with ONLY `address` set. Everything else is untouched. */
export function applyAddressToEntity(existingNode, addressValue) {
  const after = clone(existingNode);
  after.address = clone(addressValue);
  return after;
}

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * @param {object} contract  buildOrganizationAddressContract() output
 * @param {{organization: object}} evidence
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateAddressFixContract(contract, evidence) {
  const errors = [];
  const org = evidence?.organization;
  const existing = org?.primary?.node;
  const assessment = org?.address;

  if (!contract || contract.kind !== ADDRESS_FIX_KIND) return { valid: false, errors: ['The recommendation is not an organization address contract.'] };
  if (!contract.requiresApproval || contract.modifiesWebsite) errors.push('A recommendation must require approval and must not modify the website.');
  if (contract.missingProperty !== 'address') errors.push('The missing property must be address.');
  if (!existing) errors.push('There is no existing Organization entity to add the address to.');
  if (contract.state !== 'ready') return { valid: errors.length === 0, errors };

  const p = contract.proposal;
  if (!p || !p.value || typeof p.value !== 'object' || Array.isArray(p.value)) { errors.push('A ready recommendation must carry an address value.'); return { valid: false, errors }; }
  if (!['verified', 'confirmed_by_owner'].includes(p.status)) errors.push('The proposed address is not verified or confirmed by the owner.');

  // Shape: a PostalAddress made of the five known string fields, and nothing else.
  if (p.value['@type'] !== 'PostalAddress') errors.push('The address must be a PostalAddress.');
  for (const [k, v] of Object.entries(p.value)) {
    if (k === '@type') continue;
    if (!ADDRESS_FIELDS.includes(k)) errors.push(`Unexpected property "${k}" in the address.`);
    else if (typeof v !== 'string' || !v.trim()) errors.push(`"${k}" must be non-empty text.`);
    else if (looksLikePlaceholder(v)) errors.push(`"${k}" looks like a placeholder ("${v}"), not a real value.`);
  }
  for (const f of REQUIRED_FOR_PUBLISH) if (!p.value[f]) errors.push(`The address has no ${f}; a street and a city are required before it can be published.`);

  // Traceability: every value must be one a trusted source holds (or the entity already publishes). An address nobody
  // supplied — however well-formed — is exactly what must never reach a customer's site.
  const supplied = [...(assessment?.candidates || []).filter((c) => isTrusted(c.trust) || c.trust === TRUST.USER_CONFIRMED).map((c) => c.fields), assessment?.existing?.fields || {}];
  for (const f of ADDRESS_FIELDS) {
    const v = p.value[f];
    if (!v) continue;
    if (!supplied.some((fields) => fields[f] && comparable(f, fields[f]) === comparable(f, v))) errors.push(`"${f}" ("${v}") is not supported by any verified source or by the address you confirmed.`);
  }

  // Minimal change: the entity after = the entity before + address, same identity, same type, no second entity.
  const diff = contract.diff;
  if (!diff?.after || !diff?.before) errors.push('The recommendation carries no before/after.');
  else {
    const { address: _a, ...beforeRest } = diff.before;
    const { address: afterAddress, ...afterRest } = diff.after;
    if (stableStringify(beforeRest) !== stableStringify(afterRest)) errors.push('The proposed change alters properties other than address.');
    if (stableStringify(afterAddress) !== stableStringify(p.value)) errors.push('The before/after does not match the proposed address.');
    if (existing && stableStringify(diff.before) !== stableStringify(existing)) errors.push('The "before" is not the entity currently on the page.');
    if ((existing?.['@id'] || null) !== (diff.after['@id'] || null)) errors.push('The entity @id must not change.');
    if (stableStringify(existing?.['@type'] ?? null) !== stableStringify(diff.after['@type'] ?? null)) errors.push('The entity type must not change.');
  }
  if (org?.conflictingEntities || (org?.duplicateIds || []).length) errors.push('The page describes the organization more than once; the right entity cannot be identified.');
  if (diff?.changes && (diff.changes.length !== 1 || diff.changes[0].path !== 'address')) errors.push('The change list must contain exactly the address.');
  return { valid: errors.length === 0, errors };
}

// ── Builder ───────────────────────────────────────────────────────────────────

const VERIFY_REQUIREMENTS = Object.freeze([
  'the page is re-crawled after the change is applied',
  'the Organization entity with the same @id carries the intended address',
  'no second Organization entity appears',
  'the page\'s other structured data is still present',
  'the detector\'s own test (the entity has an address) passes on the re-crawled page',
]);

/**
 * @param {object} p
 * @param {object} p.evidence   schema evidence with organization.intent.addressDemand
 * @param {string} p.projectId
 * @param {string} [p.issueId]
 * @returns {object|null}  null when this finding is not an address finding
 */
export function buildOrganizationAddressContract({ evidence, projectId, issueId = 'organization_schema' }) {
  const org = evidence?.organization;
  const intent = org?.intent;
  const assessment = org?.address;
  if (!intent?.addressDemand || !assessment) return null;

  const existing = org.primary?.node || null;
  const state = assessment.state === 'no_change' ? 'needs_review' : assessment.state;
  const proposal = assessment.proposal && assessment.state === 'ready'
    ? { property: 'address', value: clone(assessment.proposal.value), formatted: assessment.proposal.formatted, fieldSources: assessment.proposal.fieldSources, sources: assessment.proposal.sources, status: assessment.proposal.status, confidence: assessment.proposal.confidence, completes: assessment.proposal.completes }
    : null;

  const contract = {
    version: ADDRESS_CONTRACT_VERSION,
    kind: ADDRESS_FIX_KIND,
    issue: { id: issueId, ruleId: 'organization_schema' },
    context: { projectId: String(projectId ?? ''), pageUrl: evidence.url?.crawlKey || evidence.pageUrl, displayUrl: evidence.url?.display || null },
    entity: { id: org.pageId || existing?.['@id'] || null, types: org.primary?.types || [], present: !!existing },
    missingProperty: 'address',
    currentState: {
      addressState: assessment.existing.state,
      present: assessment.existing.state !== 'missing',
      fields: assessment.existing.fields,
      missingParts: assessment.existing.missing,
      // The same test the detector applies (entity.address is empty), run on the stored markup — so the claim rests on
      // evidence and not on a model's say-so.
      confirmedByEvidence: ['missing', 'incomplete'].includes(assessment.existing.state),
    },
    evidence: summarizeAddressAssessment({ ...assessment, proposal: null, alternatives: assessment.alternatives }),
    proposal,
    state,
    action: ACTION_FOR_STATE[state] || 'review_changes',
    reasonCode: assessment.reason || null,
    message: assessment.message || null,
    requiresApproval: true,
    modifiesWebsite: false,
    verification: { requires: [...VERIFY_REQUIREMENTS] },
    diff: null,
    validation: { valid: true, errors: [] },
  };

  if (proposal && existing) {
    const after = applyAddressToEntity(existing, proposal.value);
    contract.diff = {
      before: clone(existing),
      after,
      changes: [{ path: 'address', kind: assessment.existing.state === 'incomplete' ? 'change' : 'add', before: existing.address ?? null, after: clone(proposal.value) }],
      lines: diffJsonLines(existing, after),
    };
  }

  const v = validateAddressFixContract(contract, evidence);
  contract.validation = v;
  if (!v.valid) {
    // A proposal that fails validation is never offered: no Apply, and the owner is asked to review.
    contract.state = 'needs_review';
    contract.action = ACTION_FOR_STATE.needs_review;
    contract.proposal = proposal ? { ...proposal, status: 'rejected' } : null;
    contract.diff = null;
  }
  return contract;
}

/** The merged entity as a JSON-LD script (existing entity + address) — what a manual implementation replaces the entity with. */
export function mergedEntityScript(contract) {
  if (!contract?.diff?.after) return null;
  const node = { '@context': 'https://schema.org', ...contract.diff.after };
  return `<script type="application/ld+json">\n${serializeJsonLdForScript(node)}\n</script>`;
}

export { normalizePostalAddress };
export default { buildOrganizationAddressContract, validateAddressFixContract, diffJsonLines, applyAddressToEntity, mergedEntityScript, looksLikePlaceholder, ACTION_FOR_STATE, ADDRESS_FIX_KIND, ADDRESS_CONTRACT_VERSION };
