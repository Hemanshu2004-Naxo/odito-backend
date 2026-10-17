/**
 * profileUrl — the ONE policy for what may become an Organization `sameAs` value.
 *
 * Used by discovery (every link found on the site), by the manual-entry form's server-side validation and by the fix
 * planner, so "a link Odito found" and "a link the owner typed" are judged by the same rules. Pure: no I/O. In particular it
 * never fetches the URL it judges (a user-supplied URL must not make the server request an arbitrary address), so
 * "reachable" is never claimed here.
 *
 * What it decides for one URL:
 *   - is it a well-formed, absolute, public HTTPS address (no credentials, no port, no private/local/placeholder host)?
 *   - is it a link to a PROFILE, not a share button, login page, tracking endpoint, single post, resource file or short link?
 *   - which platform is it, and does its path structurally identify an ORGANIZATION (LinkedIn /company/…), an ACCOUNT whose
 *     owner type cannot be told from the URL (Instagram/X/Facebook vanity handles), a PERSONAL profile (LinkedIn /in/…), or
 *     something AMBIGUOUS (Facebook /people/…, a Wikipedia article)?
 *   - the canonical form to store, and a platform-aware identity key so x.com/a and twitter.com/a/ are one profile.
 *
 * Identity-bearing query parameters are preserved (facebook.com/profile.php?id=…); tracking parameters (utm_*, fbclid, igshid …)
 * are removed — and only those, by exact name.
 */

import { sameAsComparisonKey, SOCIAL_PROFILE_LIMITS, validateSocialProfileUrl } from '../../tasks/service/socialProfileUrls.js';
import { stripTrackingParams } from '../schemaGraph.js';

export const PROFILE_ERROR = Object.freeze({
  NOT_A_STRING: 'NOT_A_STRING',
  EMPTY: 'EMPTY',
  TOO_LONG: 'TOO_LONG',
  INVALID_CHARACTERS: 'INVALID_CHARACTERS',
  NOT_HTTPS: 'NOT_HTTPS',
  NOT_HTTP: 'NOT_HTTP',
  INVALID_URL: 'INVALID_URL',
  CREDENTIALS: 'CREDENTIALS',
  PORT: 'PORT',
  INVALID_HOST: 'INVALID_HOST',
  SELF_SITE: 'SELF_SITE',
  PLACEHOLDER: 'PLACEHOLDER',
  RESOURCE_URL: 'RESOURCE_URL',
  TRACKING_ENDPOINT: 'TRACKING_ENDPOINT',
  SHARE_LINK: 'SHARE_LINK',
  LOGIN_LINK: 'LOGIN_LINK',
  POST_LINK: 'POST_LINK',
  SHORT_LINK: 'SHORT_LINK',
  CONTACT_CHANNEL: 'CONTACT_CHANNEL',
  PERSONAL_PROFILE: 'PERSONAL_PROFILE',
  NOT_A_PROFILE: 'NOT_A_PROFILE',
  UNSUPPORTED_PLATFORM: 'UNSUPPORTED_PLATFORM',
  DUPLICATE: 'DUPLICATE',
  TOO_MANY: 'TOO_MANY',
});

