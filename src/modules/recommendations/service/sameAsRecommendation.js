import crypto from 'crypto';
import { RecommendationRefusedError } from './recommendationRefusal.js';
import { buildSameAsPatch, renderRecommendedJsonLd } from '../../schema-evidence/sameAs/sameAsMarkup.js';

/**
 * Deterministic recommendation for the `sameas_array` issue ("Organization schema missing sameAs array").
 *
 * The model used to be asked to supply a profile URL and — correctly, because nothing in its context could confirm one — answered
 * "not provided in context". The discovery step (schema-evidence/sameAs/) now finds the organization's real profile links, so this
 * recommendation is built ONLY from what was seen on the site:
 *
 *   - profiles Odito is confident belong to the organization (declared or linked from the site's header/footer, corroborated)
 *     become the recommended JSON-LD: the Organization the site ALREADY publishes, with only sameAs added — never a second entity
 *   - profiles that need the owner's confirmation are LISTED, with why, but not written into the recommended markup
 *   - when nothing was found the recommendation says so and explains how to add real profiles; it never invents a URL, never
 *     emits an empty sameAs array and never shows a placeholder
 *
 * Thrown as SameAsRecommendationError when there is no Organization to attach profiles to (nothing is stored then).
 */

export class SameAsRecommendationError extends RecommendationRefusedError {
  constructor(code, message, statusCode = 422) {
    super(code, message, statusCode);
    this.name = 'SameAsRecommendationError';
  }
}

export const SAMEAS_RECOMMENDATION_VERSION = 1;

/** Keyed to the entity, its current sameAs and the discovered candidates, so a changed site never serves a stale recommendation. */
export function sameAsFingerprint(projectId, pageUrl, discovery) {
  const cands = (discovery.candidates || []).map((c) => `${c.id}:${c.status}`).sort().join(',');
  const existing = (discovery.entity?.existing?.urls || []).slice().sort().join(',');
  return crypto.createHash('sha256')
    .update(`sameas_array|v${SAMEAS_RECOMMENDATION_VERSION}|${projectId}|${pageUrl}|${discovery.entity?.id || ''}|${discovery.entity?.state || ''}|${existing}|${cands}`)
    .digest('hex');
}

export function assertSameAsEntityUsable(discovery) {
  if (!discovery?.entity || discovery.entity.state === 'no_entity' || !discovery.entity.node) {
    throw new SameAsRecommendationError('SAMEAS_NO_ORGANIZATION', 'No Organization entity was found on this site\'s latest crawl, so there is nothing to attach profile links to. Run a new audit, then try again.');
  }
  if (discovery.entity.state === 'multiple_entities') {
    throw new SameAsRecommendationError('SAMEAS_DUPLICATE_ENTITIES', 'The site publishes more than one Organization entity. Resolve the duplicate first; adding profile links to the wrong one would not fix this finding.', 409);
  }
}

/** JSON-LD safe to paste inside a <script> element. */
const toScriptTag = (jsonLd) => `<script type="application/ld+json">\n${jsonLd.replace(/</g, '\\u003c')}\n</script>`;

const platformList = (candidates) => candidates.map((c) => `${c.platformLabel} (${c.url})`).join('; ');

