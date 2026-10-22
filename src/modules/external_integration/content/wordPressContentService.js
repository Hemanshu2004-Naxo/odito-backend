import crypto from 'crypto';
import wordPressService, { WordPressConnectionError } from '../service/wordPressService.js';
import { resolveContentAdapter } from './contentAdapterRegistry.js';
import { ContentAdapterError, CONTENT_UNSUPPORTED } from './ContentAdapter.js';
import { fetchRenderedPage, RenderedHtmlError } from './renderedHtml.js';
import { normalizeH1Value } from '../../tasks/service/h1Value.js';

/**
 * WordPress CONTENT fixes (currently: the page H1), independent of any SEO plugin and of the
 * Odito SEO Bridge. Everything about a change is derived here, on the server:
 *
 *   pageUrl -> the exact WordPress post (never an ID from the client) -> its stored content
 *   -> the builder's adapter -> a plan -> a minimal edit -> write -> READ BACK -> fetch the
 *   rendered page -> verify
 *
 * The caller (wordPressSeoFixService for the Task lifecycle) supplies only the plain-text H1
 * (already derived from the recommendation and normalized) and the fingerprint of the page
 * state the user was shown. Nothing in a request can name a post, a field or content.
 *
 * Failure handling, in order of certainty:
 *   - the stored content does not read back exactly as written, or no longer parses as the
 *     builder's format, or the change touched anything but the targeted heading -> the
 *     original content is RESTORED and the error says so;
 *   - the rendered page shows MORE than one H1 after the write -> RESTORED (we would be
 *     leaving the page worse than we found it);
 *   - the rendered page does not (yet) show the H1, or could not be fetched -> the write
 *     stays (caches and CDNs legitimately lag) but immediateVerification is 'failed'/'unknown'.
 * Whether the fix counts as done is never decided here: TaskVerificationService, after a real
 * recrawl, remains the only authority.
 */

const PAGE_FIELDS = 'id,type,status,link,slug,title,content,modified_gmt,meta';
const POST_TYPES = new Set(['posts', 'pages']);

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const lf = (s) => String(s || '').replace(/\r\n/g, '\n');

export const fingerprintOf = (page) => crypto
  .createHash('sha256')
  .update(`${page.content?.raw ?? ''}\n${page.modifiedGmt ?? ''}\n${page.status ?? ''}`)
  .digest('hex');

const conflict = (message, details = {}) => {
  const error = new WordPressConnectionError('CONFLICT', message, 409);
  error.details = { field: 'h1', reason: 'stale_current_value', ...details };
  return error;
};

function assertSameSite(connection, pageUrl) {
  let page;
  let site;
  try {
    page = new URL(pageUrl);
    site = new URL(connection.site_url);
  } catch {
    throw new WordPressConnectionError('FIELD_NOT_WRITABLE', 'The page URL is not valid.', 422);
  }
  if (page.host.toLowerCase() !== site.host.toLowerCase() || !['http:', 'https:'].includes(page.protocol)) {
    // The post is later located BY URL on the connected site, so this cannot be reached by
    // pointing a task at another site's URL — but it is refused up front anyway.
    throw new WordPressConnectionError('FIELD_NOT_WRITABLE', 'This page is not on the connected WordPress site.', 422);
  }
}

async function readPage(connection, { postId, postType }) {
  const { data } = await wordPressService.wpRequest(connection, {
    method: 'GET',
    path: `/wp-json/wp/v2/${postType}/${postId}?context=edit&_fields=${PAGE_FIELDS}`,
  });
  if (!data || data.content?.raw === undefined) {
    // Without context=edit access WordPress omits content.raw: the credentials cannot edit this page.
    throw new WordPressConnectionError('FIELD_NOT_WRITABLE', 'WordPress did not return this page\'s editable content — the connected user may not be allowed to edit it.', 422);
  }
  return {
    id: data.id,
    type: data.type,
    postType,
    status: data.status,
    link: data.link,
    slug: data.slug,
    title: { raw: data.title?.raw ?? '' },
    content: { raw: data.content.raw },
    meta: data.meta || {},
    modifiedGmt: data.modified_gmt || null,
  };
}

async function renderedState(connection, pageUrl, { cacheBust }) {
  try {
    return await fetchRenderedPage(pageUrl, { siteUrl: connection.site_url, cacheBust });
  } catch (error) {
    if (error instanceof RenderedHtmlError) return { error: error.message, code: error.code };
    throw error;
  }
}

/**
 * Resolves and reads the page a task refers to. Returns null-safe `unsupported` results as
 * data (never throws for "not a WordPress post/page" — that is a normal outcome).
 */
