/**
 * issueFixStrategies — for each issue type ODITO can act on, the stages of an evidence-driven fix and how complete each one is.
 *
 *   evidence        what must be proven before a value is proposed (and from where)
 *   identification  how the exact property / element is located (never by guessing)
 *   proposal        how the value is produced
 *   validation      what a proposal must satisfy before it is offered
 *   application     the capability that can apply it (or why none can), through the EXISTING integration
 *   verification    what proves the change is really live (never an HTTP 200 alone)
 *
 * This is a DESCRIPTION of what exists, kept next to the code so it cannot silently drift: issueFixStrategies.test.js proves every
 * module named here exists and that every application claim agrees with the WordPress capability registry. It does not drive any
 * behaviour and it does not make anything automatic — adding an entry here changes nothing until the stages it names are built.
 *
 * `readiness` is deliberately blunt:
 *   contract         the full chain exists and is validated: evidence -> typed contract -> validated proposal -> approval -> apply -> verify
 *   typed_fix        a typed, approved, reconciled apply + verify exists, but the recommendation is not yet a typed contract
 *   single_field     applied as one value through the generic WordPress SEO field channel (compare, write, read back, crawl-verify)
 *   recommendation   a recommendation only; ODITO cannot apply it
 */

import { getCapabilityForIssue } from '../../external_integration/service/providerCapabilityRegistry.js';