const MESSAGES = {
  NOT_A_STRING: 'Each profile must be a text URL.',
  EMPTY: 'Enter a URL.',
  TOO_LONG: `URL is too long (maximum ${SOCIAL_PROFILE_LIMITS.maxUrlLength} characters).`,
  INVALID_CHARACTERS: 'URL contains spaces, line breaks, HTML or other characters that are not allowed.',
  NOT_HTTPS: 'Use the https:// address of the profile. Insecure http:// links are not published.',
  NOT_HTTP: 'URL must start with https:// (for example https://www.linkedin.com/company/your-company).',
  INVALID_URL: 'This is not a valid URL.',
  CREDENTIALS: 'URL must not contain a username or password.',
  PORT: 'URL must not specify a port.',
  INVALID_HOST: 'URL must point to a public website address, not localhost, a private network or an IP address.',
  SELF_SITE: 'This is a page of your own website. sameAs lists profiles on OTHER sites that describe the same organization.',
  PLACEHOLDER: 'This looks like a placeholder or example address, not a real profile.',
  RESOURCE_URL: 'This links to a file or script (image, stylesheet, script, document), not a profile page.',
  TRACKING_ENDPOINT: 'This is an analytics, advertising or tracking address, not a profile.',
  SHARE_LINK: 'This is a "share this page" link, not the organization\'s profile.',
  LOGIN_LINK: 'This is a login or sign-up link, not a profile.',
  POST_LINK: 'This links to a single post, video or board, not to the organization\'s profile.',
  SHORT_LINK: 'Shortened links hide where they lead. Use the full address of the profile.',
  CONTACT_CHANNEL: 'This is a messaging/contact link, not a profile page.',
  PERSONAL_PROFILE: 'This is a personal profile. sameAs for an organization must point to the organization\'s own page (for LinkedIn: a /company/ page).',
  NOT_A_PROFILE: 'This address is not the address of a profile page. Use the full address of the organization\'s profile.',
  UNSUPPORTED_PLATFORM: 'Not a recognised social network or business directory.',
  DUPLICATE: 'This profile is listed more than once.',
  TOO_MANY: 'Too many profile links were sent at once.',
};

export const PROFILE_LIMITS = Object.freeze({ ...SOCIAL_PROFILE_LIMITS, maxProfilesPerRequest: 10 });

const msg = (code, extra) => (extra ? `${MESSAGES[code]} ${extra}` : MESSAGES[code]);

// ── hosts that are never a profile ────────────────────────────────────────────

const TRACKING_HOSTS = [
  'google-analytics.com', 'googletagmanager.com', 'doubleclick.net', 'googleadservices.com', 'googlesyndication.com',
  'facebook.net', 'fbcdn.net', 'stats.wp.com', 'hotjar.com', 'clarity.ms', 'segment.io', 'mixpanel.com', 'adsrvr.org',
];
const SHARE_HOSTS = ['addthis.com', 'sharethis.com', 'addtoany.com'];
const SHORTENER_HOSTS = ['bit.ly', 't.co', 'lnkd.in', 'fb.me', 'fb.watch', 'goo.gl', 'tinyurl.com', 'ow.ly', 'buff.ly', 'is.gd', 'rebrand.ly', 'cutt.ly', 'tiny.cc', 'maps.app.goo.gl', 'g.co'];
const CONTACT_HOSTS = ['wa.me', 'api.whatsapp.com', 'web.whatsapp.com', 'whatsapp.com', 'm.me', 'messenger.com'];
// Documentation / reserved test domains: an address on these can only be an example, never a real profile.
const EXAMPLE_HOST = /(^|\.)(example\.(com|org|net)|[a-z0-9-]+\.(example|invalid|test|localhost|local|internal|lan|home\.arpa))$/i;
const RESOURCE_EXTENSION = /\.(png|jpe?g|gif|svg|webp|avif|ico|bmp|css|js|mjs|map|json|xml|rss|atom|pdf|docx?|xlsx?|pptx?|zip|gz|mp4|mp3|webm|woff2?|ttf|eot|txt)$/i;
const PLACEHOLDER_SLUG = /^(your-?(company|business|brand|name|handle|page|username|organi[sz]ation)|company-?name|business-?name|user-?name|handle|example|sample|placeholder|test|xxx+|username)$/i;

const hostIs = (host, domain) => host === domain || host.endsWith(`.${domain}`);
const hostIn = (host, list) => list.some((d) => hostIs(host, d));

const segmentsOf = (pathname) => pathname.split('/').filter(Boolean);

const reject = (code, extra) => ({ reject: code, extra });
const profile = (kind, path, identity, handle, extra = {}) => ({ kind, path, identity, handle, ...extra });

// ── platform specs ────────────────────────────────────────────────────────────
// Every parser receives the URL path split into segments and the parsed URL, and returns profile(...) or reject(...).
// kind: 'organization' = the path structure itself says "organization page"; 'account' = an account whose owner type
// cannot be read from the URL; 'ambiguous' = may or may not be this organization's own page.

