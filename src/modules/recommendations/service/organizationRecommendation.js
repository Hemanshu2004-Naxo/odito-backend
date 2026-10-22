import crypto from 'crypto';
import { RecommendationRefusedError } from './recommendationRefusal.js';
import { serializeJsonLdForScript } from '../../schema-evidence/breadcrumbHierarchy.js';
import { buildOrganizationJsonLd } from '../../schema-evidence/organizationMarkup.js';
import { ADDRESS_FIELDS, SOURCE_LABEL as ADDRESS_SOURCE_LABEL, formatAddress } from '../../schema-evidence/organizationAddress.js';
import { buildOrganizationAddressContract, mergedEntityScript } from './organizationAddressContract.js';

/**
 * Deterministic recommendation for `organization_schema` / `primary_organization_schema`, driven by the SCHEMA INTENT
 * (schema-evidence/schemaIntent.js) that ODITO resolved from verified evidence.
 *
 * Why deterministic: the right output is fully determined by the intent (which type, reuse of which @id, which facts)
 * and the verified facts. A model adds nothing the evidence does not already say, and every time one was asked it was a
 * chance to type the entity as a generic Organization, invent an address or paste a placeholder (the production log that
 * motivated this: three rounds of "placeholder text — Claude output not grounded", then a generic fallback). Prose is a
 * fixed template that states WHY this type was chosen, WHICH facts were used (and where they came from) and WHAT is
 * still missing.
 *
 * Four outcomes (intent.action):
 *   generate     JSON-LD for the intended type, from verified facts only
 *   reuse        the entity already exists on this page — nothing to generate, nothing duplicated
 *   reference    this page needs no standalone entity; the site's entity (declared elsewhere) is referenced by @id
 *   needs_input  the chosen type requires a fact ODITO cannot prove (e.g. the street address): ask, never guess
 *
 * Generating or copying this does not change the website and does not touch any task: it is never "implemented" and
 * never "verified" until a recrawl observes the deployed markup.
 */

export class OrganizationRecommendationError extends RecommendationRefusedError {
  constructor(code, message, statusCode = 422) {
    super(code, message, statusCode);
    this.name = 'OrganizationRecommendationError';
  }
}

export const ORGANIZATION_INTENT_ISSUES = new Set(['organization_schema', 'primary_organization_schema']);

/**
 * Keyed to everything that determines the output: the page, the intent (type, action, reuse, missing facts), the
 * published facts, the name, the verified logo and the entity id (all folded into evidence.fingerprintKey). A change in any
 * of them — a new address on the site, a verified Business Profile, a different canonical — means a new key, so a
 * recommendation made under another intent is never served.
 */
export function organizationFingerprint(projectId, pageUrl, evidence) {
  const i = evidence.organization.intent;
  return crypto
    .createHash('sha256')
    .update(`organization_intent|${projectId}|${pageUrl}|${i.intent}|${i.action}|${i.type}|${evidence.fingerprintKey}`)
    .digest('hex');
}

const FACT_ORDER = ['telephone', 'email', 'address', 'geo', 'hasMap', 'openingHoursSpecification', 'openingHours', 'priceRange', 'areaServed', 'contactPoint', 'faxNumber', 'sameAs'];
export { buildOrganizationJsonLd };

const SOURCE_LABEL = {
  page_markup: "this page's own markup",
  site_entity_markup: "the site's existing entity markup",
  site_place_markup: "the site's Place markup",
  google_business_profile: 'your connected Google Business Profile (verified to belong to this website)',
};
const NAME_SOURCE_LABEL = {
  existing_organization_schema: "this page's entity markup",
  existing_website_schema: "the site's WebSite markup",
  'og:site_name': 'the og:site_name tag',
  site_entity_schema: "the site's existing entity markup",
  google_business_profile: 'your verified Google Business Profile',
};
const FIELD_LABEL = { telephone: 'telephone', email: 'email', address: 'address', geo: 'map coordinates', hasMap: 'map link', openingHoursSpecification: 'opening hours', openingHours: 'opening hours', priceRange: 'price range', areaServed: 'service area', contactPoint: 'contact point', faxNumber: 'fax', sameAs: 'social/profile links' };

const comment = (text) => `<!-- ODITO: ${text.replace(/--/g, '—')} -->`;

