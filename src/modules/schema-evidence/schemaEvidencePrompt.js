/**
 * Renders schemaEvidence as the "VERIFIED SCHEMA EVIDENCE" block of a generation prompt.
 *
 * Three states are kept visibly apart so the model cannot blur them: VERIFIED (publishable),
 * OBSERVED-UNVERIFIED (seen, not confirmed - never publishable), and NOT AVAILABLE (omit it
 * and ask the owner). Nothing in this block is something the model is asked to supply.
 */

const q = (v) => JSON.stringify(v);
const list = (v) => (Array.isArray(v) ? v : [v]).map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('; ');

function organizationLines(ev) {
  const o = ev.organization;
  const lines = ['ORGANIZATION:'];
  const it = o.intent;
  if (it) {
    // The decision ODITO already made from evidence. The model writes prose around it; it does not re-decide the type.
    lines.push(`  SCHEMA INTENT: ${it.intent} - publish @type ${q(it.types.length === 1 ? it.types[0] : it.types)}${it.id ? ` reusing @id ${q(it.id)}` : ''}. Do NOT choose a different type; never downgrade a specific type to Organization and never claim a more specific one.`);
    for (const r of it.reasons || []) lines.push(`    - ${r}`);
    if (it.action === 'needs_input') lines.push(`  BLOCKED: do NOT output JSON-LD. Ask the owner for: ${(it.missing || []).map((m) => m.label).join('; ')}.`);
    if (it.action === 'reference' || it.action === 'reuse') lines.push('  The entity already exists: do NOT output a new Organization/LocalBusiness block; explain how the existing entity is reused.');
    if (o.factSources && Object.keys(o.factSources).length) lines.push(`  Fact sources: ${Object.entries(o.factSources).map(([k, v]) => `${k} <- ${v}`).join('; ')}`);
  }
  if (o.present) {
    lines.push(`  Existing entity (reuse it - do NOT create a second Organization): @id ${q(o.id)}, @type ${q(o.primary.types.length === 1 ? o.primary.types[0] : o.primary.types)}`);
    if (o.conflictingEntities || o.duplicateIds.length) lines.push(`  WARNING: the page already describes the organization ${o.entityCount} times${o.duplicateIds.length ? ` (duplicate @id: ${o.duplicateIds.map((d) => d.id).join(', ')})` : ''} - recommend consolidating to one entity.`);
  } else {
    lines.push('  Existing entity: none found on this page.');
    if (o.homepageUrl) lines.push(`  Stable @id to use: ${q(`${o.homepageUrl}#organization`)}`);
  }
  lines.push(o.name ? `  Name: ${q(o.name.value)} (VERIFIED, from ${o.name.source})` : '  Name: NOT VERIFIED - the page title/domain is only a guess; if you must write a name, flag it under implementationNotes as "confirm the official name".');
  if (o.homepageUrl) lines.push(`  Homepage URL: ${o.homepageUrl} (VERIFIED)`);

  const logo = o.logo;
  if (logo.verified) {
    const v = logo.verified;
    lines.push(`  Logo: VERIFIED ${q(v.url)} - ${v.format || 'image'}${v.width ? `, measured ${v.width}x${v.height}px` : ''}${logo.status === 'verified_html_hint' || logo.status === 'replaces_broken_existing' ? ' (found as a page image named "logo"; mention that the owner should confirm it is the brand logo)' : ''}. Use exactly this URL${v.width ? ' and these measured dimensions' : ' and NO width/height'}.`);
  } else {
    const why = {
      existing_broken: 'the logo the site already declares returns an error or is not an image',
      all_broken: 'every logo candidate returned an error or is not an image',
      unverified: 'a candidate exists but could not be fetched right now',
      none: 'no logo was found on the site',
    }[logo.status] || 'no logo could be verified';
    lines.push(`  Logo: NOT AVAILABLE (${why}). Do NOT output a "logo" property and do NOT guess a URL (never /wp-content/uploads/logo.png, never built from the domain). Say under implementationNotes: "needs your input: logo image URL".`);
  }

  const contact = Object.entries(o.contact || {});
  if (contact.length) lines.push(`  Already published by the site (reuse unchanged, only these): ${contact.map(([k, v]) => `${k}=${list(v)}`).join(' | ')}`);
  lines.push('  NOT AVAILABLE (omit; never invent): any telephone, email, address, contactPoint, sameAs entry, foundingDate, legalName, geo, openingHours or other fact that is not listed above.');
  return lines;
}

function breadcrumbLines(ev) {
  const b = ev.breadcrumb;
  const lines = ['BREADCRUMB:'];
  if (ev.url.display) lines.push(`  URL of this page for markup: ${ev.url.display} (${ev.url.trusted ? 'VERIFIED - from the page\'s canonical tag' : 'NOT CONFIRMED - this is the crawler\'s internal key, which has no trailing-slash information; say the canonical must be confirmed'})`);
  if (b.hierarchy.status === 'existing' || b.hierarchy.status === 'user_provided') {
    lines.push(b.hierarchy.status === 'existing'
      ? '  Verified hierarchy (from the page\'s existing BreadcrumbList; use exactly these items, URLs and order):'
      : '  Verified hierarchy (confirmed by the site owner; use exactly these items, URLs and order):');
    b.hierarchy.items.forEach((i, n) => lines.push(`    ${n + 1}. ${q(i.name)} -> ${i.url}`));
  } else {
    lines.push('  Hierarchy: UNKNOWN. The crawl found no valid breadcrumb trail for this page, so parent pages cannot be named. Do NOT invent parents or output a BreadcrumbList; in implementationCode write only a short explanation (not JSON-LD) that the trail comes from enabling breadcrumbs in the SEO plugin or from the owner providing the hierarchy.');
  }
  if (b.duplicateLists) lines.push('  WARNING: more than one BreadcrumbList already exists on the page.');
  return lines;
}

function articleLines(ev) {
  const a = ev.article;
  const lines = ['ARTICLE:'];
  if (!a.applicable) { lines.push(`  NOT AN ARTICLE PAGE: ${a.reason} Do not generate Article/BlogPosting markup; explain why.`); return lines; }
  lines.push(`  Applicable: ${a.reason}`);
  lines.push(`  @type to use: ${a.existing ? q(a.existingType) : a.type}${a.existing ? ' (existing - keep it)' : ''}`);
  lines.push(a.headline ? `  headline: ${q(a.headline.value)} (VERIFIED, ${a.headline.source})` : '  headline: NOT AVAILABLE');
  lines.push(a.datePublished ? `  datePublished: ${q(a.datePublished.value)} (VERIFIED, ${a.datePublished.source}${a.datePublished.hasTimezone ? '' : '; no timezone on the page - keep it exactly as written'})` : '  datePublished: NOT AVAILABLE - omit it');
  lines.push(a.dateModified ? `  dateModified: ${q(a.dateModified.value)} (VERIFIED, ${a.dateModified.source})` : '  dateModified: NOT AVAILABLE - omit it');
  lines.push(a.author ? `  author: ${q(a.author.name)} (${a.author.source === 'meta:author' ? 'OBSERVED in the page meta tags' : 'VERIFIED'})` : '  author: NOT AVAILABLE - omit it (never use a company name or a made-up person)');
  lines.push(a.image.verified ? `  image: VERIFIED ${q(a.image.verified.url)}` : '  image: NOT AVAILABLE - omit it');
  lines.push(a.mainEntityOfPage ? `  mainEntityOfPage: ${a.mainEntityOfPage} (VERIFIED canonical)` : '  mainEntityOfPage: NOT AVAILABLE - omit it');
  if (a.dateProblems?.length) lines.push(`  Ignored invalid dates: ${a.dateProblems.map((p) => `${p.field} (${p.reason})`).join(', ')}`);
  return lines;
}

export function renderSchemaEvidence(evidence) {
  if (!evidence) return '';
  const out = [
    'VERIFIED SCHEMA EVIDENCE (the ONLY facts you may publish - ODITO fetched and checked them. Anything not listed as VERIFIED must be omitted and named under implementationNotes as "needs your input: <field>"):',
  ];
  if (!evidence.pageDataAvailable) out.push('  NOTE: the crawl data for this page was not available, so nothing below is verified.');
  if (evidence.kinds.includes('organization')) out.push(...organizationLines(evidence));
  if (evidence.kinds.includes('breadcrumb')) out.push(...breadcrumbLines(evidence));
  if (evidence.kinds.includes('article')) out.push(...articleLines(evidence));
  return out.join('\n');
}

export default { renderSchemaEvidence };
