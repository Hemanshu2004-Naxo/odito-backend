import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import wordPressSeoFixService from './wordPressSeoFixService.js';
import { WordPressConnectionError } from './wordPressService.js';
import WordPressCoreAdapter from '../adapters/wordpressCoreAdapter.js';
import AioseoAdapter from '../adapters/aioseoAdapter.js';
import SeopressAdapter from '../adapters/seopressAdapter.js';
import RankMathAdapter from '../adapters/rankMathAdapter.js';
import YoastAdapter from '../adapters/yoastAdapter.js';
import { getAdapterForConnection, PROVIDER_LABELS } from '../adapters/index.js';

const FIELD_KEYS = ['title', 'metaDescription', 'canonical', 'robots', 'openGraph', 'schema', 'slug', 'altText'];

function assertValidCapabilityShape(capabilities) {
  assert.equal(Object.keys(capabilities).length, FIELD_KEYS.length);
  for (const key of FIELD_KEYS) {
    assert.ok(capabilities[key], `missing capability entry for ${key}`);
    assert.equal(typeof capabilities[key].read, 'boolean');
    assert.equal(typeof capabilities[key].write, 'boolean');
  }
}

describe('Provider adapters — capability table shape (Phase 4)', () => {
  test('WordPressCoreAdapter: title writable; slug/altText readable but NOT writable via the capabilities API (not wired into the Task apply-flow yet)', () => {
    const adapter = new WordPressCoreAdapter({ site_url: 'https://example.com', username: 'u', application_password: 'p' });
    const caps = adapter.getCapabilities();
    assertValidCapabilityShape(caps);
    assert.equal(caps.title.write, true);
    // Bug fix (production-readiness audit): slug/altText have working adapter
    // methods (writeSlug/writeAltText) but no issueSnapshotTypes.js mapping /
    // unambiguous image target respectively, so TaskVerificationService could
    // never confirm either change — the capabilities API must not advertise
    // them as writable just because the adapter method exists.
    assert.equal(caps.slug.read, true);
    assert.equal(caps.slug.write, false);
    assert.equal(caps.altText.read, true);
    assert.equal(caps.altText.write, false);
    assert.equal(caps.metaDescription.write, false);
    assert.equal(caps.canonical.write, false);
  });

  test('AioseoAdapter: title/metaDescription/canonical writable and Task-verifiable; robots/openGraph/slug/altText NOT (no issueSnapshotTypes/TaskVerificationService/FIELD_CONFIG wiring)', () => {
    const adapter = new AioseoAdapter({ site_url: 'https://example.com', username: 'u', application_password: 'p' });
    const caps = adapter.getCapabilities();
    assertValidCapabilityShape(caps);
    for (const key of ['title', 'metaDescription', 'canonical']) {
      assert.equal(caps[key].write, true, `expected ${key} to be writable for AIOSEO`);
    }
    // Bug fix (Phase 3): robots/openGraph adapter write methods exist (native
    // AIOSEO REST support) but have no Task verification path — must not be
    // advertised as writable capabilities until issueSnapshotTypes.js/
    // TaskVerificationService gain a case for them.
    assert.equal(caps.robots.write, false);
    assert.equal(caps.openGraph.write, false);
    assert.equal(caps.schema.write, false); // not confirmed writable — read-only until verified
    assert.equal(caps.slug.write, false);
    assert.equal(caps.altText.write, false);
  });

  test('SeopressAdapter: title/metaDescription writable and Task-verifiable; robots/openGraph/canonical/slug/altText NOT', () => {
    const adapter = new SeopressAdapter({ site_url: 'https://example.com', username: 'u', application_password: 'p' });
    const caps = adapter.getCapabilities();
    assertValidCapabilityShape(caps);
    for (const key of ['title', 'metaDescription']) {
      assert.equal(caps[key].write, true, `expected ${key} to be writable for SEOPress`);
    }
    // Bug fix (Phase 3): same reasoning as AIOSEO above — no Task
    // verification path exists for robots/openGraph.
    assert.equal(caps.robots.write, false);
    assert.equal(caps.openGraph.write, false);
    assert.equal(caps.canonical.read, false);
    assert.equal(caps.canonical.write, false);
    assert.equal(caps.slug.write, false);
    assert.equal(caps.altText.write, false);
  });

  test('RankMathAdapter: no SEO-plugin-owned field is writable (no bridge installed); slug/altText not advertised either (unwired capability)', () => {
    const adapter = new RankMathAdapter({ site_url: 'https://example.com', username: 'u', application_password: 'p' });
    const caps = adapter.getCapabilities();
    assertValidCapabilityShape(caps);
    for (const key of ['title', 'metaDescription', 'canonical', 'robots', 'openGraph', 'schema']) {
      assert.equal(caps[key].write, false, `expected ${key} to be non-writable for Rank Math without the bridge`);
    }
    assert.equal(caps.slug.write, false);
    assert.equal(caps.altText.write, false);
  });

  test('YoastAdapter: read-only for every SEO-plugin-owned field (Yoast REST is read-only by design); slug/altText not advertised either (unwired capability)', () => {
    const adapter = new YoastAdapter({ site_url: 'https://example.com', username: 'u', application_password: 'p' });
    const caps = adapter.getCapabilities();
    assertValidCapabilityShape(caps);
    for (const key of ['title', 'metaDescription', 'canonical', 'robots', 'openGraph', 'schema']) {
      assert.equal(caps[key].read, true, `expected ${key} to be readable via yoast_head_json`);
      assert.equal(caps[key].write, false, `expected ${key} to be non-writable for Yoast without the bridge`);
    }
    assert.equal(caps.slug.write, false);
    assert.equal(caps.altText.write, false);
  });
});