export async function loadTargetPage(connection, pageUrl) {
  assertSameSite(connection, pageUrl);
  // Never a cached mapping for a content read/write: the post is re-resolved every time.
  const resolved = await wordPressService.resolvePostIdFromUrl(connection, pageUrl, { useCache: false });
  if (!resolved) {
    let why = null;
    try {
      const detail = await wordPressService.resolveWordPressResource(connection, pageUrl, { useCache: false });
      if (detail && !detail.resolved) why = detail;
    } catch {
      // keep the generic outcome
    }
    return {
      ok: false,
      code: why?.reason === 'unsupported_post_type' ? CONTENT_UNSUPPORTED.UNSUPPORTED_POST_TYPE : 'PAGE_NOT_RESOLVED',
      reason: why?.message || 'This URL is not a WordPress post or page Odito can read.',
      resolutionReason: why?.reason || null,
    };
  }
  if (!POST_TYPES.has(resolved.postType)) {
    return { ok: false, code: CONTENT_UNSUPPORTED.UNSUPPORTED_POST_TYPE, reason: 'Only posts and pages can be changed.' };
  }
  const page = await readPage(connection, resolved);
  if (page.status !== 'publish') {
    return { ok: false, code: CONTENT_UNSUPPORTED.PAGE_NOT_PUBLISHED, reason: 'Only published pages are changed automatically.', page };
  }
  return { ok: true, page, resolved };
}

/**
 * What the dialog shows and what decides whether "Apply via WordPress" is offered for an H1.
 * Read-only.
 */
export async function getH1Context(connection, pageUrl) {
  const target = await loadTargetPage(connection, pageUrl);
  if (!target.ok) {
    return { supported: false, code: target.code, reason: target.reason, pageUrl, builder: null, state: 'unknown' };
  }
  const { page } = target;
  const rendered = await renderedState(connection, pageUrl, { cacheBust: true });
  const adapter = resolveContentAdapter(page);
  const facts = rendered.error ? { h1Count: null, h1NonEmpty: null, h1Texts: [] } : rendered;
  const ctx = adapter.getH1Context({ ...page, rendered: facts });

  return {
    ...ctx,
    builder: { name: adapter.name, label: adapter.label },
    pageUrl,
    postId: page.id,
    postType: page.postType,
    fingerprint: fingerprintOf(page),
    current: {
      h1Count: facts.h1Count,
      h1Texts: facts.h1Texts,
      state: ctx.state,
      pageTitle: page.title.raw,
    },
    renderedCheckError: rendered.error || null,
  };
}

async function writeContent(connection, page, content) {
  await wordPressService.wpRequest(connection, {
    method: 'POST',
    path: `/wp-json/wp/v2/${page.postType}/${page.id}`,
    data: { content },
  });
}

const TRANSIENT_CODES = new Set(['TIMEOUT', 'SITE_UNREACHABLE', 'UNKNOWN_ERROR', 'RATE_LIMITED']);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Puts the original content back and confirms it. Used for automatic rollback and by the live
 * test's cleanup. Writing the original back is idempotent, so a transient connection failure
 * (a dropped connection, a timeout, a rate limit) is retried a few times with a growing pause —
 * the one moment a single network hiccup must not leave a page in the changed state. Anything
 * else (bad credentials, no permission) fails immediately.
 */
export async function restoreContent(connection, { postType, postId, originalContent }, { attempts = 4, delayMs = 1500 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await writeContent(connection, { postType, id: postId }, originalContent);
      const after = await readPage(connection, { postType, postId });
      const restored = lf(after.content.raw) === lf(originalContent);
      return { restored, fingerprint: fingerprintOf(after), attempts: attempt };
    } catch (error) {
      lastError = error;
      if (!(error instanceof WordPressConnectionError) || !TRANSIENT_CODES.has(error.code) || attempt === attempts) break;
      await sleep(delayMs * attempt);
    }
  }
  throw lastError;
}

/**
 * Applies the H1 change. See the file header for the failure/rollback rules.
 * @param {object} connection hydrated WordPress connection
 * @param {{ pageUrl: string, value: string, expectedFingerprint: string }} input
 *        value: the recommendation's H1 (any markup is normalized/refused here)
 */
