import wordPressService, { WordPressConnectionError } from './wordPressService.js';
import oditoSeoBridgeService from './oditoSeoBridgeService.js';
import { getAdapterForConnection, PROVIDER_LABELS } from '../adapters/index.js';
import {
  BRIDGE_CAPABILITY_MIN_VERSIONS,
  compareVersions,
  getLatestBridgeVersion,
  isVersionAtLeast,
} from './seoBridgeVersion.js';
import { getDownloadableBridgeVersion } from './seoBridgePackage.js';
import { describeDiviImageAltCapability } from '../content/diviImageAlt.js';

/**
 * WordPressSeoDataService (Phase 4, Step 1-2 of the locked architecture)
 *
 * Read-only: capability detection + live SEO field retrieval for a single
 * page. Deliberately separate from wordPressService.js (connection
 * lifecycle) and wordPressSeoFixService.js (writes, Phase 4 Step 4+) so
 * each file has one job. Nothing here ever writes to WordPress, and
 * nothing here ever writes into `seo_page_data` — that collection remains
 * the crawler's own authoritative audit snapshot; this is live, on-demand
 * integration data only, never persisted by Odito.
 */

// The Bridge's own REST contract uses snake_case field names
// (meta_description) matching its plugin's field names; the frontend's
// existing capability display (ConnectedAccountsCard.jsx's SEO_FIELD_LABELS)
// has always expected the legacy adapters' camelCase shape. Translated once,
// here, so the frontend contract never has to know which write layer is
// actually active underneath.
function toCamelCaseCapabilities(fields) {
  if (!fields) return null;
  return {
    title: fields.title,
    metaDescription: fields.meta_description,
    canonical: fields.canonical,
    robots: fields.robots,
  };
}

// Matches the folder/main-file name odito-seo-bridge.php ships under —
// how WordPress's own plugin listing (`p.plugin.split('/')[0]`, see
// wordPressService.js's detectInstalledPlugins()) identifies it.
const SEO_BRIDGE_PLUGIN_SLUG = 'odito-seo-bridge';

/**
 * Finds the Bridge's own entry in a connection's already-collected
 * plugin_summary (the SAME plugin listing wordPressService.js's
 * detectSeoProvider() already uses to spot Rank Math/Yoast/etc. by slug —
 * reused here rather than adding a second WordPress-side detection
 * mechanism). Returns null when the listing is unavailable (a restricted
 * account without `activate_plugins`) or the Bridge isn't in it.
 */
function findBridgeInPluginSummary(pluginSummary) {
  if (pluginSummary?.status !== 'available' || !Array.isArray(pluginSummary.plugins)) return null;
  return pluginSummary.plugins.find((p) => p.slug === SEO_BRIDGE_PLUGIN_SLUG) || null;
}

// The oldest Bridge version this backend knows how to talk to. Bumped only
// when a future Bridge release changes its REST contract in a way older
// backend code can't safely drive. Deliberately NOT bumped for the 1.1.0
// release (robots/site-schema) — a 1.0.0 Bridge's title/meta_description/
// canonical REST contract is completely unchanged and still safe to drive;
// the newer, additive capabilities are gated separately via each field's
// own capability flag (e.g. `robots: {read,write}`,
// `supports.site_schema` — see oditoSeoBridgeService.getBridgeStatus's
// siteSchemaSupported), never by this minimum-version gate. This constant
// exists for a future Bridge release that changes the REST contract itself
// in a way older backend code can't safely drive.
const MIN_SUPPORTED_BRIDGE_VERSION = '1.0.0';

/**
 * The version/update facts the UI needs, all derived from seoBridgeVersion.js:
 *   - latestBridgeVersion: what the Download button will deliver (the source header, or the fallback
 *     artifact's own version when the source isn't deployed; null only when
 *     neither exists, in which case no update can be offered honestly);
 *   - bridgeUpdateAvailable: the site's installed Bridge is older than that;
 *   - bridgeRequirements: first Bridge version per capability, so the frontend
 *     never hardcodes "requires 1.2.0 or newer".
 * An unknown installed version is never reported as outdated — it can't be
 * told apart from "current".
 */