function usedFactsLines(evidence) {
  const o = evidence.organization;
  const lines = [];
  if (o.name) lines.push(`name "${o.name.value}" — from ${NAME_SOURCE_LABEL[o.name.source] || o.name.source}`);
  const byLabel = new Map();
  for (const f of FACT_ORDER) {
    if (o.contact?.[f] == null) continue;
    const src = SOURCE_LABEL[o.factSources?.[f]] || 'the published markup of this site';
    const label = FIELD_LABEL[f] || f;
    byLabel.set(label, src);
  }
  for (const [label, src] of byLabel) lines.push(`${label} — from ${src}`);
  if (o.logo?.verified) lines.push(`logo — ${o.logo.verified.url} (fetched and confirmed as an image)`);
  return lines;
}

function whyFor(intent) {
  if (intent.type === 'Organization') {
    return 'Organization structured data tells search engines and AI answer engines who is behind the site — the official name, the website and the logo — so the brand is recognised as one entity across Google, knowledge panels and AI answers. ' +
      'ODITO chooses the schema type from what your site can prove; here it supports a plain Organization.';
  }
  const noun = intent.type === 'Hospital' ? 'hospital' : intent.type === 'LocalBusiness' ? 'local business' : `${intent.type} (a kind of local business)`;
  return `${intent.type} structured data identifies the site as a ${noun} at a real physical location — with its address, phone and opening hours — which is what local search, map results and AI answers use to recommend it. ` +
    'ODITO chose this type from evidence on your site, not by default; it only ever publishes details it can prove.';
}

const FIELD_NAME = { streetAddress: 'street', addressLocality: 'city', addressRegion: 'region', postalCode: 'postal code', addressCountry: 'country' };
const sourceText = (key) => ADDRESS_SOURCE_LABEL[key] || String(key).replace(/_/g, ' ');

/**
 * Sections for the finding "the existing Organization entity has no (complete) address". Everything is stated from the
 * evidence and the validated contract: what is missing, the exact property to add, where each value came from, and when
 * no verified address exists what ODITO needs from the owner. Nothing here changes the website.
 */
