/**
 * SeedExpansionService — Onboarding keyword seed expansion.
 *
 * Maps a business subType (or fallback seedKeyword) to 5–10 commercial
 * seed phrases. Each seed is sent as a separate DataForSEO task in the
 * batched keyword_suggestions/live request, dramatically widening the
 * result pool compared to a single seed.
 *
 * Rules:
 *  - Used ONLY by the onboarding keyword suggestion pipeline.
 *  - Never imported by ranking, SERP, or Maps modules.
 *  - Stateless — no DB, no HTTP.
 */

// Primary seed map keyed by lowercased subType or mappedSeed.
const SEED_MAP = {
  // ── Software / IT ────────────────────────────────────────────────────────
  'software':               ['software company', 'software development company', 'custom software development', 'IT company', 'software solutions'],
  'software company':       ['software company', 'software development company', 'custom software development', 'IT company', 'software solutions'],
  'it services':            ['IT services company', 'IT support services', 'managed IT services', 'IT consulting company', 'IT solutions provider'],
  'it services company':    ['IT services company', 'IT support services', 'managed IT services', 'IT consulting company', 'IT solutions provider'],
  'it company':             ['IT company', 'IT services company', 'technology company', 'IT solutions', 'tech company'],

  // ── Marketing / Agency ───────────────────────────────────────────────────
  'agency':                 ['digital marketing agency', 'marketing agency', 'advertising agency', 'SEO agency', 'branding agency'],
  'digital marketing':      ['digital marketing agency', 'SEO agency', 'social media marketing agency', 'online marketing agency', 'digital marketing services'],
  'digital marketing agency':['digital marketing agency', 'SEO agency', 'social media marketing agency', 'online marketing services', 'PPC agency'],
  'marketing':              ['marketing agency', 'digital marketing agency', 'advertising agency', 'branding agency', 'marketing services'],
  'marketing agency':       ['marketing agency', 'digital marketing agency', 'advertising agency', 'branding agency', 'marketing services'],

  // ── Food & Beverage ──────────────────────────────────────────────────────
  'restaurant':             ['restaurant', 'fine dining restaurant', 'family restaurant', 'best restaurant near me', 'local restaurant'],
  'cafe':                   ['cafe', 'coffee shop', 'best cafe near me', 'coffee house', 'cafe restaurant'],
  'bakery':                 ['bakery', 'artisan bakery', 'cake shop', 'best bakery near me', 'custom cake bakery'],

  // ── Hospitality ──────────────────────────────────────────────────────────
  'hotel':                  ['hotel', 'luxury hotel', 'business hotel', 'hotel accommodation', 'best hotel near me'],

  // ── Healthcare ───────────────────────────────────────────────────────────
  'clinic':                 ['medical clinic', 'health clinic', 'primary care clinic', 'general practice clinic', 'healthcare clinic'],
  'dentist':                ['dentist', 'dental clinic', 'dental care services', 'emergency dentist', 'teeth whitening services'],
  'dental':                 ['dental clinic', 'dental care services', 'dentist near me', 'teeth whitening', 'dental services'],
  'dental clinic':          ['dental clinic', 'dental care services', 'dentist near me', 'cosmetic dentistry', 'dental services'],
  'doctor':                 ['doctor', 'general physician', 'medical doctor near me', 'family doctor', 'healthcare provider'],
  'hospital':               ['hospital', 'multispeciality hospital', 'medical center', 'private hospital', 'healthcare hospital'],
  'pharmacy':               ['pharmacy', 'medical store', 'online pharmacy', 'prescription pharmacy', 'drugstore near me'],

  // ── Legal ────────────────────────────────────────────────────────────────
  'lawyer':                 ['lawyer', 'attorney', 'legal services', 'law firm', 'legal consultant'],
  'law firm':               ['law firm', 'legal services company', 'corporate law firm', 'attorney services', 'legal consulting firm'],

  // ── Fitness & Wellness ───────────────────────────────────────────────────
  'gym':                    ['gym', 'fitness center', 'health club', 'fitness gym near me', 'workout center'],
  'salon':                  ['salon', 'beauty salon', 'hair salon', 'beauty services', 'best salon near me'],
  'spa':                    ['spa', 'day spa', 'wellness spa', 'luxury spa near me', 'spa services'],

  // ── Real Estate ──────────────────────────────────────────────────────────
  'real estate':            ['real estate company', 'property dealer', 'real estate agency', 'property consultant', 'real estate services'],
  'real_estate':            ['real estate company', 'property dealer', 'real estate agency', 'property consultant', 'real estate services'],
  'real estate company':    ['real estate company', 'property dealer', 'real estate agency', 'property consultant', 'real estate developer'],

  // ── Consulting ───────────────────────────────────────────────────────────
  'consulting':             ['consulting firm', 'business consulting company', 'management consulting', 'strategy consulting firm', 'consulting services'],
  'consulting firm':        ['consulting firm', 'business consulting company', 'management consulting', 'strategy consulting firm', 'consulting services'],

  // ── E-commerce ───────────────────────────────────────────────────────────
  'ecommerce':              ['online store', 'e-commerce store', 'online shopping', 'online retail store', 'buy online'],
  'online store':           ['online store', 'e-commerce store', 'online shopping', 'online retail store', 'buy online'],

  // ── Education ────────────────────────────────────────────────────────────
  'school':                 ['school', 'private school', 'best school near me', 'primary school', 'educational institution'],
  'college':                ['college', 'best college near me', 'private college', 'degree college', 'higher education college'],

  // ── Home Services ────────────────────────────────────────────────────────
  'plumber':                ['plumber', 'plumbing services', 'emergency plumber near me', 'plumbing contractor', 'pipe repair services'],
  'electrician':            ['electrician', 'electrical services', 'emergency electrician near me', 'electrical contractor', 'electrical repair services'],
  'carpenter':              ['carpenter', 'carpentry services', 'furniture carpenter', 'custom carpentry', 'woodwork services'],
  'interior':               ['interior designer', 'interior design services', 'home interior designer', 'office interior design', 'interior decoration services'],
  'interior design':        ['interior designer', 'interior design services', 'home interior designer', 'office interior design', 'interior decoration services'],
  'interior designer':      ['interior designer', 'interior design services', 'home interior designer', 'office interior design', 'interior decoration company'],

  // ── Creative ─────────────────────────────────────────────────────────────
  'architect':              ['architect', 'architecture firm', 'residential architect', 'commercial architect', 'architecture services'],
  'photographer':           ['photographer', 'professional photographer', 'photography services', 'commercial photographer', 'event photographer'],

  // ── Travel & Transport ───────────────────────────────────────────────────
  'travel':                 ['travel agency', 'tour operator', 'travel services', 'holiday packages', 'travel consultant'],
  'travel agency':          ['travel agency', 'tour operator', 'travel services', 'holiday packages', 'vacation travel agency'],
  'logistics':              ['logistics company', 'logistics services', 'freight company', 'supply chain services', 'cargo company'],
  'logistics company':      ['logistics company', 'logistics services', 'freight company', 'supply chain solutions', 'cargo company'],
  'transport':              ['transport company', 'transportation services', 'freight services', 'cargo transport', 'logistics company'],
  'transport company':      ['transport company', 'transportation services', 'freight services', 'cargo transport', 'logistics solutions'],

  // ── Finance & Legal ──────────────────────────────────────────────────────
  'ca firm':                ['CA firm', 'chartered accountant firm', 'accounting firm', 'tax consultant', 'financial consulting firm'],
  'accountant':             ['accountant', 'accounting services', 'tax accountant', 'bookkeeping services', 'financial accountant'],
  'insurance':              ['insurance company', 'insurance agency', 'insurance services', 'insurance provider', 'insurance broker'],
  'insurance company':      ['insurance company', 'insurance agency', 'insurance services', 'life insurance company', 'general insurance company'],
  'bank':                   ['bank', 'banking services', 'commercial bank', 'private bank', 'financial institution'],

  // ── Retail ───────────────────────────────────────────────────────────────
  'shop':                   ['shop', 'retail shop', 'local shop near me', 'specialty shop', 'online shop'],
  'store':                  ['store', 'retail store', 'specialty store', 'local store near me', 'online store'],

  // ── Non-profit ───────────────────────────────────────────────────────────
  'ngo':                    ['NGO', 'non-profit organization', 'charitable organization', 'non-governmental organization', 'social organization'],
};

