import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeTextValue,
  canonicalValuesMatch,
  extractCanonicalUrlValue,
  normalizeRobotsValue,
  parseRobotsDirectives,
  robotsValueToWireString,
  robotsValuesMatch,
  normalizeSchemaTextValue,
  normalizeSchemaUrlValue,
  normalizeBreadcrumbEnableValue,
} from './valueNormalization.js';

/**
 * Phase 3 verification audit — the normalization logic newly introduced
 * into TaskVerificationService._valuesMatch() and
 * wordPressSeoFixService.js's own comparisons. Pure/synchronous, no DB or
 * network required.
 */

describe('normalizeTextValue()', () => {
  test('is a strict superset of plain trim+lowercase — every previously-equal pair stays equal', () => {
    assert.equal(normalizeTextValue('  Hello World  '), normalizeTextValue('hello world'));
    assert.equal(normalizeTextValue('Hello World'), 'hello world');
  });

  test('folds typographic (curly) quotes to their ASCII equivalents — the wptexturize case', () => {
    const aiRecommended = "Company's Best Widgets";
    const wordpressRendered = 'Company’s Best Widgets'; // curly apostrophe, as wptexturize would render it
    assert.equal(normalizeTextValue(aiRecommended), normalizeTextValue(wordpressRendered));
  });

  test('folds curly double quotes and em/en dashes', () => {
    assert.equal(normalizeTextValue('"Great" Deal - Today'), normalizeTextValue('“Great” Deal – Today'));
  });

  test('decodes common HTML entities before comparing', () => {
    assert.equal(normalizeTextValue('Widgets & Gadgets'), normalizeTextValue('Widgets &amp; Gadgets'));
    assert.equal(normalizeTextValue("It's here"), normalizeTextValue('It&#8217;s here'));
  });

  test('collapses internal whitespace differences', () => {
    assert.equal(normalizeTextValue('Hello   World'), normalizeTextValue('Hello World'));
  });

  test('genuinely different content still compares as different', () => {
    assert.notEqual(normalizeTextValue('Best Widgets'), normalizeTextValue('Best Gadgets'));
  });

  test('non-string input is returned as-is (matches every existing call site\'s null handling)', () => {
    assert.equal(normalizeTextValue(null), null);
    assert.equal(normalizeTextValue(undefined), undefined);
  });
});

describe('canonicalValuesMatch()', () => {
  test('tolerates a trailing-slash difference', () => {
    assert.equal(canonicalValuesMatch('https://example.com/page', 'https://example.com/page/'), true);
    assert.equal(canonicalValuesMatch('https://example.com/page/', 'https://example.com/page'), true);
  });

  test('a genuinely different path is still a mismatch', () => {
    assert.equal(canonicalValuesMatch('https://example.com/page-a', 'https://example.com/page-b'), false);
  });

  test('a genuinely different host is still a mismatch', () => {
    assert.equal(canonicalValuesMatch('https://example.com/page', 'https://other.com/page'), false);
  });

  test('empty/missing values on either side never count as a match (matches TaskVerificationService\'s existing "can\'t confirm" convention)', () => {
    assert.equal(canonicalValuesMatch('', ''), false);
    assert.equal(canonicalValuesMatch(null, null), false);
    assert.equal(canonicalValuesMatch('https://example.com/page', ''), false);
    assert.equal(canonicalValuesMatch('', 'https://example.com/page'), false);
  });

  test('is case-insensitive on the whole URL (same rationale as every other text comparison here) and entity/typography-aware', () => {
    assert.equal(canonicalValuesMatch('https://Example.com/Page', 'https://example.com/page'), true);
  });
});

/**
 * extractCanonicalUrlValue() — added to fix a real production bug: an AI
 * recommendation for canonical_tag_errors was generated with the full
 * `<link rel="canonical" href="...">` HTML tag as its value (a
 * PromptBuilder.js wording bug, since fixed) instead of a bare URL. That
 * string flowed straight through TaskHistoryService._deriveExpectedAfterValue()
 * into the literal value wordPressSeoFixService.js wrote to Rank Math's
 * canonical meta field — Rank Math accepted the malformed string without
 * complaint, then silently declined to render an invalid <link> tag from
 * it, so Odito reported success while the public page had no canonical
 * tag at all. This is the second, independent safety net (the first being
 * the corrected AI prompt) — it must never let a wrapped or otherwise
 * malformed value reach a WordPress write.
 */