export async function applyH1Change(connection, { pageUrl, value, expectedFingerprint }) {
  const normalized = normalizeH1Value(value);
  if (!normalized.ok) {
    const error = new WordPressConnectionError('INVALID_H1', normalized.message, 422);
    error.details = { field: 'h1', reason: normalized.code };
    throw error;
  }
  if (typeof expectedFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(expectedFingerprint)) {
    const error = new WordPressConnectionError('EXPECTED_STATE_REQUIRED', 'The page state you reviewed is required to apply this change. Refresh and try again.', 400);
    error.details = { field: 'h1' };
    throw error;
  }

  const target = await loadTargetPage(connection, pageUrl);
  if (!target.ok) {
    throw new WordPressConnectionError('FIELD_NOT_WRITABLE', target.reason, 422);
  }
  const { page } = target;

  // ── STALE-VALUE PROTECTION: the page must be exactly what the user reviewed ────────────
  const currentFingerprint = fingerprintOf(page);
  if (currentFingerprint !== expectedFingerprint) {
    throw conflict('This page changed on WordPress after you reviewed it, so nothing was overwritten. Refresh and review it again.', { expectedFingerprint, currentFingerprint });
  }

  const adapter = resolveContentAdapter(page);
  const rendered = await renderedState(connection, pageUrl, { cacheBust: true });
  if (rendered.error) {
    throw new WordPressConnectionError('FIELD_NOT_WRITABLE', `The page's current H1 could not be read (${rendered.error}), so it will not be changed.`, 422);
  }
  // The adapter decides from the stored content AND what visitors actually see, and its write
  // methods re-derive the same context — so they must receive the same enriched page.
  const livePage = { ...page, rendered };
  const ctx = adapter.getH1Context(livePage);
  if (!ctx.supported) {
    const status = ctx.code === CONTENT_UNSUPPORTED.H1_ALREADY_PRESENT || ctx.code === CONTENT_UNSUPPORTED.MULTIPLE_H1 ? 409 : 422;
    const error = new WordPressConnectionError(status === 409 ? 'CONFLICT' : 'FIELD_NOT_WRITABLE', ctx.reason, status);
    error.details = { field: 'h1', reason: ctx.code === CONTENT_UNSUPPORTED.H1_ALREADY_PRESENT ? 'stale_current_value' : ctx.code, builder: adapter.name };
    throw error;
  }

  let change;
  try {
    change = ctx.state === 'empty' ? adapter.updateH1(livePage, normalized.text) : adapter.addH1(livePage, normalized.text);
  } catch (error) {
    if (error instanceof ContentAdapterError) {
      throw new WordPressConnectionError('FIELD_NOT_WRITABLE', error.message, 422);
    }
    throw error;
  }

  const originalContent = page.content.raw;
  const restoreInfo = { postType: page.postType, postId: page.id, originalContent };
  const rollback = async (why) => {
    try {
      const result = await restoreContent(connection, restoreInfo);
      const error = new WordPressConnectionError('WRITE_FAILED', `${why} The original page content was restored.`, 502);
      error.details = { field: 'h1', rolledBack: true, restored: result.restored };
      return error;
    } catch (restoreError) {
      const error = new WordPressConnectionError('WRITE_FAILED', `${why} Restoring the original content ALSO failed — restore it from the page's WordPress revision history.`, 502);
      error.details = { field: 'h1', rolledBack: false, rollbackFailed: true, originalFingerprint: expectedFingerprint };
      return error;
    }
  };

  // ── WRITE ────────────────────────────────────────────────────────────────────────────
  await writeContent(connection, page, change.content);

  // ── READ BACK: exactly what was sent, still valid, only the target changed ─────────────
  let after;
  try {
    after = await readPage(connection, { postType: page.postType, postId: page.id });
  } catch (error) {
    throw await rollback('The page could not be re-read after the change.');
  }
  if (lf(after.content.raw) !== lf(change.content)) {
    throw await rollback('WordPress stored different content than was sent.');
  }
  const contentCheck = adapter.verifyH1(after, { text: normalized.text, originalContent, plan: change.plan });
  if (!contentCheck.ok) {
    throw await rollback(`The saved page content failed verification (${contentCheck.problems.join('; ')}).`);
  }

  // ── RENDERED PAGE: what visitors and crawlers actually get ─────────────────────────────
  const renderedAfter = await renderedState(connection, pageUrl, { cacheBust: true });
  let immediateVerification;
  if (renderedAfter.error) {
    immediateVerification = 'unknown';
  } else if (renderedAfter.h1NonEmpty > 1) {
    throw await rollback(`The rendered page shows ${renderedAfter.h1NonEmpty} H1 headings after the change.`);
  } else if (renderedAfter.h1NonEmpty === 1 && norm(renderedAfter.h1Texts[0]) === norm(normalized.text)) {
    immediateVerification = 'success';
  } else {
    // Not rendered (yet): a cache may still be serving the old page. The write stays; TaskVerificationService decides.
    immediateVerification = 'failed';
  }

  return {
    postId: page.id,
    postType: page.postType,
    builder: { name: adapter.name, label: adapter.label },
    plan: change.plan,
    value: normalized.text,
    before: { fingerprint: currentFingerprint, h1Count: rendered.h1Count },
    after: { fingerprint: fingerprintOf(after) },
    contentVerified: true,
    rendered: renderedAfter.error
      ? { error: renderedAfter.error }
      : { h1Count: renderedAfter.h1Count, h1NonEmpty: renderedAfter.h1NonEmpty, h1Texts: renderedAfter.h1Texts, matches: immediateVerification === 'success' },
    immediateVerification,
    // For rollback by the caller (e.g. the Task could not be saved): the exact previous content.
    restore: restoreInfo,
  };
}

/** Page read / content write primitives, shared with the Divi image-alt fix so both go through the same authenticated, same-site path. */
export { readPage as readPageById, writeContent as writePageContent };

export default { fingerprintOf, loadTargetPage, getH1Context, applyH1Change, restoreContent };
