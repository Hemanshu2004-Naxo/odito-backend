/**
 * WordPress CONTENT adapters: the safe, page-builder-specific way to change what a page
 * actually says (as opposed to the SEO-plugin fields the Bridge/Rank Math handle).
 *
 * WHY THIS EXISTS: an H1 is not an SEO-plugin field. It lives in the page's own content —
 * Gutenberg blocks, Divi shortcodes, Elementor JSON, or plain HTML — and each of those has
 * its own structure. A generic `post_content.replace(...)` or "prepend <h1>" would corrupt
 * page-builder layouts, shortcodes and reusable blocks. So there is no generic writer: each
 * builder gets an adapter that understands its format and exposes only narrow, deterministic
 * operations. An adapter that cannot make a change SAFELY says so (supported: false + reason)
 * and the UI never offers Apply.
 *
 * The frontend never supplies content, meta keys or operations. The backend derives the
 * operation from: Task -> Recommendation -> issue type -> the verified WordPress page ->
 * the detected builder -> the adapter.
 *
 * `page` (what every adapter receives) is a plain object built by wordPressContentService:
 *   { id, type, status, link, title, content: { raw }, meta, rendered: { h1Count, h1NonEmpty, h1Texts } }
 */

export class ContentAdapterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ContentAdapterError';
    this.code = code;
  }
}

/** Machine-readable reasons an adapter can decline (shown to the user as `reason`). */
export const CONTENT_UNSUPPORTED = Object.freeze({
  BUILDER_NOT_SUPPORTED: 'BUILDER_NOT_SUPPORTED',
  H1_ALREADY_PRESENT: 'H1_ALREADY_PRESENT',
  MULTIPLE_H1: 'MULTIPLE_H1',
  NO_SAFE_TARGET: 'NO_SAFE_TARGET',
  EMPTY_H1_NOT_LOCATABLE: 'EMPTY_H1_NOT_LOCATABLE',
  CONTENT_UNPARSEABLE: 'CONTENT_UNPARSEABLE',
  PAGE_NOT_PUBLISHED: 'PAGE_NOT_PUBLISHED',
  UNSUPPORTED_POST_TYPE: 'UNSUPPORTED_POST_TYPE',
});

export class ContentAdapter {
  /** Stable id stored on the task and shown in the UI. */
  get name() { throw new Error(`${this.constructor.name} must define name`); }

  /** Human label ("Divi"). */
  get label() { return this.name; }

  /** True when this adapter recognises the page's content format. Pure; no network. */
  // eslint-disable-next-line no-unused-vars
  canHandle(page) { return false; }

  /**
   * What the page's H1 situation is and whether this adapter can safely change it.
   * @returns {{
   *   supported: boolean, builder: string, state: 'missing'|'empty'|'present'|'multiple'|'unknown',
   *   code?: string, reason?: string,
   *   plan?: { strategy: string, summary: string, changes: string[], target: object }
   * }}
   */
  // eslint-disable-next-line no-unused-vars
  getH1Context(page) { throw new Error(`${this.constructor.name} must implement getH1Context`); }

  /** Case A: page has no H1. @returns {{ content: string, plan: object }} the NEW post_content. */
  // eslint-disable-next-line no-unused-vars
  addH1(page, value) { throw new ContentAdapterError(CONTENT_UNSUPPORTED.NO_SAFE_TARGET, 'This adapter cannot add an H1.'); }

  /** Case B: an H1 exists but is empty. @returns {{ content: string, plan: object }} */
  // eslint-disable-next-line no-unused-vars
  updateH1(page, value) { throw new ContentAdapterError(CONTENT_UNSUPPORTED.NO_SAFE_TARGET, 'This adapter cannot update an H1.'); }

  /**
   * Checks the CONTENT after a write: exactly one intended H1, and nothing else changed.
   * @param {object} page the page as re-read after the write
   * @param {{ text: string, originalContent: string, plan: object }} expected
   * @returns {{ ok: boolean, h1Count: number, problems: string[] }}
   */
  // eslint-disable-next-line no-unused-vars
  verifyH1(page, expected) { throw new Error(`${this.constructor.name} must implement verifyH1`); }
}

export default { ContentAdapter, ContentAdapterError, CONTENT_UNSUPPORTED };
