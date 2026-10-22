import { describe, test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import wordPressSeoDataService from './wordPressSeoDataService.js';
import wordPressService, { WordPressConnectionError } from './wordPressService.js';
import oditoSeoBridgeService from './oditoSeoBridgeService.js';
import { BRIDGE_CAPABILITY_MIN_VERSIONS, getLatestBridgeVersion } from './seoBridgeVersion.js';

/**
 * getCapabilities() write-layer preference — no prior test coverage existed
 * for this file at all (added alongside the Bridge integration). Mocks
 * wordPressService/oditoSeoBridgeService only; no live Mongo/HTTP.
 */

beforeEach(() => {
  mock.restoreAll();
});

function mockConnected({ seoProvider = 'rank_math', seoProviders = ['rank_math'], pluginSummary = null } = {}) {
  mock.method(wordPressService, 'getConnectionStatus', async () => ({
    connected: true, status: 'connected', seoProvider, seoProviders,
  }));
  mock.method(wordPressService, 'getHydratedConnectionOrThrow', async () => ({
    site_url: 'https://example.com',
    plugin_summary: pluginSummary,
  }));
}

describe('wordPressSeoDataService.getCapabilities() — faqSchemaSupported', () => {
  test('not connected: false', async () => {
    mock.method(wordPressService, 'getConnectionStatus', async () => ({ connected: false, status: 'not_connected' }));
    assert.equal((await wordPressSeoDataService.getCapabilities('project-1')).faqSchemaSupported, false);
  });

  test('an active Bridge that reports FAQ support is faqSchemaSupported — even with NO SEO plugin active', async () => {
    mockConnected({ seoProvider: 'none', seoProviders: [] });
    mock.method(oditoSeoBridgeService, 'getBridgeStatus', async () => ({
      installed: true, provider: 'none', providers: [], bridgeVersion: '1.2.0', faqSchemaSupported: true,
    }));
    const result = await wordPressSeoDataService.getCapabilities('project-1');
    assert.equal(result.faqSchemaSupported, true);
  });

  test('...and with ambiguous SEO plugins ("multiple"), because the Bridge renders the FAQ itself', async () => {
    mockConnected({ seoProvider: 'multiple', seoProviders: ['rank_math', 'yoast'] });
    mock.method(oditoSeoBridgeService, 'getBridgeStatus', async () => ({
      installed: true, provider: 'multiple', providers: ['rank_math', 'yoast'], bridgeVersion: '1.2.0', faqSchemaSupported: true,
    }));
    const result = await wordPressSeoDataService.getCapabilities('project-1');
    assert.equal(result.ambiguous, true);
    assert.equal(result.faqSchemaSupported, true);
  });

  test('a Bridge that predates FAQ support is never reported as supporting it', async () => {
    mockConnected({ seoProvider: 'rank_math' });
    mock.method(oditoSeoBridgeService, 'getBridgeStatus', async () => ({
      installed: true, provider: 'rank_math', providers: ['rank_math'], bridgeVersion: '1.1.0', faqSchemaSupported: false,
    }));
    mock.method(oditoSeoBridgeService, 'getBridgeCapabilities', async () => ({ installed: true, provider: 'rank_math', providers: ['rank_math'], fields: {} }));
    assert.equal((await wordPressSeoDataService.getCapabilities('project-1')).faqSchemaSupported, false);
  });

  test('ratingSchemaSupported follows the Bridge flag, independent of provider and of FAQ support', async () => {
    mockConnected({ seoProvider: 'none', seoProviders: [] });
    mock.method(oditoSeoBridgeService, 'getBridgeStatus', async () => ({
      installed: true, provider: 'none', providers: [], bridgeVersion: '1.3.0', faqSchemaSupported: true, ratingSchemaSupported: true,
    }));
    assert.equal((await wordPressSeoDataService.getCapabilities('project-1')).ratingSchemaSupported, true);
    mock.restoreAll();
    mockConnected({ seoProvider: 'none', seoProviders: [] });
    mock.method(oditoSeoBridgeService, 'getBridgeStatus', async () => ({
      installed: true, provider: 'none', providers: [], bridgeVersion: '1.2.0', faqSchemaSupported: true, ratingSchemaSupported: false,
    }));
    const older = await wordPressSeoDataService.getCapabilities('project-1');
    assert.equal(older.ratingSchemaSupported, false);
    assert.equal(older.faqSchemaSupported, true);
  });

  test('no Bridge installed: false', async () => {
    mockConnected({ seoProvider: 'yoast', seoProviders: ['yoast'] });
    mock.method(oditoSeoBridgeService, 'getBridgeStatus', async () => ({ installed: false, provider: 'none', providers: [], bridgeVersion: null, faqSchemaSupported: false }));
    assert.equal((await wordPressSeoDataService.getCapabilities('project-1')).faqSchemaSupported, false);
  });
});

describe('wordPressSeoDataService.getCapabilities()', () => {
  test('not connected: returns the not-connected shape without ever checking the Bridge', async () => {
    mock.method(wordPressService, 'getConnectionStatus', async () => ({ connected: false, status: 'not_connected' }));
    const bridgeCall = mock.method(oditoSeoBridgeService, 'getBridgeStatus', async () => { throw new Error('must not be called'); });

    const result = await wordPressSeoDataService.getCapabilities('project-1');
    assert.equal(result.connected, false);
    assert.equal(result.bridgeInstalled, false);
    assert.equal(bridgeCall.mock.callCount(), 0);
  });

  test('Bridge installed with a single provider: capabilities come from the Bridge, translated to camelCase, not the legacy static table', async () => {
    mockConnected({ seoProvider: 'rank_math' });
    mock.method(oditoSeoBridgeService, 'getBridgeStatus', async () => ({
      installed: true, provider: 'rank_math', providers: ['rank_math'], bridgeVersion: '1.0.0',
    }));
    mock.method(oditoSeoBridgeService, 'getBridgeCapabilities', async () => ({
      installed: true, provider: 'rank_math', providers: ['rank_math'],
      fields: { title: { read: true, write: true }, meta_description: { read: true, write: true }, canonical: { read: true, write: true }, robots: { read: true, write: true } },
    }));

    const result = await wordPressSeoDataService.getCapabilities('project-1');
    assert.equal(result.bridgeInstalled, true);
    assert.equal(result.bridgeVersion, '1.0.0');
    assert.equal(result.provider, 'rank_math');
    assert.equal(result.bridgeRequired, false);
    assert.deepEqual(result.capabilities, {
      title: { read: true, write: true },
      metaDescription: { read: true, write: true },
      canonical: { read: true, write: true },
      robots: { read: true, write: true },
    });
  });

  test('Bridge installed but ambiguous ("multiple"): reports ambiguous with null capabilities, never guesses one provider', async () => {
    mockConnected({ seoProvider: 'rank_math' });
    mock.method(oditoSeoBridgeService, 'getBridgeStatus', async () => ({
      installed: true, provider: 'multiple', providers: ['rank_math', 'yoast'], bridgeVersion: '1.0.0',
    }));
    const capsCall = mock.method(oditoSeoBridgeService, 'getBridgeCapabilities', async () => { throw new Error('must not be called when ambiguous'); });

    const result = await wordPressSeoDataService.getCapabilities('project-1');
    assert.equal(result.ambiguous, true);
    assert.equal(result.capabilities, null);
    assert.deepEqual(result.providers, ['rank_math', 'yoast']);
    assert.equal(capsCall.mock.callCount(), 0);
  });

  test('Bridge not installed: falls back to the legacy static per-provider capability table, still reports bridgeRequired for rank_math/yoast', async () => {
    mockConnected({ seoProvider: 'rank_math' });
    mock.method(oditoSeoBridgeService, 'getBridgeStatus', async () => ({ installed: false, provider: 'none', providers: [], bridgeVersion: null }));

    const result = await wordPressSeoDataService.getCapabilities('project-1');
    assert.equal(result.bridgeInstalled, false);
    assert.equal(result.bridgeRequired, true, 'rank_math with no Bridge must still ask the user to install it');
    // RankMathAdapter (legacy, no bridge) reports write:false for every
    // SEO-owned field, title included — Rank Math owns the page title
    // entirely once active, so there is no "falls back to core WP title"
    // case to fall back to.
    assert.equal(result.capabilities.title.write, false, 'without the Bridge, Rank Math title is not writable');
    assert.equal(result.capabilities.metaDescription.write, false, 'without the Bridge, Rank Math meta description is not writable');
  });

  test('Bridge installed but reports "none" (no supported plugin active yet): falls back to legacy, reports bridgeInstalled AND bridgeActive true', async () => {
    mockConnected({ seoProvider: 'none', seoProviders: [] });
    mock.method(oditoSeoBridgeService, 'getBridgeStatus', async () => ({ installed: true, provider: 'none', providers: [], bridgeVersion: '1.0.0' }));

    const result = await wordPressSeoDataService.getCapabilities('project-1');
    assert.equal(result.bridgeInstalled, true);
    assert.equal(result.bridgeActive, true, 'a live 200 from the Bridge always means active, regardless of provider');
    assert.equal(result.bridgeVersion, '1.0.0');
    assert.equal(result.provider, 'none');
    assert.equal(result.capabilities.title.write, true);
  });

  test('Bridge installed and active with a provider: bridgeActive is true', async () => {
    mockConnected({ seoProvider: 'rank_math' });
    mock.method(oditoSeoBridgeService, 'getBridgeStatus', async () => ({ installed: true, provider: 'rank_math', providers: ['rank_math'], bridgeVersion: '1.0.0' }));
    mock.method(oditoSeoBridgeService, 'getBridgeCapabilities', async () => ({
      installed: true, provider: 'rank_math', providers: ['rank_math'],
      fields: { title: { read: true, write: true }, meta_description: { read: true, write: true }, canonical: { read: true, write: true }, robots: { read: true, write: true } },
    }));

    const result = await wordPressSeoDataService.getCapabilities('project-1');
    assert.equal(result.bridgeInstalled, true);
    assert.equal(result.bridgeActive, true);
  });

  test('Bridge NOT live-reachable (404) but present-and-inactive in the plugin listing: reports installed:true, active:false, with the listed version', async () => {
    mockConnected({
      seoProvider: 'rank_math',
      pluginSummary: {
        status: 'available',
        plugins: [
          { name: 'Odito SEO Bridge', slug: 'odito-seo-bridge', status: 'inactive', version: '1.0.0' },
          { name: 'Rank Math SEO', slug: 'seo-by-rank-math', status: 'active', version: '1.0.278' },
        ],
      },
    });
    mock.method(oditoSeoBridgeService, 'getBridgeStatus', async () => ({ installed: false, provider: 'none', providers: [], bridgeVersion: null }));
    const capsCall = mock.method(oditoSeoBridgeService, 'getBridgeCapabilities', async () => { throw new Error('must not fetch Bridge capabilities when it is inactive'); });

    const result = await wordPressSeoDataService.getCapabilities('project-1');
    assert.equal(result.bridgeInstalled, true, 'present in the plugin list, even though inactive');
    assert.equal(result.bridgeActive, false);
    assert.equal(result.bridgeVersion, '1.0.0', 'version comes from the plugin listing when the live check cannot reach it');
    // Falls back to the legacy static capability table since the Bridge
    // cannot actually service reads/writes while inactive.
    assert.equal(result.capabilities.title.write, false, 'RankMathAdapter (legacy, no active bridge) reports every field write:false');
    assert.equal(capsCall.mock.callCount(), 0);
  });

  test('Bridge NOT live-reachable and NOT found in the plugin listing at all: reports installed:false, active:false', async () => {
    mockConnected({
      seoProvider: 'rank_math',
      pluginSummary: {
        status: 'available',
        plugins: [
          { name: 'Rank Math SEO', slug: 'seo-by-rank-math', status: 'active', version: '1.0.278' },
        ],
      },
    });
    mock.method(oditoSeoBridgeService, 'getBridgeStatus', async () => ({ installed: false, provider: 'none', providers: [], bridgeVersion: null }));

    const result = await wordPressSeoDataService.getCapabilities('project-1');
    assert.equal(result.bridgeInstalled, false);
    assert.equal(result.bridgeActive, false);
    assert.equal(result.bridgeVersion, null);
    assert.equal(result.bridgeRequired, true);
  });

  test('Bridge NOT live-reachable and plugin listing unavailable (restricted account): cannot distinguish, reports installed:false', async () => {
    mockConnected({ seoProvider: 'rank_math', pluginSummary: { status: 'unavailable', reason: 'insufficient_permissions', plugins: [] } });
    mock.method(oditoSeoBridgeService, 'getBridgeStatus', async () => ({ installed: false, provider: 'none', providers: [], bridgeVersion: null }));

    const result = await wordPressSeoDataService.getCapabilities('project-1');
    assert.equal(result.bridgeInstalled, false);
    assert.equal(result.bridgeActive, false);
  });

  test('Bridge active but reports a version older than this backend supports: capabilities withheld, bridgeVersionSupported false', async () => {
    mockConnected({ seoProvider: 'rank_math' });
    mock.method(oditoSeoBridgeService, 'getBridgeStatus', async () => ({ installed: true, provider: 'rank_math', providers: ['rank_math'], bridgeVersion: '0.9.0' }));
    mock.method(oditoSeoBridgeService, 'getBridgeCapabilities', async () => ({
      installed: true, provider: 'rank_math', providers: ['rank_math'],
      fields: { title: { read: true, write: true }, meta_description: { read: true, write: true }, canonical: { read: true, write: true }, robots: { read: true, write: true } },
    }));

    const result = await wordPressSeoDataService.getCapabilities('project-1');
    assert.equal(result.bridgeActive, true);
    assert.equal(result.bridgeVersionSupported, false);
    assert.equal(result.capabilities, null, 'never offer auto-apply from an unsupported Bridge version');
  });

  test('Bridge active with a version at or above the minimum: bridgeVersionSupported true, capabilities returned normally', async () => {
    mockConnected({ seoProvider: 'rank_math' });
    mock.method(oditoSeoBridgeService, 'getBridgeStatus', async () => ({ installed: true, provider: 'rank_math', providers: ['rank_math'], bridgeVersion: '1.2.0' }));
    mock.method(oditoSeoBridgeService, 'getBridgeCapabilities', async () => ({
      installed: true, provider: 'rank_math', providers: ['rank_math'],
      fields: { title: { read: true, write: true }, meta_description: { read: true, write: true }, canonical: { read: true, write: true }, robots: { read: true, write: true } },
    }));

    const result = await wordPressSeoDataService.getCapabilities('project-1');
    assert.equal(result.bridgeVersionSupported, true);
    assert.ok(result.capabilities);
  });

  describe('Bridge update detection (installed version vs the version this backend ships)', () => {
    const latest = getLatestBridgeVersion();
    const rankMathFields = { title: { read: true, write: true }, meta_description: { read: true, write: true }, canonical: { read: true, write: true }, robots: { read: true, write: true } };

    function mockBridge(bridgeVersion) {
      mockConnected({ seoProvider: 'rank_math' });
      mock.method(oditoSeoBridgeService, 'getBridgeStatus', async () => ({ installed: true, provider: 'rank_math', providers: ['rank_math'], bridgeVersion }));
      mock.method(oditoSeoBridgeService, 'getBridgeCapabilities', async () => ({ installed: true, provider: 'rank_math', providers: ['rank_math'], fields: rankMathFields }));
    }

    test('the shipped version is known, and is the source header version', () => {
      assert.match(latest, /^\d+\.\d+\.\d+/);
    });

    test('an installed 1.1.0 Bridge (the reported scenario) is flagged as updatable to the shipped version', async () => {
      mockBridge('1.1.0');
      const result = await wordPressSeoDataService.getCapabilities('project-1');
      assert.equal(result.bridgeVersion, '1.1.0');
      assert.equal(result.latestBridgeVersion, latest);
      assert.equal(result.bridgeUpdateAvailable, true);
      assert.equal(result.bridgeVersionSupported, true, '1.1.0 is still above the compatibility floor — only the newer capabilities are unavailable');
    });

    test('a Bridge already at the shipped version is not flagged', async () => {
      mockBridge(latest);
      assert.equal((await wordPressSeoDataService.getCapabilities('project-1')).bridgeUpdateAvailable, false);
    });

    test('a Bridge NEWER than the shipped version (e.g. 1.10.0 vs 1.3.0) is not flagged — numeric, not string, comparison', async () => {
      mockBridge('99.10.0');
      assert.equal((await wordPressSeoDataService.getCapabilities('project-1')).bridgeUpdateAvailable, false);
    });

    test('an unparseable installed version is never guessed into an update prompt', async () => {
      mockBridge('not-a-version');
      assert.equal((await wordPressSeoDataService.getCapabilities('project-1')).bridgeUpdateAvailable, false);
    });

    test('no Bridge installed: nothing to update (the UI offers the first install instead)', async () => {
      mockConnected({ seoProvider: 'yoast', seoProviders: ['yoast'] });
      mock.method(oditoSeoBridgeService, 'getBridgeStatus', async () => ({ installed: false, provider: 'none', providers: [], bridgeVersion: null }));
      const result = await wordPressSeoDataService.getCapabilities('project-1');
      assert.equal(result.bridgeUpdateAvailable, false);
      assert.equal(result.latestBridgeVersion, latest);
    });

    test('bridgeRequirements carries the per-capability minimums the UI shows (single source: BRIDGE_CAPABILITY_MIN_VERSIONS)', async () => {
      mockBridge('1.1.0');
      const { bridgeRequirements } = await wordPressSeoDataService.getCapabilities('project-1');
      assert.deepEqual(bridgeRequirements, BRIDGE_CAPABILITY_MIN_VERSIONS);
      assert.equal(bridgeRequirements.faq_schema, '1.2.0');
    });

    test('the not-connected shape also carries the requirements/latest version', async () => {
      mock.method(wordPressService, 'getConnectionStatus', async () => ({ connected: false, status: 'not_connected' }));
      const result = await wordPressSeoDataService.getCapabilities('project-1');
      assert.equal(result.bridgeUpdateAvailable, false);
      assert.deepEqual(result.bridgeRequirements, BRIDGE_CAPABILITY_MIN_VERSIONS);
    });

    test('a 1.1.0 Bridge does not gain the FAQ capability just because the shipped version is newer', async () => {
      mockConnected({ seoProvider: 'rank_math' });
      mock.method(oditoSeoBridgeService, 'getBridgeStatus', async () => ({ installed: true, provider: 'rank_math', providers: ['rank_math'], bridgeVersion: '1.1.0', faqSchemaSupported: false, ratingSchemaSupported: false }));
      mock.method(oditoSeoBridgeService, 'getBridgeCapabilities', async () => ({ installed: true, provider: 'rank_math', providers: ['rank_math'], fields: rankMathFields }));
      const result = await wordPressSeoDataService.getCapabilities('project-1');
      assert.equal(result.faqSchemaSupported, false);
      assert.equal(result.ratingSchemaSupported, false);
    });
  });

  test('a transient Bridge check failure never breaks the whole capabilities response — falls back to legacy', async () => {
    mockConnected({ seoProvider: 'yoast' });
    mock.method(oditoSeoBridgeService, 'getBridgeStatus', async () => { throw new Error('simulated transient network failure'); });

    const result = await wordPressSeoDataService.getCapabilities('project-1');
    assert.equal(result.connected, true);
    assert.equal(result.provider, 'yoast');
    assert.equal(result.bridgeInstalled, false);
    assert.equal(result.bridgeRequired, true);
  });
});

/**
 * getPageSeoData() — regression coverage for a real production bug: this
 * function used to go ONLY through the legacy direct adapter, regardless
 * of whether the Bridge was installed/active. For Rank Math and Yoast,
 * the legacy adapter's read is a documented best-effort no-op (their
 * fields are never registered for core REST), so the Apply-fix
 * confirmation dialog showed "(empty)" for pages that had a real,
 * substantial meta description — while wordPressSeoFixService.js's own
 * write-time read (already Bridge-aware) saw the correct value. These
 * tests pin the fix: same Bridge-first priority as getCapabilities(),
 * same oditoSeoBridgeService.readSeoData() call, same
 * toLegacySeoShape() reshaping wordPressSeoFixService.js's own
 * readCurrentValue() now also uses — one authoritative live-read path.
 */
describe('wordPressSeoDataService.getPageSeoData()', () => {
  function mockHydratedConnection(overrides = {}) {
    mock.method(wordPressService, 'getHydratedConnectionOrThrow', async () => ({
      site_url: 'https://example.com',
      detected_seo_provider: 'rank_math',
      ...overrides,
    }));
  }

  test('Bridge active (Rank Math): returns the REAL live meta description, not empty — the exact bug this fixes', async () => {
    mockHydratedConnection();
    mock.method(oditoSeoBridgeService, 'getBridgeStatus', async () => ({
      installed: true, provider: 'rank_math', providers: ['rank_math'], bridgeVersion: '1.0.0',
    }));
    mock.method(wordPressService, 'resolvePostIdFromUrl', async () => ({ postId: 42, postType: 'posts' }));
    mock.method(oditoSeoBridgeService, 'readSeoData', async (connection, postId) => {
      assert.equal(postId, 42);
      return {
        provider: 'rank_math',
        fields: {
          title: 'SEO Reseller Services for Agencies | Naxonify',
          meta_description: 'Resell professional SEO services with Naxonify. Our SEO reseller services help agencies offer SEO audits, local SEO, technical SEO, content, and reporting under their own brand.',
          canonical: null,
        },
      };
    });

    const result = await wordPressSeoDataService.getPageSeoData('project-1', 'https://naxonify.com/seo-reseller');

    assert.equal(result.pageId, 42);
    assert.equal(result.provider.name, 'rank_math');
    assert.equal(
      result.seo.metaDescription,
      'Resell professional SEO services with Naxonify. Our SEO reseller services help agencies offer SEO audits, local SEO, technical SEO, content, and reporting under their own brand.'
    );
    assert.ok(result.seo.metaDescription.length > 160, 'sanity check: this is the real 177-char-class value, not a placeholder');
  });

  test('Bridge active: a GENUINELY empty live meta description is reported as empty, not confused with a read failure', async () => {
    mockHydratedConnection();
    mock.method(oditoSeoBridgeService, 'getBridgeStatus', async () => ({
      installed: true, provider: 'rank_math', providers: ['rank_math'], bridgeVersion: '1.0.0',
    }));
    mock.method(wordPressService, 'resolvePostIdFromUrl', async () => ({ postId: 7, postType: 'posts' }));
    mock.method(oditoSeoBridgeService, 'readSeoData', async () => ({
      provider: 'rank_math', fields: { title: 'A Title', meta_description: null, canonical: null },
    }));

    const result = await wordPressSeoDataService.getPageSeoData('project-1', 'https://example.com/genuinely-empty');
    assert.equal(result.seo.metaDescription, null);
    assert.equal(result.seo.title, 'A Title');
  });

  test('Bridge active but ambiguous ("multiple"): refused with 409, never silently falls back to legacy or guesses a provider', async () => {
    mockHydratedConnection();
    mock.method(oditoSeoBridgeService, 'getBridgeStatus', async () => ({
      installed: true, provider: 'multiple', providers: ['rank_math', 'yoast'], bridgeVersion: '1.0.0',
    }));
    const readCall = mock.method(oditoSeoBridgeService, 'readSeoData', async () => { throw new Error('must never be called when ambiguous'); });

    await assert.rejects(
      () => wordPressSeoDataService.getPageSeoData('project-1', 'https://example.com/x'),
      (err) => {
        assert.ok(err instanceof WordPressConnectionError);
        assert.equal(err.code, 'PLUGIN_NOT_SUPPORTED');
        assert.equal(err.statusCode, 409);
        return true;
      }
    );
    assert.equal(readCall.mock.callCount(), 0);
  });

  test('Bridge active but the URL cannot be resolved to a post/page: returns null (not an error, not a fabricated empty seo object)', async () => {
    mockHydratedConnection();
    mock.method(oditoSeoBridgeService, 'getBridgeStatus', async () => ({
      installed: true, provider: 'rank_math', providers: ['rank_math'], bridgeVersion: '1.0.0',
    }));
    mock.method(wordPressService, 'resolvePostIdFromUrl', async () => null);
    const readCall = mock.method(oditoSeoBridgeService, 'readSeoData', async () => { throw new Error('must never be called without a resolved postId'); });

    const result = await wordPressSeoDataService.getPageSeoData('project-1', 'https://example.com/not-a-real-page');
    assert.equal(result, null);
    assert.equal(readCall.mock.callCount(), 0);
  });

  test('Bridge not installed: falls back to the legacy adapter path unchanged', async () => {
    mockHydratedConnection({ detected_seo_provider: 'none' });
    mock.method(oditoSeoBridgeService, 'getBridgeStatus', async () => ({ installed: false, provider: 'none', providers: [], bridgeVersion: null }));
    const bridgeReadCall = mock.method(oditoSeoBridgeService, 'readSeoData', async () => { throw new Error('must never be called when the Bridge is not installed'); });
    // WordPressCoreAdapter (provider 'none') calls wordPressService.wpRequest
    // internally — mocked here exactly like wordPressSeoFixService's own
    // integration tests mock the legacy path.
    mock.method(wordPressService, 'resolvePostIdFromUrl', async () => ({ postId: 5, postType: 'pages' }));
    mock.method(wordPressService, 'wpRequest', async () => ({
      status: 200,
      data: { id: 5, link: 'https://example.com/x', title: { raw: 'Legacy Title', rendered: 'Legacy Title' } },
    }));

    const result = await wordPressSeoDataService.getPageSeoData('project-1', 'https://example.com/x');
    assert.equal(result.seo.title, 'Legacy Title');
    assert.equal(bridgeReadCall.mock.callCount(), 0);
  });

  test('Bridge installed but reports "none": falls back to the legacy adapter, same as not-installed', async () => {
    mockHydratedConnection({ detected_seo_provider: 'none' });
    mock.method(oditoSeoBridgeService, 'getBridgeStatus', async () => ({ installed: true, provider: 'none', providers: [], bridgeVersion: '1.0.0' }));
    mock.method(wordPressService, 'resolvePostIdFromUrl', async () => ({ postId: 9, postType: 'pages' }));
    mock.method(wordPressService, 'wpRequest', async () => ({
      status: 200,
      data: { id: 9, link: 'https://example.com/y', title: { raw: 'Core Title', rendered: 'Core Title' } },
    }));

    const result = await wordPressSeoDataService.getPageSeoData('project-1', 'https://example.com/y');
    assert.equal(result.seo.title, 'Core Title');
  });

  test('legacy path ambiguity ("multiple" from connection-level detection, Bridge not installed): still refused with 409', async () => {
    mockHydratedConnection({ detected_seo_provider: 'multiple' });
    mock.method(oditoSeoBridgeService, 'getBridgeStatus', async () => ({ installed: false, provider: 'none', providers: [], bridgeVersion: null }));

    await assert.rejects(
      () => wordPressSeoDataService.getPageSeoData('project-1', 'https://example.com/x'),
      (err) => {
        assert.ok(err instanceof WordPressConnectionError);
        assert.equal(err.code, 'PLUGIN_NOT_SUPPORTED');
        assert.equal(err.statusCode, 409);
        return true;
      }
    );
  });

  test('the Bridge-sourced value and the legacy-sourced value use the SAME field names in the returned seo object (title/metaDescription/canonical)', async () => {
    mockHydratedConnection();
    mock.method(oditoSeoBridgeService, 'getBridgeStatus', async () => ({
      installed: true, provider: 'rank_math', providers: ['rank_math'], bridgeVersion: '1.0.0',
    }));
    mock.method(wordPressService, 'resolvePostIdFromUrl', async () => ({ postId: 1, postType: 'posts' }));
    mock.method(oditoSeoBridgeService, 'readSeoData', async () => ({
      provider: 'rank_math', fields: { title: 'T', meta_description: 'D', canonical: 'https://example.com/c' },
    }));

    const result = await wordPressSeoDataService.getPageSeoData('project-1', 'https://example.com/x');
    assert.deepEqual(Object.keys(result.seo).sort(), ['canonical', 'metaDescription', 'openGraph', 'robots', 'schema', 'title']);
  });
});

/**
 * getSiteSchema() — the read side of the site-level sameAs/breadcrumb
 * capability. Always resolves (never throws) to `supported:true` or
 * `supported:false` — the frontend uses this single call to decide whether
 * to render the sameAs/breadcrumb UI at all, per the capability-driven-UI
 * requirement (never hardcode "if rank_math then show everything").
 */
describe('wordPressSeoDataService.getSiteSchema()', () => {
  function mockHydratedConnection(overrides = {}) {
    mock.method(wordPressService, 'getHydratedConnectionOrThrow', async () => ({
      site_url: 'https://example.com',
      detected_seo_provider: 'rank_math',
      ...overrides,
    }));
  }

  test('Bridge active with site-schema support: returns the real organization/breadcrumbs state', async () => {
    mockHydratedConnection();
    mock.method(oditoSeoBridgeService, 'getBridgeStatus', async () => ({
      installed: true, provider: 'rank_math', providers: ['rank_math'], bridgeVersion: '1.1.0', siteSchemaSupported: true,
    }));
    mock.method(oditoSeoBridgeService, 'getSiteSchema', async () => ({
      provider: 'rank_math',
      organization: { name: 'Naxonify', description: '', url: 'https://naxonify.com', logo: '', sameAs: ['https://twitter.com/naxonify'] },
      breadcrumbs: { enabled: false },
    }));

    const result = await wordPressSeoDataService.getSiteSchema('project-1');
    assert.equal(result.supported, true);
    assert.equal(result.bridgeVersion, '1.1.0');
    assert.deepEqual(result.organization.sameAs, ['https://twitter.com/naxonify']);
    assert.equal(result.breadcrumbs.enabled, false);
  });

  test('Bridge installed but running an OLDER version (no siteSchemaSupported): reports unsupported with a specific update-required reason, never a fabricated empty schema', async () => {
    mockHydratedConnection();
    mock.method(oditoSeoBridgeService, 'getBridgeStatus', async () => ({
      installed: true, provider: 'rank_math', providers: ['rank_math'], bridgeVersion: '1.0.0', siteSchemaSupported: false,
    }));
    const getSiteSchemaCall = mock.method(oditoSeoBridgeService, 'getSiteSchema', async () => { throw new Error('must never be called when unsupported'); });

    const result = await wordPressSeoDataService.getSiteSchema('project-1');
    assert.equal(result.supported, false);
    assert.match(result.reason, /older version/i);
    assert.equal(result.bridgeVersion, '1.0.0');
    assert.equal(getSiteSchemaCall.mock.callCount(), 0);
  });

  test('Bridge not installed: reports unsupported with a Bridge-required reason', async () => {
    mockHydratedConnection();
    mock.method(oditoSeoBridgeService, 'getBridgeStatus', async () => ({
      installed: false, provider: 'none', providers: [], bridgeVersion: null, siteSchemaSupported: false,
    }));

    const result = await wordPressSeoDataService.getSiteSchema('project-1');
    assert.equal(result.supported, false);
    assert.match(result.reason, /Bridge is required/i);
  });

  test('Bridge active but ambiguous ("multiple"): refused with 409, never silently falls back', async () => {
    mockHydratedConnection();
    mock.method(oditoSeoBridgeService, 'getBridgeStatus', async () => ({
      installed: true, provider: 'multiple', providers: ['rank_math', 'yoast'], bridgeVersion: '1.1.0', siteSchemaSupported: false,
    }));

    await assert.rejects(
      () => wordPressSeoDataService.getSiteSchema('project-1'),
      (err) => {
        assert.ok(err instanceof WordPressConnectionError);
        assert.equal(err.code, 'PLUGIN_NOT_SUPPORTED');
        assert.equal(err.statusCode, 409);
        return true;
      }
    );
  });

  test('non-Rank-Math provider (e.g. Yoast, which has no site-schema mechanism): reports unsupported, not an error', async () => {
    mockHydratedConnection();
    mock.method(oditoSeoBridgeService, 'getBridgeStatus', async () => ({
      installed: true, provider: 'yoast', providers: ['yoast'], bridgeVersion: '1.1.0', siteSchemaSupported: false,
    }));

    const result = await wordPressSeoDataService.getSiteSchema('project-1');
    assert.equal(result.supported, false);
  });
});
