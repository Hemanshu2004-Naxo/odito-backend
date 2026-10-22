import crypto from 'crypto';

/**
 * Profile snapshot — turns the resolved Social Business Profile
 * (socialBusinessProfileResolver.js) into the compact, token-free object that
 * (a) is given to the AI, (b) is stored with the strategy so an old strategy
 * stays reproducible, and (c) is hashed so a later change to the Business
 * Profile can be detected ("this strategy was generated from an older profile").
 *
 * Nothing here re-implements the Google / project precedence rules: it only
 * flattens the `{ value, source }` facts the resolver already decided. No phone,
 * hours, map links, Google ids, connection data or tokens are included — a
 * strategy does not need them and a snapshot must not be a second copy of them.
 */

const val = (fact) => (fact && fact.source !== 'unavailable' && fact.value !== undefined ? fact.value : null);

/** Fields that legitimately move without the profile having been edited (a new review changes the rating). They are in the snapshot for the AI, but not in the change-detection hash. */
const VOLATILE_BUSINESS_FIELDS = ['rating', 'reviewCount'];
/** Informational flags: connecting GBP changes the facts themselves (which ARE hashed), the flag alone is not a change. */
const NON_HASHED_TOP_LEVEL = ['hasGoogleBusinessProfile', 'hasLogo'];

/**
 * Bounds that keep a snapshot small and deterministic however big the catalog is. A snapshot carries REFERENCES
 * (ids, URLs) to media — never an image, never a storage key.
 */
export const SNAPSHOT_LIMITS = Object.freeze({
  services: 30,
  products: 50,
  imagesPerProduct: 5,
  productDescription: 600,
  serviceDescription: 600,
  brandText: 500,
});

const VISUAL_BRAND_KEYS = ['primaryColor', 'secondaryColor', 'accentColor', 'fontHeading', 'fontBody'];
const clip = (v, max) => (typeof v === 'string' ? v.slice(0, max) : v);
const list = (v) => (Array.isArray(v) ? [...v] : []);

/**
 * The Brand Kit's user-entered identity and messaging (voice, personality, tagline, key messages, preferred words,
 * instructions, the uploaded logo's URL). Returns null when the user has set none of it, so a profile that never
 * used the Brand Kit produces exactly the snapshot (and hash) it always did.
 */
function buildBrandKit(resolvedProfile) {
  const b = resolvedProfile.brand || {};
  const kit = {};
  const put = (key, value) => {
    if (Array.isArray(value) ? value.length : (typeof value === 'string' ? value.trim() : value)) kit[key] = value;
  };
  put('name', clip(b.name, SNAPSHOT_LIMITS.brandText));
  put('description', clip(b.description, SNAPSHOT_LIMITS.brandText));
  put('voice', clip(b.voice, SNAPSHOT_LIMITS.brandText));
  put('personality', list(b.personality));
  put('tagline', clip(b.tagline, SNAPSHOT_LIMITS.brandText));
  put('keyMessages', list(b.keyMessages));
  put('preferredWords', list(b.preferredWords));
  put('instructions', clip(b.additionalInstructions, SNAPSHOT_LIMITS.brandText));
  // Only a logo the USER uploaded is referenced (a Google / website logo URL can expire or change on its own).
  const logo = resolvedProfile.media?.logo;
  if (logo?.source === 'social_override' && typeof logo.value === 'string' && logo.value) kit.logoUrl = logo.value;
  return Object.keys(kit).length ? kit : null;
}

const toSnapshotService = (s) => ({
  id: s.id,
  name: s.name,
  description: clip(s.description || '', SNAPSHOT_LIMITS.serviceDescription),
  category: s.category ?? null,
  features: list(s.features),
  benefits: list(s.benefits),
  url: s.serviceUrl ?? null,
  tags: list(s.tags),
});

/**
 * Prices are snapshotted as the display string a caption would use ("₹1,299"): the content guard only accepts a
 * price that appears in the supplied text, so the number alone would make every real price look invented.
 */
const toSnapshotProduct = (p) => ({
  id: p.id,
  name: p.name,
  shortDescription: p.shortDescription || '',
  description: clip(p.description || '', SNAPSHOT_LIMITS.productDescription),
  category: p.category ?? null,
  subcategory: p.subcategory ?? null,
  features: list(p.features),
  benefits: list(p.benefits),
  price: p.priceDisplay ?? null,
  salePrice: p.salePriceDisplay ?? null,
  url: p.productUrl ?? null,
  tags: list(p.tags),
  images: (p.images || []).slice(0, SNAPSHOT_LIMITS.imagesPerProduct).map((i) => ({ mediaId: i.mediaId, url: i.url, altText: i.altText || '', isPrimary: !!i.isPrimary })),
});