describe('extractCanonicalUrlValue()', () => {
  test('returns a plain, already-valid absolute URL unchanged', () => {
    assert.equal(extractCanonicalUrlValue('https://naxonify.com/about-naxonify/'), 'https://naxonify.com/about-naxonify/');
  });

  test('the exact production bug: extracts the href out of a full <link rel="canonical"> tag', () => {
    assert.equal(
      extractCanonicalUrlValue('<link rel="canonical" href="https://naxonify.com/about-naxonify/" />'),
      'https://naxonify.com/about-naxonify/'
    );
  });

  test('extracts the href regardless of attribute order or single quotes', () => {
    assert.equal(
      extractCanonicalUrlValue("<link href='https://example.com/x' rel='canonical'>"),
      'https://example.com/x'
    );
  });

  test('trims surrounding whitespace', () => {
    assert.equal(extractCanonicalUrlValue('   https://example.com/x   '), 'https://example.com/x');
  });

  test('rejects a relative path — never guesses a domain to complete it with', () => {
    assert.equal(extractCanonicalUrlValue('/about-naxonify/'), null);
  });

  test('rejects a non-http(s) scheme (javascript:, data:, mailto:, ftp:)', () => {
    assert.equal(extractCanonicalUrlValue('javascript:alert(1)'), null);
    assert.equal(extractCanonicalUrlValue('data:text/html,<script>alert(1)</script>'), null);
    assert.equal(extractCanonicalUrlValue('mailto:someone@example.com'), null);
    assert.equal(extractCanonicalUrlValue('ftp://example.com/x'), null);
  });

  test('rejects a value that still contains markup after unwrapping (embedded/nested HTML) — never guesses which part is the real URL', () => {
    assert.equal(extractCanonicalUrlValue('<div><link rel="canonical" href="https://example.com/x"></div>'), null);
    assert.equal(extractCanonicalUrlValue('Some text <b>bold</b> https://example.com/x'), null);
  });

  test('rejects empty, whitespace-only, null, undefined, and non-string input', () => {
    assert.equal(extractCanonicalUrlValue(''), null);
    assert.equal(extractCanonicalUrlValue('   '), null);
    assert.equal(extractCanonicalUrlValue(null), null);
    assert.equal(extractCanonicalUrlValue(undefined), null);
    assert.equal(extractCanonicalUrlValue(42), null);
    assert.equal(extractCanonicalUrlValue({ href: 'https://example.com' }), null);
  });

  test('rejects a malformed/unparseable URL string', () => {
    assert.equal(extractCanonicalUrlValue('not a url at all'), null);
    assert.equal(extractCanonicalUrlValue('https://'), null);
  });

  test('never throws for any input — always returns null or a string', () => {
    for (const input of [null, undefined, 42, {}, [], '<<<>>>', 'https://a/b/../c']) {
      assert.doesNotThrow(() => extractCanonicalUrlValue(input));
    }
  });
});

/**
 * Robots meta (noindex_key_pages / noindex_tags) — added alongside the WordPress
 * Apply-fix expansion to Rank Math's robots field. normalizeRobotsValue is the
 * STRICT parser for a Recommendation's recommendedVersion (closed allowlist of
 * exactly 4 strings — never a free-form robots-directive parser, since that
 * would let an issue type smuggle an unsupported directive like "noarchive"
 * through as if it were safe); parseRobotsDirectives is the LENIENT parser for
 * reading back a real value (the Bridge's own wire string, or the crawler's
 * rendered <meta> content) — deliberately never rejects, since every string a
 * live WordPress site could plausibly render has a well-defined reading.
 */
describe('normalizeRobotsValue() — strict recommendedVersion parser', () => {
  test('accepts exactly the 4 allowed directive strings', () => {
    assert.deepEqual(normalizeRobotsValue('index, follow'), { index: true, follow: true });
    assert.deepEqual(normalizeRobotsValue('noindex, follow'), { index: false, follow: true });
    assert.deepEqual(normalizeRobotsValue('index, nofollow'), { index: true, follow: false });
    assert.deepEqual(normalizeRobotsValue('noindex, nofollow'), { index: false, follow: false });
  });

  test('is case-insensitive and tolerates extra internal whitespace', () => {
    assert.deepEqual(normalizeRobotsValue('  INDEX,   Follow  '), { index: true, follow: true });
    assert.deepEqual(normalizeRobotsValue('NoIndex,Follow'.replace(',', ', ')), { index: false, follow: true });
  });

  test('rejects a bare directive without its pair — no partial/implicit form is accepted', () => {
    assert.equal(normalizeRobotsValue('noindex'), null);
    assert.equal(normalizeRobotsValue('follow'), null);
  });

  test('rejects an unsupported/unknown directive — never smuggled through as if it were safe', () => {
    assert.equal(normalizeRobotsValue('noarchive, follow'), null);
    assert.equal(normalizeRobotsValue('index, follow, noarchive'), null);
  });

  test('rejects HTML markup, free-form prose, and non-string input', () => {
    assert.equal(normalizeRobotsValue('<meta name="robots" content="index, follow">'), null);
    assert.equal(normalizeRobotsValue('Set the page to index and follow'), null);
    assert.equal(normalizeRobotsValue(null), null);
    assert.equal(normalizeRobotsValue(undefined), null);
    assert.equal(normalizeRobotsValue(42), null);
  });

  test('rejects empty/whitespace-only input', () => {
    assert.equal(normalizeRobotsValue(''), null);
    assert.equal(normalizeRobotsValue('   '), null);
  });
});

