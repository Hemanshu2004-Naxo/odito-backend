import wordPressService, { WordPressConnectionError } from '../service/wordPressService.js';
import { SeoProviderAdapter } from './seoProviderAdapter.js';

/**
 * WordPressCoreAdapter — the always-available fallback. Used when no SEO
 * plugin is detected ('none'), when multiple are detected and ambiguity
 * hasn't been resolved ('multiple'), and as the source of truth for the two
 * fields (slug, image alt text) that are core WordPress concepts regardless
 * of which SEO plugin, if any, is active.
 *
 * `title` here is the post's own title (`post_title`) — when no SEO plugin
 * overrides it, this genuinely is what most themes render into the page's
 * `<title>` tag, so it's a real, correct write target for the 'none'
 * provider case. It is NOT offered as a title fix when an SEO plugin IS
 * active (see rankMathAdapter.js/yoastAdapter.js, whose own capability
 * tables report title write:false rather than silently delegating to this
 * adapter) — writing post_title while Rank Math/Yoast override the
 * rendered `<title>` would change something the user can see in wp-admin
 * without changing what a browser or crawler actually sees, which is worse
 * than doing nothing.
 */
export class WordPressCoreAdapter extends SeoProviderAdapter {
  static get providerName() {
    return 'none';
  }

  getCapabilities() {
    return {
      title: { read: true, write: true },
      metaDescription: { read: false, write: false },
      canonical: { read: false, write: false },
      robots: { read: false, write: false },
      openGraph: { read: false, write: false },
      schema: { read: false, write: false },
      // Bug fix (production-readiness audit): writeSlug()/writeAltText()
      // below are real, working, unit-tested methods — but capability must
      // mean "can currently be safely written AND subsequently verified by
      // the existing Task verification architecture" (the locked
      // architecture's own definition), not merely "an adapter method
      // exists." issueSnapshotTypes.js has no 'slug' snapshot type at all
      // (TaskVerificationService could never confirm a slug change), and
      // image_alt has no unambiguous image-target wiring yet in
      // wordPressSeoFixService.js (see its own docblock). Reporting
      // write:true here would let a future API/UI consumer reasonably
      // assume Odito's Task-based apply flow supports these fields, when it
      // does not. Flip to true only once both are wired end-to-end
      // (a separate phase, per the locked architecture).
      slug: { read: true, write: false },
      altText: { read: true, write: false },
    };
  }

  async getSeoData(pageUrl) {
    const resolved = await wordPressService.resolvePostIdFromUrl(this.connection, pageUrl);
    if (!resolved) return null;

    const { data: post } = await wordPressService.wpRequest(this.connection, {
      method: 'GET',
      // context=edit requests the unrendered `raw` variant of title/content —
      // safe here because every outbound call already authenticates as the
      // connected Application Password user, who by definition can edit
      // this content (the same account resolvePostIdFromUrl's read just used).
      path: `/wp-json/wp/v2/${resolved.postType}/${resolved.postId}?context=edit&_fields=id,link,title,slug`,
    });

    return {
      pageId: resolved.postId,
      postType: resolved.postType,
      url: post.link || pageUrl,
      seo: {
        title: post.title?.raw ?? post.title?.rendered ?? null,
        metaDescription: null,
        canonical: null,
        robots: null,
        openGraph: { title: null, description: null, image: null },
        schema: null,
      },
      provider: { name: 'none', version: null },
    };
  }

  /**
   * Writes the post's core title. Read-before-write is enforced by the
   * caller (wordPressSeoFixService.js), not here — this adapter only knows
   * how to perform the write once approved.
   */
  async writeTitle(pageUrl, newTitle) {
    const resolved = await wordPressService.resolvePostIdFromUrl(this.connection, pageUrl);
    if (!resolved) {
      throw new WordPressConnectionError('FIELD_NOT_WRITABLE', 'Could not resolve this URL to a WordPress post or page.', 422);
    }
    const { status } = await wordPressService.wpRequest(this.connection, {
      method: 'PUT',
      path: `/wp-json/wp/v2/${resolved.postType}/${resolved.postId}`,
      data: { title: newTitle },
    });
    return { httpStatus: status, wordpressPostId: resolved.postId };
  }

  async writeSlug(pageUrl, newSlug) {
    const resolved = await wordPressService.resolvePostIdFromUrl(this.connection, pageUrl);
    if (!resolved) {
      throw new WordPressConnectionError('FIELD_NOT_WRITABLE', 'Could not resolve this URL to a WordPress post or page.', 422);
    }
    const { status } = await wordPressService.wpRequest(this.connection, {
      method: 'PUT',
      path: `/wp-json/wp/v2/${resolved.postType}/${resolved.postId}`,
      data: { slug: newSlug },
    });
    return { httpStatus: status, wordpressPostId: resolved.postId };
  }