/**
 * @param {object} resolvedProfile  resolvedProfile from resolveSocialBusinessProfile()
 * @param {{ seoScope?: string|null, now?: Date }} [extra]
 */
export function buildProfileData(resolvedProfile, { seoScope = null } = {}) {
  const b = resolvedProfile.business;
  const s = resolvedProfile.strategy;
  const loc = b.location;
  const data = {
    business: {
      name: val(b.name),
      description: val(b.description),
      category: val(b.category),
      secondaryCategories: val(b.secondaryCategories) || [],
      website: val(b.website),
      language: val(b.language),
      seoScope: seoScope || null,
      location: { address: val(loc.address), city: val(loc.city), region: val(loc.region), country: val(loc.country) },
      serviceArea: val(b.serviceArea),
      rating: val(b.rating),
      reviewCount: val(b.reviewCount),
    },
    audience: { primary: s.audience?.primary ?? null, secondary: s.audience?.secondary || [] },
    toneOfVoice: { primary: s.toneOfVoice?.primary ?? null, secondary: s.toneOfVoice?.secondary || [] },
    goals: s.goals || [],
    uniqueSellingPoints: s.uniqueSellingPoints || [],
    offers: s.offers || [],
    competitors: s.competitors || [],
    contentPillars: s.contentPillars || [],
    prohibitedPhrases: s.prohibitedPhrases || [],
    additionalInstructions: s.additionalInstructions || '',
    // colours and fonts only: the rest of the Brand Kit is `brandKit` below, which exists only when the user used it
    brand: Object.fromEntries(VISUAL_BRAND_KEYS.filter((k) => k in (resolvedProfile.brand || {})).map((k) => [k, resolvedProfile.brand[k]])),
    hasLogo: !!val(resolvedProfile.media?.logo),
    connectedPlatforms: {
      facebook: !!resolvedProfile.social?.facebook?.connected,
      instagram: !!resolvedProfile.social?.instagram?.connected,
    },
    hasGoogleBusinessProfile: !!resolvedProfile.meta?.hasGoogleBusinessProfile,
  };

  // Everything below is OPTIONAL: it is added only when it has content, so a profile that never used the business
  // model / Brand Kit / services / catalog produces the same snapshot — and the same hash — as before they existed
  // (existing strategies are not suddenly reported as "profile changed").
  const businessModel = val(b.businessModel);
  if (businessModel) data.businessModel = businessModel;

  const brandKit = buildBrandKit(resolvedProfile);
  if (brandKit) data.brandKit = brandKit;

  const services = (resolvedProfile.services || []).slice(0, SNAPSHOT_LIMITS.services).map(toSnapshotService);
  if (services.length) data.services = services;

  const allProducts = resolvedProfile.products || [];
  const products = allProducts.slice(0, SNAPSHOT_LIMITS.products).map(toSnapshotProduct);
  if (products.length) {
    data.products = products;
    if (allProducts.length > products.length) data.productCount = allProducts.length; // the snapshot says it is a partial list
  }
  return data;
}

/**
 * The part of the data that decides whether a strategy is out of date. Media references are NOT part of it: a new
 * product photo or a new logo file changes no fact the strategy was built on, so it must not mark the strategy stale
 * (the references stay in the stored snapshot for the AI; a future feature resolves live media by product id).
 */
function hashable(data) {
  const copy = JSON.parse(JSON.stringify(data));
  for (const k of VOLATILE_BUSINESS_FIELDS) delete copy.business?.[k];
  for (const k of NON_HASHED_TOP_LEVEL) delete copy[k];
  if (copy.brandKit) {
    delete copy.brandKit.logoUrl;
    if (!Object.keys(copy.brandKit).length) delete copy.brandKit;
  }
  if (copy.products) for (const p of copy.products) delete p.images;
  return copy;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  }
  return value;
}

export function hashProfileData(data) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(hashable(data)))).digest('hex');
}

export function buildProfileSnapshot(resolvedProfile, { seoScope = null, now = new Date() } = {}) {
  const data = buildProfileData(resolvedProfile, { seoScope });
  return { generatedAt: now, hash: hashProfileData(data), data };
}