function buildAddressSections(evidence) {
  const o = evidence.organization;
  const intent = o.intent;
  const contract = buildOrganizationAddressContract({ evidence, projectId: null });
  const entityRef = `${(o.primary?.types || intent.types).join(' + ')}${o.pageId ? ` (@id ${o.pageId})` : ''}`;
  const existingNote = contract.currentState.addressState === 'incomplete'
    ? `The entity publishes an incomplete address (missing ${contract.currentState.missingParts.map((f) => FIELD_NAME[f] || f).join(' and ')}).`
    : 'The entity has no address property.';
  const deployNote = "Generating or copying this does not change your website. Mark the task as implemented once it is live; Odito re-checks the page's actual markup on the next recrawl and only then reports it as fixed.";
  const why = `A published postal address ties the business to a real place: search engines and AI answer engines use it to match the entity with maps, listings and other sources, and it is one of the properties the Organization markup is expected to carry. Your existing ${entityRef} entity is completed — it keeps its @id and every property it already has, and no second entity is created.`;
  const common = {
    estimatedRecovery: { aiVisibility: 6, semanticTrust: 10, freshness: 0, accessibility: 0 },
    sourceAttribution: {
      generatedBy: 'template',
      promptPath: 'deterministic_organization_address',
      promptGroup: null,
      contextSources: {
        schemaIntent: intent.intent, schemaType: intent.type, schemaTypes: intent.types, schemaAction: contract.state === 'ready' ? 'generate' : 'needs_input', schemaScope: intent.scope,
        schemaReusedId: intent.id || null, schemaFactSources: o.factSources || {}, llmUsed: false,
        schemaAddress: { state: contract.state, existing: contract.currentState.addressState, fields: contract.proposal ? Object.fromEntries(Object.entries(contract.proposal.value).filter(([k]) => k !== '@type')) : null },
      },
      modelUsed: null,
      cacheStatus: 'miss',
    },
  };

  if (contract.state !== 'ready') {
    const lines = [];
    if (contract.state === 'conflict') {
      lines.push('Different addresses were found. ODITO will not choose between them:');
      contract.evidence.alternatives.forEach((a, i) => lines.push(`  ${i + 1}. ${a.formatted} — from ${a.sources.map(sourceText).join(', ')}`));
    } else if (contract.state === 'needs_confirmation' && contract.evidence.suggestion) {
      lines.push(`Found, but not enough to publish: ${contract.evidence.suggestion.formatted || '(a partial address)'} — from ${contract.evidence.suggestion.sources.map(sourceText).join(', ')}.`);
    } else if (contract.state === 'unavailable') {
      lines.push('No address was found on your site, in your Business Profile, or in the business details stored in ODITO.');
    } else if (contract.state === 'needs_review') {
      lines.push(contract.validation.errors[0] || contract.message || 'The entity could not be identified unambiguously.');
    }
    const needs = contract.state === 'needs_review' ? 'review before anything is proposed' : 'your confirmation of the full address (at least street and city)';
    return {
      whyThisMatters: why,
      recommendedFix: [
        `What is missing: the address property of your existing ${entityRef} entity. ${existingNote}`,
        '',
        ...lines,
        '',
        `ODITO needs ${needs} before it proposes a change. Nothing was guessed: an address that is not confirmed would be published as fact.`,
        '',
        deployNote,
      ].join('\n'),
      implementationExample: { type: 'html', content: `<!-- ODITO: no markup is shown yet — ${contract.state === 'needs_review' ? 'the entity needs review' : 'a confirmed address is needed first'}. -->` },
      expectedImpact: ['Once the address is confirmed, it is added to your existing entity only — nothing else changes.'],
      difficulty: 'easy',
      estimatedFixTime: '5 minutes',
      recommendedVersion: `Needs your confirmation: business address (${contract.state.replace('_', ' ')})`,
      changeSummary: { items: [{ field: 'address', changeType: 'add', before: contract.currentState.present ? formatAddress(contract.currentState.fields) : 'No address on the entity', after: 'Waiting for a confirmed address', reason: contract.message || 'The address could not be verified.', priority: 'medium' }] },
      ...common,
    };
  }

  const p = contract.proposal;
  const fieldLines = ADDRESS_FIELDS.filter((f) => p.value[f]).map((f) => `   • ${FIELD_NAME[f]}: ${p.value[f]} — from ${sourceText(p.fieldSources[f])}`);
  const script = mergedEntityScript(contract);
  return {
    whyThisMatters: why,
    recommendedFix: [
      `1. What is missing: the address property of your existing ${entityRef} entity. ${existingNote}`,
      '2. Proposed change — add this PostalAddress (only values from the evidence below):',
      ...fieldLines,
      p.completes?.length ? `   The parts the entity already has are kept; ODITO adds only: ${p.completes.map((f) => FIELD_NAME[f]).join(', ')}.` : null,
      `3. Where it comes from: ${p.status === 'confirmed_by_owner' ? 'the address you confirmed in ODITO' : p.sources.map(sourceText).join(', ') + ' (verified)'}.`,
      '4. Where to make the change: in the setting or code that outputs your existing organization entity. Do NOT add a second Organization block — merge the address into the existing entity (same @id). The full merged entity is in the code example; Review & Apply uses your connected WordPress site where that is supported.',
      `5. ${deployNote}`,
    ].filter((l) => l != null).join('\n'),
    implementationExample: { type: 'html', content: `<!-- ODITO: REPLACE your existing ${entityRef} block with this merged entity (same @id). Do NOT add it next to the old one. Only the address is new: -->\n${script}` },
    expectedImpact: [
      'Search engines and AI answer engines can read where the business is located from its own entity.',
      'Only the address changes: the entity keeps its @id, type and every other property, so no duplicate or conflicting entity appears.',
    ],
    difficulty: 'easy',
    estimatedFixTime: '10 minutes',
    recommendedVersion: JSON.stringify({ address: p.value }, null, 2),
    changeSummary: { items: [{ field: 'address', changeType: contract.currentState.addressState === 'incomplete' ? 'modify' : 'add', before: contract.currentState.present ? formatAddress(contract.currentState.fields) : 'Not on the existing entity', after: p.formatted, reason: p.status === 'confirmed_by_owner' ? 'Address confirmed by the owner.' : 'Verified from the evidence listed above.', priority: 'medium' }] },
    ...common,
  };
}