const STRATEGIES = [
  {
    id: 'organization_address',
    issueCodes: ['organization_schema'],
    property: 'address',
    readiness: 'contract',
    evidence: {
      module: 'schema-evidence/organizationAddress.js',
      sources: ['page_entity_markup', 'site markup (entity, linked Place, location entities)', 'Google Business Profile (only when verified for this website)', 'project business details', 'owner-entered details', 'address confirmed by the owner'],
      rule: 'Only a structured address with a street and a city from a trusted source (or confirmed by the owner) is publishable; conflicts and branch-only addresses go to the owner; free text is never evidence.',
    },
    identification: { module: 'schema-evidence/schemaGraph.js', rule: 'The page\'s own Organization entity by @id; several entities means stop and review.' },
    proposal: { module: 'recommendations/service/organizationAddressContract.js', rule: 'Deterministic from evidence; no model text is ever the value.' },
    validation: { module: 'recommendations/service/organizationAddressContract.js', rule: 'Every value traceable to a source, no placeholders, entity differs only by address, same @id and type.' },
    application: { capabilityField: 'organization_schema', channel: 'schema_fix', provider: 'rank_math', requires: ['Odito SEO Bridge 1.6.0 (organization_address)', 'Rank Math Local SEO module', 'explicit approval of the exact plan'], unsupported: 'Other SEO plugins, or an entity published by a theme/other plugin: manual path with the merged entity.' },
    verification: { module: 'schema-evidence/schemaVerification.js', checks: ['saved value read back', 'rendered entity (same @id) carries the approved address', 'no duplicate entity', 'other structured data intact', 'detector-equivalent test'] },
  },
  {
    id: 'organization_identity',
    issueCodes: ['organization_schema'],
    property: 'name / logo / type',
    readiness: 'typed_fix',
    evidence: { module: 'schema-evidence/schemaEvidence.js', rule: 'Verified name, a fetched-and-confirmed logo, a type decided by the schema intent.' },
    identification: { module: 'schema-evidence/schemaIntent.js', rule: 'Intent: Organization / LocalBusiness / Hospital / reuse / reference / ask.' },
    proposal: { module: 'recommendations/service/organizationRecommendation.js', rule: 'Deterministic from the intent.' },
    validation: { module: 'schema-evidence/schemaOutputGuard.js', rule: 'Guard + validator against the evidence.' },
    application: { capabilityField: 'organization_schema', channel: 'schema_fix', provider: 'rank_math', requires: ['Odito SEO Bridge 1.4.0', 'explicit approval'], unsupported: 'Other SEO plugins.' },
    verification: { module: 'schema-evidence/schemaVerification.js', checks: ['saved value read back', 'rendered entity type / name / logo', 'no duplicate entity'] },
  },
  {
    id: 'organization_same_as',
    issueCodes: ['sameas_array'],
    property: 'Organization sameAs (profile links)',
    readiness: 'typed_fix',
    evidence: { module: 'schema-evidence/sameAs/sameAsDiscovery.js', sources: ['sameAs already declared in the Organization JSON-LD the site publishes', 'header / footer / contact / about links of the home page (same-site fetch)', 'a bounded sample of other same-site pages and the stored crawl links', 'profiles of accounts connected to the project'], rule: 'Only links that were SEEN on the site (or typed by the owner) are candidates; each carries its source, method, confidence and verification status; weak or ambiguous ones are never pre-selected and a share button, employee, customer or tracking link is never a candidate.' },
    identification: { module: 'schema-evidence/sameAs/sameAsEntity.js', rule: 'The Organization by @id across ALL JSON-LD blocks; the sameAs of a Person is never the sameAs of the organization; two Organizations are not merged (stop); a shared entity is fixed once at its source.' },
    proposal: { module: 'recommendations/service/sameAsRecommendation.js', rule: 'Deterministic JSON-LD patch (schema-evidence/sameAs/sameAsMarkup.js): the existing entity with only sameAs added or the one approved value changed; no model text is ever a URL, no empty array.' },
    validation: { module: 'schema-evidence/sameAs/profileUrl.js', rule: 'Absolute public HTTPS, a profile (not a share/login/tracking/post/resource link), not the site itself, no placeholder; the same policy for discovered and typed links; no client URL is ever fetched.' },
    application: { capabilityField: 'same_as', channel: 'schema_fix', provider: 'rank_math', requires: ['Odito SEO Bridge 1.4.0 (organization.sameAs add/remove)', 'Rank Math as the source of the entity (@id <home>#organization)', 'explicit approval of the exact URLs'], unsupported: 'Other SEO plugins, a theme/page-builder-generated or duplicated Organization, WordPress not connected: source-specific manual instructions with the same JSON-LD; no Apply button.' },
    verification: { module: 'schema-evidence/sameAs/sameAsVerification.js', checks: ['saved value read back', 'public page fetched now: approved URLs on the intended Organization (@id)', 'previous values preserved, removed values gone', 'no second Organization', 'crawler verdict only after a crawl newer than the write'] },
  },
  {
    id: 'breadcrumb_trail',
    issueCodes: ['breadcrumblist_schema'],
    property: 'BreadcrumbList (the trail of one page)',
    readiness: 'typed_fix',
    evidence: { module: 'schema-evidence/breadcrumbs/breadcrumbDiscovery.js', sources: ['BreadcrumbList JSON-LD the page outputs now', 'breadcrumb microdata / the visible breadcrumb navigation', 'the stored crawl records', 'the site navigation menu and same-path parents shown linking to the page', 'canonical URL and title (names and the current page only)'], rule: 'A URL path never proves a hierarchy. A trail is verified only from the page own markup, otherwise it is a suggestion the owner confirms; a menu heading without a page is asked for a URL, never given one.' },
    identification: { module: 'schema-evidence/breadcrumbs/breadcrumbTrails.js', rule: 'Per page and independently: already_valid / verified / suggested / incomplete / not_found, or conflict when an invalid or duplicate BreadcrumbList exists (never a second one).' },
    proposal: { module: 'recommendations/service/breadcrumbRecommendation.js', rule: 'Deterministic JSON-LD from the trail the owner confirmed; positions generated from the order; no model text.' },
    validation: { module: 'schema-evidence/breadcrumbHierarchy.js', rule: 'Absolute same-site https URLs, no credentials, no fragments, no duplicate item, last item is the verified canonical of the page.' },
    application: { capabilityField: 'breadcrumb_schema', channel: 'schema_fix', provider: 'rank_math', requires: ['Odito SEO Bridge 1.4.0 (breadcrumbs.enabled)', 'Rank Math as the source', 'the trail Rank Math would build equals the confirmed trail', 'explicit approval'], unsupported: 'Other SEO plugins, a trail Rank Math would build differently, breadcrumbs already on yet missing, an invalid or duplicate existing BreadcrumbList: the JSON-LD and manual steps, no Apply button.' },
    verification: { module: 'schema-evidence/breadcrumbs/breadcrumbVerification.js', checks: ['setting read back', 'the page fetched now: exactly one valid BreadcrumbList whose trail is the confirmed one', 'every other page of the site-wide change checked on its own', 'crawler verdict only after a crawl newer than the write'] },
  },
  {
    id: 'image_alt_text',
    issueCodes: ['images_missing_alt_text'],
    property: 'alt text of one image',
    readiness: 'typed_fix',
    evidence: { module: 'external_integration/mediaFix/altText.js', rule: 'Suggestions only from the site\'s own text; the owner approves the wording.' },
    identification: { module: 'external_integration/mediaFix/imageIdentity.js', rule: 'Exact upload-path equality with WordPress\'s own media record; never filename similarity.' },
    proposal: { module: 'external_integration/mediaFix/altFixPlan.js', rule: 'Per image, from owner-approved text.' },
    validation: { module: 'external_integration/mediaFix/altText.js', rule: 'Length, no markup, decorative handling.' },
    application: { channel: 'media_alt', provider: 'any', requires: ['Odito SEO Bridge 1.5.0 (media_alt)', 'explicit approval'], unsupported: 'Alt stored inside page content (ALT_EMBEDDED_IN_CONTENT).' },
    verification: { module: 'tasks/service/TaskVerificationService.js', checks: ['each changed image matched by id / exact path', 'rendered alt on the crawled page'] },
  },
  {
    id: 'title_tag',
    issueCodes: ['title_missing', 'title_too_short', 'title_too_long'],
    property: 'title',
    readiness: 'single_field',
    evidence: { module: 'recommendations/service/recommendationService.js', rule: 'Recommendation generated from page context; the value is the owner\'s to review.' },
    identification: { module: 'external_integration/service/wordPressUrlResolver.js', rule: 'The page resolved to its exact WordPress object.' },
    proposal: { module: 'recommendations/service/recommendationService.js', rule: 'Model-assisted, then normalized by the capability registry.' },
    validation: { module: 'external_integration/service/providerCapabilityRegistry.js', rule: 'normalizeRecommendation / valuesMatch.' },
    application: { capabilityField: 'title', channel: 'seo_field', provider: 'any', requires: ['Odito SEO Bridge', 'approval'], unsupported: 'Multiple SEO plugins active.' },
    verification: { module: 'tasks/service/TaskVerificationService.js', checks: ['read-back', 'crawler value comparison'] },
  },
  {
    id: 'meta_description',
    issueCodes: ['meta_description_missing', 'meta_description_too_short', 'meta_description_too_long'],
    property: 'meta description',
    readiness: 'single_field',
    evidence: { module: 'recommendations/service/recommendationService.js', rule: 'Recommendation generated from page context; the value is the owner\'s to review.' },
    identification: { module: 'external_integration/service/wordPressUrlResolver.js', rule: 'The page resolved to its exact WordPress object.' },
    proposal: { module: 'recommendations/service/recommendationService.js', rule: 'Model-assisted, then normalized by the capability registry.' },
    validation: { module: 'external_integration/service/providerCapabilityRegistry.js', rule: 'normalizeRecommendation / valuesMatch.' },
    application: { capabilityField: 'meta_description', channel: 'seo_field', provider: 'any', requires: ['Odito SEO Bridge', 'approval'], unsupported: 'Multiple SEO plugins active.' },
    verification: { module: 'tasks/service/TaskVerificationService.js', checks: ['read-back', 'crawler value comparison'] },
  },
]

export const FIX_STRATEGIES = Object.freeze(STRATEGIES.map((s) => Object.freeze(s)))
export const READINESS = Object.freeze(['contract', 'typed_fix', 'single_field', 'recommendation'])

/** Every strategy that applies to an issue code (an issue can have several: organization_schema has identity and address). */
export function getFixStrategies(issueCode) {
  return FIX_STRATEGIES.filter((s) => s.issueCodes.includes(issueCode))
}

/** Where an issue type stands for evidence-driven fixing; 'recommendation' when nothing is registered (ODITO cannot apply it). */
export function readinessFor(issueCode) {
  const found = getFixStrategies(issueCode)
  if (!found.length) return { readiness: 'recommendation', strategies: [] }
  const best = [...found].sort((a, b) => READINESS.indexOf(a.readiness) - READINESS.indexOf(b.readiness))[0]
  return { readiness: best.readiness, strategies: found.map((s) => s.id) }
}

/** The WordPress capability behind a strategy's application, or null when it has none. */
export function capabilityOf(strategy) {
  return strategy.application?.capabilityField ? getCapabilityForIssue(strategy.issueCodes[0])?.capability || null : null
}

export default { FIX_STRATEGIES, READINESS, getFixStrategies, readinessFor, capabilityOf }
