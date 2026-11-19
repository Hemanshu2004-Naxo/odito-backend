// Called through the default-exported object (not named imports) so tests
// can substitute request/requestAbsolute for the duration of one test —
// same reasoning as metaInstagramService.js's identical choice (see that
// file's header comment). Needed here specifically to unit-test
// pagination/multiple-Pages/duplicate-Pages scenarios for getUserPages(),
// none of which a fake token can ever produce from the real Meta API.
import metaApiService from './metaApiService.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import { isAuthenticationFailure, isRateLimited } from './metaErrorClassifier.js';
// Default export (not a named import) so tests can substitute getGrantedTargets.
import metaTokenService from './metaTokenService.js';

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
  LoggerUtil.service('MetaPages', 'get_user_pages', 'failed', { status: result.status, code: result.data?.error?.code ?? null });

  // Throttled (e.g. code 4 'Application request limit reached', sent as HTTP 403): the token is fine — say so, never 'invalid or expired'.
  if (isRateLimited(result)) {
    return { success: false, pages: [], error: { code: 'META_RATE_LIMITED', message: 'Meta is limiting requests from Odito right now. Wait a few minutes, then try again.' } };
  }

  if (isAuthenticationFailure(result)) {
    return { success: false, pages: [], error: { code: 'META_PAGE_ACCESS_DENIED', message: 'Meta access token is invalid or expired' } };
  }
  return { success: false, pages: [], error: { code: 'META_PAGES_FETCH_FAILED', message: 'Failed to retrieve Facebook Pages' } };
}

// ── Extended discovery: granted Pages /me/accounts omits + Business Portfolio Pages ──
//
// /me/accounts lists the Pages the person has a role on. It is NOT the full
// set the app was granted: a Page reachable only through a Business
// Portfolio assignment is granted (pages_show_list target_ids) and loadable
// by ID with its Page token, yet absent from /me/accounts. And Pages a
// granted portfolio owns but that were not ticked in the consent dialog
// silently vanished, with nothing telling the user why. Both paths below use
// only the USER token and documented Graph edges (GET /debug_token,
// GET /{page-id}, GET /me/businesses, GET /{business-id}/owned_pages and
// /client_pages — business_management), live-verified on v21.0.
//
// Best-effort by design: any failure here only means fewer extra Pages; the
// /me/accounts result is never lost because of it.

const PAGE_LOOKUP_FIELDS = 'id,name,category,picture{url},access_token';
const BUSINESS_PAGE_FIELDS = 'id,name,picture{url}';
const MAX_BUSINESSES = 50;
const MAX_DIRECT_LOOKUPS = 100;
const MAX_EDGE_BATCHES = 10;
// One call for every portfolio and both of its Page lists (field expansion) instead of 1 + 2 per portfolio.
const BUSINESS_WITH_PAGES_FIELDS = `id,name,owned_pages.limit(100){${BUSINESS_PAGE_FIELDS}},client_pages.limit(100){${BUSINESS_PAGE_FIELDS}}`;

/** Follows paging.next for a list edge. Returns { ok, items, error }. */
async function listEdge(path, params, userAccessToken, context) {
  const items = [];
  let result = await metaApiService.request({ method: 'GET', path, params: { ...params, limit: 100 }, accessToken: userAccessToken, context });
  let batches = 0;
  while (result.success) {
    const batch = Array.isArray(result.data?.data) ? result.data.data : [];
    items.push(...batch);
    batches += 1;
    const next = result.data?.paging?.next;
    if (!next || batches >= MAX_EDGE_BATCHES) return { ok: true, items, error: null };
    result = await metaApiService.requestAbsolute({ method: 'GET', url: next, context: `${context}_page` });
  }
  return { ok: false, items, error: { status: result.status, code: result.data?.error?.code ?? null, rateLimited: isRateLimited(result) } };
}