/** Tracked groups for the "what changed" list (rating / review count are excluded on purpose). */
const TRACKED = [
  ['business.name', (d) => d.business.name],
  ['business.description', (d) => d.business.description],
  ['business.category', (d) => d.business.category],
  ['business.secondaryCategories', (d) => d.business.secondaryCategories],
  ['business.website', (d) => d.business.website],
  ['business.language', (d) => d.business.language],
  ['business.seoScope', (d) => d.business.seoScope],
  ['business.location', (d) => d.business.location],
  ['business.serviceArea', (d) => d.business.serviceArea],
  ['audience', (d) => d.audience],
  ['toneOfVoice', (d) => d.toneOfVoice],
  ['goals', (d) => d.goals],
  ['uniqueSellingPoints', (d) => d.uniqueSellingPoints],
  ['offers', (d) => d.offers],
  ['competitors', (d) => d.competitors],
  ['contentPillars', (d) => d.contentPillars],
  ['prohibitedPhrases', (d) => d.prohibitedPhrases],
  ['additionalInstructions', (d) => d.additionalInstructions],
  ['brand', (d) => d.brand],
  ['businessModel', (d) => d.businessModel],
  ['brandKit', (d) => { const { logoUrl: _logoUrl, ...rest } = d.brandKit || {}; return Object.keys(rest).length ? rest : null; }],
  ['services', (d) => d.services],
  ['products', (d) => (d.products ? d.products.map(({ images: _images, ...rest }) => rest) : null)],
  ['connectedPlatforms', (d) => d.connectedPlatforms],
];

/** Which tracked parts of the profile differ between the snapshot a strategy was made from and the profile now. */
export function diffProfileData(oldData, newData) {
  if (!oldData || !newData) return [];
  return TRACKED
    .filter(([, pick]) => JSON.stringify(canonical(pick(oldData) ?? null)) !== JSON.stringify(canonical(pick(newData) ?? null)))
    .map(([path]) => path);
}

/**
 * Every string in a snapshot, joined: the only text a generated figure / address / link may be traced back to.
 * (Strategy, calendar and post generation all use it for their "no invented facts" guards.)
 */
export function snapshotFactsText(value) {
  const out = [];
  const walk = (v) => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(value);
  return out.join(' \n ');
}

const hasText = (v) => typeof v === 'string' && v.trim().length > 0;

/**
 * What is missing from the profile, computed deterministically on the server
 * (never left to the AI to notice). Used for the UI's "complete your profile"
 * list and merged into the strategy's gaps.
 */
export function computeProfileGaps(data) {
  const gaps = [];
  const add = (field, importance, reason) => gaps.push({ field, importance, reason, source: 'profile' });
  const b = data.business;

  if (!hasText(data.audience.primary)) add('audience', 'high', 'No primary audience has been defined.');
  if (!data.goals.length) add('goals', 'high', 'No business goals have been defined.');
  if (!data.connectedPlatforms.facebook && !data.connectedPlatforms.instagram) add('connectedPlatforms', 'high', 'No Facebook or Instagram account is connected, so platform advice is general.');
  if (!hasText(b.description)) add('description', 'medium', 'There is no business description.');
  if (!hasText(b.category)) add('category', 'medium', 'There is no business category.');
  if (!hasText(data.toneOfVoice.primary)) add('toneOfVoice', 'medium', 'No tone of voice has been defined.');
  if (!data.uniqueSellingPoints.length) add('uniqueSellingPoints', 'medium', 'No unique selling points have been defined.');
  if (!hasText(b.location.city) && !hasText(b.location.address) && !hasText(b.location.country)) add('location', 'low', 'No business location is known.');
  if (!data.offers.length) add('offers', 'low', 'No offers have been defined.');
  if (!data.competitors.length) add('competitors', 'low', 'No competitors have been defined.');
  if (!data.contentPillars.length) add('contentPillars', 'low', 'No content pillars have been defined; the AI proposes some.');
  if (!data.brand.primaryColor && !data.brand.fontHeading) add('brand', 'low', 'No brand colours or fonts have been set.');
  // What the business sells: only asked for once the business has said what kind of business it is.
  if (!data.businessModel) add('businessModel', 'medium', 'The business has not said whether it is service-based or product-based.');
  if (data.businessModel === 'service' && !(data.services || []).length) add('services', 'medium', 'No services have been added to the service catalog.');
  if (data.businessModel === 'product' && !(data.products || []).length) add('products', 'medium', 'No products have been added to the product catalog.');
  return gaps;
}

/**
 * The minimum needed to responsibly generate a strategy. Deliberately small:
 * the business must at least be describable (a description or a category).
 * Everything else only produces a gap, not a refusal.
 */
export function generationBlockers(data) {
  const blockers = [];
  if (!hasText(data.business.name)) blockers.push({ field: 'name', reason: 'The business has no name.' });
  if (!hasText(data.business.description) && !hasText(data.business.category)) {
    blockers.push({ field: 'description', reason: 'Add a business description or category in the Business profile so the strategy has something real to work from.' });
  }
  return blockers;
}

export default { buildProfileData, buildProfileSnapshot, hashProfileData, diffProfileData, computeProfileGaps, generationBlockers, snapshotFactsText };
