import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import taskHistoryService from './TaskHistoryService.js';

/**
 * Regression coverage for the production bug where a canonical_tag_errors
 * recommendation generated as a full `<link rel="canonical" href="...">`
 * HTML tag (a PromptBuilder.js prompt-wording bug, since fixed) flowed
 * straight through _deriveExpectedAfterValue() as the literal value written
 * to WordPress. Rank Math accepted the malformed string into its canonical
 * meta field without complaint, then silently declined to render an invalid
 * <link> tag from it — so the write "succeeded" (HTTP 200, read-back
 * matched what was written) while the public page had no canonical tag at
 * all. _deriveExpectedAfterValue() is the single shared boundary consumed
 * by BOTH wordPressSeoFixService.js (what Odito writes) and
 * TaskVerificationService (what it later compares against, via the frozen
 * fixHistory entry) — so this is the one place a fix here protects both.
 *
 * _deriveExpectedAfterValue is pure/synchronous (no DB access) so it can be
 * called directly off the exported singleton without mocking anything.
 */
describe('TaskHistoryService._deriveExpectedAfterValue()', () => {
  test('canonical: a clean absolute URL recommendedVersion is passed through', () => {
    const rec = { sections: { recommendedVersion: 'https://naxonify.com/about-naxonify/' } };
    assert.deepEqual(
      taskHistoryService._deriveExpectedAfterValue(rec, 'canonical_tag_errors'),
      { type: 'canonical', canonical: 'https://naxonify.com/about-naxonify/' }
    );
  });

  test('the exact production bug: a clean, standalone HTML <link> tag as recommendedVersion is salvaged down to its bare href (defense-in-depth), never stored/written as HTML', () => {
    const rec = {
      sections: {
        recommendedVersion: '<link rel="canonical" href="https://naxonify.com/about-naxonify/" />',
      },
    };
    assert.deepEqual(
      taskHistoryService._deriveExpectedAfterValue(rec, 'canonical_tag_errors'),
      { type: 'canonical', canonical: 'https://naxonify.com/about-naxonify/' }
    );
  });

  test('a value with markup surrounding/embedding a <link> tag (not a clean standalone tag) is rejected outright — never guesses which part is the real URL', () => {
    const rec = {
      sections: {
        recommendedVersion: '<div><link rel="canonical" href="https://naxonify.com/about-naxonify/" /></div>',
      },
    };
    assert.equal(taskHistoryService._deriveExpectedAfterValue(rec, 'canonical_tag_errors'), null);
  });

  test('canonical: prefers contentRewrite.optimized over recommendedVersion when both are present', () => {
    const rec = {
      sections: {
        contentRewrite: { optimized: 'https://naxonify.com/optimized-path/' },
        recommendedVersion: 'https://naxonify.com/fallback-path/',
      },
    };
    assert.deepEqual(
      taskHistoryService._deriveExpectedAfterValue(rec, 'canonical_tag_errors'),
      { type: 'canonical', canonical: 'https://naxonify.com/optimized-path/' }
    );
  });

  test('canonical: a malformed contentRewrite.optimized value is rejected even with a clean recommendedVersion fallback present', () => {
    // _deriveExpectedAfterValue does not fall back field-to-field — once a
    // value is chosen (optimized over recommendedVersion) it either
    // validates or the whole derivation yields null. Silently falling back
    // to a "safer" field would mask which value actually reached WordPress.
    const rec = {
      sections: {
        contentRewrite: { optimized: '<div><link rel="canonical" href="https://naxonify.com/x/" /></div>' },
        recommendedVersion: 'https://naxonify.com/fallback-path/',
      },
    };
    assert.equal(taskHistoryService._deriveExpectedAfterValue(rec, 'canonical_tag_errors'), null);
  });

  test('canonical: empty/missing value yields null rather than an empty canonical', () => {
    assert.equal(taskHistoryService._deriveExpectedAfterValue({ sections: {} }, 'canonical_tag_errors'), null);
    assert.equal(
      taskHistoryService._deriveExpectedAfterValue({ sections: { recommendedVersion: '' } }, 'canonical_tag_errors'),
      null
    );
  });

  test('non-canonical types are unaffected by the canonical-specific validation', () => {
    const rec = { sections: { recommendedVersion: 'A Better Page Title' } };
    assert.deepEqual(
      taskHistoryService._deriveExpectedAfterValue(rec, 'title_too_short'),
      { type: 'title', title: 'A Better Page Title' }
    );
  });

  test('an issueKey with no known snapshot type yields null', () => {
    const rec = { sections: { recommendedVersion: 'https://naxonify.com/x/' } };
    assert.equal(taskHistoryService._deriveExpectedAfterValue(rec, 'some_unmapped_issue'), null);
  });

  test('robots: a valid recommendedVersion directive string derives {type, index, follow}', () => {
    const rec = { sections: { recommendedVersion: 'index, follow' } };
    assert.deepEqual(
      taskHistoryService._deriveExpectedAfterValue(rec, 'noindex_key_pages'),
      { type: 'robots', index: true, follow: true }
    );
  });

  test('robots: noindex_tags maps to the same robots snapshot type as noindex_key_pages', () => {
    const rec = { sections: { recommendedVersion: 'noindex, follow' } };
    assert.deepEqual(
      taskHistoryService._deriveExpectedAfterValue(rec, 'noindex_tags'),
      { type: 'robots', index: false, follow: true }
    );
  });

  test('robots: a malformed/free-form recommendedVersion (not one of the 4 allowed strings) yields null, refusing the write', () => {
    const rec = { sections: { recommendedVersion: 'Please make this page indexable' } };
    assert.equal(taskHistoryService._deriveExpectedAfterValue(rec, 'noindex_key_pages'), null);
  });

  test('same_as: a valid absolute URL recommendedVersion derives {type, url}', () => {
    const rec = { sections: { recommendedVersion: 'https://linkedin.com/company/naxonify' } };
    assert.deepEqual(
      taskHistoryService._deriveExpectedAfterValue(rec, 'sameas_array'),
      { type: 'same_as', url: 'https://linkedin.com/company/naxonify' }
    );
  });

  test('same_as: a malformed value (relative, javascript:, or HTML) yields null, refusing the write', () => {
    for (const bad of ['/social/naxonify', 'javascript:alert(1)', '<a href="https://x.com">x</a>']) {
      const rec = { sections: { recommendedVersion: bad } };
      assert.equal(taskHistoryService._deriveExpectedAfterValue(rec, 'sameas_array'), null, `expected null for "${bad}"`);
    }
  });

  test('breadcrumb: the closed-allowlist "enabled" string derives {type, enabled: true}', () => {
    const rec = { sections: { recommendedVersion: 'enabled' } };
    assert.deepEqual(
      taskHistoryService._deriveExpectedAfterValue(rec, 'breadcrumblist_schema'),
      { type: 'breadcrumb', enabled: true }
    );
  });

  test('breadcrumb: anything other than the exact "enabled" string yields null', () => {
    for (const bad of ['true', '1', 'yes', 'Enable breadcrumbs please']) {
      const rec = { sections: { recommendedVersion: bad } };
      assert.equal(taskHistoryService._deriveExpectedAfterValue(rec, 'breadcrumblist_schema'), null, `expected null for "${bad}"`);
    }
  });
});