describe('parseRobotsDirectives() — lenient reader for a live/rendered value', () => {
  test('a raw rendered <meta> content string with both directives absent means index, follow', () => {
    assert.deepEqual(parseRobotsDirectives(''), { index: true, follow: true });
    assert.deepEqual(parseRobotsDirectives('max-snippet:-1, max-image-preview:large'), { index: true, follow: true });
  });

  test('detects noindex/nofollow regardless of surrounding tokens or casing', () => {
    assert.deepEqual(parseRobotsDirectives('noindex'), { index: false, follow: true });
    assert.deepEqual(parseRobotsDirectives('NOFOLLOW'), { index: true, follow: false });
    assert.deepEqual(parseRobotsDirectives('noindex, nofollow'), { index: false, follow: false });
    assert.deepEqual(parseRobotsDirectives('index, follow'), { index: true, follow: true });
  });

  test('a real production-shaped value (the exact reported bug\'s live page): "nofollow, noindex"', () => {
    assert.deepEqual(parseRobotsDirectives('nofollow, noindex'), { index: false, follow: false });
  });

  test('never rejects — always returns a well-defined {index, follow} for any string, including garbage', () => {
    for (const input of ['', 'garbage', '<<<>>>', 'noindexnofollow']) {
      const result = parseRobotsDirectives(input);
      assert.equal(typeof result.index, 'boolean');
      assert.equal(typeof result.follow, 'boolean');
    }
    // "noindexnofollow" (no separator) still matches both \bnoindex\b and
    // \bnofollow\b word boundaries only if they appear as whole tokens —
    // glued together with no delimiter, neither word-boundary regex matches
    // a substring in the middle, so this reads as the permissive default.
    assert.deepEqual(parseRobotsDirectives('noindexnofollow'), { index: true, follow: true });
  });

  test('returns null only for non-string input — never guesses at a default for "nothing to read"', () => {
    assert.equal(parseRobotsDirectives(null), null);
    assert.equal(parseRobotsDirectives(undefined), null);
    assert.equal(parseRobotsDirectives(42), null);
  });
});

describe('robotsValueToWireString() — the Bridge wire format', () => {
  test('no restriction serializes to an empty string', () => {
    assert.equal(robotsValueToWireString({ index: true, follow: true }), '');
  });

  test('lists only the restrictive directives present, alphabetically sorted ("nofollow" sorts before "noindex")', () => {
    assert.equal(robotsValueToWireString({ index: false, follow: true }), 'noindex');
    assert.equal(robotsValueToWireString({ index: true, follow: false }), 'nofollow');
    assert.equal(robotsValueToWireString({ index: false, follow: false }), 'nofollow, noindex');
  });

  test('never includes the standalone words "index"/"follow" (only "noindex"/"nofollow", which don\'t word-boundary-match them)', () => {
    const wire = robotsValueToWireString({ index: false, follow: false });
    assert.equal(wire, 'nofollow, noindex');
    assert.doesNotMatch(wire, /\bindex\b/);
    assert.doesNotMatch(wire, /\bfollow\b/);
  });

  test('handles missing/malformed input without throwing', () => {
    assert.doesNotThrow(() => robotsValueToWireString(undefined));
    assert.doesNotThrow(() => robotsValueToWireString({}));
    assert.equal(robotsValueToWireString({}), ''); // undefined !== false on either axis -> treated as not-restricted
  });
});

describe('robotsValuesMatch()', () => {
  test('matches when both axes agree', () => {
    assert.equal(robotsValuesMatch({ index: true, follow: true }, { index: true, follow: true }), true);
    assert.equal(robotsValuesMatch({ index: false, follow: false }, { index: false, follow: false }), true);
  });

  test('a genuine mismatch on either axis is not a match', () => {
    assert.equal(robotsValuesMatch({ index: true, follow: true }, { index: false, follow: true }), false);
    assert.equal(robotsValuesMatch({ index: true, follow: true }, { index: true, follow: false }), false);
  });

  test('null/non-object on either side never matches anything, including another null', () => {
    assert.equal(robotsValuesMatch(null, null), false);
    assert.equal(robotsValuesMatch(null, { index: true, follow: true }), false);
    assert.equal(robotsValuesMatch({ index: true, follow: true }, undefined), false);
  });
});