const linkedin = (s) => {
  const first = (s[0] || '').toLowerCase();
  if (['company', 'school', 'showcase'].includes(first)) {
    return s[1] ? profile('organization', `/${first}/${s[1]}`, `${first}:${s[1].toLowerCase()}`, s[1]) : reject('NOT_A_PROFILE');
  }
  if (['in', 'pub', 'profile'].includes(first)) return reject('PERSONAL_PROFILE');
  if (['sharing', 'sharearticle', 'share'].includes(first)) return reject('SHARE_LINK');
  if (['login', 'signup', 'uas', 'authwall', 'checkpoint'].includes(first)) return reject('LOGIN_LINK');
  if (['posts', 'pulse', 'feed'].includes(first)) return reject('POST_LINK');
  return reject('NOT_A_PROFILE');
};

const FB_SHARE = new Set(['sharer', 'sharer.php', 'share', 'share.php', 'dialog', 'plugins', 'intent']);
const FB_TRACK = new Set(['tr', 'ajax', 'rsrc.php', 'connect', 'fbml']);
const FB_LOGIN = new Set(['login', 'login.php', 'recover', 'checkpoint', 'r.php', 'signup']);
const FB_POST_PARTS = new Set(['posts', 'photos', 'videos', 'reels', 'watch', 'permalink', 'photo', 'story']);
const FB_FOLD_PARTS = new Set(['about', 'reviews', 'community', 'services', 'mentions', 'home', 'info']);
const FB_NOT_PROFILE = new Set(['policy', 'policies', 'help', 'events', 'watch', 'photo', 'photo.php', 'photos', 'posts', 'story.php', 'permalink.php', 'hashtag', 'marketplace', 'groups', 'gaming', 'reel', 'reels', 'video', 'videos', 'ads', 'business', 'legal', 'privacy', 'terms', 'settings', 'public', 'home.php', 'notifications', 'messages', 'friends', 'bookmarks', 'search', 'stories', 'fundraisers', 'security', 'cookies', 'about', 'careers', 'developers', 'campaign', 'l.php']);
const facebook = (s, url) => {
  const first = (s[0] || '').toLowerCase();
  if (!first) return reject('NOT_A_PROFILE');
  if (FB_SHARE.has(first)) return reject('SHARE_LINK');
  if (FB_TRACK.has(first)) return reject('TRACKING_ENDPOINT');
  if (FB_LOGIN.has(first)) return reject('LOGIN_LINK');
  if (first === 'profile.php') {
    const id = url.searchParams.get('id');
    return id && /^\d{5,}$/.test(id) ? profile('ambiguous', '/profile.php', `id:${id}`, id, { query: `?id=${id}` }) : reject('NOT_A_PROFILE');
  }
  if (first === 'pages' && s.length >= 3) return profile('organization', `/pages/${s[1]}/${s[2]}`, `pages:${s[2]}`, s[2]);
  if (first === 'people' && s.length >= 3) return profile('ambiguous', `/people/${s[1]}/${s[2]}`, `people:${s[2]}`, s[2]);
  if (FB_NOT_PROFILE.has(first)) return reject('NOT_A_PROFILE');
  if (s[1] && FB_POST_PARTS.has(s[1].toLowerCase())) return reject('POST_LINK');
  if (s.length > 1 && !FB_FOLD_PARTS.has(s[1].toLowerCase())) return reject('NOT_A_PROFILE');
  return /^[A-Za-z0-9._-]{3,80}$/.test(s[0]) ? profile('account', `/${s[0]}`, `fb:${s[0].toLowerCase()}`, s[0]) : reject('NOT_A_PROFILE');
};

const IG_POST = new Set(['p', 'reel', 'reels', 'tv', 'stories']);
const IG_LOGIN = new Set(['accounts', 'oauth', 'challenge', 'session']);
const IG_NOT_PROFILE = new Set(['explore', 'direct', 'about', 'developer', 'legal', 'web', 'directory', 'emails', 'api', 'privacy', 'terms']);
const instagram = (s) => {
  const first = (s[0] || '').toLowerCase();
  if (!first) return reject('NOT_A_PROFILE');
  if (IG_POST.has(first)) return reject('POST_LINK');
  if (IG_LOGIN.has(first)) return reject('LOGIN_LINK');
  if (IG_NOT_PROFILE.has(first)) return reject('NOT_A_PROFILE');
  if (s.length > 1 && !['reels', 'tagged', 'guide'].includes(s[1].toLowerCase())) return reject('NOT_A_PROFILE');
  return /^[A-Za-z0-9._]{1,30}$/.test(s[0]) ? profile('account', `/${s[0]}`, `ig:${s[0].toLowerCase()}`, s[0]) : reject('NOT_A_PROFILE');
};

