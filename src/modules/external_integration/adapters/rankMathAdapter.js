import wordPressService from '../service/wordPressService.js';
import { SeoProviderAdapter } from './seoProviderAdapter.js';

/**
 * RankMathAdapter — NO official REST write support exists (Rank Math's own
 * support explicitly states there is no direct API access for setting meta
 * title/description; a historical `rankmath/v1/updateMeta` endpoint is
 * undocumented for third-party use and was the subject of a since-patched
 * permission_callback vulnerability — not something this integration
 * relies on). Writing Rank Math's fields requires the "Odito SEO Bridge"
 * companion plugin (a later phase, NOT implemented here) to expose
 * `rank_math_title`/`rank_math_description`/`rank_math_canonical_url` via
 * `register_post_meta`. This adapter is read-only-at-best and write:false
 * for every SEO-plugin-owned field until that bridge exists and is
 * detected as installed.
 *
 * Read is best-effort only: Rank Math does not expose its own meta via a
 * documented public REST field, so `rank_math_title`/`rank_math_description`
 * are only readable here if this specific site happens to have registered
 * them to REST itself (rare) — most sites will read back `null` for
 * everything except slug/altText (core fields, unaffected by which SEO
 * plugin is active).
 */
export class RankMathAdapter extends SeoProviderAdapter {
  static get providerName() {
    return 'rank_math';
  }

  getCapabilities() {
    return {
      title: { read: true, write: false },
      metaDescription: { read: true, write: false },
      canonical: { read: true, write: false },
      robots: { read: false, write: false },
      openGraph: { read: false, write: false },
      schema: { read: false, write: false },
      // See wordpressCoreAdapter.js's getCapabilities() comment: not yet
      // wired into the Task-verified apply flow — must not be advertised
      // as writable via the capabilities API.
      slug: { read: true, write: false },
      altText: { read: true, write: false },
    };
  }

  async getSeoData(pageUrl) {
    const resolved = await wordPressService.resolvePostIdFromUrl(this.connection, pageUrl);
    if (!resolved) return null;

    const { data: post } = await wordPressService.wpRequest(this.connection, {
      method: 'GET',
      // meta is only returned here if the site has registered these
      // specific keys to REST itself — absent on the overwhelming majority
      // of Rank Math sites; this is a genuine best-effort read, not a
      // guaranteed one.
      path: `/wp-json/wp/v2/${resolved.postType}/${resolved.postId}?context=edit&_fields=id,link,meta`,
    });
    const meta = post.meta || {};

    return {
      pageId: resolved.postId,
      postType: resolved.postType,
      url: pageUrl,
      seo: {
        title: meta.rank_math_title ?? null,
        metaDescription: meta.rank_math_description ?? null,
        canonical: meta.rank_math_canonical_url ?? null,
        robots: null,
        openGraph: { title: null, description: null, image: null },
        schema: null,
      },
      provider: { name: 'rank_math', version: null },
    };
  }
}

export default RankMathAdapter;
