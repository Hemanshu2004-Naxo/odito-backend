/**
 * renderComparison — what JavaScript changed: raw HTML facts vs rendered DOM facts (both produced by the SAME inspector, so they are
 * directly comparable). Pure.
 */

const norm = (u) => String(u || '').replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase();

export function compareRawRendered(raw, rendered) {
  const diffs = [];
  const add = (aspect, a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push({ aspect, raw: a, rendered: b }); };

  const rawTypes = [...(raw.structuredData?.jsonLdTypes || [])].sort();
  const renTypes = [...(rendered.structuredData?.jsonLdTypes || [])].sort();
  add('jsonLdTypes', rawTypes, renTypes);
  add('title', raw.title, rendered.title);
  add('metaDescription', raw.metaDescription, rendered.metaDescription);
  add('metaRobots', raw.metaRobots, rendered.metaRobots);
  add('canonical', (raw.canonicalLinks || []).map(norm), (rendered.canonicalLinks || []).map(norm));
  add('h1Count', raw.h1Count, rendered.h1Count);
  add('headingCount', (raw.headings || []).length, (rendered.headings || []).length);
  add('visibleBreadcrumbItems', (raw.visibleBreadcrumbs || []).map((b) => b.items.length), (rendered.visibleBreadcrumbs || []).map((b) => b.items.length));
  add('breadcrumbListCount', (raw.structuredData?.breadcrumbLists || []).length, (rendered.structuredData?.breadcrumbLists || []).length);
  add('navigationLinkCount', (raw.navigation || []).length, (rendered.navigation || []).length);
  add('imagesMissingAlt', raw.images?.missingAltAttribute, rendered.images?.missingAltAttribute);
  add('accessibilitySignalTypes', [...new Set((raw.accessibilitySignals || []).map((s) => s.type))].sort(), [...new Set((rendered.accessibilitySignals || []).map((s) => s.type))].sort());
  add('lang', raw.lang, rendered.lang);

  return {
    identical: diffs.length === 0,
    differences: diffs,
    jsonLdTypesOnlyRendered: renTypes.filter((t) => !rawTypes.includes(t)),
    jsonLdTypesOnlyRaw: rawTypes.filter((t) => !renTypes.includes(t)),
    summary: diffs.length ? `JavaScript changes: ${diffs.map((d) => d.aspect).join(', ')}` : 'The rendered DOM matches the raw HTML on every compared aspect.',
  };
}

export default { compareRawRendered };