const X_SHARE = new Set(['intent', 'share']);
const X_LOGIN = new Set(['login', 'signup', 'oauth', 'i']);
const X_NOT_PROFILE = new Set(['home', 'search', 'hashtag', 'settings', 'explore', 'notifications', 'messages', 'compose', 'tos', 'privacy', 'about', 'download', 'jobs', 'who_to_follow', 'account', 'widgets.js']);
const xTwitter = (s) => {
  const first = (s[0] || '').toLowerCase();
  if (!first) return reject('NOT_A_PROFILE');
  if (X_SHARE.has(first)) return reject('SHARE_LINK');
  if (X_LOGIN.has(first)) return reject('LOGIN_LINK');
  if (X_NOT_PROFILE.has(first)) return reject('NOT_A_PROFILE');
  if (s[1] && s[1].toLowerCase() === 'status') return reject('POST_LINK');
  if (s.length > 1) return reject('NOT_A_PROFILE');
  return /^@?[A-Za-z0-9_]{1,15}$/.test(s[0]) ? profile('account', `/${s[0].replace(/^@/, '')}`, `x:${s[0].replace(/^@/, '').toLowerCase()}`, s[0].replace(/^@/, '')) : reject('NOT_A_PROFILE');
};

const YT_POST = new Set(['watch', 'embed', 'playlist', 'shorts', 'live', 'clip', 'v']);
const youtube = (s) => {
  const first = s[0] || '';
  const lower = first.toLowerCase();
  if (!first) return reject('NOT_A_PROFILE');
  if (YT_POST.has(lower)) return reject('POST_LINK');
  if (['redirect', 'oembed', 'api', 'results', 'feed', 'account', 'signin', 'accounts'].includes(lower)) return reject(lower === 'signin' || lower === 'accounts' ? 'LOGIN_LINK' : 'NOT_A_PROFILE');
  if (lower === 'channel') return /^UC[\w-]{20,}$/.test(s[1] || '') ? profile('account', `/channel/${s[1]}`, `yt:channel:${s[1]}`, s[1]) : reject('NOT_A_PROFILE');
  if ((lower === 'c' || lower === 'user') && s[1]) return profile('account', `/${lower}/${s[1]}`, `yt:${lower}:${s[1].toLowerCase()}`, s[1]);
  if (first.startsWith('@') && first.length > 1) return profile('account', `/${first}`, `yt:@${first.slice(1).toLowerCase()}`, first.slice(1));
  return reject('NOT_A_PROFILE');
};

const pinterest = (s) => {
  const first = (s[0] || '').toLowerCase();
  if (!first) return reject('NOT_A_PROFILE');
  if (['pin', 'ideas', 'today', 'topics'].includes(first)) return reject('POST_LINK');
  if (['login', 'signup', 'auth'].includes(first)) return reject('LOGIN_LINK');
  if (['search', 'business', 'settings', 'about', 'help', 'policy', 'create'].includes(first)) return reject('NOT_A_PROFILE');
  if (s.length > 1) return reject('POST_LINK');
  return /^[A-Za-z0-9_]{3,30}$/.test(s[0]) ? profile('account', `/${s[0]}`, `pin:${s[0].toLowerCase()}`, s[0]) : reject('NOT_A_PROFILE');
};

const tiktok = (s) => {
  const first = s[0] || '';
  if (!first.startsWith('@') || first.length < 2) return reject('NOT_A_PROFILE');
  if (s.length > 1) return reject(s[1].toLowerCase() === 'video' ? 'POST_LINK' : 'NOT_A_PROFILE');
  return profile('account', `/${first}`, `tt:${first.slice(1).toLowerCase()}`, first.slice(1));
};