function bridgeVersionInfo(bridgeInstalled, installedVersion) {
  const latestBridgeVersion = getDownloadableBridgeVersion();
  const bridgeUpdateAvailable = Boolean(
    bridgeInstalled && latestBridgeVersion && installedVersion &&
    compareVersions(installedVersion, latestBridgeVersion) === -1
  );
  return { latestBridgeVersion, bridgeUpdateAvailable, bridgeRequirements: { ...BRIDGE_CAPABILITY_MIN_VERSIONS } };
}

/**
 * @param {string} projectId
 * @returns {Promise<{
 *   connected: boolean,
 *   status: string,
 *   provider: string,
 *   providerLabel: string,
 *   providers: string[],
 *   ambiguous: boolean,
 *   capabilities: object|null,
 *   bridgeRequired: boolean,
 *   bridgeInstalled: boolean,
 *   bridgeActive: boolean,
 *   bridgeVersion: string|null,
 *   faqSchemaSupported: boolean,
 *   ratingSchemaSupported: boolean,
 *   latestBridgeVersion: string|null,
 *   bridgeUpdateAvailable: boolean,
 *   bridgeRequirements: Record<string, string>,
 * }>}
 */
async function getCapabilities(projectId) {
  // The Divi page-module alt-text capability is a property of Odito, reported next to the connection's own capabilities.
  return { ...(await getConnectionCapabilities(projectId)), diviImageAlt: describeDiviImageAltCapability() };
}

async function getConnectionCapabilities(projectId) {
  const status = await wordPressService.getConnectionStatus(projectId);
  if (!status.connected) {
    return {
      connected: false,
      status: status.status,
      provider: 'none',
      providerLabel: PROVIDER_LABELS.none,
      providers: [],
      ambiguous: false,
      capabilities: null,
      bridgeRequired: false,
      bridgeInstalled: false,
      bridgeActive: false,
      bridgeVersion: null,
      bridgeVersionSupported: true,
      faqSchemaSupported: false,
      ratingSchemaSupported: false,
      ...bridgeVersionInfo(false, null),
    };
  }

  // Odito SEO Bridge (preferred, live signal) — checked first, same
  // priority order as wordPressSeoFixService.validateFix(). Best-effort:
  // any failure here (a transient WordPress outage, a revoked credential
  // that verifyWordPressConnection hasn't caught yet) must never break the
  // capabilities display — it simply falls through to the legacy, static
  // per-connection-provider capability table below, mirroring the
  // detectWordPressVersion/detectInstalledPlugins "never fail the overall
  // response" convention already used elsewhere in this feature.
  let bridgeStatus = { installed: false, provider: 'none', providers: [], bridgeVersion: null };
  let bridgeCapabilitiesFields = null;
  let connection = null;
  try {
    connection = await wordPressService.getHydratedConnectionOrThrow(projectId);
    bridgeStatus = await oditoSeoBridgeService.getBridgeStatus(connection);
    if (bridgeStatus.installed && bridgeStatus.provider !== 'none' && bridgeStatus.provider !== 'multiple') {
      const bridgeCapabilities = await oditoSeoBridgeService.getBridgeCapabilities(connection);
      bridgeCapabilitiesFields = bridgeCapabilities.fields;
    }
  } catch {
    // Fall through to the legacy path below.
  }

  // A live 200 from the Bridge's own /status route ONLY happens when the
  // plugin is ACTIVE — an inactive plugin's PHP never runs, so its REST
  // routes never register, and the request 404s exactly as if it were
  // never installed at all. That 404 is genuinely ambiguous on its own, so
  // when the live check didn't find it, fall back to the connection's own
  // plugin listing (plugin_summary — the SAME data detectSeoProvider()
  // already collects at connect/verify time, reused here rather than
  // adding a second WordPress-side detection mechanism) to tell "never
  // installed" apart from "installed but not activated." A restricted
  // account without `activate_plugins` (plugin_summary unavailable) simply
  // can't distinguish the two — reported as not installed, same as before
  // this fallback existed.
  let bridgeInstalled = bridgeStatus.installed;
  let bridgeActive = bridgeStatus.installed;
  let bridgeVersion = bridgeStatus.bridgeVersion;
  if (!bridgeStatus.installed) {
    const found = findBridgeInPluginSummary(connection?.plugin_summary);
    if (found) {
      bridgeInstalled = true;
      bridgeActive = found.status === 'active';
      bridgeVersion = found.version;
    }
  }

  // FAQ schema is applied by the Bridge itself (it renders the JSON-LD), so —
  // unlike the SEO-plugin fields — its availability does not depend on which
  // SEO plugin is active, or whether the site's plugins are ambiguous.
  const faqSchemaSupported = Boolean(bridgeStatus.installed && bridgeStatus.faqSchemaSupported);
  const ratingSchemaSupported = Boolean(bridgeStatus.installed && bridgeStatus.ratingSchemaSupported);

  if (bridgeActive && bridgeStatus.provider !== 'none') {
    const ambiguous = bridgeStatus.provider === 'multiple';
    const bridgeVersionSupported = isVersionAtLeast(bridgeVersion, MIN_SUPPORTED_BRIDGE_VERSION);
    return {
      connected: true,
      status: status.status,
      provider: bridgeStatus.provider,
      providerLabel: PROVIDER_LABELS[bridgeStatus.provider] || bridgeStatus.provider,
      providers: bridgeStatus.providers,
      ambiguous,
      // An unsupported Bridge version can't be trusted to honor the same
      // REST contract this backend expects — never offer auto-apply from
      // it, same as any other "can't confirm this is safe" case.
      capabilities: (ambiguous || !bridgeVersionSupported) ? null : toCamelCaseCapabilities(bridgeCapabilitiesFields),
      bridgeRequired: false,
      bridgeInstalled: true,
      bridgeActive: true,
      bridgeVersion,
      bridgeVersionSupported,
      faqSchemaSupported,
      ratingSchemaSupported,
      ...bridgeVersionInfo(true, bridgeVersion),
    };
  }

  // Legacy path — Bridge not installed, installed but inactive, or active
  // but reporting no supported provider. Same static per-provider
  // capability table as before the Bridge existed.
  const provider = status.seoProvider || 'none';
  const ambiguous = provider === 'multiple';

  // A lean/plain status object is enough here — getAdapterForConnection only
  // reads detected_seo_provider, never the credential (no live WordPress
  // call is made to answer a capability question; the capability table is
  // static per provider, see seoProviderAdapter.js).
  const { adapter } = getAdapterForConnection({ detected_seo_provider: ambiguous ? 'none' : provider });
  const capabilities = ambiguous ? null : adapter.getCapabilities();

  const bridgeRequired = provider === 'rank_math' || provider === 'yoast';

  return {
    connected: true,
    status: status.status,
    provider,
    providerLabel: PROVIDER_LABELS[provider] || provider,
    providers: status.seoProviders || [],
    ambiguous,
    capabilities,
    bridgeRequired,
    bridgeInstalled,
    bridgeActive,
    bridgeVersion,
    bridgeVersionSupported: true,
    faqSchemaSupported,
    ratingSchemaSupported,
    ...bridgeVersionInfo(bridgeInstalled, bridgeVersion),
  };
}

