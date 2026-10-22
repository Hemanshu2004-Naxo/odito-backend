import { describe, test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import oditoSeoBridgeService from './oditoSeoBridgeService.js';
import wordPressService, { WordPressConnectionError } from './wordPressService.js';

/**
 * Unit tests for oditoSeoBridgeService.js — the backend client for the
 * "Odito SEO Bridge" WordPress plugin. Mocks wordPressService.wpRequest
 * only (the one shared, already-tested HTTP helper this service builds
 * on) — never a live WordPress server. Real, live-WordPress validation of
 * this exact module (against Rank Math, Yoast, SEOPress, and AIOSEO, all
 * genuinely installed) is covered separately in the Phase 5 report; this
 * suite exists to pin down the response-shaping and error-classification
 * logic this file owns, in isolation.
 */

const fakeConnection = { site_url: 'https://example.com', username: 'admin', application_password: 'x' };

function mockWpRequest(impl) {
  return mock.method(wordPressService, 'wpRequest', impl);
}

beforeEach(() => {
  mock.restoreAll();
});

describe('oditoSeoBridgeService.getBridgeStatus()', () => {
  test('a 404 (route not found) means the Bridge is not installed — never thrown as an error', async () => {
    mockWpRequest(async () => ({ status: 404, data: { code: 'rest_no_route', message: 'No route was found.' } }));
    const result = await oditoSeoBridgeService.getBridgeStatus(fakeConnection);
    assert.deepEqual(result, { installed: false, provider: 'none', providers: [], bridgeVersion: null, siteSchemaSupported: false, faqSchemaSupported: false, ratingSchemaSupported: false, organizationTypeSupported: false, organizationAddressSupported: false, mediaAltSupported: false, conditionalWritesSupported: false });
  });

  test('a 200 with a single provider is reported installed with that provider', async () => {
    mockWpRequest(async () => ({
      status: 200,
      data: { installed: true, bridge_version: '1.0.0', provider: 'yoast', providers: ['yoast'], wordpress_version: '6.6' },
    }));
    const result = await oditoSeoBridgeService.getBridgeStatus(fakeConnection);
    assert.deepEqual(result, { installed: true, provider: 'yoast', providers: ['yoast'], bridgeVersion: '1.0.0', siteSchemaSupported: false, faqSchemaSupported: false, ratingSchemaSupported: false, organizationTypeSupported: false, organizationAddressSupported: false, mediaAltSupported: false, conditionalWritesSupported: false });
  });

  test('a Bridge version reporting supports.site_schema is surfaced as siteSchemaSupported', async () => {
    mockWpRequest(async () => ({
      status: 200,
      data: { bridge_version: '1.1.0', provider: 'rank_math', providers: ['rank_math'], supports: { read: true, write: true, site_schema: true } },
    }));
    const result = await oditoSeoBridgeService.getBridgeStatus(fakeConnection);
    assert.equal(result.siteSchemaSupported, true);
  });

  test('a pre-site-schema Bridge (older deployed version, no supports.site_schema key) reports siteSchemaSupported false, never guessed true', async () => {
    mockWpRequest(async () => ({
      status: 200,
      data: { bridge_version: '1.0.0', provider: 'rank_math', providers: ['rank_math'], supports: { read: true, write: true } },
    }));
    const result = await oditoSeoBridgeService.getBridgeStatus(fakeConnection);
    assert.equal(result.siteSchemaSupported, false);
  });

  test('a Bridge reporting supports.faq_schema is surfaced as faqSchemaSupported — independent of the SEO provider', async () => {
    mockWpRequest(async () => ({
      status: 200,
      data: { bridge_version: '1.2.0', provider: 'none', providers: [], supports: { read: true, write: false, site_schema: false, faq_schema: true } },
    }));
    const result = await oditoSeoBridgeService.getBridgeStatus(fakeConnection);
    assert.equal(result.faqSchemaSupported, true);
    assert.equal(result.provider, 'none');
  });

  test('a pre-FAQ Bridge (no supports.faq_schema key) reports faqSchemaSupported false, never guessed true', async () => {
    mockWpRequest(async () => ({
      status: 200,
      data: { bridge_version: '1.1.0', provider: 'rank_math', providers: ['rank_math'], supports: { read: true, write: true, site_schema: true } },
    }));
    const result = await oditoSeoBridgeService.getBridgeStatus(fakeConnection);
    assert.equal(result.faqSchemaSupported, false);
  });

  test('a Bridge reporting supports.rating_schema is surfaced as ratingSchemaSupported; an older one never is', async () => {
    mockWpRequest(async () => ({ status: 200, data: { bridge_version: '1.3.0', provider: 'none', providers: [], supports: { faq_schema: true, rating_schema: true } } }));
    assert.equal((await oditoSeoBridgeService.getBridgeStatus(fakeConnection)).ratingSchemaSupported, true);
    mockWpRequest(async () => ({ status: 200, data: { bridge_version: '1.2.0', provider: 'none', providers: [], supports: { faq_schema: true } } }));
    assert.equal((await oditoSeoBridgeService.getBridgeStatus(fakeConnection)).ratingSchemaSupported, false);
  });

  test('"multiple" providers is passed through as-is — never silently resolved to one', async () => {
    mockWpRequest(async () => ({
      status: 200,
      data: { bridge_version: '1.0.0', provider: 'multiple', providers: ['rank_math', 'yoast'] },
    }));
    const result = await oditoSeoBridgeService.getBridgeStatus(fakeConnection);
    assert.equal(result.provider, 'multiple');
    assert.deepEqual(result.providers, ['rank_math', 'yoast']);
  });

  test('a 401 is classified as INVALID_CREDENTIALS, not a generic error', async () => {
    mockWpRequest(async () => ({ status: 401, data: { code: 'odito_not_authenticated' } }));
    await assert.rejects(
      () => oditoSeoBridgeService.getBridgeStatus(fakeConnection),
      (err) => {
        assert.ok(err instanceof WordPressConnectionError);
        assert.equal(err.code, 'INVALID_CREDENTIALS');
        assert.equal(err.statusCode, 401);
        return true;
      }
    );
  });

  test('an unexpected 500 is classified as UNKNOWN_ERROR rather than silently reported as "not installed"', async () => {
    mockWpRequest(async () => ({ status: 500, data: {} }));
    await assert.rejects(
      () => oditoSeoBridgeService.getBridgeStatus(fakeConnection),
      (err) => {
        assert.ok(err instanceof WordPressConnectionError);
        assert.equal(err.code, 'UNKNOWN_ERROR');
        return true;
      }
    );
  });
});

describe('oditoSeoBridgeService.getBridgeCapabilities()', () => {
  test('when the Bridge is not installed, returns empty (all-false) capabilities without a second HTTP call', async () => {
    const wp = mockWpRequest(async () => ({ status: 404, data: {} }));
    const result = await oditoSeoBridgeService.getBridgeCapabilities(fakeConnection);
    assert.equal(result.installed, false);
    assert.deepEqual(result.fields, {
      title: { read: false, write: false },
      meta_description: { read: false, write: false },
      canonical: { read: false, write: false },
      robots: { read: false, write: false },
    });
    assert.equal(wp.mock.callCount(), 1, 'only the status check should have run — no capabilities call once "not installed" is known');
  });

  test('filters the response down to exactly the four supported fields, defaulting anything missing to false', async () => {
    let call = 0;
    mockWpRequest(async () => {
      call += 1;
      if (call === 1) return { status: 200, data: { provider: 'seopress', providers: ['seopress'], bridge_version: '1.0.0' } };
      return {
        status: 200,
        data: {
          provider: 'seopress',
          providers: ['seopress'],
          fields: {
            title: { read: true, write: true },
            meta_description: { read: true, write: true },
            // canonical/robots omitted entirely — must default to false, not throw
          },
        },
      };
    });
    const result = await oditoSeoBridgeService.getBridgeCapabilities(fakeConnection);
    assert.deepEqual(result.fields, {
      title: { read: true, write: true },
      meta_description: { read: true, write: true },
      canonical: { read: false, write: false },
      robots: { read: false, write: false },
    });
  });

  test('a future Bridge version reporting an extra, unsupported field can never unlock it — defensive allowlist, not just trust', async () => {
    let call = 0;
    mockWpRequest(async () => {
      call += 1;
      if (call === 1) return { status: 200, data: { provider: 'rank_math', providers: ['rank_math'] } };
      return {
        status: 200,
        data: {
          provider: 'rank_math',
          providers: ['rank_math'],
          fields: {
            title: { read: true, write: true },
            meta_description: { read: true, write: true },
            canonical: { read: true, write: true },
            robots: { read: true, write: true },
            slug: { read: true, write: true }, // must be dropped — not in Odito's own verifiable allowlist
          },
        },
      };
    });
    const result = await oditoSeoBridgeService.getBridgeCapabilities(fakeConnection);
    assert.equal(result.fields.slug, undefined);
    assert.deepEqual(Object.keys(result.fields).sort(), ['canonical', 'meta_description', 'robots', 'title']);
  });
});

describe('oditoSeoBridgeService.readSeoData() / writeSeoField()', () => {
  test('readSeoData returns raw string-or-null VALUES, never the {read,write} capability shape', async () => {
    mockWpRequest(async () => ({
      status: 200,
      data: { postId: 2, provider: 'rank_math', fields: { title: 'Hello', meta_description: null, canonical: 'https://example.com/x' } },
    }));
    const result = await oditoSeoBridgeService.readSeoData(fakeConnection, 2);
    assert.deepEqual(result, {
      provider: 'rank_math',
      fields: { title: 'Hello', meta_description: null, canonical: 'https://example.com/x', robots: null },
    });
  });

  test('readSeoData treats an empty string the same as null for title/meta_description/canonical (never a fabricated empty value)', async () => {
    mockWpRequest(async () => ({
      status: 200,
      data: { fields: { title: '', meta_description: 'x', canonical: '' } },
    }));
    const result = await oditoSeoBridgeService.readSeoData(fakeConnection, 2);
    assert.equal(result.fields.title, null);
    assert.equal(result.fields.canonical, null);
    assert.equal(result.fields.meta_description, 'x');
  });

  // robots is deliberately different: "" is the Bridge's own confirmed wire
  // value for "no restriction" (index, follow), not an absent/unset value —
  // collapsing it to null the way title/meta_description/canonical do would
  // make a real, confirmed value indistinguishable from "this provider
  // doesn't report robots at all," breaking both the read-before-write
  // conflict check and the Apply modal's "(empty)" display for the single
  // most common robots state.
  test('readSeoData preserves an empty-string robots value as "" (a real, confirmed value), never collapsing it to null', async () => {
    mockWpRequest(async () => ({
      status: 200,
      data: { fields: { title: 'Hello', meta_description: 'x', canonical: 'https://example.com/x', robots: '' } },
    }));
    const result = await oditoSeoBridgeService.readSeoData(fakeConnection, 2);
    assert.equal(result.fields.robots, '');
  });

  test('readSeoData preserves a restrictive robots wire value unchanged', async () => {
    mockWpRequest(async () => ({
      status: 200,
      data: { fields: { title: 'Hello', meta_description: 'x', canonical: 'https://example.com/x', robots: 'nofollow, noindex' } },
    }));
    const result = await oditoSeoBridgeService.readSeoData(fakeConnection, 2);
    assert.equal(result.fields.robots, 'nofollow, noindex');
  });

  test('readSeoData reports robots as null when the provider does not report it at all (e.g. Yoast/AIOSEO/SEOPress today)', async () => {
    mockWpRequest(async () => ({
      status: 200,
      data: { fields: { title: 'Hello', meta_description: 'x', canonical: 'https://example.com/x' } },
    }));
    const result = await oditoSeoBridgeService.readSeoData(fakeConnection, 2);
    assert.equal(result.fields.robots, null);
  });

  test('writeSeoField sends a PUT with {field, value} as the JSON body and returns the Bridge-confirmed value', async () => {
    const wp = mockWpRequest(async (connection, options) => {
      assert.equal(options.method, 'PUT');
      assert.equal(options.path, '/wp-json/odito/v1/seo/2');
      assert.deepEqual(options.data, { field: 'title', value: 'New Title' });
      return { status: 200, data: { postId: 2, provider: 'yoast', field: 'title', value: 'New Title' } };
    });
    const result = await oditoSeoBridgeService.writeSeoField(fakeConnection, 2, 'title', 'New Title');
    assert.deepEqual(result, { provider: 'yoast', field: 'title', value: 'New Title' });
    assert.equal(wp.mock.callCount(), 1);
  });

  test('a 409 write response (ambiguous providers) is classified as PLUGIN_NOT_SUPPORTED, never a generic WRITE_FAILED', async () => {
    mockWpRequest(async () => ({
      status: 409,
      data: { code: 'odito_multiple_providers', message: 'Multiple supported SEO plugins are active.' },
    }));
    await assert.rejects(
      () => oditoSeoBridgeService.writeSeoField(fakeConnection, 2, 'title', 'x'),
      (err) => {
        assert.ok(err instanceof WordPressConnectionError);
        assert.equal(err.code, 'PLUGIN_NOT_SUPPORTED');
        assert.equal(err.statusCode, 409);
        return true;
      }
    );
  });

  test('a 422 write response (field not writable for this provider) is classified as FIELD_NOT_WRITABLE', async () => {
    mockWpRequest(async () => ({
      status: 422,
      data: { code: 'odito_field_unsupported', message: 'This field is not writable for the active SEO plugin.' },
    }));
    await assert.rejects(
      () => oditoSeoBridgeService.writeSeoField(fakeConnection, 2, 'canonical', 'x'),
      (err) => {
        assert.ok(err instanceof WordPressConnectionError);
        assert.equal(err.code, 'FIELD_NOT_WRITABLE');
        return true;
      }
    );
  });

  test('a 403 write response is classified as PERMISSION_DENIED', async () => {
    mockWpRequest(async () => ({ status: 403, data: { code: 'odito_permission_denied' } }));
    await assert.rejects(
      () => oditoSeoBridgeService.writeSeoField(fakeConnection, 2, 'title', 'x'),
      (err) => {
        assert.ok(err instanceof WordPressConnectionError);
        assert.equal(err.code, 'PERMISSION_DENIED');
        assert.equal(err.statusCode, 403);
        return true;
      }
    );
  });

  test('a 404 on a read (post not found/deleted) is classified as FIELD_NOT_WRITABLE with a clear message', async () => {
    mockWpRequest(async () => ({ status: 404, data: { code: 'odito_invalid_post', message: 'This post could not be found.' } }));
    await assert.rejects(
      () => oditoSeoBridgeService.readSeoData(fakeConnection, 999999),
      (err) => {
        assert.ok(err instanceof WordPressConnectionError);
        assert.equal(err.code, 'FIELD_NOT_WRITABLE');
        return true;
      }
    );
  });

  test('a 500 write response is classified as WRITE_FAILED', async () => {
    mockWpRequest(async () => ({ status: 500, data: {} }));
    await assert.rejects(
      () => oditoSeoBridgeService.writeSeoField(fakeConnection, 2, 'title', 'x'),
      (err) => {
        assert.ok(err instanceof WordPressConnectionError);
        assert.equal(err.code, 'WRITE_FAILED');
        return true;
      }
    );
  });
});

describe('oditoSeoBridgeService.toLegacySeoShape()', () => {
  test('passes robots through as the raw wire string, not parsed into an object here', () => {
    const shape = oditoSeoBridgeService.toLegacySeoShape({ title: 'T', meta_description: 'D', canonical: 'https://example.com/x', robots: 'noindex' });
    assert.equal(shape.robots, 'noindex');
    assert.equal(typeof shape.robots, 'string');
  });

  test('an empty-string robots wire value stays "" — not coerced to null by this reshape', () => {
    const shape = oditoSeoBridgeService.toLegacySeoShape({ title: 'T', meta_description: 'D', canonical: null, robots: '' });
    assert.equal(shape.robots, '');
  });

  test('robots is null when the underlying fields omit it entirely', () => {
    const shape = oditoSeoBridgeService.toLegacySeoShape({ title: 'T', meta_description: 'D', canonical: null });
    assert.equal(shape.robots, null);
  });
});

describe('oditoSeoBridgeService.getSiteSchema() / updateSiteSchemaField()', () => {
  test('getSiteSchema reads and normalizes the full organization + breadcrumbs shape, including the protected/additional sameAs split', async () => {
    mockWpRequest(async (connection, options) => {
      assert.equal(options.method, 'GET');
      assert.equal(options.path, '/wp-json/odito/v1/seo/site');
      return {
        status: 200,
        data: {
          provider: 'rank_math',
          organization: {
            name: 'Naxonify', description: '', url: 'https://naxonify.com', logo: '',
            sameAs: ['https://twitter.com/naxonify', 'https://linkedin.com/company/naxonify'],
            protectedSameAs: ['https://twitter.com/naxonify'],
            additionalSameAs: ['https://linkedin.com/company/naxonify'],
          },
          breadcrumbs: { enabled: false },
        },
      };
    });
    const result = await oditoSeoBridgeService.getSiteSchema(fakeConnection);
    assert.deepEqual(result, {
      provider: 'rank_math',
      operation: null,
      organization: {
        name: 'Naxonify', description: '', url: 'https://naxonify.com', logo: '', type: '', kind: '', hasAddress: false, address: {}, localSeoActive: false,
        sameAs: ['https://twitter.com/naxonify', 'https://linkedin.com/company/naxonify'],
        protectedSameAs: ['https://twitter.com/naxonify'],
        additionalSameAs: ['https://linkedin.com/company/naxonify'],
      },
      breadcrumbs: { enabled: false },
    });
  });

  test('getSiteSchema defaults missing sub-fields (including protectedSameAs/additionalSameAs) to safe empty values rather than throwing', async () => {
    mockWpRequest(async () => ({ status: 200, data: { provider: 'rank_math' } }));
    const result = await oditoSeoBridgeService.getSiteSchema(fakeConnection);
    assert.deepEqual(result.organization, {
      name: '', description: '', url: '', logo: '', type: '', kind: '', hasAddress: false, address: {}, localSeoActive: false, sameAs: [], protectedSameAs: [], additionalSameAs: [],
    });
    assert.deepEqual(result.breadcrumbs, { enabled: false });
  });

  test('getSiteSchema surfaces a 422 (provider does not support site schema) as FIELD_NOT_WRITABLE', async () => {
    mockWpRequest(async () => ({
      status: 422,
      data: { code: 'odito_site_schema_unsupported', message: 'Site-level schema is not supported for the active SEO plugin.' },
    }));
    await assert.rejects(
      () => oditoSeoBridgeService.getSiteSchema(fakeConnection),
      (err) => {
        assert.ok(err instanceof WordPressConnectionError);
        assert.equal(err.code, 'FIELD_NOT_WRITABLE');
        return true;
      }
    );
  });

  test('updateSiteSchemaField sends {entity, field, value, op} as the JSON body and returns the full refreshed schema', async () => {
    const wp = mockWpRequest(async (connection, options) => {
      assert.equal(options.method, 'PUT');
      assert.equal(options.path, '/wp-json/odito/v1/seo/site');
      assert.deepEqual(options.data, { entity: 'organization', field: 'name', value: 'Naxonify Inc.', op: null });
      return {
        status: 200,
        data: {
          provider: 'rank_math',
          organization: { name: 'Naxonify Inc.', description: '', url: '', logo: '', sameAs: [] },
          breadcrumbs: { enabled: false },
        },
      };
    });
    const result = await oditoSeoBridgeService.updateSiteSchemaField(fakeConnection, 'organization', 'name', 'Naxonify Inc.');
    assert.equal(result.organization.name, 'Naxonify Inc.');
    assert.equal(wp.mock.callCount(), 1);
  });

  test('updateSiteSchemaField passes the op through for sameAs add/remove', async () => {
    const wp = mockWpRequest(async (connection, options) => {
      assert.deepEqual(options.data, { entity: 'organization', field: 'sameAs', value: 'https://linkedin.com/company/naxonify', op: 'add' });
      return { status: 200, data: { provider: 'rank_math', organization: { name: '', description: '', url: '', logo: '', sameAs: ['https://linkedin.com/company/naxonify'] }, breadcrumbs: { enabled: false } } };
    });
    await oditoSeoBridgeService.updateSiteSchemaField(fakeConnection, 'organization', 'sameAs', 'https://linkedin.com/company/naxonify', 'add');
    assert.equal(wp.mock.callCount(), 1);
  });

  test('a 403 (not manage_options) is classified as PERMISSION_DENIED', async () => {
    mockWpRequest(async () => ({ status: 403, data: { code: 'odito_permission_denied', message: 'You do not have permission to change site-wide SEO settings.' } }));
    await assert.rejects(
      () => oditoSeoBridgeService.updateSiteSchemaField(fakeConnection, 'breadcrumbs', 'enabled', true),
      (err) => {
        assert.ok(err instanceof WordPressConnectionError);
        assert.equal(err.code, 'PERMISSION_DENIED');
        return true;
      }
    );
  });
});

describe('oditoSeoBridgeService FAQ schema read/write', () => {
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [{ '@type': 'Question', name: 'What is SEO?', acceptedAnswer: { '@type': 'Answer', text: 'Search engine optimization.' } }],
  };

  test('readFaqSchema: GETs the dedicated faq-schema route and returns the stored pairs', async () => {
    const calls = [];
    mockWpRequest(async (_c, opts) => { calls.push(opts); return { status: 200, data: { postId: 42, exists: true, schema } }; });
    const result = await oditoSeoBridgeService.readFaqSchema(fakeConnection, 42);
    assert.deepEqual(result.pairs, [{ question: 'What is SEO?', answer: 'Search engine optimization.' }]);
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].path, '/wp-json/odito/v1/faq-schema/42');
  });

  test('readFaqSchema: nothing stored -> pairs null (never an empty-but-truthy value)', async () => {
    mockWpRequest(async () => ({ status: 200, data: { postId: 42, exists: false, schema: null } }));
    assert.deepEqual(await oditoSeoBridgeService.readFaqSchema(fakeConnection, 42), { pairs: null });
  });

  test('readFaqSchema: a stored value that is not a well-formed FAQPage is reported as nothing, not a partial guess', async () => {
    mockWpRequest(async () => ({ status: 200, data: { schema: { '@type': 'FAQPage', mainEntity: [{ '@type': 'Question', name: 'Q?' }] } } }));
    assert.deepEqual(await oditoSeoBridgeService.readFaqSchema(fakeConnection, 42), { pairs: null });
  });

  test('writeFaqSchema: PUTs the FAQPage object as { schema } and returns what the Bridge says is now stored', async () => {
    const calls = [];
    mockWpRequest(async (_c, opts) => { calls.push(opts); return { status: 200, data: { postId: 42, exists: true, schema } }; });
    const result = await oditoSeoBridgeService.writeFaqSchema(fakeConnection, 42, schema);
    assert.equal(calls[0].method, 'PUT');
    assert.equal(calls[0].path, '/wp-json/odito/v1/faq-schema/42');
    assert.deepEqual(calls[0].data, { schema });
    assert.equal(result.pairs.length, 1);
  });

  test('writeFaqSchema: a Bridge validation rejection (400) is a WRITE_FAILED, permission (403) is PERMISSION_DENIED', async () => {
    mockWpRequest(async () => ({ status: 400, data: { message: 'A valid FAQPage schema is required.' } }));
    await assert.rejects(() => oditoSeoBridgeService.writeFaqSchema(fakeConnection, 42, schema), (e) => e instanceof WordPressConnectionError && e.code === 'WRITE_FAILED');
    mockWpRequest(async () => ({ status: 403, data: { message: 'no' } }));
    await assert.rejects(() => oditoSeoBridgeService.writeFaqSchema(fakeConnection, 42, schema), (e) => e.code === 'PERMISSION_DENIED');
  });
});

