/**
 * investigationContract — the validated shape of an investigation result, and the guards between the model and everything else.
 *
 * Nothing the model writes reaches the UI or an adapter without passing `validateModelOutput`. The validator:
 *   - enforces enums, types and length caps (unknown keys are dropped, so a model cannot smuggle "fixApplied: true")
 *   - grounds claims: evidence ids must exist and have been retrieved successfully; URLs in proposed code must come
 *     from collected evidence (no invented parents / images / profiles)
 *   - lints JSON-LD it is asked to emit (valid JSON, @context/@type, contiguous BreadcrumbList positions)
 *   - flags a proposal that would duplicate a structured-data type the live page already outputs
 *   - OVERRIDES automatic-fix eligibility with Odito's own capability resolution — the model can never grant itself an adapter
 *   - always sets requiresHumanApproval when any change is proposed
 *
 * The lifecycle (proposed / applied / verified) is server-owned and starts as "proposed" only.
 */

import { EVIDENCE_STATUS } from '../evidence/evidenceLedger.js';
import { ELIGIBILITY } from '../capabilities/fixCapabilities.js';
import { assessFindings, renderedStateGap, BASIS } from './evidenceBasis.js';
import { analyzersForTypes, analyzerById } from '../structuredData/registry.js';

export const CONTRACT_VERSION = 3;

export const ENUMS = Object.freeze({
  investigationStatus: ['complete', 'partial', 'blocked', 'insufficient_evidence'],
  issueStatus: ['confirmed', 'already_resolved', 'partially_present', 'uncertain'],
  confidenceLabel: ['high', 'medium', 'low'],
  rootCauseCategory: ['page_markup', 'shared_template', 'cms_setting', 'plugin', 'rendering', 'server_response', 'content', 'configuration', 'crawl_directive', 'unknown'],
  solutionMethod: ['automatic_fix', 'manual_code_change', 'cms_configuration', 'content_edit', 'server_configuration', 'no_action', 'needs_more_information'],
  owner: ['odito', 'site_owner', 'developer', 'content_editor'],
  changeType: ['add', 'modify', 'remove', 'configure'],
  severity: ['low', 'medium', 'high'],
});

const LIMITS = Object.freeze({ summary: 700, text: 1200, code: 12_000, items: 12, evidence: 20, steps: 15, codeBlocks: 4 });
const SAFE_URL_HOSTS = ['schema.org', 'www.w3.org', 'json-schema.org', 'ogp.me', 'purl.org'];

export class ContractError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'ContractError'; this.code = code; this.details = details; }
}

const str = (v, max = LIMITS.text) => (typeof v === 'string' ? v.replace(/\u0000/g, '').trim().slice(0, max) : '');
const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);
const arr = (v, max = LIMITS.items) => (Array.isArray(v) ? v.slice(0, max) : []);

/** Pulls the JSON object out of a model reply (plain, fenced, or surrounded by prose). */
export function extractJson(text) {
  const raw = String(text ?? '').trim();
  if (!raw) throw new ContractError('EMPTY_OUTPUT', 'The model returned no content.');
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [raw, fenced?.[1]].filter(Boolean);
  const start = raw.indexOf('{'); const end = raw.lastIndexOf('}');
  if (start !== -1 && end > start) candidates.push(raw.slice(start, end + 1));
  for (const c of candidates) {
    try { const v = JSON.parse(c); if (v && typeof v === 'object' && !Array.isArray(v)) return v; } catch { /* try next */ }
  }
  throw new ContractError('MALFORMED_JSON', 'The model output was not valid JSON.');
}