/**
 * Live SEO data for one page, normalized across providers. Returns null
 * (not an error) when the URL doesn't resolve to a WordPress post/page the
 * connected account can read, or when the provider is ambiguous — the
 * caller (controller) turns both into the appropriate 2xx-with-null vs 409
 * response; this function only concerns itself with the WordPress side.
 *
 * Bug fix: this used to go ONLY through the legacy direct adapter,
 * regardless of whether the Bridge was installed and active. For Rank
 * Math and Yoast specifically, the legacy adapter's read is a
 * documented best-effort no-op (their fields aren't registered for core
 * REST at all — see rankMathAdapter.js/yoastAdapter.js) — so this endpoint
 * was returning null/empty for a page that genuinely had a real meta
 * description, while wordPressSeoFixService.js's OWN write-time read
 * (already Bridge-aware) saw the correct value. That mismatch is exactly
 * what let the Apply-fix confirmation dialog show "(empty)" for a page
 * with real content. Now checked in the SAME priority order, and read
 * through the SAME oditoSeoBridgeService.readSeoData() call + the SAME
 * toLegacySeoShape() reshaping, as wordPressSeoFixService.js's
 * readCurrentValue() — one authoritative live-read path, not two.
 */
async function getPageSeoData(projectId, pageUrl) {
  const connection = await wordPressService.getHydratedConnectionOrThrow(projectId);

  const bridgeStatus = await oditoSeoBridgeService.getBridgeStatus(connection);
  if (bridgeStatus.installed && bridgeStatus.provider === 'multiple') {
    throw new WordPressConnectionError(
      'PLUGIN_NOT_SUPPORTED',
      'Multiple SEO plugins are active on this WordPress site. Resolve the ambiguity before reading live SEO data.',
      409
    );
  }
  if (bridgeStatus.installed && bridgeStatus.provider !== 'none') {
    const resolved = await wordPressService.resolvePostIdFromUrl(connection, pageUrl);
    if (!resolved) return null;
    const seoData = await oditoSeoBridgeService.readSeoData(connection, resolved.postId);
    return {
      pageId: resolved.postId,
      postType: resolved.postType,
      url: pageUrl,
      seo: oditoSeoBridgeService.toLegacySeoShape(seoData.fields),
      provider: { name: seoData.provider, version: null },
    };
  }

  // Legacy direct-adapter path — Bridge not installed, installed but
  // inactive, or active but reporting no supported provider.
  const { adapter, ambiguous } = getAdapterForConnection(connection);
  if (ambiguous) {
    throw new WordPressConnectionError(
      'PLUGIN_NOT_SUPPORTED',
      'Multiple SEO plugins are active on this WordPress site. Resolve the ambiguity before reading live SEO data.',
      409
    );
  }
  return adapter.getSeoData(pageUrl);
}