describe('oditoSeoBridgeService AggregateRating schema read/write', () => {
  const node = {
    '@context': 'https://schema.org',
    '@type': 'Service',
    '@id': 'https://example.com/seo/#service',
    name: 'SEO Service',
    aggregateRating: { '@type': 'AggregateRating', ratingValue: '4.8', reviewCount: '127', bestRating: '5' },
  };
  const parsed = {
    target: { type: 'Service', id: 'https://example.com/seo/#service', name: 'SEO Service' },
    rating: { ratingValue: 4.8, bestRating: 5, reviewCount: 127 },
  };

  test('readRatingSchema: GETs the dedicated rating-schema route and returns {target, rating}', async () => {
    const calls = [];
    mockWpRequest(async (_c, opts) => { calls.push(opts); return { status: 200, data: { postId: 42, exists: true, schema: node } }; });
    assert.deepEqual(await oditoSeoBridgeService.readRatingSchema(fakeConnection, 42), { value: parsed });
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].path, '/wp-json/odito/v1/rating-schema/42');
  });

  test('readRatingSchema: nothing stored, or something that is not a well-formed rating node -> value null', async () => {
    mockWpRequest(async () => ({ status: 200, data: { exists: false, schema: null } }));
    assert.deepEqual(await oditoSeoBridgeService.readRatingSchema(fakeConnection, 42), { value: null });
    mockWpRequest(async () => ({ status: 200, data: { schema: { ...node, aggregateRating: { '@type': 'AggregateRating', ratingValue: '4.8' } } } }));
    assert.deepEqual(await oditoSeoBridgeService.readRatingSchema(fakeConnection, 42), { value: null });
  });

  test('writeRatingSchema: PUTs the node as { schema } and returns what the Bridge says is stored', async () => {
    const calls = [];
    mockWpRequest(async (_c, opts) => { calls.push(opts); return { status: 200, data: { schema: node } }; });
    const result = await oditoSeoBridgeService.writeRatingSchema(fakeConnection, 42, node);
    assert.equal(calls[0].method, 'PUT');
    assert.equal(calls[0].path, '/wp-json/odito/v1/rating-schema/42');
    assert.deepEqual(calls[0].data, { schema: node });
    assert.deepEqual(result, { value: parsed });
  });

  test('writeRatingSchema: Bridge validation rejection (400) -> WRITE_FAILED', async () => {
    mockWpRequest(async () => ({ status: 400, data: { message: 'A valid rating is required.' } }));
    await assert.rejects(() => oditoSeoBridgeService.writeRatingSchema(fakeConnection, 42, node), (e) => e instanceof WordPressConnectionError && e.code === 'WRITE_FAILED');
  });
});