  /**
   * Alt text is attached to a media attachment, not the page/post itself —
   * `imageSrc` (the exact `src` seo_page_data recorded for this image, per
   * TaskHistoryService's image_alt snapshot shape) is resolved to a media
   * ID by filename search, then confirmed by exact `source_url` match, the
   * same "search then confirm the exact match" shape resolvePostIdFromUrl
   * uses for posts/pages.
   */
  async writeAltText(imageSrc, newAlt) {
    let filename;
    try {
      filename = new URL(imageSrc).pathname.split('/').filter(Boolean).pop();
    } catch {
      throw new WordPressConnectionError('FIELD_NOT_WRITABLE', 'This image URL could not be resolved to a WordPress media item.', 422);
    }
    if (!filename) {
      throw new WordPressConnectionError('FIELD_NOT_WRITABLE', 'This image URL could not be resolved to a WordPress media item.', 422);
    }

    const { data } = await wordPressService.wpRequest(this.connection, {
      method: 'GET',
      path: `/wp-json/wp/v2/media?search=${encodeURIComponent(filename)}&_fields=id,source_url`,
    });
    const match = Array.isArray(data) ? data.find((item) => item.source_url === imageSrc) : null;
    if (!match) {
      throw new WordPressConnectionError('FIELD_NOT_WRITABLE', 'This image could not be found in the WordPress media library.', 422);
    }

    return this._putAltText(match.id, newAlt);
  }

  // ── Exact-target media access (used by the typed image-alt fix, ../mediaFix/) ───────────────────────────────────
  // writeAltText() above finds a media item by file-name search + equality with its source_url. The typed fix instead
  // identifies the attachment itself (imageIdentity.js) and then reads/writes THAT id only, so none of these methods searches
  // for anything to write. Only the alt_text field is ever sent.

  /** One PUT, one field: the single place an attachment's alt text is written. */
  async _putAltText(attachmentId, newAlt) {
    const { status } = await wordPressService.wpRequest(this.connection, {
      method: 'PUT',
      path: `/wp-json/wp/v2/media/${attachmentId}`,
      data: { alt_text: newAlt },
    });
    return { httpStatus: status, wordpressPostId: attachmentId };
  }

  /** @returns {Promise<object|null>} the attachment as the authenticated user may edit it, or null when it does not exist. */
  async readMediaById(attachmentId) {
    const id = Number(attachmentId);
    if (!Number.isInteger(id) || id <= 0) return null;
    const result = await wordPressService.wpRequest(this.connection, {
      method: 'GET',
      path: `/wp-json/wp/v2/media/${id}?context=edit&_fields=id,source_url,alt_text,caption,post,media_type,mime_type,media_details,modified_gmt`,
      skipErrorClassification: true,
    });
    return this._mediaOrNull(result, 'attachment');
  }

  /** Candidate attachments for a search term (acceptance is decided by exact file equality, never by this search). */
  async searchMedia(term, page = 1) {
    if (typeof term !== 'string' || !term) return [];
    const result = await wordPressService.wpRequest(this.connection, {
      method: 'GET',
      path: `/wp-json/wp/v2/media?context=edit&search=${encodeURIComponent(term)}&per_page=100&page=${Number(page) || 1}&_fields=id,source_url,alt_text,caption,post,media_type,mime_type,media_details,modified_gmt`,
      skipErrorClassification: true,
    });
    if (result.status === 400) return []; // a page beyond the last one
    const list = this._mediaOrNull(result, 'media library');
    return Array.isArray(list) ? list : [];
  }

  /** The page's raw (unrendered) content, to learn whether an image's alt is stored inside it. null when unreadable. */
  async readPostRawContent(postType, postId) {
    if (!/^[a-z0-9_-]+$/i.test(String(postType)) || !Number.isInteger(Number(postId))) return null;
    const result = await wordPressService.wpRequest(this.connection, {
      method: 'GET',
      path: `/wp-json/wp/v2/${postType}/${Number(postId)}?context=edit&_fields=id,content`,
      skipErrorClassification: true,
    });
    if (result.status === 401 || result.status === 403 || result.status === 404) return null;
    const raw = result.data?.content?.raw;
    return typeof raw === 'string' ? raw : null;
  }

  /** Writes ONLY alt_text of exactly this attachment. */
  async writeAltTextForAttachment(attachmentId, newAlt) {
    const id = Number(attachmentId);
    if (!Number.isInteger(id) || id <= 0 || typeof newAlt !== 'string') {
      throw new WordPressConnectionError('FIELD_NOT_WRITABLE', 'A valid attachment and alt text are required.', 422);
    }
    return this._putAltText(id, newAlt);
  }

  _mediaOrNull(result, what) {
    if (result.status === 404) return null;
    if (result.status === 401) throw new WordPressConnectionError('INVALID_CREDENTIALS', 'Invalid WordPress username or Application Password.', 401);
    if (result.status === 403) throw new WordPressConnectionError('PERMISSION_DENIED', `This WordPress account may not edit the ${what}.`, 403);
    if (result.status < 200 || result.status >= 300) throw new WordPressConnectionError('UNKNOWN_ERROR', `The ${what} could not be read from WordPress.`, 502);
    return result.data;
  }
}

export default WordPressCoreAdapter;