/**
 * Live, on-demand read of the SITE-LEVEL schema (Organization sameAs,
 * breadcrumbs) — genuinely different scope from getPageSeoData() above,
 * which is always for one page. No pageUrl involved; this reads one
 * site-wide state.
 *
 * Returns `{ supported: false, reason }` (never throws, never a fabricated
 * empty schema) when the Bridge doesn't report site-schema support — e.g.
 * an older deployed Bridge version, no Bridge at all, or a non-Rank-Math
 * provider. The frontend uses this to decide whether to show the sameAs/
 * breadcrumb UI at all, per Section 13's capability-driven-UI requirement.
 */
async function getSiteSchema(projectId) {
  const connection = await wordPressService.getHydratedConnectionOrThrow(projectId);

  const bridgeStatus = await oditoSeoBridgeService.getBridgeStatus(connection);
  if (bridgeStatus.installed && bridgeStatus.provider === 'multiple') {
    throw new WordPressConnectionError(
      'PLUGIN_NOT_SUPPORTED',
      'Multiple SEO plugins are active on this WordPress site. Resolve the ambiguity before reading site schema.',
      409
    );
  }

  if (!bridgeStatus.installed || bridgeStatus.provider === 'none' || !bridgeStatus.siteSchemaSupported) {
    return {
      supported: false,
      reason: !bridgeStatus.installed || bridgeStatus.provider === 'none'
        ? 'The Odito SEO Bridge is required for site-level schema fixes.'
        : 'This WordPress site is running an older version of the Odito SEO Bridge that does not yet support site-level schema fixes. Update the plugin, then try again.',
      bridgeVersion: bridgeStatus.bridgeVersion,
      provider: bridgeStatus.provider,
    };
  }

  const schema = await oditoSeoBridgeService.getSiteSchema(connection);
  return {
    supported: true,
    provider: schema.provider,
    bridgeVersion: bridgeStatus.bridgeVersion,
    organization: schema.organization,
    breadcrumbs: schema.breadcrumbs,
  };
}

/**
 * Whether this page resolves to a WordPress post/page Odito can act on, and if not, exactly why.
 * Read-only; goes through the shared resolver (wordPressUrlResolver.js) so it can never disagree
 * with what an Apply would do. Always a normal result — "not resolved" is data, not an error.
 */
async function getPageResolution(projectId, pageUrl) {
  const connection = await wordPressService.getHydratedConnectionOrThrow(projectId);
  const result = await wordPressService.resolveWordPressResource(connection, pageUrl);
  if (!result.resolved) {
    return { resolved: false, reason: result.reason, message: result.message, postType: result.postTypeName || null };
  }
  return {
    resolved: true,
    postId: result.postId,
    postType: result.postTypeName,
    slug: result.slug,
    permalink: result.permalink,
    isFrontPage: result.isFrontPage,
    matchedBy: result.matchedBy,
  };
}

export default { getCapabilities, getPageSeoData, getSiteSchema, getPageResolution };