/** Loads one Page by ID with the user token — succeeds only when the app was granted that Page. */
async function lookupPage(pageId, userAccessToken) {
  const result = await metaApiService.request({ method: 'GET', path: `/${pageId}`, params: { fields: PAGE_LOOKUP_FIELDS }, accessToken: userAccessToken, context: 'meta_lookup_granted_page' });
  if (!result.success || !result.data?.id) return { ok: false, code: result.data?.error?.code ?? null, status: result.status, rateLimited: isRateLimited(result) };
  const d = result.data;
  return {
    ok: true,
    page: { id: String(d.id), name: d.name || null, category: d.category || null, picture: d.picture?.data?.url || null, accessToken: d.access_token || null, tasks: [] },
  };
}

/**
 * Every Business Portfolio with its owned + client Pages. Preferred: ONE call
 * with field expansion (owned_pages{...},client_pages{...} on /me/businesses).
 * If Meta rejects that form (anything but a rate limit), falls back to the
 * per-portfolio edges. An absent edge key just means "no Pages there".
 * Returns { ok, businesses: [{ id, name, pages: [{ id, name, picture }] }], error, calls }.
 */
async function listBusinessesWithPages(userAccessToken) {
  const toPages = (edge) => (Array.isArray(edge?.data) ? edge.data : []).map((x) => ({ id: String(x.id), name: x.name || null, picture: x.picture?.data?.url || null }));
  const expanded = await listEdge('/me/businesses', { fields: BUSINESS_WITH_PAGES_FIELDS }, userAccessToken, 'meta_list_businesses_with_pages');
  if (expanded.ok) {
    return {
      ok: true,
      calls: 'expanded',
      businesses: expanded.items.slice(0, MAX_BUSINESSES).map((b) => ({ id: String(b.id), name: b.name || null, pages: [...toPages(b.owned_pages), ...toPages(b.client_pages)] })),
      error: null,
    };
  }
  if (expanded.error?.rateLimited) return { ok: false, calls: 'expanded', businesses: [], error: expanded.error };

  // Fallback: 1 + 2 calls per portfolio.
  const plain = await listEdge('/me/businesses', { fields: 'id,name' }, userAccessToken, 'meta_list_businesses');
  if (!plain.ok) return { ok: false, calls: 'per_edge', businesses: [], error: plain.error };
  const businesses = [];
  const errors = [];
  for (const b of plain.items.slice(0, MAX_BUSINESSES)) {
    const pages = [];
    for (const edge of ['owned_pages', 'client_pages']) {
      const list = await listEdge(`/${b.id}/${edge}`, { fields: BUSINESS_PAGE_FIELDS }, userAccessToken, `meta_list_business_${edge}`);
      if (!list.ok) {
        errors.push({ step: edge, businessId: String(b.id), ...list.error });
        if (list.error.rateLimited) return { ok: false, calls: 'per_edge', businesses, error: list.error, errors };
      }
      pages.push(...list.items.map((x) => ({ id: String(x.id), name: x.name || null, picture: x.picture?.data?.url || null })));
    }
    businesses.push({ id: String(b.id), name: b.name || null, pages });
  }
  return { ok: true, calls: 'per_edge', businesses, error: null, errors };
}

/**
 * Finds Pages beyond /me/accounts. Returns
 *   { pages: [{ ...page, source }], unsharedPages: [{ id, name, picture, businessId, businessName, reason }], diagnostics, excluded }
 * `pages` are connectable (granted, Page token issued or not — a missing
 * token is shown, never hidden); `unsharedPages` belong to a granted
 * Business Portfolio but were not shared with this app in the consent dialog.
 *
 * Call budget (Meta rate-limits the whole app per rolling hour — code 4,
 * live-hit Nov 2026): 1 debug_token + 1 portfolio call + one lookup per
 * granted-but-unlisted Page. A portfolio Page outside a RESTRICTED grant is
 * reported as not shared without a lookup (Meta would refuse it anyway);
 * only an unrestricted grant needs lookups. The first rate-limit answer
 * stops everything that is left. Never throws.
 */