describe('oditoSeoBridgeService — conditional media alt write and conflict reasons (Bridge 1.5.0)', () => {
  const conflict = (reason) => ({ status: 409, data: { code: 'odito_conflict', message: 'x', data: { status: 409, reason } } });

  test('swapMediaAlt PUTs only value, expected and expectedFile to the attachment-scoped route — no field name, no meta key', async () => {
    const calls = [];
    mockWpRequest(async (_c, opts) => { calls.push(opts); return { status: 200, data: { id: 7, alt: 'New', file: '2026/10/a.png', operation: { id: 'op-1', atomic: true, alreadyApplied: false, created: false } } }; });
    const result = await oditoSeoBridgeService.swapMediaAlt(fakeConnection, 7, { value: 'New', expected: '', expectedFile: '2026/10/a.png' });
    assert.equal(calls[0].method, 'PUT');
    assert.equal(calls[0].path, '/wp-json/odito/v1/media/7/alt');
    assert.deepEqual(Object.keys(calls[0].data).sort(), ['expected', 'expectedFile', 'value']);
    assert.deepEqual(result, { id: 7, alt: 'New', file: '2026/10/a.png', operation: { id: 'op-1', atomic: true, alreadyApplied: false, created: false, attempts: null } });
  });

  test('swapMediaAlt refuses a non-positive or non-numeric attachment id before any request is made', async () => {
    const spy = mockWpRequest(async () => ({ status: 200, data: {} }));
    for (const bad of [0, -1, 'abc', 1.5, null, undefined]) {
      await assert.rejects(() => oditoSeoBridgeService.swapMediaAlt(fakeConnection, bad, { value: 'x', expected: '', expectedFile: 'f' }), (e) => e instanceof WordPressConnectionError);
    }
    assert.equal(spy.mock.callCount(), 0);
  });

  test('a 409 odito_conflict is CONFLICT and carries the machine reason', async () => {
    for (const reason of ['expected_mismatch', 'target_changed', 'ambiguous_meta', 'contention']) {
      mockWpRequest(async () => conflict(reason));
      await assert.rejects(() => oditoSeoBridgeService.swapMediaAlt(fakeConnection, 7, { value: 'x', expected: '', expectedFile: 'f' }), (e) => e.code === 'CONFLICT' && e.reason === reason);
      mock.restoreAll();
    }
  });

  test('an unknown or malformed conflict reason falls back to expected_mismatch (never echoed back)', async () => {
    mockWpRequest(async () => conflict('<script>alert(1)</script>'));
    await assert.rejects(() => oditoSeoBridgeService.swapMediaAlt(fakeConnection, 7, { value: 'x', expected: '', expectedFile: 'f' }), (e) => e.code === 'CONFLICT' && e.reason === 'expected_mismatch' && !/script/.test(e.message));
  });

  test('a 409 without odito_conflict is still the multi-plugin error, not a conflict', async () => {
    mockWpRequest(async () => ({ status: 409, data: { code: 'odito_ambiguous', message: 'Multiple SEO plugins' } }));
    await assert.rejects(() => oditoSeoBridgeService.readMediaAlt(fakeConnection, 7), (e) => e.code === 'PLUGIN_NOT_SUPPORTED');
  });

  test('a permission failure on the attachment is PERMISSION_DENIED', async () => {
    mockWpRequest(async () => ({ status: 403, data: { code: 'odito_permission_denied', message: 'no' } }));
    await assert.rejects(() => oditoSeoBridgeService.swapMediaAlt(fakeConnection, 7, { value: 'x', expected: '', expectedFile: 'f' }), (e) => e.code === 'PERMISSION_DENIED');
  });

  test('updateSiteSchemaField exposes the Bridge operation record (id, atomic, attempts) for the ledger', async () => {
    mockWpRequest(async () => ({ status: 200, data: { provider: 'rank_math', operation: { id: 'op-2', atomic: true, attempts: 2, field: 'name' }, organization: {}, breadcrumbs: {} } }));
    const result = await oditoSeoBridgeService.updateSiteSchemaField(fakeConnection, 'organization', 'name', 'A', null, { expected: '' });
    assert.deepEqual(result.operation, { id: 'op-2', atomic: true, alreadyApplied: false, created: false, attempts: 2 });
  });

  test('getBridgeStatus reports mediaAltSupported from supports.media_alt', async () => {
    mockWpRequest(async () => ({ status: 200, data: { provider: 'rank_math', providers: ['rank_math'], version: '1.5.0', supports: { site_schema: true, media_alt: true } } }));
    assert.equal((await oditoSeoBridgeService.getBridgeStatus(fakeConnection)).mediaAltSupported, true);
    mockWpRequest(async () => ({ status: 200, data: { provider: 'rank_math', providers: ['rank_math'], version: '1.4.0', supports: { site_schema: true } } }));
    assert.equal((await oditoSeoBridgeService.getBridgeStatus(fakeConnection)).mediaAltSupported, false);
  });
});
