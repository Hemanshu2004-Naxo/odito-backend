import wordPressService, { WordPressConnectionError } from '../service/wordPressService.js';
import { SeoProviderAdapter } from './seoProviderAdapter.js';

/**
 * SeopressAdapter — SEOPress ships an official REST API (since v5.0) with
 * CONFIRMED write endpoints (verified directly against seopress.org's own
 * REST API guide during Phase 4 research):
 *
 *   PUT /wp-json/seopress/v1/posts/{id}/title-description-metas   { title, description }
 *   PUT /wp-json/seopress/v1/posts/{id}/social-settings           { _seopress_social_fb_title, ... }
 *   PUT /wp-json/seopress/v1/posts/{id}/meta-robot-settings       { _seopress_robots_index, _seopress_robots_follow, _seopress_robots_canonical }
 *
 * All three require the `edit_post` capability, satisfied by any
 * Application Password whose underlying WordPress user can edit the post.
 *
 * NOT VERIFIED: a dedicated canonical-URL field/endpoint, and GET support
 * on these same paths (only PUT was confirmed in the fetched guide) — reads
 * below are a best-effort GET against the same paths and degrade to null
 * per-field on any non-2xx response rather than failing the whole read, and
 * canonical is deliberately left unimplemented (not merely unverified-but-
 * attempted) until confirmed, per the "do not assume unsupported fields"
 * requirement.
 */
export class SeopressAdapter extends SeoProviderAdapter {
  static get providerName() {
    return 'seopress';
  }

  getCapabilities() {
    return {
      title: { read: true, write: true },
      metaDescription: { read: true, write: true },
      // Not implemented: no confirmed dedicated endpoint/field for this in
      // the fetched official guide.
      canonical: { read: false, write: false },
      // Bug fix (Phase 3 verification audit): same reasoning as
      // aioseoAdapter.js — writeRobots()/writeOpenGraph() are real, working
      // methods, but issueSnapshotTypes.js/TaskVerificationService have no
      // 'robots'/'openGraph' snapshot type at all, and
      // wordPressSeoFixService.FIELD_CONFIG has no entry for either — no
      // request path could reach these write methods, so advertising
      // write:true here was a pure capabilities-API overclaim.
      robots: { read: true, write: false },
      openGraph: { read: true, write: false },
      schema: { read: false, write: false },
      // See wordpressCoreAdapter.js's getCapabilities() comment: not yet
      // wired into the Task-verified apply flow — must not be advertised
      // as writable via the capabilities API.
      slug: { read: true, write: false },
      altText: { read: true, write: false },
    };
  }

  async _bestEffortGet(resolved, path) {
    try {
      const { data } = await wordPressService.wpRequest(this.connection, {
        method: 'GET',
        path: `/wp-json/seopress/v1/posts/${resolved.postId}${path}`,
      });
      return data;
    } catch {
      // GET support on this path is unverified for this site/SEOPress
      // version — treated as "field unavailable," not a failed read.
      return null;
    }
  }

  async getSeoData(pageUrl) {
    const resolved = await wordPressService.resolvePostIdFromUrl(this.connection, pageUrl);
    if (!resolved) return null;

    const [titleDesc, social, robots] = await Promise.all([
      this._bestEffortGet(resolved, '/title-description-metas'),
      this._bestEffortGet(resolved, '/social-settings'),
      this._bestEffortGet(resolved, '/meta-robot-settings'),
    ]);

    return {
      pageId: resolved.postId,
      postType: resolved.postType,
      url: pageUrl,
      seo: {
        title: titleDesc?.title ?? null,
        metaDescription: titleDesc?.description ?? null,
        canonical: null,
        robots: this._robotsToString(robots),
        openGraph: {
          title: social?._seopress_social_fb_title ?? null,
          description: social?._seopress_social_fb_desc ?? null,
          image: social?._seopress_social_fb_img ?? null,
        },
        schema: null,
      },
      provider: { name: 'seopress', version: null },
    };
  }

  _robotsToString(robots) {
    if (!robots) return null;
    const indexPart = robots._seopress_robots_index === 'yes' ? 'noindex' : 'index';
    const followPart = robots._seopress_robots_follow === 'yes' ? 'nofollow' : 'follow';
    return `${indexPart},${followPart}`;
  }

  async _resolveOrThrow(pageUrl) {
    const resolved = await wordPressService.resolvePostIdFromUrl(this.connection, pageUrl);
    if (!resolved) {
      throw new WordPressConnectionError('FIELD_NOT_WRITABLE', 'Could not resolve this URL to a WordPress post or page.', 422);
    }
    return resolved;
  }

  async writeTitle(pageUrl, newTitle) {
    const resolved = await this._resolveOrThrow(pageUrl);
    const { status } = await wordPressService.wpRequest(this.connection, {
      method: 'PUT',
      path: `/wp-json/seopress/v1/posts/${resolved.postId}/title-description-metas`,
      data: { title: newTitle },
    });
    return { httpStatus: status, wordpressPostId: resolved.postId };
  }

  async writeMetaDescription(pageUrl, newDescription) {
    const resolved = await this._resolveOrThrow(pageUrl);
    const { status } = await wordPressService.wpRequest(this.connection, {
      method: 'PUT',
      path: `/wp-json/seopress/v1/posts/${resolved.postId}/title-description-metas`,
      data: { description: newDescription },
    });
    return { httpStatus: status, wordpressPostId: resolved.postId };
  }

  /** @param {string} robots - 'index,follow' | 'noindex,follow' | 'index,nofollow' | 'noindex,nofollow' */
  async writeRobots(pageUrl, robots) {
    const resolved = await this._resolveOrThrow(pageUrl);
    const [indexPart, followPart] = String(robots).split(',').map((s) => s.trim().toLowerCase());
    const { status } = await wordPressService.wpRequest(this.connection, {
      method: 'PUT',
      path: `/wp-json/seopress/v1/posts/${resolved.postId}/meta-robot-settings`,
      data: {
        _seopress_robots_index: indexPart === 'noindex' ? 'yes' : '',
        _seopress_robots_follow: followPart === 'nofollow' ? 'yes' : '',
      },
    });
    return { httpStatus: status, wordpressPostId: resolved.postId };
  }

  async writeOpenGraph(pageUrl, { title, description, image } = {}) {
    const resolved = await this._resolveOrThrow(pageUrl);
    const data = {};
    if (title !== undefined) data._seopress_social_fb_title = title;
    if (description !== undefined) data._seopress_social_fb_desc = description;
    if (image !== undefined) data._seopress_social_fb_img = image;
    const { status } = await wordPressService.wpRequest(this.connection, {
      method: 'PUT',
      path: `/wp-json/seopress/v1/posts/${resolved.postId}/social-settings`,
      data,
    });
    return { httpStatus: status, wordpressPostId: resolved.postId };
  }
}

export default SeopressAdapter;
