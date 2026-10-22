/**
 * breadcrumbFixPlan — decides, from the trail the owner CONFIRMED, what the page outputs now, and what WordPress can do, whether Odito may
 * switch on Rank Math's site-wide breadcrumb setting for this finding. Pure: no I/O, no clock — every rule is testable and the fingerprint
 * is stable for identical inputs.
 *
 * Why only Rank Math's switch, and only sometimes: Rank Math builds the BreadcrumbList itself from the page structure (home › parent pages
 * › page). Odito cannot write a custom trail into it, so the switch is a valid fix ONLY when the trail Rank Math will build is the trail
 * the owner confirmed. When it would differ (the confirmed parent is a menu heading, a category, a different page …) turning it on would
 * publish a trail nobody approved, so the plan is `unsupported` and the owner gets the exact JSON-LD plus the manual ways to publish it.
 * A trail Rank Math decides at render time (posts: category / blog page) cannot be predicted: the plan says so, and the rendered page is
 * verified afterwards.
 *
 * It is a SITE-WIDE setting: one change affects every page, so the plan lists the pages whose finding it can resolve; each is verified on
 * its own after the change.
 */

import crypto from 'crypto';
import { breadcrumbUrlKey } from '../../schema-evidence/breadcrumbHierarchy.js';

export const BREADCRUMB_FIX_TYPE = 'breadcrumb_setting';
export const BREADCRUMB_ISSUE_KEY = 'breadcrumblist_schema';
export const BREADCRUMB_PLAN_VERSION = 1;
/** The field name of the single change, in the ledger and in the engine. */
export const BREADCRUMB_FIELD = 'breadcrumbs_enabled';

export const BREADCRUMB_TARGET = Object.freeze({
  rank_math: { kind: 'seo_plugin_setting', label: 'Rank Math → Titles & Meta → Misc → Breadcrumbs', storage: 'rank-math-options-general.breadcrumbs' },
});

const reason = (code, message) => ({ code, message });

/** Where the owner publishes the trail by hand, per source. The same JSON-LD is shown next to every one of these. */
export function manualInstructions(provider, { hasJsonLd = true } = {}) {
  const head = {
    rank_math: 'In WordPress go to Rank Math → Titles & Meta → Misc → Breadcrumbs. Rank Math builds the trail from the page\'s parent pages; set this page\'s Parent in the page editor so the trail matches, or publish the JSON-LD below instead.',
    yoast: 'In WordPress go to Yoast SEO → Settings → Advanced → Breadcrumbs and make sure breadcrumbs are enabled for your theme. Yoast then publishes the BreadcrumbList from your page structure.',
    aioseo: 'In WordPress go to All in One SEO → General Settings → Breadcrumbs and enable them.',
    seopress: 'In WordPress go to SEOPress → Titles & Metas → Advanced → Breadcrumbs and enable them.',
    none: 'No supported SEO plugin was detected. Publish the BreadcrumbList JSON-LD below in this page\'s <head> (your theme\'s header-scripts or custom-code field), or use a plugin that outputs breadcrumb structured data.',
    multiple: 'More than one SEO plugin is active. Deactivate the one you do not use, then enable breadcrumbs in the remaining plugin.',
  }[provider] || 'Your breadcrumb markup is produced by a theme or plugin Odito cannot edit. Open it and publish the trail below.';
  return [
    head,
    hasJsonLd ? 'Add it in ONE place only — never in two, or the page outputs two BreadcrumbList entities.' : 'Do not add a second BreadcrumbList if the page already has one.',
  ];
}

const keysOf = (urls) => (urls || []).map((u) => breadcrumbUrlKey(u) || u);
const sameKeys = (a, b) => a.length === b.length && a.every((k, i) => k === b[i]);

/**
 * @param {object} p
 * @param {{name: string, url: string}[]|null} p.trail        the owner-confirmed trail (server-loaded; never client input)
 * @param {{status: 'valid'|'missing'|'invalid'|'duplicate'|'unreachable', problems?: string[]}|null} p.live   the page fetched now
 * @param {boolean|null} p.enabledNow                          Rank Math's breadcrumb setting
 * @param {string} p.provider                                  the Bridge's live SEO provider
 * @param {{predictable: boolean, urls: string[], reason: string|null}|null} p.predicted   the trail Rank Math would build for this page
 * @param {{resolved: boolean, reason?: string, message?: string}|null} p.resource
 * @param {string[]} [p.affectedPages]
 * @param {{code: string, message: string}|null} [p.unavailable]  WordPress / the Bridge cannot be used at all (manual path, not an error)
 * @param {{projectId: *, connectionId: *, pageUrl: string}} [p.context]
 * @param {{siteSchemaSupported?: boolean}} [p.capabilities]
 */