export async function discoverAdditionalPages(userAccessToken, { knownPageIds = [] } = {}) {
  const known = new Set(knownPageIds.map(String));
  const pages = [];
  const unsharedPages = [];
  const excluded = [];
  const diagnostics = { grantedTargets: null, grantedAdded: 0, businesses: null, businessCalls: null, businessPages: 0, businessAdded: 0, unshared: 0, lookups: 0, rateLimited: false, errors: [] };

  if (process.env.META_EXTENDED_PAGE_DISCOVERY === 'off') return { pages, unsharedPages, diagnostics: { ...diagnostics, skipped: 'disabled' }, excluded };

  try {
    // 1. Pages the token was granted that /me/accounts did not list.
    const granted = await metaTokenService.getGrantedTargets(userAccessToken);
    const grantedIds = granted.success ? granted.byScope.pages_show_list : null;
    const restricted = Array.isArray(grantedIds);
    if (!granted.success) diagnostics.errors.push({ step: 'granted_targets', reason: granted.reason });
    diagnostics.grantedTargets = restricted ? grantedIds.length : (granted.success ? 'unrestricted' : null);
    const grantedSet = new Set(restricted ? grantedIds : []);

    const tried = new Set();
    const tryAdd = async (pageId, source) => {
      if (known.has(pageId) || tried.has(pageId) || diagnostics.lookups >= MAX_DIRECT_LOOKUPS || diagnostics.rateLimited) return null;
      tried.add(pageId);
      diagnostics.lookups += 1;
      const found = await lookupPage(pageId, userAccessToken);
      if (found.rateLimited) diagnostics.rateLimited = true;
      if (found.ok) {
        known.add(pageId);
        pages.push({ ...found.page, source });
        if (!found.page.accessToken) excluded.push({ id: pageId, reason: 'NO_PAGE_TOKEN' });
      }
      return found;
    };

    for (const id of restricted ? grantedIds : []) {
      if (diagnostics.rateLimited) break;
      const found = await tryAdd(id, 'granted');
      if (found?.ok) diagnostics.grantedAdded += 1;
      else if (found) excluded.push({ id, reason: found.rateLimited ? 'RATE_LIMITED' : `GRANTED_LOOKUP_FAILED_${found.code ?? found.status}` });
    }

    // 2. Pages owned by / shared with the granted Business Portfolios.
    if (!diagnostics.rateLimited) {
      const portfolio = await listBusinessesWithPages(userAccessToken);
      diagnostics.businessCalls = portfolio.calls;
      if (portfolio.error) {
        diagnostics.errors.push({ step: 'businesses', ...portfolio.error });
        if (portfolio.error.rateLimited) diagnostics.rateLimited = true;
      }
      for (const e of portfolio.errors || []) diagnostics.errors.push(e);
      diagnostics.businesses = portfolio.businesses.length;

      for (const business of portfolio.businesses) {
        for (const item of business.pages) {
          diagnostics.businessPages += 1;
          if (known.has(item.id) || unsharedPages.some((u) => u.id === item.id)) continue;
          // Restricted grant: a Page outside it is not shared — no call needed. Unrestricted: ask Meta.
          if (!restricted || grantedSet.has(item.id)) {
            const found = await tryAdd(item.id, 'business');
            if (found?.ok) { diagnostics.businessAdded += 1; continue; }
            if (found?.rateLimited || diagnostics.rateLimited) continue; // unknown, not "not shared"
          }
          if (known.has(item.id)) continue;
          unsharedPages.push({ id: item.id, name: item.name, picture: item.picture, businessId: business.id, businessName: business.name, reason: 'NOT_SHARED_WITH_APP' });
          excluded.push({ id: item.id, reason: 'NOT_SHARED_WITH_APP' });
        }
      }
    }
    diagnostics.unshared = unsharedPages.length;
  } catch (error) {
    LoggerUtil.error('[META_PAGES] Extended Page discovery failed', { message: error.message }, {});
    diagnostics.errors.push({ step: 'unexpected', reason: 'EXCEPTION' });
  }
  return { pages, unsharedPages, diagnostics, excluded };
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

export default { getUserPages, discoverAdditionalPages, getPageInstagramAccount, getInstagramProfile };