const threads = (s) => {
  const first = s[0] || '';
  if (!first.startsWith('@') || first.length < 2) return reject(first.toLowerCase() === 't' ? 'POST_LINK' : 'NOT_A_PROFILE');
  if (s.length > 1) return reject('POST_LINK');
  return profile('account', `/${first}`, `th:${first.slice(1).toLowerCase()}`, first.slice(1));
};

const GITHUB_RESERVED = new Set(['features', 'pricing', 'about', 'login', 'join', 'topics', 'marketplace', 'sponsors', 'settings', 'notifications', 'explore', 'search', 'pulls', 'issues', 'new', 'apps', 'enterprise', 'collections', 'trending', 'readme', 'security', 'contact', 'site', 'customer-stories']);
const github = (s) => {
  const first = (s[0] || '').toLowerCase();
  if (!first) return reject('NOT_A_PROFILE');
  if (first === 'orgs' && s[1]) return profile('organization', `/${s[1]}`, `gh:${s[1].toLowerCase()}`, s[1]);
  if (GITHUB_RESERVED.has(first)) return reject(first === 'login' || first === 'join' ? 'LOGIN_LINK' : 'NOT_A_PROFILE');
  if (s.length > 1) return reject('NOT_A_PROFILE');
  return /^[A-Za-z0-9-]{1,39}$/.test(s[0]) ? profile('account', `/${s[0]}`, `gh:${s[0].toLowerCase()}`, s[0]) : reject('NOT_A_PROFILE');
};

const crunchbase = (s) => (s[0] === 'organization' && s[1] ? profile('organization', `/organization/${s[1]}`, `cb:${s[1].toLowerCase()}`, s[1]) : reject('NOT_A_PROFILE'));
const clutch = (s) => (s[0] === 'profile' && s[1] ? profile('organization', `/profile/${s[1]}`, `clutch:${s[1].toLowerCase()}`, s[1]) : reject('NOT_A_PROFILE'));
const trustpilot = (s) => (s[0] === 'review' && s[1] ? profile('organization', `/review/${s[1]}`, `tp:${s[1].toLowerCase()}`, s[1]) : reject('NOT_A_PROFILE'));
const yelp = (s) => (s[0] === 'biz' && s[1] ? profile('organization', `/biz/${s[1]}`, `yelp:${s[1].toLowerCase()}`, s[1]) : reject('NOT_A_PROFILE'));
const g2 = (s) => (['products', 'sellers'].includes(s[0]) && s[1] ? profile('organization', `/${s[0]}/${s[1]}`, `g2:${s[0]}:${s[1].toLowerCase()}`, s[1]) : reject('NOT_A_PROFILE'));
const glassdoor = (s) => (s[0] === 'Overview' && s[1] ? profile('organization', `/Overview/${s[1]}`, `gd:${s[1].toLowerCase()}`, s[1]) : reject('NOT_A_PROFILE'));
const gpage = (s) => (s[0] ? profile('organization', `/${s[0]}`, `gpage:${s[0].toLowerCase()}`, s[0]) : reject('NOT_A_PROFILE'));
const wikipedia = (s) => (s[0] === 'wiki' && s[1] && !/^(Special|Category|File|Talk|Help|Template|Wikipedia|Portal):/i.test(decodeURIComponent(s[1]).replace(/_/g, ' ')) ? profile('ambiguous', `/wiki/${s[1]}`, `wiki:${s[1].toLowerCase()}`, s[1]) : reject('NOT_A_PROFILE'));
const wikidata = (s) => (s[0] === 'wiki' && /^Q\d+$/.test(s[1] || '') ? profile('ambiguous', `/wiki/${s[1]}`, `wd:${s[1]}`, s[1]) : reject('NOT_A_PROFILE'));