describe('robots round-trip integration: normalize -> wire -> parse stays consistent', () => {
  test('every one of the 4 allowed recommendedVersion strings survives a full write/read cycle unchanged', () => {
    for (const text of ['index, follow', 'noindex, follow', 'index, nofollow', 'noindex, nofollow']) {
      const normalized = normalizeRobotsValue(text);
      const wire = robotsValueToWireString(normalized);
      const readBack = parseRobotsDirectives(wire);
      assert.deepEqual(readBack, normalized, `round-trip failed for "${text}"`);
    }
  });
});

/**
 * Organization/site schema (organization_schema, sameas_array,
 * breadcrumblist_schema issues) — added alongside the site-level Rank Math
 * Knowledge Graph/breadcrumbs Bridge capability. normalizeSchemaTextValue is
 * currently unused by any wired issue (organization_schema's individual
 * fields aren't automated yet — see providerCapabilityRegistry.js's
 * ORGANIZATION_UNSUPPORTED_REASON) but is tested here so its behavior is
 * pinned down for when that capability is built.
 */
describe('normalizeSchemaTextValue()', () => {
  test('accepts non-empty plain text, trimmed', () => {
    assert.equal(normalizeSchemaTextValue('  Naxonify Inc.  '), 'Naxonify Inc.');
  });

  test('rejects HTML markup, empty, and non-string input', () => {
    assert.equal(normalizeSchemaTextValue('<b>Naxonify</b>'), null);
    assert.equal(normalizeSchemaTextValue(''), null);
    assert.equal(normalizeSchemaTextValue('   '), null);
    assert.equal(normalizeSchemaTextValue(null), null);
    assert.equal(normalizeSchemaTextValue(undefined), null);
    assert.equal(normalizeSchemaTextValue(42), null);
  });
});

describe('normalizeSchemaUrlValue() — used for sameas_array and Organization url/logo', () => {
  test('accepts a clean absolute http(s) URL', () => {
    assert.equal(normalizeSchemaUrlValue('https://linkedin.com/company/naxonify'), 'https://linkedin.com/company/naxonify');
    assert.equal(normalizeSchemaUrlValue('  http://example.com/x  '), 'http://example.com/x');
  });

  test('rejects a relative URL — never guesses a domain to complete it with', () => {
    assert.equal(normalizeSchemaUrlValue('/company/naxonify'), null);
  });

  test('rejects a non-http(s) scheme (javascript:, data:, mailto:)', () => {
    assert.equal(normalizeSchemaUrlValue('javascript:alert(1)'), null);
    assert.equal(normalizeSchemaUrlValue('data:text/html,<script>alert(1)</script>'), null);
    assert.equal(normalizeSchemaUrlValue('mailto:someone@example.com'), null);
  });

  test('rejects HTML markup, even if it contains what looks like a valid URL', () => {
    assert.equal(normalizeSchemaUrlValue('<a href="https://linkedin.com/company/naxonify">link</a>'), null);
  });

  test('rejects empty, whitespace-only, and non-string input', () => {
    assert.equal(normalizeSchemaUrlValue(''), null);
    assert.equal(normalizeSchemaUrlValue('   '), null);
    assert.equal(normalizeSchemaUrlValue(null), null);
    assert.equal(normalizeSchemaUrlValue(undefined), null);
  });

  test('never throws for any input', () => {
    for (const input of [null, undefined, 42, {}, [], '<<<>>>']) {
      assert.doesNotThrow(() => normalizeSchemaUrlValue(input));
    }
  });
});

describe('normalizeBreadcrumbEnableValue() — closed allowlist for breadcrumblist_schema', () => {
  test('accepts exactly the literal "enabled" string, case-insensitive, trimmed', () => {
    assert.equal(normalizeBreadcrumbEnableValue('enabled'), true);
    assert.equal(normalizeBreadcrumbEnableValue('  ENABLED  '), true);
    assert.equal(normalizeBreadcrumbEnableValue('Enabled'), true);
  });

  test('rejects any other value — no boolean-ish guessing ("true", "1", "yes")', () => {
    for (const bad of ['true', '1', 'yes', 'on', 'disabled', 'Enable breadcrumbs']) {
      assert.equal(normalizeBreadcrumbEnableValue(bad), null, `expected null for "${bad}"`);
    }
  });

  test('rejects empty, whitespace-only, and non-string input', () => {
    assert.equal(normalizeBreadcrumbEnableValue(''), null);
    assert.equal(normalizeBreadcrumbEnableValue('   '), null);
    assert.equal(normalizeBreadcrumbEnableValue(null), null);
    assert.equal(normalizeBreadcrumbEnableValue(undefined), null);
  });
});