describe('Adapter registry — getAdapterForConnection()', () => {
  test('never silently resolves an ambiguous ("multiple") connection to one provider', () => {
    const { adapter, ambiguous } = getAdapterForConnection({ detected_seo_provider: 'multiple', detected_seo_providers: ['rank_math', 'aioseo'] });
    assert.equal(adapter, null);
    assert.equal(ambiguous, true);
  });

  test('falls back to WordPressCoreAdapter for "none" and for an unrecognized provider value', () => {
    const { adapter: noneAdapter, ambiguous: noneAmbiguous } = getAdapterForConnection({ detected_seo_provider: 'none' });
    assert.equal(noneAmbiguous, false);
    assert.ok(noneAdapter instanceof WordPressCoreAdapter);

    const { adapter: fallbackAdapter } = getAdapterForConnection({ detected_seo_provider: 'some_future_plugin' });
    assert.ok(fallbackAdapter instanceof WordPressCoreAdapter);
  });

  test('resolves each known provider to its own adapter class', () => {
    assert.ok(getAdapterForConnection({ detected_seo_provider: 'aioseo' }).adapter instanceof AioseoAdapter);
    assert.ok(getAdapterForConnection({ detected_seo_provider: 'seopress' }).adapter instanceof SeopressAdapter);
    assert.ok(getAdapterForConnection({ detected_seo_provider: 'rank_math' }).adapter instanceof RankMathAdapter);
    assert.ok(getAdapterForConnection({ detected_seo_provider: 'yoast' }).adapter instanceof YoastAdapter);
  });

  test('PROVIDER_LABELS has a human-readable label for every enum value including "multiple"', () => {
    for (const key of ['none', 'aioseo', 'seopress', 'rank_math', 'yoast', 'multiple']) {
      assert.equal(typeof PROVIDER_LABELS[key], 'string');
      assert.ok(PROVIDER_LABELS[key].length > 0);
    }
  });
});

describe('wordPressSeoFixService.validateFix() — task state machine gate (no DB/HTTP required)', () => {
  // Bug fix (production-readiness audit): validateFix() previously had no
  // Task.isValidTransition() check at all, so a task already 'implemented'
  // or terminally 'verified_fixed' could be pushed back to 'implemented'
  // directly — an invalid transition per Task.js's own state machine, and
  // exactly the kind of stale-frontend-state race a background
  // TaskVerificationService pass could trigger.
  test('rejects a task whose current status cannot transition to implemented (verified_fixed is terminal)', async () => {
    const task = { status: 'verified_fixed', issueKey: 'title_missing', recommendationId: 'r1', projectId: 'p1', pageUrl: 'https://example.com/x' };
    await assert.rejects(
      () => wordPressSeoFixService.validateFix(task),
      (err) => {
        assert.ok(err instanceof WordPressConnectionError);
        assert.equal(err.code, 'CONFLICT');
        assert.equal(err.statusCode, 409);
        return true;
      }
    );
  });

  test('rejects a task already implemented (duplicate apply attempt would otherwise re-implement it)', async () => {
    const task = { status: 'implemented', issueKey: 'title_missing', recommendationId: 'r1', projectId: 'p1', pageUrl: 'https://example.com/x' };
    await assert.rejects(
      () => wordPressSeoFixService.validateFix(task),
      (err) => {
        assert.ok(err instanceof WordPressConnectionError);
        assert.equal(err.code, 'CONFLICT');
        return true;
      }
    );
  });

});

