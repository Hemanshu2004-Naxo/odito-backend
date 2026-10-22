/**
 * V2IssueResolver
 *
 * Single resolver for ALL V2 ai_issues: AISO-*, AEO-*, GEO-*.
 *
 * Design principle: evidence-driven, zero per-rule case logic.
 * The ai_issues.evidence field is the authoritative detected-value source.
 * Adding a new V2 rule to the Python pipeline requires no change here.
 *
 * Evidence → currentState priority order (first match wins):
 *   1.  blocked: true              → text  (bot blocked)
 *   2.  explicit_allow: false      → absent (no explicit allow directive)
 *   3.  js_rendered_only: true     → text
 *   4.  js_rendered_only: null + reason → text
 *   5.  noindex: true              → text
 *   6.  found: false               → absent (file missing, e.g. llms.txt)
 *   7.  broken_urls array          → list
 *   8.  missing_fields array       → list
 *   9.  mismatches array           → list
 *   10. examples array             → list
 *   11. generic *_present: false   → absent
 *   12. nap_consistent: false      → text (with reason if present)
 *   13. reason string              → text
 *   14. count-key + threshold      → metric
 *   15. *_preview string           → text
 *   16. any non-empty array        → list
 *   17. fallback                   → absent
 */
export class V2IssueResolver {
  /**
   * @param {object|null} issueDoc  - Document from ai_issues
   * @param {string}      ruleId    - e.g. "AISO-A2"
   * @returns {{ currentState, expectedState }}
   */
  resolve(issueDoc, ruleId) {
    // No failing issue for this URL — rule passed on this page.
    if (!issueDoc) {
      return {
        currentState: {
          displayType: 'absent',
          rawValue: null,
          formattedValue: null,
          measurement: { value: null, unit: null, threshold: null },
          affectedItems: [],
          isAbsent: false,
          checkedFor: ruleId,
          passed: true,
        },
        expectedState: {
          description: 'This rule passed for the selected page — no issue detected.',
          measurement: {},
        },
      };
    }

    const evidence      = issueDoc.evidence      || {};
    const recommendation = issueDoc.recommendation || issueDoc.issue_description || '';

    return {
      currentState:  this._buildCurrentState(ruleId, evidence, issueDoc.issue_title),
      expectedState: { description: recommendation, measurement: {} },
    };
  }

  // ─── Evidence → currentState mapping ─────────────────────────────────────────

