import wordPressService, { WordPressConnectionError } from '../service/wordPressService.js';
import { SeoProviderAdapter } from './seoProviderAdapter.js';

/**
 * AioseoAdapter — All in One SEO has an official, actively maintained,
 * free REST API (since AIOSEO 4.9.8) that reads/writes its own metadata
 * natively via an `aioseo_meta_data` object embedded in the standard
 * `/wp/v2/{posts|pages}/{id}` response body — no companion plugin needed.
 *
 * NOT independently verified in this implementation: the exact field names
 * inside `aioseo_meta_data` beyond `title`/`description` (documented in
 * AIOSEO's own guide as the property to set for updates). The OG/robots/
 * canonical field names below are this integration's best-effort mapping
 * based on AIOSEO's publicly documented meta-box field names — confirm
 * against a live AIOSEO REST response before depending on canonical/OG/
 * robots reads or writes in production; title/description are the only
 * fields confirmed directly against AIOSEO's own documentation.
 */
export class AioseoAdapter extends SeoProviderAdapter {
  static get providerName() {
    return 'aioseo';
  }

  getCapabilities() {
    return {
      title: { read: true, write: true },
      metaDescription: { read: true, write: true },
      canonical: { read: true, write: true },
      // Bug fix (Phase 3 verification audit): writeRobots()/writeOpenGraph()
      // below are real, working adapter methods — but, exactly like
      // slug/altText, issueSnapshotTypes.js has NO 'robots' or 'openGraph'
      // snapshot type at all, so TaskVerificationService has no case for
      // either one and could never confirm a change or detect a
      // regression. wordPressSeoFixService.FIELD_CONFIG correspondingly has
      // no entry for them either (title/meta_description/canonical only),
      // so this was purely a capabilities-API overclaim — no request path
      // could actually reach these write methods. Flip to write:true only
      // once a real snapshot type + TaskVerificationService case exists for
      // each (a separate phase, per the locked architecture's "do not
      // modify snapshot types unless required" rule — inventing one here
      // would be exactly that).
      robots: { read: true, write: false },
      openGraph: { read: true, write: false },
      // Schema read is plausible (AIOSEO generates schema markup), but no
      // documented write path was confirmed for it — kept read-only until
      // that's independently verified.
      schema: { read: true, write: false },
      // See wordpressCoreAdapter.js's getCapabilities() comment: these are
      // core-level fields with a working adapter method, but not yet wired
      // into the Task-verified apply flow (no issueSnapshotTypes.js
      // mapping for slug; no unambiguous image target for alt text) — the
      // capabilities API must not overclaim write support for them.
      slug: { read: true, write: false },
      altText: { read: true, write: false },
    };
  }

  async getSeoData(pageUrl) {
    const resolved = await wordPressService.resolvePostIdFromUrl(this.connection, pageUrl);
    if (!resolved) return null;

    const { data: post } = await wordPressService.wpRequest(this.connection, {
      method: 'GET',
      path: `/wp-json/wp/v2/${resolved.postType}/${resolved.postId}?context=edit&_fields=id,link,aioseo_meta_data`,
    });
    const meta = post.aioseo_meta_data || {};

    return {
      pageId: resolved.postId,
      postType: resolved.postType,
      url: post.link || pageUrl,
      seo: {
        title: meta.title ?? null,
        metaDescription: meta.description ?? null,
        canonical: meta.canonical_url ?? null,
        robots: this._robotsToString(meta),
        openGraph: {
          title: meta.og_title ?? null,
          description: meta.og_description ?? null,
          image: meta.og_image_custom_url ?? meta.og_image ?? null,
        },
        schema: meta.schema ?? null,
      },
      provider: { name: 'aioseo', version: null },
    };
  }

  _robotsToString(meta) {
    if (meta.robots_default === true || meta.robots_default === undefined) return null; // "use site default" — nothing explicit set
    const parts = [meta.robots_noindex ? 'noindex' : 'index', meta.robots_nofollow ? 'nofollow' : 'follow'];
    return parts.join(',');
  }

  async _write(pageUrl, aioseoMetaData) {
    const resolved = await wordPressService.resolvePostIdFromUrl(this.connection, pageUrl);
    if (!resolved) {
      throw new WordPressConnectionError('FIELD_NOT_WRITABLE', 'Could not resolve this URL to a WordPress post or page.', 422);
    }
    const { status } = await wordPressService.wpRequest(this.connection, {
      method: 'PUT',
      path: `/wp-json/wp/v2/${resolved.postType}/${resolved.postId}`,
      data: { aioseo_meta_data: aioseoMetaData },
    });
    return { httpStatus: status, wordpressPostId: resolved.postId };
  }

  async writeTitle(pageUrl, newTitle) {
    return this._write(pageUrl, { title: newTitle });
  }

  async writeMetaDescription(pageUrl, newDescription) {
    return this._write(pageUrl, { description: newDescription });
  }

  async writeCanonical(pageUrl, newCanonical) {
    return this._write(pageUrl, { canonical_url: newCanonical });
  }

  /** @param {string} robots - 'index,follow' | 'noindex,follow' | 'index,nofollow' | 'noindex,nofollow' */
  async writeRobots(pageUrl, robots) {
    const [indexPart, followPart] = String(robots).split(',').map((s) => s.trim().toLowerCase());
    return this._write(pageUrl, {
      robots_default: false,
      robots_noindex: indexPart === 'noindex',
      robots_nofollow: followPart === 'nofollow',
    });
  }

  async writeOpenGraph(pageUrl, { title, description, image } = {}) {
    const patch = {};
    if (title !== undefined) patch.og_title = title;
    if (description !== undefined) patch.og_description = description;
    if (image !== undefined) patch.og_image_custom_url = image;
    return this._write(pageUrl, patch);
  }
}

export default AioseoAdapter;