export function planBreadcrumbFix({ trail, live = null, enabledNow = null, provider, predicted = null, resource = null, affectedPages = [], unavailable = null, context = {}, capabilities = {} }) {
  const out = (status, why = {}, extra = {}) => finish({
    status, code: why.code || null, message: why.message || null,
    changes: [], blocked: [], warnings: [], manual: null,
    target: provider === 'rank_math' ? BREADCRUMB_TARGET.rank_math : null,
    scope: { kind: 'site_wide', affectedPages: affectedPages.slice(0, 200), affectedCount: affectedPages.length },
    ...extra,
  }, { trail, live, enabledNow, provider, predicted, capabilities, context });
  const unsupported = (why, extra = {}) => out('unsupported', why, { target: null, manual: { provider: provider || 'none', steps: manualInstructions(provider || 'none') }, ...extra });

  if (!Array.isArray(trail) || trail.length < 2) {
    return out('validation_failed', reason('TRAIL_NOT_CONFIRMED', 'Confirm the breadcrumb trail above first. Odito never switches breadcrumbs on without a trail you approved.'));
  }
  if (live?.status === 'valid') {
    return out('nothing_to_change', reason('STALE_FINDING', 'This page already outputs a valid BreadcrumbList, so there is nothing to apply. The finding leaves the audit after the next analysis of the page.'));
  }
  if (live && ['invalid', 'duplicate'].includes(live.status)) {
    return unsupported(reason('EXISTING_BREADCRUMB_INVALID', live.status === 'duplicate'
      ? 'This page already outputs more than one BreadcrumbList. Switching on another source would not remove the duplicate — fix or remove the extra one where it comes from.'
      : `This page already outputs a BreadcrumbList, but it is not valid (${(live.problems || []).join(', ') || 'see the structured data'}). Switching on another source would add a second one — fix the existing one where it comes from.`), { manual: { provider: provider || 'none', steps: ['Find where the existing BreadcrumbList comes from (your theme, a schema plugin or custom code) and correct or remove it.', 'Then publish the trail below in that one place only.'] } });
  }
  if (unavailable) return unsupported(reason(unavailable.code, unavailable.message));
  if (provider !== 'rank_math') {
    return unsupported(reason('PROVIDER_NOT_SUPPORTED', provider === 'multiple'
      ? 'More than one SEO plugin is active on this WordPress site, so Odito cannot tell which one publishes the breadcrumbs.'
      : `Breadcrumbs can only be switched on through Rank Math. ${provider && provider !== 'none' ? `This site uses ${provider}.` : 'No supported SEO plugin was detected.'}`));
  }
  if (!capabilities.siteSchemaSupported) {
    return out('blocked', reason('BRIDGE_UPDATE_REQUIRED', 'Switching on breadcrumbs requires Odito SEO Bridge 1.4.0 or newer. Update the plugin on this WordPress site, then try again.'),
      { blocked: [{ field: BREADCRUMB_FIELD, code: 'BRIDGE_UPDATE_REQUIRED', message: 'Update the Odito SEO Bridge plugin.' }] });
  }
  if (enabledNow === true) {
    return unsupported(reason('BREADCRUMBS_ALREADY_ON', 'Rank Math breadcrumbs are already switched on, yet this page outputs no BreadcrumbList. Something else prevents it (the breadcrumb setting for this content type, a theme override or another plugin), and Odito cannot change that. Publish the trail below instead.'));
  }
  if (!resource || !resource.resolved) {
    return unsupported(reason('PAGE_NOT_RESOLVED', resource?.message || 'This page could not be matched to a WordPress page or post, so Odito cannot tell what trail Rank Math would build for it.'));
  }

  const warnings = [];
  const approved = keysOf(trail.map((t) => t.url));
  if (predicted?.predictable) {
    const would = keysOf(predicted.urls);
    if (!sameKeys(would, approved)) {
      return unsupported(reason('TRAIL_WOULD_DIFFER', `Rank Math would build this trail from your page structure: ${predicted.urls.join(' › ')}. It differs from the one you confirmed (${trail.map((t) => t.url).join(' › ')}), so switching it on would publish a trail you did not approve.`), {
        predicted: { urls: predicted.urls },
      });
    }
  } else {
    warnings.push({ code: 'TRAIL_NOT_PREDICTABLE', message: predicted?.reason || 'Rank Math decides this page\'s trail when it renders (for a post: its category or the blog page), so Odito cannot confirm in advance that it matches yours. The rendered page is checked right after the change.' });
  }
  warnings.push({ code: 'SITE_WIDE', message: 'This is a site-wide Rank Math setting: it turns breadcrumbs on for every page, not only this one. Odito checks the pages affected by this finding one by one afterwards.' });
  warnings.push({ code: 'RANK_MATH_OPTIONS', message: 'Rank Math options such as "Hide Homepage Link" change the trail it builds. Odito verifies the real page, not the setting.' });

  const changes = [{ field: BREADCRUMB_FIELD, kind: 'enable', before: '', after: 'on', source: 'owner_confirmed_trail', label: 'Rank Math breadcrumbs', rankMathOption: BREADCRUMB_TARGET.rank_math.storage }];
  return out('ready', {}, { changes, warnings, predicted: predicted ? { predictable: !!predicted.predictable, urls: predicted.urls || [] } : null });
}

function finish(plan, { trail, live, enabledNow, provider, predicted, capabilities = {}, context = {} }) {
  const material = JSON.stringify({
    v: BREADCRUMB_PLAN_VERSION, t: BREADCRUMB_FIX_TYPE,
    ctx: [String(context.projectId ?? ''), String(context.connectionId ?? ''), String(context.pageUrl ?? '')],
    s: plan.status, c: plan.code,
    ch: plan.changes.map((c) => [c.field, c.kind, c.before, c.after]),
    trail: (trail || []).map((t) => [t.name, t.url]),
    live: live?.status || null, on: enabledNow, prov: provider || null,
    pred: predicted ? [!!predicted.predictable, keysOf(predicted.urls)] : null,
    cap: !!capabilities.siteSchemaSupported,
  });
  return { ...plan, fingerprint: crypto.createHash('sha256').update(material).digest('hex') };
}

export default { planBreadcrumbFix, manualInstructions, BREADCRUMB_FIX_TYPE, BREADCRUMB_ISSUE_KEY, BREADCRUMB_FIELD, BREADCRUMB_PLAN_VERSION, BREADCRUMB_TARGET };
