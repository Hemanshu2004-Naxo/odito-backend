/**
 * Campaign CONTEXT builder (spec §7 / §16).
 *
 * Produces the MINIMUM structured project context worth giving Claude, from
 * data Odito already holds — so the user doesn't re-type what the project
 * knows. Strictly an allow-list: the whole SeoProject document is NEVER
 * passed through.
 *
 * DELIBERATELY EXCLUDED: user ids, database _id / __v, OAuth tokens and any
 * GoogleConnection data, crawl/audit results, verified-business phone /
 * placeId / ratings, billing, and every other field not listed below.
 *
 * Landing-page enrichment: Phase 2 does NOT crawl anything. If a future
 * phase has trusted page-analysis data (title, meta description, H1, service
 * topics) it plugs in at `landingPage` — see the note there.
 */

function str(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function hostOf(url) {
  try {
    return new URL(url).host.replace(/^www\./i, '').toLowerCase();
  } catch {
    return null;
  }
}

/**
 * @param {object} args
 * @param {object} args.project  a SeoProject document (or lean object)
 * @param {object} args.brief    the normalized brief (from campaignBriefValidator)
 * @returns {{ project: object, landingPage: (object|null) }}
 */
export function buildGenerationContext({ project, brief }) {
  const p = project || {};

  // Explicit field allow-list — add a field here only when Claude genuinely
  // needs it to write better campaign copy, and only when it is safe to send.
  const projectContext = {
    name: str(p.project_name) || null,
    websiteUrl: str(p.main_url) || null,
    businessType: str(p.business_type) || null,
    industry: str(p.industry) || null,
    primaryLocation: str(p.location) || null,
    country: str(p.country) || null,
    language: str(p.language) || null,
    seoScope: str(p.seo_scope) || null,
  };

  let landingPage = null;
  const landingUrl = brief?.landingPageUrl || null;
  if (landingUrl) {
    const projectHost = hostOf(projectContext.websiteUrl);
    const landingHost = hostOf(landingUrl);
    landingPage = {
      url: landingUrl,
      isProjectDomain: !!(projectHost && landingHost && projectHost === landingHost),
      // FUTURE: when Odito has trusted extracted page data for this URL,
      // add { title, metaDescription, mainHeading, serviceTopics } here —
      // selected fields only, never raw HTML. No network call is made in
      // this phase.
    };
  }

  return { project: projectContext, landingPage };
}

export default { buildGenerationContext };
