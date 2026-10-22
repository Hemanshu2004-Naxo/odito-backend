// Called through the default-exported object (not named imports) so tests
// can substitute request/requestAbsolute for the duration of one test —
// same reasoning as metaInstagramService.js's identical choice (see that
// file's header comment). Needed here specifically to unit-test
// pagination/multiple-Pages/duplicate-Pages scenarios for getUserPages(),
// none of which a fake token can ever produce from the real Meta API.
import metaApiService from './metaApiService.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import { isAuthenticationFailure } from './metaErrorClassifier.js';

/**
 * MetaPageService — Facebook Page discovery (GET /me/accounts) built on
 * metaApiService.js's generic Graph API client. Kept separate from
 * metaApiService.js itself (which only knows generic HTTP mechanics, no
 * business logic) and separate from the controller (no DB access here at
 * all — this file only talks to Meta).
 */

// Hard ceiling on how many Pages a single discovery call will follow
// pagination for — Section 15's explicit "sensible maximum ... to
// prevent abuse/resource exhaustion". No real Meta user is expected to
// manage anywhere near this many Pages; this exists purely as a backstop
// against a pathological/malicious response, not a realistic limit.
const MAX_PAGES = 200;

const FIELDS = 'id,name,category,access_token,tasks,picture{url}';

/**
 * Fetches every Facebook Page the given USER access token can list,
 * following paging.next until Meta reports no further pages, MAX_PAGES
 * is reached, or an unrecoverable error occurs. Returns
 * { success, pages, error } — `pages` is always an array (possibly
 * empty), never null, so an empty result is a normal, valid outcome
 * (Section 4: "do not treat zero Pages as a server crash"), not folded
 * into the error path.
 */
export async function getUserPages(userAccessToken) {
  const pages = [];
  const seenPageIds = new Set();
  let nextUrl = null;
  let page = 0;

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const result = page === 0
        ? await metaApiService.request({ method: 'GET', path: '/me/accounts', params: { fields: FIELDS, limit: 100 }, accessToken: userAccessToken, context: 'meta_get_user_pages' })
        : await metaApiService.requestAbsolute({ method: 'GET', url: nextUrl, context: 'meta_get_user_pages_page' });

      if (!result.success) {
        return normalizeFailure(result);
      }

      const batch = Array.isArray(result.data?.data) ? result.data.data : [];
      for (const entry of batch) {
        if (pages.length >= MAX_PAGES) break;
        // A Page ID can legitimately appear more than once across pages
        // of a paginated response (e.g. the same Page reachable through
        // more than one Business Portfolio the user belongs to) — never
        // meaningful to show twice in a picker, so de-duplicated by ID
        // here rather than left for the frontend to notice.
        if (seenPageIds.has(entry.id)) continue;
        seenPageIds.add(entry.id);
        pages.push({
          id: entry.id,
          name: entry.name || null,
          category: entry.category || null,
          picture: entry.picture?.data?.url || null,
          accessToken: entry.access_token || null,
          tasks: Array.isArray(entry.tasks) ? entry.tasks : [],
        });
      }

      nextUrl = result.data?.paging?.next || null;
      page += 1;

      if (!nextUrl || pages.length >= MAX_PAGES) {
        break;
      }
    }

    // Safe diagnostic (never the token itself, only whether one was
    // present) — added to trace a real report of "Meta shows fewer Pages
    // than the user actually manages". This logs exactly what Meta's
    // /me/accounts response contained for THIS token, so a "Meta only
    // granted access to N of my Pages" question can be answered from a
    // real log line instead of guessed. `tasks` is Meta's own per-Page
    // permission-level field (MODERATE/ADVERTISE/ANALYZE/CREATE_CONTENT/
    // MANAGE) — an empty tasks array on a Page that IS returned points at
    // a task-based/limited-access grant, not a missing Page.
    LoggerUtil.info('META_PAGES_DISCOVERED', {
      pageCount: pages.length,
      pages: pages.map((p) => ({ id: p.id, name: p.name, category: p.category, tasks: p.tasks, hasAccessToken: !!p.accessToken })),
    });
    LoggerUtil.service('MetaPages', 'get_user_pages', 'completed', { pageCount: pages.length });
    return { success: true, pages, error: null };
  } catch (error) {
    // Defensive: getUserPages must never throw into a route handler —
    // any unexpected shape/error becomes a normalized failure instead.
    LoggerUtil.error('[META_PAGES] Unexpected error during Page discovery', { message: error.message }, {});
    return { success: false, pages: [], error: { code: 'META_PAGES_FETCH_FAILED', message: 'Failed to retrieve Facebook Pages' } };
  }
}

function normalizeFailure(result) {
  LoggerUtil.service('MetaPages', 'get_user_pages', 'failed', { status: result.status });

  if (isAuthenticationFailure(result)) {
    return { success: false, pages: [], error: { code: 'META_PAGE_ACCESS_DENIED', message: 'Meta access token is invalid or expired' } };
  }
  return { success: false, pages: [], error: { code: 'META_PAGES_FETCH_FAILED', message: 'Failed to retrieve Facebook Pages' } };
}

