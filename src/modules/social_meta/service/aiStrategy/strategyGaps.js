/**
 * strategyGaps - one list of what a strategy is missing, without duplicates.
 *
 * Gaps come from two places: the server's own profile check (computeProfileGaps: canonical fields such as `services`, `offers`) and the AI,
 * which names the same holes in its own words ("Service catalog", "Offers and pricing", "Competitors"). Both are mapped to one canonical
 * field here, so each missing thing is listed once: the server's entry wins (its reason is a fact), and an AI entry is kept only when it
 * names something the server cannot know (case studies, a booking page, ...). Applied when a strategy is saved AND when it is read, so
 * strategies saved before this rule are shown deduplicated too.
 */

const RULES = [
  ['location', /\blocation\b|\baddress\b|service area/],
  ['services', /\bservices?\b|service catalog/],
  ['products', /\bproducts?\b|product catalog/],
  ['offers', /\boffers?\b|pricing|promotions?|discounts?/],
  ['competitors', /\bcompetit/],
  ['audience', /\baudiences?\b|target customers?/],
  ['goals', /\bgoals?\b|objectives?/],
  ['toneOfVoice', /\btone\b|\bvoice\b/],
  ['uniqueSellingPoints', /selling points?|\busps?\b|differentiat/],
  ['brand', /brand colou?rs?|\bfonts?\b|visual identity/],
  ['contentPillars', /content pillars?/],
  ['connectedPlatforms', /connected (accounts?|platforms?)|account connection/],
  ['description', /business description/],
  ['category', /business category/],
  ['businessModel', /business (type|model)/],
];

/** The canonical field a gap is about (the server's field names), or a normalised form of its own name when it is about something else. */
export function canonicalGapField(field) {
  const raw = String(field || '').trim();
  if (RULES.some(([key]) => key === raw)) return raw;
  const text = raw.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/[_-]+/g, ' ');
  const hit = RULES.find(([, re]) => re.test(text));
  return hit ? hit[0] : text.replace(/[^a-z0-9]+/g, ' ').trim();
}

const RANK = { high: 0, medium: 1, low: 2 };

/**
 * Merges and deduplicates gaps. The first entry for a canonical field wins (pass the server's gaps first); a later duplicate may only raise
 * the importance. Every returned gap carries its canonical `field`; an AI gap about something the server has no field for keeps its own label
 * (`label`), so the UI can still name it.
 */
export function mergeGaps(...lists) {
  const out = new Map();
  for (const gap of lists.flat()) {
    if (!gap || typeof gap !== 'object') continue;
    const key = canonicalGapField(gap.field);
    if (!key) continue;
    const known = RULES.some(([k]) => k === key);
    const existing = out.get(key);
    if (!existing) {
      out.set(key, { ...gap, field: known ? key : gap.field, ...(known ? {} : { label: gap.label || gap.field }) });
    } else if ((RANK[gap.importance] ?? 3) < (RANK[existing.importance] ?? 3)) {
      existing.importance = gap.importance;
    }
  }
  return [...out.values()];
}

export default { canonicalGapField, mergeGaps };