export function buildSameAsSections(discovery) {
  const entity = discovery.entity;
  const fresh = discovery.candidates.filter((c) => c.status !== 'already_present');
  const confident = fresh.filter((c) => c.status === 'suggested');
  const toConfirm = fresh.filter((c) => c.status === 'needs_confirmation' || c.status === 'weak');
  const existing = entity.existing?.urls || [];
  const where = "Add them in your SEO plugin's Organization / social profiles settings (Rank Math: Titles & Meta → Local SEO → Additional profiles) or in the template that outputs the Organization markup.";

  const why = 'sameAs tells search engines and AI answer engines which official profiles (LinkedIn, Facebook, Instagram, YouTube, a directory page …) belong to this organization. '
    + 'Without it they have to guess whether pages on other sites describe the same entity, which weakens entity recognition and knowledge-panel matching.';

  const stateWord = entity.state === 'populated' ? 'only partly filled in' : 'missing';
  let recommendedFix;
  let recommendedVersion;
  let implementationExample;
  let after;
  let reason;

  if (confident.length) {
    const patch = buildSameAsPatch({ node: entity.node, add: confident.map((c) => c.url) });
    const json = renderRecommendedJsonLd(patch.node);
    recommendedVersion = json;
    implementationExample = { type: 'html', content: toScriptTag(json) };
    recommendedFix = `The Organization's sameAs is ${stateWord}. Add the profile links Odito found on your own site (${platformList(confident)}) to the Organization you ALREADY publish (${entity.id || 'its @id'}) — `
      + 'do not add a second Organization. '
      + (toConfirm.length ? `${toConfirm.length} more link${toConfirm.length === 1 ? ' needs' : 's need'} your confirmation before it can be added (${platformList(toConfirm)}). ` : '')
      + 'Review every link, remove any that is not an official profile of the organization, then approve the change. '
      + where;
    after = `sameAs with ${confident.length + existing.length} profile${confident.length + existing.length === 1 ? '' : 's'}`;
    reason = 'These profile links are published on the site itself and describe the organization, but are not declared in its structured data.';
  } else if (toConfirm.length) {
    recommendedVersion = `Odito found ${toConfirm.length} possible profile link${toConfirm.length === 1 ? '' : 's'} but could not confirm that ${toConfirm.length === 1 ? 'it belongs' : 'they belong'} to the organization:\n`
      + toConfirm.map((c) => `- ${c.platformLabel}: ${c.url} (${c.reasons[0] || 'seen on the site'})`).join('\n')
      + '\n\nConfirm the ones that are official profiles of this organization; Odito then builds the exact structured data for them. Nothing is added until you do.';
    implementationExample = { type: 'text', content: recommendedVersion };
    recommendedFix = `The Organization's sameAs is ${stateWord}. Odito found possible profile links but none is certain enough to add automatically. Confirm which of them are official profiles of the organization, or add your own, then review the generated structured data.`;
    after = 'sameAs with the profile links you confirm';
    reason = 'Candidate profile links were found but need the site owner\'s confirmation.';
  } else {
    recommendedVersion = 'No organization profile links were found on this site, in its structured data or in your connected accounts, so Odito has nothing real to add — and it will not invent one.\n\n'
      + 'sameAs is optional. If the organization has official profiles (for example a LinkedIn company page, a Facebook page or a Google Business Profile), add their exact addresses, and Odito will build the structured data and add them to the Organization you already publish. '
      + 'Do not add an empty sameAs list or example addresses.';
    implementationExample = { type: 'text', content: recommendedVersion };
    recommendedFix = `The Organization's sameAs is ${stateWord} and no profile links could be discovered. Add the organization's official profile links yourself (they are validated before anything is written), or leave sameAs out if there are none. `
      + where;
    after = 'sameAs with the official profile links you add';
    reason = 'No profile links were discovered, so the owner has to supply them.';
  }

  const pagesLooked = (discovery.sources?.pages || []).filter((p) => p.status === 'ok').length;
  return {
    whyThisMatters: why,
    recommendedFix,
    implementationExample,
    expectedImpact: [
      'Search engines and AI answer engines can connect this organization to its official profiles.',
      'The Organization entity stays a single entity: only its sameAs property changes.',
    ],
    difficulty: 'easy',
    estimatedFixTime: '5 minutes',
    recommendedVersion,
    changeSummary: {
      items: [{
        field: 'Organization.sameAs',
        changeType: entity.state === 'populated' ? 'modify' : 'add',
        before: existing.length ? `${existing.length} profile${existing.length === 1 ? '' : 's'}: ${existing.join(', ')}` : 'No sameAs on the Organization',
        after,
        reason,
        priority: 'medium',
      }],
    },
    sourceAttribution: {
      generatedBy: 'template',
      promptPath: 'deterministic_same_as',
      promptGroup: null,
      contextSources: { discoveredProfiles: discovery.candidates.length, confident: confident.length, needConfirmation: toConfirm.length, pagesInspected: pagesLooked, llmUsed: false },
      modelUsed: null,
      cacheStatus: 'miss',
    },
  };
}

export default { SameAsRecommendationError, assertSameAsEntityUsable, sameAsFingerprint, buildSameAsSections, SAMEAS_RECOMMENDATION_VERSION };