  _buildCurrentState(ruleId, evidence, issueTitle) {

    // ── 1. Bot blocked ────────────────────────────────────────────────────────
    if (evidence.blocked === true) {
      const agent = evidence.user_agent || ruleId;
      return this._textState(`${agent} is blocked from crawling this page`);
    }

    // ── 2. Explicit allow missing ─────────────────────────────────────────────
    if (evidence.explicit_allow === false) {
      const agent = evidence.user_agent || 'AI crawler';
      return this._absentState(`explicit ${agent} Allow directive in robots.txt`);
    }

    // ── 3. JS-only content ────────────────────────────────────────────────────
    if (evidence.js_rendered_only === true) {
      return this._textState('Content is only available after JavaScript execution — not visible to AI crawlers');
    }

    // ── 4. Headless not run (js_rendered_only is null) ────────────────────────
    if (evidence.js_rendered_only === null && typeof evidence.reason === 'string') {
      return this._textState(evidence.reason);
    }

    // ── 5. noindex directive ─────────────────────────────────────────────────
    if (evidence.noindex === true) {
      return this._textState('Page carries a noindex directive — excluded from AI and search indexing');
    }

    // ── 6. File / resource missing (llms.txt) ────────────────────────────────
    if (evidence.found === false) {
      return this._absentState('llms.txt file');
    }

    // ── 7. Broken URL list ────────────────────────────────────────────────────
    if (Array.isArray(evidence.broken_urls) && evidence.broken_urls.length > 0) {
      return this._listState(evidence.broken_urls.map(String));
    }

    // ── 8. Missing required schema fields (e.g. GEO-059 partial) ─────────────
    if (Array.isArray(evidence.missing_fields) && evidence.missing_fields.length > 0) {
      return this._listState(evidence.missing_fields.map(f => `Missing field: ${f}`));
    }

    // ── 9. FAQ mismatches (AEO-048) ───────────────────────────────────────────
    if (Array.isArray(evidence.mismatches) && evidence.mismatches.length > 0) {
      return this._listState(evidence.mismatches.map(String));
    }

    // ── 10. Example list (AEO-053 filler phrases) ────────────────────────────
    if (Array.isArray(evidence.examples) && evidence.examples.length > 0) {
      return this._listState(evidence.examples.map(String));
    }

    // ── 11. Generic *_present: false (author, org, canonical, geocoords, etc.) ──
    const presentKey = Object.keys(evidence).find(
      k => k.endsWith('_present') && evidence[k] === false
    );
    if (presentKey) {
      const label = presentKey.replace(/_present$/, '').replace(/_/g, ' ');
      return this._absentState(label);
    }

    // Same pattern but for *_exists: false (sitemap)
    const existsKey = Object.keys(evidence).find(
      k => k.endsWith('_exists') && evidence[k] === false
    );
    if (existsKey) {
      const label = existsKey.replace(/_exists$/, '').replace(/_/g, ' ');
      return this._absentState(label);
    }

    // ── 12. NAP inconsistency ─────────────────────────────────────────────────
    if (evidence.nap_consistent === false) {
      const reason = evidence.reason || 'NAP (name, address, phone) mismatch between schema and visible page text';
      return this._textState(reason);
    }

    // ── 13. Reason string (generic fallback for rule authors) ─────────────────
    if (typeof evidence.reason === 'string' && evidence.reason.length > 0) {
      return this._textState(evidence.reason);
    }

    // ── 14. Count + threshold → metric ────────────────────────────────────────
    //   Matches: word_count, intro_word_count, filler_count, internal_link_count, entry_count
    const countKey = Object.keys(evidence).find(
      k => typeof evidence[k] === 'number' &&
           (k.endsWith('_count') || k.endsWith('_words')) &&
           'threshold' in evidence
    );
    if (countKey) {
      const unitLabel = countKey
        .replace(/_count$/, '')
        .replace(/_words$/, ' words')
        .replace(/_/g, ' ')
        .trim();
      return this._metricState(evidence[countKey], unitLabel, evidence.threshold, issueTitle);
    }

    // ── 15. Preview string (first_60_words_preview, intro_preview) ───────────
    const previewKey = Object.keys(evidence).find(
      k => k.endsWith('_preview') && typeof evidence[k] === 'string' && evidence[k].length > 0
    );
    if (previewKey) {
      return this._textState(evidence[previewKey]);
    }

    // ── 16. Any remaining non-empty array ─────────────────────────────────────
    const arrayKey = Object.keys(evidence).find(
      k => Array.isArray(evidence[k]) && evidence[k].length > 0
    );
    if (arrayKey) {
      const items = evidence[arrayKey].map(i => (typeof i === 'string' ? i : JSON.stringify(i)));
      return this._listState(items);
    }

    // ── 17. Fallback — nothing useful in evidence ──────────────────────────────
    return this._absentState(issueTitle || ruleId);
  }

  // ─── State shape builders (mirrors BaseResolver helpers exactly) ──────────────

  _absentState(checkedFor) {
    return {
      displayType:    'absent',
      rawValue:       null,
      formattedValue: null,
      measurement:    { value: null, unit: null, threshold: null },
      affectedItems:  [],
      isAbsent:       true,
      checkedFor,
    };
  }

  _textState(rawValue) {
    return {
      displayType:    'text',
      rawValue:       rawValue || null,
      formattedValue: rawValue || null,
      label:          null,
      measurement:    { value: null, unit: null, threshold: null, maxThreshold: null },
      affectedItems:  [],
      isAbsent:       !rawValue,
    };
  }

  _listState(items) {
    return {
      displayType:    'list',
      rawValue:       items,
      formattedValue: items,
      measurement:    { value: items.length, unit: 'items', threshold: null },
      affectedItems:  items,
      isAbsent:       items.length === 0,
    };
  }

  _metricState(rawValue, unit, threshold, label) {
    return {
      displayType:    'metric',
      rawValue,
      formattedValue: rawValue,
      measurement: {
        value:     typeof rawValue === 'number' ? rawValue : parseFloat(rawValue) || 0,
        unit:      unit      || null,
        threshold: threshold || null,
        label:     label     || null,
      },
      affectedItems:  [],
      isAbsent:       rawValue === null || rawValue === undefined,
    };
  }
}

export default new V2IssueResolver();
