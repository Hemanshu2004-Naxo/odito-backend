import wordPressService from '../service/wordPressService.js';
import { SeoProviderAdapter } from './seoProviderAdapter.js';

/**
 * YoastAdapter — Yoast SEO ships an OFFICIAL, well-documented read-only REST
 * field, `yoast_head_json`, which returns the fully computed set of SEO
 * tags (title, meta description, canonical, robots, OG, and the JSON-LD
 * schema graph) for any post/page — confirmed against developer.yoast.com.
 * Yoast deliberately does NOT register its underlying postmeta
 * (`_yoast_wpseo_title`, `_yoast_wpseo_metadesc`, ...) as REST-writable, so
 * there is no official write path; every field here is write:false until
 * the "Odito SEO Bridge" companion plugin (a later phase, NOT implemented
 * here) registers those meta keys itself.
 */
export class YoastAdapter extends SeoProviderAdapter {
  static get providerName() {
    return 'yoast';
  }

  getCapabilities() {
    return {
      title: { read: true, write: false },
      metaDescription: { read: true, write: false },
      canonical: { read: true, write: false },
      robots: { read: true, write: false },
      openGraph: { read: true, write: false },
      schema: { read: true, write: false },
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
      path: `/wp-json/wp/v2/${resolved.postType}/${resolved.postId}?_fields=id,link,yoast_head_json`,
    });
    const head = post.yoast_head_json || {};
    const robotsObj = head.robots || {};
    const robots = (robotsObj.index || robotsObj.follow)
      ? `${robotsObj.index || 'index'},${robotsObj.follow || 'follow'}`
      : null;

    return {
      pageId: resolved.postId,
      postType: resolved.postType,
      url: post.link || pageUrl,
      seo: {
        title: head.title ?? null,
        metaDescription: head.description ?? null,
        canonical: head.canonical ?? null,
        robots,
        openGraph: {
          title: head.og_title ?? null,
          description: head.og_description ?? null,
          image: Array.isArray(head.og_image) ? (head.og_image[0]?.url ?? null) : null,
        },
        schema: head.schema ?? null,
      },
      provider: { name: 'yoast', version: null },
    };
  }
}

export default YoastAdapter;