/** host -> spec. `canonicalHost` is what is stored; `id` groups different hosts of one network (twitter.com + x.com). */
const PLATFORMS = [
  { id: 'linkedin', label: 'LinkedIn', domains: ['linkedin.com'], canonicalHost: 'www.linkedin.com', parse: linkedin },
  { id: 'facebook', label: 'Facebook', domains: ['facebook.com'], canonicalHost: 'www.facebook.com', parse: facebook },
  { id: 'instagram', label: 'Instagram', domains: ['instagram.com'], canonicalHost: 'www.instagram.com', parse: instagram },
  { id: 'x', label: 'X (Twitter)', domains: ['twitter.com', 'x.com'], canonicalHost: null, parse: xTwitter },
  { id: 'youtube', label: 'YouTube', domains: ['youtube.com'], canonicalHost: 'www.youtube.com', parse: youtube },
  { id: 'pinterest', label: 'Pinterest', domains: ['pinterest.com'], canonicalHost: 'www.pinterest.com', parse: pinterest },
  { id: 'tiktok', label: 'TikTok', domains: ['tiktok.com'], canonicalHost: 'www.tiktok.com', parse: tiktok },
  { id: 'threads', label: 'Threads', domains: ['threads.net', 'threads.com'], canonicalHost: null, parse: threads },
  { id: 'github', label: 'GitHub', domains: ['github.com'], canonicalHost: 'github.com', parse: github },
  { id: 'crunchbase', label: 'Crunchbase', domains: ['crunchbase.com'], canonicalHost: 'www.crunchbase.com', parse: crunchbase, directory: true },
  { id: 'clutch', label: 'Clutch', domains: ['clutch.co'], canonicalHost: 'clutch.co', parse: clutch, directory: true },
  { id: 'trustpilot', label: 'Trustpilot', domains: ['trustpilot.com'], canonicalHost: 'www.trustpilot.com', parse: trustpilot, directory: true },
  { id: 'yelp', label: 'Yelp', domains: ['yelp.com'], canonicalHost: 'www.yelp.com', parse: yelp, directory: true },
  { id: 'g2', label: 'G2', domains: ['g2.com'], canonicalHost: 'www.g2.com', parse: g2, directory: true },
  { id: 'glassdoor', label: 'Glassdoor', domains: ['glassdoor.com'], canonicalHost: null, parse: glassdoor, directory: true },
  { id: 'google_business', label: 'Google Business Profile', domains: ['g.page'], canonicalHost: 'g.page', parse: gpage, directory: true },
  { id: 'wikipedia', label: 'Wikipedia', domains: ['wikipedia.org'], canonicalHost: null, parse: wikipedia, directory: true },
  { id: 'wikidata', label: 'Wikidata', domains: ['wikidata.org'], canonicalHost: 'www.wikidata.org', parse: wikidata, directory: true },
];

export const SUPPORTED_PLATFORMS = Object.freeze(PLATFORMS.map((p) => ({ id: p.id, label: p.label, directory: !!p.directory })));

const platformFor = (host) => PLATFORMS.find((p) => p.domains.some((d) => hostIs(host, d))) || null;

// ── the public API ────────────────────────────────────────────────────────────

/**
 * Judges ONE URL. `source: 'manual'` additionally accepts a well-formed HTTPS profile address on a site Odito does not
 * recognise (as `platform: 'other'`, kind 'ambiguous', with a warning); `source: 'discovered'` does not — a link found on a
 * page that is not a known social network or business directory is just an outbound link.
 *
 * @param {unknown} raw
 * @param {{ siteUrl?: string, source?: 'manual'|'discovered'|'schema'|'integration' }} [options]
 * @returns {{ ok: true, url: string, comparisonKey: string, identityKey: string, platform: string, platformLabel: string,
 *   kind: 'organization'|'account'|'ambiguous', handle: string|null, warnings: {code: string, message: string}[],
 *   normalized: {upgradedHttp: boolean, strippedTracking: boolean} }
 *  | { ok: false, code: string, message: string, platform?: string }}
 */
