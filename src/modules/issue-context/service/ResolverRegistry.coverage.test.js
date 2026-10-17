import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { getRegistryEntry, isKnownIssue } from './ResolverRegistry.js';
import { resolveGroup } from '../../recommendations/prompts/GroupRegistry.js';

/**
 * The analyzer (Python rules) and the issue-context registry are two hand-maintained lists
 * of issue ids. When they drift, an issue that HAS been detected renders as "Not detected /
 * Unknown issue type / issueId not in registry" and cannot get a recommendation. That is
 * exactly what happened to `form_labels` (registered as `form_inputs_labels`).
 *
 * This reads the rule ids straight out of the Python rule files, so a new rule with no
 * registry entry fails here instead of in production.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RULES_DIR = path.resolve(__dirname, '../../../../../python_workers/scraper/workers/seo/page_analysis/rules/categories');

const emittedRuleIds = () => {
  const ids = new Set();
  for (const file of fs.readdirSync(RULES_DIR)) {
    if (!file.endsWith('.py') || file.startsWith('test_')) continue;
    const text = fs.readFileSync(path.join(RULES_DIR, file), 'utf8');
    for (const m of text.matchAll(/^\s+rule_id\s*=\s*"([^"]+)"/gm)) ids.add(m[1]);
  }
  return ids;
};

/**
 * Known gaps, NOT endorsed: rules that are emitted but still have no resolver. Each needs its
 * own resolver + data mapping (they read content/link/crawlability data, not accessibility
 * data). Until then they show the stored finding instead of "Not detected" (see
 * IssueContextEngine._unknownContext). This list may only shrink.
 */
const KNOWN_UNREGISTERED = new Set([
  'about_page',
  'anchor_text_diversity',
  'anchor_text_optimization',
  'firsthand_experience',
  'image_alt_text_quality',
  'noindex_on_admin_pages',
  'privacy_terms_pages',
]);

describe('every emitted rule id has an issue-context resolver', () => {
  const emitted = emittedRuleIds();

  test('the rule files were found and parsed', () => {
    assert.ok(emitted.size > 60, `only found ${emitted.size} rule ids`);
    assert.ok(emitted.has('form_labels'));
  });

  test('no NEW rule is emitted without a registry entry', () => {
    const missing = [...emitted].filter((id) => !isKnownIssue(id) && !KNOWN_UNREGISTERED.has(id));
    assert.deepEqual(missing, [], `rule ids with no ResolverRegistry entry: ${missing.join(', ')}`);
  });

  test('the known-gap list only shrinks: nothing in it has been registered since', () => {
    const stale = [...KNOWN_UNREGISTERED].filter((id) => isKnownIssue(id) || !emitted.has(id));
    assert.deepEqual(stale, [], `remove from KNOWN_UNREGISTERED: ${stale.join(', ')}`);
  });
});

describe('every Accessibility rule resolves end to end', () => {
  const ACCESSIBILITY_RULES = ['form_labels', 'keyboard_accessibility', 'focus_indicators', 'page_language', 'video_captions', 'tap_target_size'];

  for (const id of ACCESSIBILITY_RULES) {
    test(`${id}: registered with the accessibility resolver`, () => {
      assert.equal(isKnownIssue(id), true);
      assert.equal(getRegistryEntry(id).issueType, 'on_page');
    });
  }

  test('form_labels is registered, and the old name is kept as an alias', () => {
    assert.equal(getRegistryEntry('form_labels').resolver, getRegistryEntry('form_inputs_labels').resolver);
    assert.equal(getRegistryEntry('form_labels').displayType, 'table');
  });

  test('form_labels is in the accessibility prompt group (not the technical-SEO default)', () => {
    assert.equal(resolveGroup('form_labels'), resolveGroup('keyboard_accessibility'));
    assert.equal(resolveGroup('form_labels'), resolveGroup('form_inputs_labels'));
  });
});

describe('a registry entry must have a live rule behind it (logo_url_returns_200 was registered but emitted by nothing)', () => {
  test('logo_url_returns_200 is emitted by a real python rule and registered as an on-page issue', () => {
    assert.ok(emittedRuleIds().has('logo_url_returns_200'), 'no python rule emits logo_url_returns_200');
    assert.equal(isKnownIssue('logo_url_returns_200'), true);
    const entry = getRegistryEntry('logo_url_returns_200');
    assert.equal(entry.issueType, 'on_page');
    assert.deepEqual(entry.dataSources, ['page_data']);
  });

  test('that rule is registered with the engine that actually runs (not just defined in a file)', () => {
    const file = fs.readFileSync(path.join(RULES_DIR, 'schema_rules.py'), 'utf8');
    assert.match(file, /registry\.register\(LogoUrlReturns200Rule\(\)\)/);
  });
});