// ── Grounding helpers ───────────────────────────────────────────────────────────────────
const URL_RE = /https?:\/\/[^\s"'<>\\)\]},]+/gi;
const normUrl = (u) => String(u).replace(/[#].*$/, '').replace(/\/+$/, '').toLowerCase();

/** Every URL that appears in successfully retrieved evidence (plus the page and site). */
export function collectKnownUrls(ledger, { pageUrl, siteUrl } = {}) {
  const known = new Set();
  const add = (u) => { if (u) known.add(normUrl(u)); };
  add(pageUrl); add(siteUrl);
  try { add(new URL(pageUrl).origin); } catch { /* ignore */ }
  for (const item of ledger.ok) {
    add(item.url);
    const blob = JSON.stringify(item.data ?? '');
    for (const m of blob.match(URL_RE) || []) add(m.replace(/\\+$/, ''));
  }
  return known;
}

const isSafeSpecUrl = (u) => { try { return SAFE_URL_HOSTS.includes(new URL(u).hostname.toLowerCase()); } catch { return false; } };

export function findUngroundedUrls(text, known) {
  const out = new Set();
  for (const m of String(text || '').match(URL_RE) || []) {
    const clean = m.replace(/[.,;]+$/, '');
    if (isSafeSpecUrl(clean)) continue;
    if (!known.has(normUrl(clean))) out.add(clean);
  }
  return [...out].slice(0, 10);
}

/** Lints an emitted JSON-LD string. Returns { valid, types, problems[] }. */
export function lintJsonLd(content) {
  const problems = [];
  let parsed;
  // A <script type="application/ld+json"> wrapper is how this markup is actually embedded: accept exactly that wrapper, nothing else.
  const wrapped = String(content).trim().match(/^<script\s+type=["']application\/ld\+json["']\s*>([\s\S]*)<\/script>$/i);
  if (wrapped) content = wrapped[1];
  try { parsed = JSON.parse(content); } catch (e) { return { valid: false, types: [], problems: [`Not valid JSON: ${e.message}`] }; }
  const types = new Set();
  const nodes = [].concat(parsed?.['@graph'] ?? parsed);
  if (!parsed?.['@context'] && !nodes.some((n) => n?.['@context'])) problems.push('Missing @context.');
  const walk = (n, depth = 0) => {
    if (!n || typeof n !== 'object' || depth > 8) return;
    if (Array.isArray(n)) return n.forEach((x) => walk(x, depth + 1));
    [].concat(n['@type'] || []).forEach((t) => typeof t === 'string' && types.add(t));
    if ([].concat(n['@type'] || []).includes('BreadcrumbList')) {
      const items = [].concat(n.itemListElement || []);
      if (!items.length) problems.push('BreadcrumbList has no itemListElement.');
      items.forEach((it, i) => {
        if (Number(it?.position) !== i + 1) problems.push(`BreadcrumbList position ${it?.position ?? 'missing'} at index ${i} (expected ${i + 1}).`);
        if (!str(it?.name ?? it?.item?.name)) problems.push(`BreadcrumbList item ${i + 1} has no name.`);
        if (!it?.item && i !== items.length - 1) problems.push(`BreadcrumbList item ${i + 1} has no item URL (only the last item may omit it).`);
      });
    }
    Object.values(n).forEach((v) => v && typeof v === 'object' && walk(v, depth + 1));
  };
  nodes.forEach((n) => walk(n));
  if (!types.size) problems.push('No @type found.');
  return { valid: problems.length === 0, types: [...types], problems };
}

/** The JSON-LD nodes (flattening @graph) of an emitted block, or [] when it does not parse. */
export function parseJsonLdNodes(content) {
  const wrapped = String(content).trim().match(/^<script\s+type=["']application\/ld\+json["']\s*>([\s\S]*)<\/script>$/i);
  try {
    const parsed = JSON.parse(wrapped ? wrapped[1] : content);
    const out = [];
    const visit = (n, d = 0) => { if (!n || typeof n !== 'object' || d > 6) return; if (Array.isArray(n)) return n.forEach((x) => visit(x, d + 1)); out.push(n); if (n['@graph']) visit(n['@graph'], d + 1); };
    visit(parsed);
    return out;
  } catch { return []; }
}

// ── Checklist records ─────────────────────────────────────────────────────────────────────
export const CHECK_STATUS = Object.freeze({ PASSED: 'passed', FAILED: 'failed', BLOCKED: 'blocked', NOT_RUN: 'not_run' });
const CHECK_LABELS = {
  live_page_inspected: 'Live page inspected',
  rendered_state_known: 'Rendered state known',
  issue_supported_by_evidence: 'Issue supported by evidence',
  absence_claims_established: '"Missing" claims established',
  urls_backed_by_evidence: 'URLs backed by evidence',
  markup_syntactically_valid: 'Markup is syntactically valid',
  no_duplicate_markup: 'No duplicate markup',
  no_unresolved_placeholders: 'No unresolved placeholders',
  concrete_proposal_present: 'Concrete proposal can be built',
  automatic_fix_capability: 'Supported CMS capability for automatic apply',
  address_confirmed_and_complete: 'Address confirmed and complete',
  entity_identified_once: 'Organization entity identified once',
  post_change_document_valid: 'Change validates on the JSON-LD document',
  breadcrumb_hierarchy_verified: 'Hierarchy verified',
  breadcrumb_urls_in_hierarchy: 'Every URL is a verified level',
  breadcrumb_last_is_current_page: 'Last item is this page',
  breadcrumb_length_matches_hierarchy: 'Same number of levels',
  breadcrumb_parent_urls_reachable: 'Parent URLs reachable',
  breadcrumb_labels_match_evidence: 'Labels match the evidence',
};
const FALLBACK_DETAIL = { passed: 'Passed.', failed: 'Failed (no detail was recorded).', blocked: 'Blocked (no detail was recorded).', not_run: 'Not run.' };
const BLOCKER_CODE_FOR_CHECK = {
  live_page_inspected: 'PAGE_NOT_INSPECTED', rendered_state_known: 'RENDERED_STATE_UNKNOWN', issue_supported_by_evidence: 'ISSUE_NOT_SUPPORTED',
  absence_claims_established: 'ABSENCE_NOT_ESTABLISHED', urls_backed_by_evidence: 'URL_NOT_BACKED_BY_EVIDENCE', markup_syntactically_valid: 'MARKUP_INVALID',
  no_duplicate_markup: 'DUPLICATE_MARKUP', no_unresolved_placeholders: 'UNRESOLVED_PLACEHOLDERS', concrete_proposal_present: 'NO_PROPOSAL',
  address_confirmed_and_complete: 'ADDRESS_UNCONFIRMED', entity_identified_once: 'ENTITY_NOT_IDENTIFIED', post_change_document_valid: 'PROPOSAL_FAILED_VALIDATION',
  breadcrumb_hierarchy_verified: 'HIERARCHY_UNVERIFIED',
};
const CAPABILITY_CODE = {
  wordpress_connection: 'WORDPRESS_NOT_CONNECTED', odito_seo_bridge: 'BRIDGE_NOT_INSTALLED', odito_seo_bridge_organization_address: 'BRIDGE_ADDRESS_UNSUPPORTED',
  single_active_seo_plugin: 'SEO_PLUGIN_AMBIGUOUS', rank_math_local_seo_module: 'LOCAL_SEO_MODULE_OFF', rank_math_site_settings_unreadable: 'SITE_SETTINGS_UNREADABLE',
  seo_plugin_rank_math: 'PROVIDER_NOT_RANK_MATH', rank_math_company_entity: 'RANK_MATH_NOT_COMPANY',
};

const PLACEHOLDER_PATTERNS = [
  /\[[A-Z][A-Z0-9 _\/-]{2,}\]/, /<[A-Z][A-Z0-9 _-]{3,}>/, /\b(?:YOUR|REPLACE|INSERT|ENTER)[_ ][A-Z_ ]{3,}\b/, /\bplaceholder\b/i, /replace (?:all|with|these)\b/i,
  /lorem ipsum/i, /\b123 (?:main|example|test)\b/i, /\bTODO\b/, /\bx{3,}\b/i, /\b(?:street|city|state|postal code|zip)(?: address)? goes here\b/i,
];
/** Unresolved placeholder text anywhere in proposed code or changes ("[STREET ADDRESS]", "YOUR_CITY", "replace ALL placeholder values"...). */
export function scanPlaceholders(codeBlocks = [], changes = []) {
  const texts = [...codeBlocks.map((b) => b.content), ...changes.flatMap((c) => [c.before, c.after, c.description])].filter((t) => typeof t === 'string');
  const hits = [];
  for (const t of texts) for (const p of PLACEHOLDER_PATTERNS) { const m = t.match(p); if (m && !hits.includes(m[0])) hits.push(m[0]); }
  return hits.slice(0, 6);
}

// ── The validator ───────────────────────────────────────────────────────────────────────
/**
 * @param {object|string} rawOutput parsed object or raw model text
 * @param {{ ledger: import('../evidence/evidenceLedger.js').EvidenceLedger, capabilities: object, pageUrl: string, siteUrl?: string }} ctx
 * @returns {{ ok: true, value: object, warnings: string[] } | { ok: false, errors: string[] }}
 */
export function validateModelOutput(rawOutput, ctx) {
  const { ledger, capabilities, pageUrl, siteUrl } = ctx;
  let src;
  try { src = typeof rawOutput === 'string' ? extractJson(rawOutput) : rawOutput; } catch (e) { return { ok: false, errors: [e.message] }; }
  if (!src || typeof src !== 'object' || Array.isArray(src)) return { ok: false, errors: ['Output is not an object.'] };

  const errors = [];
  for (const required of ['summary', 'issueStatus', 'investigationStatus']) {
    if (typeof src[required] !== 'string' || !src[required].trim()) errors.push(`"${required}" is required.`);
  }
  if (src.investigationStatus && !ENUMS.investigationStatus.includes(src.investigationStatus)) errors.push(`investigationStatus must be one of ${ENUMS.investigationStatus.join(', ')}.`);
  if (src.issueStatus && !ENUMS.issueStatus.includes(src.issueStatus)) errors.push(`issueStatus must be one of ${ENUMS.issueStatus.join(', ')}.`);
  if (errors.length) return { ok: false, errors };

  const warnings = [];
  const okIds = new Map(ledger.ok.map((i) => [i.id, i]));
  const known = collectKnownUrls(ledger, { pageUrl, siteUrl });

  // Evidence: only references to things that were actually retrieved.
  const evidence = [];
  for (const e of arr(src.evidence, LIMITS.evidence)) {
    const id = str(e?.evidenceId, 20);
    if (!okIds.has(id)) { warnings.push(`Dropped evidence reference "${id || '?'}": no such successfully retrieved evidence.`); continue; }
    evidence.push({ evidenceId: id, kind: okIds.get(id).kind, finding: str(e?.finding, 400) });
  }

  // Findings: every material statement, with a basis the SERVER derives from what was actually retrieved (not from the model's label).
  const rawFindings = Array.isArray(src.findings) && src.findings.length
    ? src.findings
    : evidence.map((e) => ({ statement: e.finding || `Evidence ${e.evidenceId} (${e.kind})`, evidenceIds: [e.evidenceId], basis: 'observed' }));
  const { findings, downgrades } = assessFindings(rawFindings, ledger);
  warnings.push(...downgrades);

  // Code / configuration blocks, linted and URL-grounded. Duplicate detection looks at the raw HTML AND the rendered DOM.
  const livePageTypes = new Set([
    ...(ledger.first('page')?.data?.facts?.structuredData?.jsonLdTypes || []),
    ...(ledger.first('rendered_dom')?.data?.facts?.structuredData?.jsonLdTypes || []),
  ]);
  const codeOrConfiguration = [];
  const analyzerChecks = [];
  let ungrounded = false; let duplicateRisk = false; let lintFailed = false;
  for (const block of arr(src.codeOrConfiguration, LIMITS.codeBlocks)) {
    const content = str(block?.content, LIMITS.code);
    if (!content) continue;
    const language = str(block?.language, 20).toLowerCase() || 'text';
    const entry = { language, purpose: str(block?.purpose, 300), content, notes: [] };
    const bad = findUngroundedUrls(content, known);
    if (bad.length) { ungrounded = true; entry.notes.push(`URLs not found in collected evidence: ${bad.join(', ')}`); warnings.push(`Proposed code contains URLs not backed by evidence: ${bad.join(', ')}`); }
    if (['json', 'json-ld', 'jsonld', 'application/ld+json'].includes(language) || /"@context"/.test(content)) {
      const lint = lintJsonLd(content);
      entry.jsonLd = { valid: lint.valid, types: lint.types, problems: lint.problems };
      if (!lint.valid) { lintFailed = true; entry.notes.push(...lint.problems); warnings.push(`JSON-LD problems: ${lint.problems.join(' ')}`); }
      const dup = lint.types.filter((t) => livePageTypes.has(t));
      if (lint.valid) {
        // Schema-family analyzers (e.g. breadcrumb hierarchy) judge the proposal against facts derived from the evidence.
        const nodes = parseJsonLdNodes(content);
        for (const analyzer of analyzersForTypes(lint.types)) {
          const analysis = [...ledger.items].reverse().find((i) => i.kind === 'structured_analysis' && i.data?.analyzerId === analyzer.id && i.status === 'ok') || null;
          for (const node of nodes.filter((n) => [].concat(n['@type'] || []).some((t) => analyzer.schemaTypes.includes(t)))) {
            const res = analyzer.validateProposal({ node, analysis });
            analyzerChecks.push(...res.checks.map((c) => ({ ...c, analyzer: analyzer.id })));
            for (const c of res.checks.filter((x) => !x.passed)) entry.notes.push(c.detail);
          }
        }
      }
      if (dup.length && src.issueStatus !== 'partially_present') { duplicateRisk = true; entry.notes.push(`The live page already outputs ${dup.join(', ')}; adding another could create duplicate/conflicting markup.`); warnings.push(`Possible duplicate structured data: ${dup.join(', ')} already present.`); }
    }
    codeOrConfiguration.push(entry);
  }

  const proposedChanges = arr(src.proposedChanges).map((c) => {
    const after = str(c?.after, 2000);
    const bad = findUngroundedUrls(after, known);
    if (bad.length) { ungrounded = true; warnings.push(`Proposed change contains URLs not backed by evidence: ${bad.join(', ')}`); }
    return {
      changeType: oneOf(c?.changeType, ENUMS.changeType, 'modify'),
      target: { url: str(c?.target?.url, 500) || null, selector: str(c?.target?.selector, 200) || null, location: str(c?.target?.location, 300) || null },
      before: str(c?.before, 1500) || null, after: after || null, description: str(c?.description, 500),
    };
  });

  // ── Server-owned proposals ───────────────────────────────────────────────────────────────
  // Where Odito builds the remediation itself from verified facts (e.g. the Organization address), whatever the model drafted is DISCARDED:
  // the model explains, it never authors the publishable payload. With unconfirmed facts there is no payload at all.
  let codeFinal = codeOrConfiguration; let changesFinal = proposedChanges; let planOverride = null;
  let proposalStatus = null; let proposalBindings = {}; let routeNote = null;
  const ownerBlockers = []; const discardedModelProposal = [];
  const ownerAnalyses = ledger.items.filter((i) => i.kind === 'structured_analysis' && i.status === 'ok' && analyzerById(i.data?.analyzerId)?.ownsProposal);
  for (const an of ownerAnalyses) {
    const shaped = analyzerById(an.data.analyzerId).shapeProposal({ analysis: an, issueStatus: src.issueStatus });
    if (codeOrConfiguration.length || proposedChanges.length) {
      discardedModelProposal.push({
        analyzerId: an.data.analyzerId, codeBlocks: codeOrConfiguration.length, changes: proposedChanges.length,
        reason: shaped.status === 'publishable' ? 'Replaced by the change Odito built from confirmed facts for the existing entity.' : 'Withheld: the required facts are not confirmed, so no publishable payload exists.',
      });
      warnings.push(`The model's own draft for this finding was discarded (${discardedModelProposal[discardedModelProposal.length - 1].reason})`);
    }
    codeFinal = shaped.codeOrConfiguration; changesFinal = shaped.proposedChanges; planOverride = shaped.implementationPlan;
    proposalStatus = shaped.status; proposalBindings = shaped.bindings || {}; routeNote = shaped.routeNote || routeNote; ownerBlockers.push(...shaped.blockers);
    ungrounded = false; duplicateRisk = false; lintFailed = false; analyzerChecks.length = 0; // those flags described the discarded draft
  }

  // Confidence: cannot be high without grounded evidence.
  let score = Math.min(1, Math.max(0, Number(src.confidence?.score ?? src.confidence) || 0));
  let label = oneOf(src.confidence?.label, ENUMS.confidenceLabel, score >= 0.75 ? 'high' : score >= 0.4 ? 'medium' : 'low');
  let investigationStatus = src.investigationStatus; let issueStatus = src.issueStatus;
  if (!evidence.length && issueStatus !== 'uncertain') {
    warnings.push('No grounded evidence cited; diagnosis downgraded to uncertain.');
    issueStatus = 'uncertain'; score = Math.min(score, 0.3); label = 'low';
    if (investigationStatus === 'complete') investigationStatus = 'insufficient_evidence';
  }
  if ((ungrounded || lintFailed) && label === 'high') { label = 'medium'; score = Math.min(score, 0.6); }
  if (!ledger.first('page') && investigationStatus === 'complete') { investigationStatus = 'partial'; warnings.push('The live page could not be inspected; status set to partial.'); }
  const renderGap = renderedStateGap(ledger);
  if (renderGap && investigationStatus === 'complete') { investigationStatus = 'partial'; warnings.push('The rendered state of the page is unknown; status set to partial.'); }

  // ── Checks: every one is a record whose status the SERVER decided (passed | failed | blocked | not_run) ──────────────────
  // Confidence is NOT a check, "the code parses" is not safety, and a check that could not run is "not_run", never "passed".
  const rec = (id, status, detail, action = null, category = 'safety') => ({
    id, name: id, label: CHECK_LABELS[id] || id.replace(/_/g, ' '), status, passed: status === CHECK_STATUS.PASSED,
    detail: str(detail, 500) || FALLBACK_DETAIL[status], action: action ? str(action, 300) : null, category,
  });
  const hasContent = codeFinal.length + changesFinal.length > 0;
  const jsonLdBlocks = codeFinal.filter((blk) => blk.jsonLd);
  const placeholderHits = scanPlaceholders(codeFinal, changesFinal);
  const supported = findings.filter((f) => f.basis === BASIS.OBSERVED || f.basis === BASIS.CORROBORATED);
  const overclaimed = findings.filter((f) => f.absence && f.basis === BASIS.UNKNOWN && f.overclaimed);
  const acknowledgedUnknowns = findings.filter((f) => f.basis === BASIS.UNKNOWN && !f.overclaimed);

  const analyzerRecords = [];
  for (const an of ownerAnalyses) for (const r of analyzerById(an.data.analyzerId).describeChecks?.({ analysis: an }) || []) analyzerRecords.push(rec(r.id, r.status, r.detail, r.action, r.category));
  const INFO_CHECKS = new Set(['breadcrumb_hierarchy_verified']);
  for (const c of analyzerChecks.filter((x, i, all) => all.findIndex((y) => y.name === x.name && y.detail === x.detail) === i)) {
    const info = INFO_CHECKS.has(c.name);
    analyzerRecords.push(rec(c.name, c.passed ? CHECK_STATUS.PASSED : (info ? CHECK_STATUS.BLOCKED : CHECK_STATUS.FAILED), c.detail, c.passed ? null : (info ? 'Confirm the missing parent page or label in the review panel.' : 'Correct the proposal.'), info ? 'information' : 'safety'));
  }

  const nonOwnedStatus = !hasContent ? 'none'
    : [...(placeholderHits.length ? [1] : []), ...(ungrounded || lintFailed || duplicateRisk ? [1] : []), ...analyzerRecords.filter((r) => r.status === 'failed')].length ? 'blocked'
      : analyzerRecords.some((r) => r.status === 'blocked') ? 'awaiting_information' : 'publishable';
  if (!ownerAnalyses.length) proposalStatus = nonOwnedStatus;

  const issueConfirmed = ['confirmed', 'partially_present'].includes(issueStatus);
  const firstOwnerBlocker = ownerBlockers[0];
  const concrete = proposalStatus === 'publishable'
    ? rec('concrete_proposal_present', 'passed', ownerAnalyses.length ? 'A concrete change was built from confirmed facts for the existing entity.' : 'A concrete change was proposed.')
    : proposalStatus === 'none'
      ? (issueConfirmed ? rec('concrete_proposal_present', 'failed', 'Nothing concrete was proposed.', 'Retry, or follow the manual guidance.') : rec('concrete_proposal_present', 'not_run', 'No change is needed or none could be justified for this result.'))
      : rec('concrete_proposal_present', 'blocked', firstOwnerBlocker?.message || (placeholderHits.length ? `The draft contains unresolved placeholders (${placeholderHits.join(', ')}).` : 'A publishable change cannot be built yet.'), firstOwnerBlocker?.action || 'Resolve the blocking items listed below.', firstOwnerBlocker?.category === 'safety' || proposalStatus === 'blocked' ? 'safety' : 'information');

  const capabilityRecord = capabilities.eligibility === ELIGIBILITY.ELIGIBLE
    ? rec('automatic_fix_capability', 'passed', capabilities.reason, null, 'capability')
    : rec('automatic_fix_capability', 'blocked', capabilities.reason,
      capabilities.eligibility === ELIGIBILITY.NOT_SUPPORTED ? 'Follow the manual steps: Odito has no safe automatic adapter for this change.'
        : capabilities.eligibility === ELIGIBILITY.REQUIRES_SETUP ? `Set up: ${(capabilities.missingCapabilities || []).join(', ') || 'the CMS connection'}.` : 'Retry when the WordPress connection can be read.', 'capability');

  const safetyChecks = [
    rec('live_page_inspected', ledger.first('page') ? 'passed' : 'failed', ledger.first('page') ? 'The live page was retrieved and inspected.' : 'The live page could not be inspected.', ledger.first('page') ? null : 'Retry when the page is reachable.'),
    rec('rendered_state_known', renderGap ? 'failed' : 'passed', renderGap || 'The rendered state is known or was not needed.', renderGap ? 'Retry once rendering is available.' : null),
    rec('issue_supported_by_evidence', issueConfirmed && supported.length ? 'passed' : 'failed', supported.length ? `${supported.length} finding(s) are observed or corroborated by retrieved evidence.` : 'No finding is observed or corroborated by retrieved evidence.'),
    rec('absence_claims_established', overclaimed.length ? 'failed' : 'passed',
      overclaimed.length ? `Presented as established but not supported: ${overclaimed.map((f) => f.statement).join(' | ').slice(0, 300)}`
        : acknowledgedUnknowns.length ? `${acknowledgedUnknowns.length} point(s) are acknowledged unknowns (not claimed as fact): ${acknowledgedUnknowns.map((f) => f.statement).join(' | ').slice(0, 220)}` : 'No unsupported claim that something is missing.'),
    rec('urls_backed_by_evidence', !hasContent ? 'not_run' : ungrounded ? 'failed' : 'passed', !hasContent ? 'No proposal to check.' : ungrounded ? 'The proposal contains URLs no evidence supports.' : 'Every URL in the proposal appears in retrieved evidence.'),
    rec('markup_syntactically_valid', !jsonLdBlocks.length ? 'not_run' : lintFailed ? 'failed' : 'passed', !jsonLdBlocks.length ? (ownerAnalyses.length ? "Checked on the page's own JSON-LD document instead (see the entity checks)." : 'No JSON-LD markup was proposed.') : lintFailed ? 'The proposed markup is not valid.' : 'Proposed markup parses (this alone does NOT make it safe).'),
    rec('no_duplicate_markup', !jsonLdBlocks.length ? 'not_run' : duplicateRisk ? 'failed' : 'passed', !jsonLdBlocks.length ? 'No JSON-LD markup was proposed.' : duplicateRisk ? 'The page already outputs this markup type (raw HTML or rendered DOM).' : 'No conflicting markup of the same type on the page.'),
    rec('no_unresolved_placeholders', !hasContent ? 'not_run' : placeholderHits.length ? 'failed' : 'passed', !hasContent ? 'No proposal to check.' : placeholderHits.length ? `Unresolved placeholder text found: ${placeholderHits.join(', ')}.` : 'No placeholder text in the proposal.', placeholderHits.length ? 'Replace placeholders with confirmed real values, or withhold the proposal.' : null),
    concrete,
    ...analyzerRecords,
    capabilityRecord,
  ];
  const blockingRecords = safetyChecks.filter((c) => c.status === CHECK_STATUS.FAILED || c.status === CHECK_STATUS.BLOCKED);

  // Blockers: explicit codes (the AI cannot override them, and neither can the UI)
  const blockers = [];
  const addBlocker = (b) => { if (b?.code && !blockers.some((x) => x.code === b.code)) blockers.push({ code: b.code, message: str(b.message, 500) || FALLBACK_DETAIL.blocked, action: b.action ? str(b.action, 300) : null, category: b.category || 'safety' }); };
  ownerBlockers.forEach(addBlocker);
  for (const r of blockingRecords) {
    if (r.id === 'automatic_fix_capability') {
      const codes = (capabilities.missingCapabilities || []).map((m) => ({ code: CAPABILITY_CODE[m] || `CAPABILITY_${String(m).toUpperCase()}`, message: `Missing on this site: ${m}.`, action: r.action, category: 'capability' }));
      (codes.length ? codes : [{ code: capabilities.eligibility === ELIGIBILITY.NOT_SUPPORTED ? 'NO_AUTOMATIC_ADAPTER' : 'CAPABILITY_UNKNOWN', message: r.detail, action: r.action, category: 'capability' }]).forEach(addBlocker);
    } else if (r.id === 'concrete_proposal_present' && ownerBlockers.length) {
      // the specific blocker(s) above already explain why no change can be built; do not repeat them under a generic code
    } else addBlocker({ code: BLOCKER_CODE_FOR_CHECK[r.id] || r.id.toUpperCase(), message: r.detail, action: r.action, category: r.category });
  }

  // Automatic-fix eligibility is OWNED by Odito: capability resolution AND every applicable server-verified check, AND a publishable proposal. Never model confidence.
  const canAutoFix = capabilities.eligibility === ELIGIBILITY.ELIGIBLE && ['complete', 'partial'].includes(investigationStatus) && blockingRecords.length === 0 && proposalStatus === 'publishable';
  if (src.automaticFixEligibility?.eligible === true && !canAutoFix) {
    warnings.push(`Model claimed an automatic fix; overridden (${blockers.slice(0, 4).map((b) => b.code).join(', ') || capabilities.reason}).`);
  }
  const eligibilityReason = canAutoFix
    ? capabilities.reason
    : capabilities.eligibility !== ELIGIBILITY.ELIGIBLE ? capabilities.reason
      : `Not applied automatically — ${blockers.slice(0, 3).map((b) => b.message).join(' ')}`.slice(0, 500);
  const passedId = (id) => safetyChecks.find((c) => c.id === id)?.status === CHECK_STATUS.PASSED;
  const failedAmong = (ids) => safetyChecks.some((c) => ids.includes(c.id) && (c.status === 'failed' || c.status === 'blocked'));
  const requirements = [
    { code: 'EVIDENCE_SUPPORTS_ISSUE', label: 'The live page evidence supports the issue', met: passedId('issue_supported_by_evidence') && passedId('live_page_inspected') },
    { code: 'CONFIRMED_COMPLETE_INPUT', label: 'Required information is confirmed and complete', met: proposalStatus === 'publishable' && !blockingRecords.some((c) => c.category === 'information') },
    { code: 'VALID_PROPOSAL', label: 'The proposal validates (markup, placeholders, entity)', met: proposalStatus === 'publishable' && !failedAmong(['markup_syntactically_valid', 'no_unresolved_placeholders', 'urls_backed_by_evidence', 'post_change_document_valid', 'entity_identified_once']) },
    { code: 'NO_CONFLICTING_MARKUP', label: 'No duplicate or conflicting markup', met: !failedAmong(['no_duplicate_markup', 'entity_identified_once']) },
    { code: 'CMS_CAPABILITY', label: 'A supported, connected CMS adapter can apply it', met: capabilities.eligibility === ELIGIBILITY.ELIGIBLE },
    { code: 'PROPOSAL_FINGERPRINT_CURRENT', label: 'The proposal fingerprint is current (re-checked at approval and again at apply)', met: true },
    { code: 'USER_APPROVAL', label: 'Your approval of this exact change (required before anything is applied)', met: false },
  ];

  const reviewItems = ledger.items.filter((i) => i.kind === 'structured_analysis' && i.status === 'ok' && i.data?.requiresReview).map((i) => ({
    evidenceId: i.id, analyzerId: i.data.analyzerId, status: i.data.status, summary: i.summary,
    unresolved: (i.data.unresolved || []).slice(0, 6), issues: (i.data.issues || []).slice(0, 6), trail: (i.data.trail || []).slice(0, 8),
    blockers: (i.data.blockers || []).slice(0, 6),
  }));
  // Persisted analysis summaries for the UI (never the raw documents): who/what/where each fact came from and how trusted it is.
  const analyses = ledger.items.filter((i) => i.kind === 'structured_analysis' && i.status === 'ok').map((i) => {
    let data = JSON.parse(JSON.stringify(i.data || {}));
    if (JSON.stringify(data).length > 14_000) data = { ...data, candidates: (data.candidates || []).slice(0, 6), trail: (data.trail || []).slice(0, 8) };
    return { evidenceId: i.id, analyzerId: i.data?.analyzerId || null, summary: i.summary, data };
  });
  const systemLimitations = [
    ...(renderGap ? [renderGap] : []),
    ...ledger.failures.filter((f) => ['page', 'rendered_dom', 'homepage', 'robots_txt', 'sitemap'].includes(f.kind)).slice(0, 4).map((f) => `${f.kind}: ${f.error?.message || f.summary}`),
    ...overclaimed.map((f) => `Not established: ${f.note || f.statement}`),
  ];
  const hasProposal = proposalStatus === 'publishable';

  return {
    ok: true,
    warnings,
    value: {
      contractVersion: CONTRACT_VERSION,
      investigationStatus,
      issueStatus,
      confidence: { score: Number(score.toFixed(2)), label },
      summary: str(src.summary, LIMITS.summary),
      evidence,
      findings,
      rootCause: { category: oneOf(src.rootCause?.category, ENUMS.rootCauseCategory, 'unknown'), description: str(src.rootCause?.description), symptomVersusCause: str(src.rootCause?.symptomVersusCause, 500) || null },
      reasoning: str(src.reasoning, 2500),
      recommendedSolution: { method: oneOf(src.recommendedSolution?.method, ENUMS.solutionMethod, 'needs_more_information'), strategy: str(src.recommendedSolution?.strategy, 1500), rationale: str(src.recommendedSolution?.rationale, 800) || null, routeNote: routeNote ? str(routeNote, 500) : null },
      implementationPlan: (planOverride && planOverride.length ? planOverride : arr(src.implementationPlan, LIMITS.steps)).map((s2, i) => ({ step: i + 1, detail: str(s2?.detail ?? s2?.step, 600), owner: oneOf(s2?.owner, ENUMS.owner, 'site_owner') })).filter((s2) => s2.detail),
      proposedChanges: changesFinal,
      codeOrConfiguration: codeFinal,
      proposalState: { status: proposalStatus, blockerCodes: blockers.map((b) => b.code), bindings: proposalBindings, operation: ledger.items.find((i) => i.kind === 'structured_analysis' && i.status === 'ok' && i.data?.operation)?.data.operation || null },
      blockers,
      discardedModelProposal,
      automaticFixEligibility: { eligible: canAutoFix, adapterId: canAutoFix ? capabilities.adapterId : null, eligibility: capabilities.eligibility, reason: eligibilityReason, blockers: blockers.map((b) => b.code), requirements },
      requiredCapabilities: capabilities.requiredCapabilities || [],
      missingCapabilities: capabilities.missingCapabilities || [],
      risks: arr(src.risks).map((r) => ({ risk: str(r?.risk, 400), severity: oneOf(r?.severity, ENUMS.severity, 'medium'), mitigation: str(r?.mitigation, 400) || null })).filter((r) => r.risk),
      validationPlan: arr(src.validationPlan).map((v) => ({ check: str(v?.check, 300), method: str(v?.method, 300), expected: str(v?.expected, 300) })).filter((v) => v.check),
      limitations: [...new Set([...arr(src.limitations).map((l) => str(l, 400)).filter(Boolean), ...systemLimitations.map((l) => str(l, 400))])].slice(0, 14),
      safetyChecks,
      reviewItems,
      analyses,
      additionalEvidenceRequested: arr(src.additionalEvidenceRequested, 6).map((x) => str(typeof x === 'string' ? x : x?.description, 300)).filter(Boolean),
      // A person must act whenever there is a change to approve, or a decision/input a blocked or awaiting-information result is waiting for.
      // (Applying still needs approval of a PUBLISHABLE proposal only: see lifecycle / approvalService.)
      requiresHumanApproval: hasProposal || reviewItems.length > 0 || hasContent || ['blocked', 'awaiting_information'].includes(proposalStatus),
      lifecycle: lifecycleProposed(hasProposal, proposalStatus),
    },
  };
}

/** The only lifecycle a freshly generated result may have. Applied/verified are set solely by execution/verification code. */
export function lifecycleProposed(hasProposal, proposalState = null) {
  return {
    recommendationGenerated: true,
    // "proposed" means a publishable, validated change exists. A blocked or awaiting-information result is NOT a proposed fix.
    fixProposed: !!hasProposal,
    proposalState: proposalState || (hasProposal ? 'publishable' : 'none'),
    fixApplied: false,
    fixVerified: false,
    verificationStatus: 'not_started',
  };
}

/** Result when the model could not be used: evidence and capability are still returned, the diagnosis is not invented. */
export function buildEvidenceOnlyResult({ ledger, capabilities, reasonCode, reasonMessage }) {
  const pageOk = !!ledger.first('page');
  return {
    contractVersion: CONTRACT_VERSION,
    investigationStatus: pageOk ? 'partial' : 'blocked',
    issueStatus: 'uncertain',
    confidence: { score: 0, label: 'low' },
    summary: `Evidence was gathered but no AI diagnosis could be produced (${reasonCode}).`,
    evidence: ledger.ok.slice(0, LIMITS.evidence).map((i) => ({ evidenceId: i.id, kind: i.kind, finding: i.summary })),
    findings: [], safetyChecks: [], reviewItems: [], analyses: [], blockers: [], discardedModelProposal: [], proposalState: { status: 'none', blockerCodes: [], bindings: {} },
    rootCause: { category: 'unknown', description: '', symptomVsCause: null },
    reasoning: '',
    recommendedSolution: { method: 'needs_more_information', strategy: 'Retry the investigation; the collected evidence is shown below.', rationale: null },
    implementationPlan: [], proposedChanges: [], codeOrConfiguration: [],
    automaticFixEligibility: { eligible: false, adapterId: null, eligibility: capabilities.eligibility, reason: reasonMessage },
    requiredCapabilities: capabilities.requiredCapabilities || [], missingCapabilities: capabilities.missingCapabilities || [],
    risks: [], validationPlan: [],
    limitations: [reasonMessage, ...ledger.failures.slice(0, 5).map((f) => `${f.kind}: ${f.error?.message || f.summary}`)],
    additionalEvidenceRequested: [],
    requiresHumanApproval: false,
    lifecycle: lifecycleProposed(false),
  };
}

export { EVIDENCE_STATUS };
export default { validateModelOutput, parseJsonLdNodes, buildEvidenceOnlyResult, extractJson, lintJsonLd, collectKnownUrls, findUngroundedUrls, lifecycleProposed, ENUMS, CONTRACT_VERSION, ContractError };