function defaultSeeds(seedKeyword) {
  const base = seedKeyword.trim();
  return [
    base,
    `${base} services`,
    `professional ${base}`,
    `best ${base} near me`,
    `${base} company`,
  ];
}

export const SeedExpansionService = {
  /**
   * Expand a business subType or seedKeyword into 5–10 commercial seed phrases.
   *
   * @param {string} subType     - Raw business category from onboarding (e.g. "software")
   * @param {string} seedKeyword - Mapped commercial seed (e.g. "software company")
   * @returns {string[]}
   */
  expandKeywordSeeds(subType, seedKeyword) {
    const subTypeLower   = (subType    || '').toLowerCase().trim();
    const seedKeywordLow = (seedKeyword || '').toLowerCase().trim();

    // Exact match on subType first
    if (subTypeLower && SEED_MAP[subTypeLower]) {
      const seeds = SEED_MAP[subTypeLower];
      console.log(`[KW_SEED_EXPANSION] subType="${subType}" | match=exact_subtype | count=${seeds.length} | seeds=${seeds.join(' | ')}`);
      return seeds;
    }

    // Exact match on mappedSeed
    if (seedKeywordLow && SEED_MAP[seedKeywordLow]) {
      const seeds = SEED_MAP[seedKeywordLow];
      console.log(`[KW_SEED_EXPANSION] subType="${subType}" | match=exact_seed | count=${seeds.length} | seeds=${seeds.join(' | ')}`);
      return seeds;
    }

    // Partial match on subType (e.g. "digital marketing" ⊂ "digital marketing agency")
    for (const [key, seeds] of Object.entries(SEED_MAP)) {
      if (subTypeLower && (key.includes(subTypeLower) || subTypeLower.includes(key))) {
        console.log(`[KW_SEED_EXPANSION] subType="${subType}" | match=partial(${key}) | count=${seeds.length} | seeds=${seeds.join(' | ')}`);
        return seeds;
      }
    }

    // Default: generate generic commercial variations from the seed keyword
    const seeds = defaultSeeds(seedKeyword || subType);
    console.log(`[KW_SEED_EXPANSION] subType="${subType}" | match=default | count=${seeds.length} | seeds=${seeds.join(' | ')}`);
    return seeds;
  },
};
