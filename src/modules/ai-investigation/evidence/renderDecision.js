/**
 * renderDecision — should this investigation pay for a browser render? Rendering is slow and shared, so it is conditional:
 * a family's policy says when the final DOM can change the diagnosis, and only evidence of JavaScript involvement (or of a disagreement
 * between the raw HTML and Odito's own stored headless crawl) triggers it. The decision and its reasons are recorded in the ledger.
 *
 * Policies:
 *   never            the final DOM cannot change the diagnosis (robots / sitemap / performance / pure server concerns)
 *   js_signals       render only when the raw HTML shows signs the page is built or altered by JavaScript
 *   js_or_sparse_nav js_signals, or the raw HTML has almost no navigation links (client-rendered menus)
 *   js_or_scripts    js_signals, or the page loads several external scripts (final-DOM accessibility state)
 */

export const RENDER_POLICY = Object.freeze({
  structured_data: 'js_signals',
  metadata_content: 'js_signals',
  canonical_redirect: 'js_signals',
  internal_links: 'js_or_sparse_nav',
  accessibility: 'js_or_scripts',
  ai_visibility: 'js_signals',
  images_alt: 'js_signals',
  general: 'js_signals',
  crawlability_indexing: 'never',
  performance: 'never',
});

/** Pure: signs that JavaScript builds or changes what the raw HTML contains. */
export function jsSignals(rawFacts, comparison) {
  const reasons = [];
  const r = rawFacts?.rendering || {};
  if (r.likelyClientRendered) reasons.push('raw HTML is an almost empty shell with several scripts (client-rendered)');
  if (r.spaRootEmpty) reasons.push('an application root element is empty in the raw HTML');
  if (r.spaRootPresent && (r.bodyTextLength ?? 0) < 1500) reasons.push('application root present with very little server-rendered text');
  if ((rawFacts?.platform?.hints || []).some((h) => ['nextjs', 'nuxt', 'react', 'angular', 'vue'].includes(h)) && (r.bodyTextLength ?? 0) < 800) reasons.push('JavaScript framework detected with little server-rendered content');
  if (comparison?.inCrawlOnly?.length) reasons.push(`the stored headless crawl saw structured data the raw HTML does not (${comparison.inCrawlOnly.join(', ')})`);
  return reasons;
}

/**
 * @returns {{ render: boolean, policy: string, family: string, reasons: string[], skipped: string|null }}
 */
export function decideRender({ plan, rawFacts, comparison = null, rendererAvailable = true }) {
  const policy = RENDER_POLICY[plan.family] || RENDER_POLICY.general;
  const base = { policy, family: plan.family, rendererAvailable };
  if (policy === 'never') return { ...base, render: false, reasons: [], skipped: `rendering cannot change the diagnosis for ${plan.family} issues` };
  if (!rawFacts) return { ...base, render: false, reasons: [], skipped: 'the raw page could not be inspected, so there is no basis to decide' };

  const reasons = jsSignals(rawFacts, comparison);
  if (policy === 'js_or_sparse_nav' && (rawFacts.navigation || []).length < 3) reasons.push(`only ${(rawFacts.navigation || []).length} navigation link(s) in the raw HTML`);
  if (policy === 'js_or_scripts' && (rawFacts.rendering?.externalScripts ?? 0) >= 3) reasons.push(`${rawFacts.rendering.externalScripts} external scripts can change the final DOM`);
  if (!reasons.length) return { ...base, render: false, reasons: [], skipped: 'no sign that JavaScript changes what the raw HTML already shows' };
  return { ...base, render: true, reasons, skipped: null };
}

export default { decideRender, jsSignals, RENDER_POLICY };