/** @returns {object} sections in the shape Recommendation.sections expects */
export function buildOrganizationSections(evidence) {
  const o = evidence.organization;
  const intent = o?.intent;
  if (!intent) throw new OrganizationRecommendationError('SCHEMA_INTENT_MISSING', 'No schema intent could be determined for this page, so no recommendation was built.');

  if (intent.addressDemand) return buildAddressSections(evidence);

  const reasons = intent.reasons.map((r) => `• ${r}`);
  const attribution = {
    generatedBy: 'template',
    promptPath: 'deterministic_schema_intent',
    promptGroup: null,
    contextSources: {
      schemaIntent: intent.intent, schemaType: intent.type, schemaTypes: intent.types, schemaAction: intent.action, schemaScope: intent.scope,
      schemaReusedId: intent.id || null, schemaFactSources: o.factSources || {}, llmUsed: false,
    },
    modelUsed: null,
    cacheStatus: 'miss',
  };
  const deployNote = 'Generating or copying this does not change your website. Mark the task as implemented once it is live; Odito re-checks the page\'s actual markup on the next recrawl and only then reports it as fixed.';
  const common = { estimatedRecovery: { aiVisibility: 8, semanticTrust: 12, freshness: 0, accessibility: 0 }, sourceAttribution: attribution };

  if (intent.action === 'needs_input') {
    const asks = intent.missing.map((m) => `• ${m.label} — ${m.why}`);
    return {
      whyThisMatters: whyFor(intent),
      recommendedFix: [
        `ODITO needs one thing before it can write ${intent.type} markup for this site:`,
        ...asks,
        '',
        'Why this type:',
        ...reasons,
        '',
        'Nothing was guessed: an address, phone number or name that is not on your site would be published as fact, so ODITO asks instead. Add the missing detail to your site (or your SEO plugin\'s local-business settings) and re-run the recommendation.',
        ...(intent.notes.length ? ['', ...intent.notes.map((n) => `Note: ${n}`)] : []),
        '',
        deployNote,
      ].join('\n'),
      implementationExample: { type: 'html', content: comment(`needs your input: ${intent.missing.map((m) => m.label).join('; ')}. No markup is shown because it would require a fact that cannot be verified.`) },
      expectedImpact: ['Once the missing detail is provided, the markup is generated only from verified facts.'],
      difficulty: 'easy',
      estimatedFixTime: '10 minutes',
      recommendedVersion: `Needs your input: ${intent.missing.map((m) => m.label).join('; ')}`,
      changeSummary: { items: [{ field: `${intent.type} schema (JSON-LD)`, changeType: 'add', before: 'No usable business entity on this page', after: `${intent.type} — waiting for: ${intent.missing.map((m) => m.label).join(', ')}`, reason: 'A required fact could not be verified from your site.', priority: 'medium' }] },
      ...common,
    };
  }

  if (intent.action === 'reuse' || intent.action === 'reference') {
    const where = intent.action === 'reuse' ? 'on this page' : `on ${intent.reuse?.pageUrl || 'another page of this site'}`;
    return {
      whyThisMatters: intent.action === 'reuse'
        ? 'This page already describes the business as structured data. A second copy would create a duplicate entity, which search engines can read as conflicting identities.'
        : 'A business entity (Organization / LocalBusiness) belongs on the homepage and the pages that present the business or its location — not on every page. This page does not need its own copy.',
      recommendedFix: [
        `No new ${intent.type} markup is needed here. The existing ${intent.types.join(' + ')} entity ${where}${intent.id ? ` (@id ${intent.id})` : ''} stays exactly as it is.`,
        '',
        'Why:',
        ...reasons,
        '',
        ...(intent.action === 'reference' && intent.id ? [`If other markup on this page needs to name the business (for example an Article publisher or a WebPage), reference it by @id — {"@id": "${intent.id}"} — instead of repeating the entity.`, ''] : []),
        ...(intent.notes.length ? [...intent.notes.map((n) => `Note: ${n}`), ''] : []),
        'This finding is a site-level fact reported for a page that does not carry the entity; no change to this page is required.',
      ].join('\n'),
      implementationExample: { type: 'html', content: comment(`no new ${intent.type} markup is needed. The existing entity ${where}${intent.id ? ` (${intent.id})` : ''} is reused.`) },
      expectedImpact: ['The site keeps exactly one business entity — no duplicate or conflicting identity is created.'],
      difficulty: 'easy',
      estimatedFixTime: '5 minutes',
      recommendedVersion: `No new markup needed — reuse the existing ${intent.types.join(' + ')} entity${intent.id ? ` (${intent.id})` : ''}.`,
      changeSummary: { items: [{ field: `${intent.type} schema (JSON-LD)`, changeType: 'fix', before: `${intent.types.join(' + ')} ${where}`, after: 'Unchanged — the existing entity is reused', reason: 'Creating another entity would duplicate it.', priority: 'low' }] },
      ...common,
    };
  }

  // generate
  const jsonLd = buildOrganizationJsonLd(evidence);
  const code = `<script type="application/ld+json">\n${serializeJsonLdForScript(jsonLd)}\n</script>`;
  const used = usedFactsLines(evidence);
  const optional = intent.optional.length ? `Not included because ODITO could not verify it: ${intent.optional.join(', ')}. Add the real values to your site to include them.` : null;
  const extending = intent.mode === 'extend_existing' || (o.present && intent.existingEntity);
  const deltaFields = (intent.delta || []).map((d) => `${d.field} (${d.kind === 'add' ? 'added' : d.kind === 'remove' ? 'removed — it does not work' : 'updated'})`);
  const placementLine = extending
    ? `2. Your page already declares this entity (${o.primary.types.join(' + ')}${o.pageId ? `, ${o.pageId}` : ''}). Do NOT add a second block: merge the changes below into the existing JSON-LD — ${deltaFields.length ? `ODITO changes only: ${deltaFields.join(', ')}` : 'the type is made specific'}. Keep your other existing properties.`
    : intent.placement === 'homepage'
    ? '2. Add the JSON-LD below to your HOMEPAGE — the business entity is declared once, on the homepage, not repeated on every page.'
    : '2. Add the JSON-LD below to this page\'s <head> (your theme\'s header-scripts or custom-code field, or your SEO plugin\'s organization / local-business settings) — only if the page does not already output the same entity, or the page will describe the business twice.';
  const trailing = intent.reuse ? `The existing @id (${intent.id || 'none'}) is reused so this extends the entity ODITO found on ${intent.reuse.pageUrl}; it does not create a second one.` : null;

  return {
    whyThisMatters: whyFor(intent),
    recommendedFix: [
      `1. Why ${intent.type}:`,
      ...reasons.map((r) => `   ${r}`),
      placementLine,
      '3. Only verified details were used:',
      ...used.map((u) => `   • ${u}`),
      ...(trailing ? [`   ${trailing}`] : []),
      ...(optional ? [`   ${optional}`] : []),
      ...(intent.notes.length ? intent.notes.map((n) => `   Note: ${n}`) : []),
      `4. ${deployNote}`,
    ].join('\n'),
    implementationExample: { type: 'html', content: code },
    expectedImpact: [
      intent.type === 'Organization'
        ? 'Search engines and AI answer engines can resolve the brand name, website and logo as one entity.'
        : `Search engines and AI answer engines can read the business as a ${intent.type} with a real location.`,
      'Every value in the markup comes from your own site (or a verified Business Profile) — nothing was invented.',
    ],
    difficulty: 'easy',
    estimatedFixTime: '15 minutes',
    recommendedVersion: serializeJsonLdForScript(jsonLd),
    changeSummary: {
      items: extending && (intent.delta || []).length
        ? intent.delta.map((d) => ({ field: d.field, changeType: d.kind === 'add' ? 'add' : d.kind === 'remove' ? 'remove' : 'modify', before: d.kind === 'add' ? 'Not on the existing entity' : 'Existing value', after: d.kind === 'remove' ? 'Removed (the declared logo does not return an image)' : 'Verified value from your site', reason: 'Only verified facts are added or changed on your existing entity.', priority: 'medium' }))
        : [{ field: `${intent.type} schema (JSON-LD)`, changeType: o.present ? 'modify' : 'add', before: o.present ? `${o.primary.types.join(' + ')}` : 'No business entity found for this page', after: `${intent.types.join(' + ')} with ${used.length} verified detail${used.length === 1 ? '' : 's'}`, reason: intent.reasons[0] || 'Built from verified evidence.', priority: 'medium' }],
    },
    ...common,
  };
}

export { buildAddressSections };
export default { OrganizationRecommendationError, ORGANIZATION_INTENT_ISSUES, organizationFingerprint, buildOrganizationJsonLd, buildOrganizationSections };