export function evaluateProfileUrl(raw, { siteUrl, source = 'manual' } = {}) {
  const fail = (code, extra, platform) => ({ ok: false, code, message: msg(code, extra), ...(platform ? { platform } : {}) });
  if (typeof raw !== 'string') return fail('NOT_A_STRING');
  let text = raw.trim();
  if (!text) return fail('EMPTY');
  if (text.length > PROFILE_LIMITS.maxUrlLength) return fail('TOO_LONG');

  // Link found on a page: http:// to a known network is the same profile over https; upgrade it (and say so). A typed http://
  // is refused — the owner is asked for the https address instead of Odito guessing.
  let upgradedHttp = false;
  if (/^http:\/\//i.test(text)) {
    if (source === 'manual') return fail('NOT_HTTPS');
    text = text.replace(/^http:\/\//i, 'https://');
    upgradedHttp = true;
  }

  const base = validateSocialProfileUrl(text);
  if (!base.ok) {
    const map = { NOT_A_STRING: 'NOT_A_STRING', EMPTY: 'EMPTY', TOO_LONG: 'TOO_LONG', INVALID_CHARACTERS: 'INVALID_CHARACTERS', NOT_HTTP: 'NOT_HTTP', INVALID_URL: 'INVALID_URL', CREDENTIALS: 'CREDENTIALS', PORT: 'PORT', INVALID_HOST: 'INVALID_HOST' };
    return fail(map[base.code] || 'INVALID_URL');
  }

  let parsed;
  try { parsed = new URL(base.url); } catch { return fail('INVALID_URL'); }
  const host = parsed.hostname.toLowerCase();
  if (EXAMPLE_HOST.test(host)) return fail('PLACEHOLDER');

  if (siteUrl) {
    try {
      const own = new URL(siteUrl).hostname.toLowerCase().replace(/^www\./, '');
      if (host.replace(/^www\./, '') === own || hostIs(host, own)) return fail('SELF_SITE');
    } catch { /* an unreadable site URL cannot be compared with */ }
  }
  if (hostIn(host, TRACKING_HOSTS)) return fail('TRACKING_ENDPOINT');
  if (hostIn(host, SHARE_HOSTS)) return fail('SHARE_LINK');
  if (hostIn(host, SHORTENER_HOSTS)) return fail('SHORT_LINK');
  if (hostIn(host, CONTACT_HOSTS)) return fail('CONTACT_CHANNEL');
  if (RESOURCE_EXTENSION.test(parsed.pathname)) return fail('RESOURCE_URL');
  // youtu.be is a video short link; checked here because it has no platform spec of its own.
  if (host === 'youtu.be') return fail('POST_LINK');

  // Tracking parameters off (and only those); everything else — including identity-bearing parameters — stays.
  const cleanedHref = stripTrackingParams(parsed.href) || parsed.href;
  const cleaned = new URL(cleanedHref);
  const strippedTracking = cleaned.search !== parsed.search;
  const segments = segmentsOf(cleaned.pathname);
  const platform = platformFor(host);

  if (segments.some((s) => PLACEHOLDER_SLUG.test(s))) return fail('PLACEHOLDER');

  if (!platform) {
    if (source !== 'manual') return fail('UNSUPPORTED_PLATFORM');
    if (!segments.length) return fail('NOT_A_PROFILE', 'Add the full address of your profile on that site, not its home page.');
    const url = `https://${cleaned.host}${cleaned.pathname.replace(/\/+$/, '')}${cleaned.search}`;
    return {
      ok: true, url, comparisonKey: sameAsComparisonKey(url), identityKey: `other:${cleaned.host}${cleaned.pathname.replace(/\/+$/, '').toLowerCase()}${cleaned.search}`,
      platform: 'other', platformLabel: cleaned.hostname.replace(/^www\./, ''), kind: 'ambiguous', handle: null,
      warnings: [{ code: 'UNRECOGNISED_SITE', message: 'Odito does not recognise this site as a social network or business directory. Only add it if it is a page about your organization.' }],
      normalized: { upgradedHttp, strippedTracking },
    };
  }

  let spec;
  try { spec = platform.parse(segments, cleaned); } catch { spec = reject('NOT_A_PROFILE'); }
  if (spec.reject) return fail(spec.reject, spec.extra, platform.id);

  const canonicalHost = platform.canonicalHost
    || (platform.id === 'x' ? (hostIs(host, 'x.com') ? 'x.com' : 'twitter.com')
      : platform.id === 'threads' ? (hostIs(host, 'threads.com') ? 'www.threads.com' : 'www.threads.net')
        : host);
  const url = `https://${canonicalHost}${spec.path}${spec.query || ''}`;
  const warnings = [];
  if (spec.kind === 'ambiguous') warnings.push({ code: 'AMBIGUOUS_PROFILE', message: platform.directory ? 'Odito cannot tell whether this page is about your organization. Only keep it if it is.' : 'Odito cannot tell whether this is the organization\'s own page or a personal profile. Only keep it if it is the organization\'s.' });
  if (spec.kind === 'account' && !platform.directory) warnings.push({ code: 'OWNER_NOT_VERIFIABLE', message: 'The address does not show whether this account belongs to the organization. Confirm it before approving.' });
  return {
    ok: true, url, comparisonKey: sameAsComparisonKey(url), identityKey: `${platform.id}:${spec.identity}`,
    platform: platform.id, platformLabel: platform.label, kind: spec.kind, handle: spec.handle || null, warnings,
    normalized: { upgradedHttp, strippedTracking },
  };
}

/**
 * The key two sameAs values are compared by — for matching a value against what the entity already publishes, what a patch
 * contains and what the rendered page shows. Platform-aware where the URL is a recognised profile (x.com/a == twitter.com/A/ ==
 * m.facebook.com/a/about is one profile), otherwise scheme-, `www.`- and trailing-slash-insensitive. null when not a URL at all.
 */
export function profileKey(raw) {
  const r = evaluateProfileUrl(raw, { source: 'schema' });
  if (r.ok) return r.identityKey;
  const k = sameAsComparisonKey(raw);
  return k ? k.replace(/^www\./, '') : null;
}

/**
 * Validates the owner's list (manual entry or a selection coming back from the client). Every entry is judged on its own and reported
 * with its index, so the form can show the message next to the right line; duplicates (the same PROFILE, however it is written) are
 * errors, never silently merged.
 */
export function validateProfileList(list, { siteUrl, source = 'manual', max = PROFILE_LIMITS.maxProfilesPerRequest } = {}) {
  if (!Array.isArray(list)) return { valid: false, errors: [{ index: null, input: list, code: 'NOT_A_STRING', message: 'Profiles must be sent as a list of URLs.' }], items: [] };
  if (list.length > max) return { valid: false, errors: [{ index: null, input: null, code: 'TOO_MANY', message: `At most ${max} profile links can be sent at once.` }], items: [] };
  const errors = []; const items = []; const seen = new Map();
  list.forEach((raw, index) => {
    const r = evaluateProfileUrl(raw, { siteUrl, source });
    if (!r.ok) { errors.push({ index, input: typeof raw === 'string' ? raw : null, code: r.code, message: r.message }); return; }
    if (seen.has(r.identityKey) || seen.has(r.comparisonKey)) { errors.push({ index, input: raw, code: 'DUPLICATE', message: MESSAGES.DUPLICATE }); return; }
    seen.set(r.identityKey, index); seen.set(r.comparisonKey, index);
    items.push(r);
  });
  return errors.length ? { valid: false, errors, items } : { valid: true, errors: [], items };
}

/**
 * Whether a profile's handle plausibly belongs to the organization: every distinctive word of its name (or the site's domain label)
 * is contained in the handle. A SIGNAL for ranking only — a non-matching handle is never rejected for it, and a matching one is
 * never accepted for it alone.
 */
export function handleMatchesOrganization(handle, { names = [], siteHost = '' } = {}) {
  const flat = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const h = flat(handle);
  if (h.length < 3) return false;
  const stop = new Set(['the', 'and', 'ltd', 'llc', 'inc', 'pvt', 'private', 'limited', 'company', 'co', 'corp', 'official', 'group']);
  for (const name of names) {
    const tokens = String(name || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !stop.has(t));
    if (tokens.length && tokens.every((t) => h.includes(t))) return true;
    const joined = flat(name);
    if (joined.length >= 6 && (h.includes(joined) || (h.length >= 6 && joined.includes(h)))) return true;
  }
  const label = String(siteHost || '').toLowerCase().replace(/^www\./, '').split('.')[0];
  return flat(label).length >= 6 && (h.includes(flat(label)) || flat(label).includes(h));
}

export default { evaluateProfileUrl, validateProfileList, handleMatchesOrganization, profileKey, PROFILE_ERROR, PROFILE_LIMITS, SUPPORTED_PLATFORMS };