describe('wordPressSeoFixService.validateFix() — pre-network rejections (no DB/HTTP required)', () => {
  test('rejects issue types that cannot be applied (no field config: image_alt; not auto-fixed: multiple_h1_tags) with FIELD_NOT_WRITABLE, before touching the connection', async () => {
    for (const issueKey of ['images_missing_alt_text', 'multiple_h1_tags', 'some_unmapped_issue']) {
      const task = { status: 'task_created', issueKey, recommendationId: 'rec-1', projectId: 'p1', pageUrl: 'https://example.com/x' };
      await assert.rejects(
        () => wordPressSeoFixService.validateFix(task),
        (err) => {
          assert.ok(err instanceof WordPressConnectionError);
          assert.equal(err.code, 'FIELD_NOT_WRITABLE', issueKey);
          assert.equal(err.statusCode, 422);
          return true;
        }
      );
    }
  });

  test('recognizes h1_missing as the supported page-content (H1) fix, not FIELD_NOT_WRITABLE', async () => {
    const task = { status: 'task_created', issueKey: 'h1_missing', recommendationId: null, projectId: 'p1', pageUrl: 'https://example.com/x' };
    await assert.rejects(
      () => wordPressSeoFixService.validateFix(task),
      (err) => err instanceof WordPressConnectionError && err.code === 'RECOMMENDATION_REQUIRED'
    );
  });

  test('rejects a supported issue type with no linked recommendation, before touching the connection', async () => {
    const task = { status: 'task_created', issueKey: 'title_missing', recommendationId: null, projectId: 'p1', pageUrl: 'https://example.com/x' };
    await assert.rejects(
      () => wordPressSeoFixService.validateFix(task),
      (err) => {
        assert.ok(err instanceof WordPressConnectionError);
        assert.equal(err.code, 'RECOMMENDATION_REQUIRED');
        assert.equal(err.statusCode, 422);
        return true;
      }
    );
  });

  // Regression test for the robots capability added alongside
  // providerCapabilityRegistry.js — noindex_key_pages/noindex_tags now have
  // a real FIELD_CONFIG.robots entry and an issueSnapshotTypes.js mapping,
  // so this must reach the SAME "no recommendation linked" rejection every
  // other supported field type does, never the FIELD_NOT_WRITABLE an
  // unmapped issue type (e.g. h1_missing, tested above) gets.
  test('recognizes noindex_key_pages/noindex_tags as a supported (robots) field type, not FIELD_NOT_WRITABLE', async () => {
    for (const issueKey of ['noindex_key_pages', 'noindex_tags']) {
      const task = { status: 'task_created', issueKey, recommendationId: null, projectId: 'p1', pageUrl: 'https://example.com/x' };
      await assert.rejects(
        () => wordPressSeoFixService.validateFix(task),
        (err) => {
          assert.ok(err instanceof WordPressConnectionError);
          assert.equal(err.code, 'RECOMMENDATION_REQUIRED', `expected ${issueKey} to be recognized as a supported field`);
          return true;
        }
      );
    }
  });

  // Regression test for the site-scoped capabilities (same_as, breadcrumb)
  // added alongside the Organization/Knowledge Graph Bridge extension —
  // both must reach the SAME "no recommendation linked" rejection every
  // post-scoped field type does, confirming issueSnapshotTypes.js/
  // FIELD_CONFIG recognize them as supported BEFORE the (site-scoped,
  // no-post-ID) network path is ever reached.
  test('recognizes sameas_array and breadcrumblist_schema as supported (site-scoped) field types, not FIELD_NOT_WRITABLE', async () => {
    for (const issueKey of ['sameas_array', 'breadcrumblist_schema']) {
      const task = { status: 'task_created', issueKey, recommendationId: null, projectId: 'p1', pageUrl: 'https://example.com/x' };
      await assert.rejects(
        () => wordPressSeoFixService.validateFix(task),
        (err) => {
          assert.ok(err instanceof WordPressConnectionError);
          assert.equal(err.code, 'RECOMMENDATION_REQUIRED', `expected ${issueKey} to be recognized as a supported field`);
          return true;
        }
      );
    }
  });
});

describe('wordPressSeoFixService.applyFix() — approval gate', () => {
  test('rejects immediately with a 400 if approved is not exactly true, before validating anything else', async () => {
    const task = { status: 'task_created', issueKey: 'h1_missing', recommendationId: null, projectId: 'p1', pageUrl: 'https://example.com/x' };
    await assert.rejects(
      () => wordPressSeoFixService.applyFix(task, { approved: false }),
      (err) => {
        assert.ok(err instanceof WordPressConnectionError);
        assert.equal(err.code, 'WRITE_FAILED');
        assert.equal(err.statusCode, 400);
        return true;
      }
    );
  });
});