// ── Phase 3: Facebook Page -> Instagram Business/Professional Account ──────
// Both calls below are made with the Page's own access token (never the
// Meta user token, never a client-supplied value) — matching how Meta's
// Graph API actually authorizes access to a Page's linked Instagram
// Business Account: through that Page's token, not a separate IG-specific
// credential. Two calls, matching the two Graph API requests Meta itself
// requires: (1) does this Page have a linked IG account at all, (2) if so,
// fetch that IG account's own profile fields.

const INSTAGRAM_LINK_FIELDS = 'instagram_business_account';
// Deliberately minimal — only what Phase 3 actually displays (id/username/
// name/picture). No analytics/insights fields; those are explicitly out of
// scope for this phase.
const INSTAGRAM_PROFILE_FIELDS = 'id,username,name,profile_picture_url';

/**
 * Looks up whether the given Facebook Page has a linked Instagram
 * Business/Professional account. Returns
 * { success, instagramBusinessAccountId, error }. A Page with NO linked
 * Instagram account is a normal, successful outcome —
 * instagramBusinessAccountId is simply null, never an error.
 */
export async function getPageInstagramAccount(pageId, pageAccessToken) {
  try {
    const result = await metaApiService.request({
      method: 'GET',
      path: `/${pageId}`,
      params: { fields: INSTAGRAM_LINK_FIELDS },
      accessToken: pageAccessToken,
      context: 'meta_get_page_instagram_account',
    });

    if (!result.success) {
      return normalizeInstagramLinkFailure(result);
    }

    const instagramBusinessAccountId = result.data?.instagram_business_account?.id || null;
    LoggerUtil.service('MetaInstagram', 'get_page_instagram_account', 'completed', { linked: !!instagramBusinessAccountId });
    return { success: true, instagramBusinessAccountId, error: null };
  } catch (error) {
    LoggerUtil.error('[META_INSTAGRAM] Unexpected error looking up the Page\'s Instagram link', { message: error.message }, {});
    return { success: false, instagramBusinessAccountId: null, error: { code: 'META_INSTAGRAM_DISCOVERY_FAILED', message: 'Failed to look up the linked Instagram account' } };
  }
}

function normalizeInstagramLinkFailure(result) {
  LoggerUtil.service('MetaInstagram', 'get_page_instagram_account', 'failed', { status: result.status });
  if (isAuthenticationFailure(result)) {
    return { success: false, instagramBusinessAccountId: null, error: { code: 'META_INSTAGRAM_ACCESS_DENIED', message: 'Meta denied access to this Page\'s Instagram account' } };
  }
  return { success: false, instagramBusinessAccountId: null, error: { code: 'META_INSTAGRAM_DISCOVERY_FAILED', message: 'Failed to look up the linked Instagram account' } };
}

/**
 * Fetches safe profile fields for an already-discovered Instagram Business
 * Account, using the SAME Page access token (Meta does not issue a
 * separate Instagram-specific token for this — see SocialAccount's own
 * Phase 3 comment). Returns { success, profile, error }.
 */
export async function getInstagramProfile(instagramAccountId, pageAccessToken) {
  try {
    const result = await metaApiService.request({
      method: 'GET',
      path: `/${instagramAccountId}`,
      params: { fields: INSTAGRAM_PROFILE_FIELDS },
      accessToken: pageAccessToken,
      context: 'meta_get_instagram_profile',
    });

    if (!result.success) {
      return normalizeInstagramProfileFailure(result);
    }

    const data = result.data || {};
    if (!data.id) {
      LoggerUtil.service('MetaInstagram', 'get_instagram_profile', 'malformed_response', {});
      return { success: false, profile: null, error: { code: 'META_INSTAGRAM_PROFILE_FAILED', message: 'Instagram profile response was malformed' } };
    }

    LoggerUtil.service('MetaInstagram', 'get_instagram_profile', 'completed', {});
    return {
      success: true,
      profile: {
        id: data.id,
        username: data.username || null,
        name: data.name || null,
        profilePictureUrl: data.profile_picture_url || null,
      },
      error: null,
    };
  } catch (error) {
    LoggerUtil.error('[META_INSTAGRAM] Unexpected error fetching the Instagram profile', { message: error.message }, {});
    return { success: false, profile: null, error: { code: 'META_INSTAGRAM_PROFILE_FAILED', message: 'Failed to retrieve the Instagram profile' } };
  }
}

function normalizeInstagramProfileFailure(result) {
  LoggerUtil.service('MetaInstagram', 'get_instagram_profile', 'failed', { status: result.status });
  if (isAuthenticationFailure(result)) {
    return { success: false, profile: null, error: { code: 'META_INSTAGRAM_ACCESS_DENIED', message: 'Meta denied access to this Instagram profile' } };
  }
  return { success: false, profile: null, error: { code: 'META_INSTAGRAM_PROFILE_FAILED', message: 'Failed to retrieve the Instagram profile' } };
}

export default { getUserPages, getPageInstagramAccount, getInstagramProfile };
