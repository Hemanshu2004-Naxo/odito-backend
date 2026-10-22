/**
 * SeoProviderAdapter — base class every provider adapter extends.
 *
 * Deliberately thin (Phase 4, Step 1-2 of the locked architecture): the only
 * operations actually required so far are detection, a static capability
 * table, and a normalized read. Write methods are added in Phase 4 Step 4-6
 * (WordPress Core / AIOSEO / SEOPress only) directly on the adapters that
 * support them — this base class does not declare a default writeField()
 * that silently no-ops, because a silently-no-op write is a worse failure
 * mode than a missing method (the caller finds out immediately via
 * "not a function" instead of believing a write happened).
 *
 * Every adapter is constructed with a hydrated WordPressConnection (never a
 * raw URL/credential pair — see wordPressService.getHydratedConnectionOrThrow)
 * and talks to WordPress exclusively through wordPressService.wpRequest(),
 * never its own axios/fetch call — this is what keeps "no duplicated
 * WordPress HTTP logic" true as more adapters are added.
 */

/** @typedef {{read: boolean, write: boolean}} FieldCapability */
/**
 * @typedef {Object} SeoCapabilities
 * @property {FieldCapability} title
 * @property {FieldCapability} metaDescription
 * @property {FieldCapability} canonical
 * @property {FieldCapability} robots
 * @property {FieldCapability} openGraph
 * @property {FieldCapability} schema
 * @property {FieldCapability} slug
 * @property {FieldCapability} altText
 */

export class SeoProviderAdapter {
  /** @param {import('../model/WordPressConnection.js').default} connection */
  constructor(connection) {
    if (new.target === SeoProviderAdapter) {
      throw new Error('SeoProviderAdapter is abstract — instantiate a provider-specific subclass.');
    }
    this.connection = connection;
  }

  /** Stable provider key — matches WordPressConnection.detected_seo_provider's enum. */
  static get providerName() {
    throw new Error('providerName must be implemented by the subclass.');
  }

  /**
   * @returns {SeoCapabilities} A static, provider-level capability table.
   * Deliberately NOT re-probed live on every call — it reflects what this
   * integration currently implements for this provider (verified against
   * each vendor's own documentation, see the Phase 4 research report), not
   * a runtime feature-detection result. Bumping a provider from write:false
   * to write:true is a deliberate code change (a new Phase), never a value
   * that flips itself based on what a single site happens to expose.
   */
  getCapabilities() {
    throw new Error(`getCapabilities() must be implemented by ${this.constructor.name}`);
  }

  /**
   * @param {string} pageUrl
   * @returns {Promise<null | {
   *   pageId: number|string,
   *   postType: string,
   *   url: string,
   *   seo: {
   *     title: string|null,
   *     metaDescription: string|null,
   *     canonical: string|null,
   *     robots: string|null,
   *     openGraph: { title: string|null, description: string|null, image: string|null },
   *     schema: object|null,
   *   },
   *   provider: { name: string, version: string|null },
   * }>} Normalized live SEO data for one page, or null if the URL doesn't
   *   resolve to a WordPress post/page this connection's account can read.
   */
  async getSeoData(pageUrl) {
    throw new Error(`getSeoData() must be implemented by ${this.constructor.name}`);
  }
}

/** Shared "nothing resolved" capability shape — every field unsupported. */
export function emptyCapabilities() {
  const unsupported = { read: false, write: false };
  return {
    title: { ...unsupported },
    metaDescription: { ...unsupported },
    canonical: { ...unsupported },
    robots: { ...unsupported },
    openGraph: { ...unsupported },
    schema: { ...unsupported },
    slug: { ...unsupported },
    altText: { ...unsupported },
  };
}

export default SeoProviderAdapter;
