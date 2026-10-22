/**
 * RecommendationContextSchema
 *
 * Central constants and shape definitions for the RecommendationContext contract.
 * Consumed by: RecommendationContextBuilder, DisplayTypeNormalizer, ObjectiveStrategyMap.
 *
 * VERSION HISTORY
 *   v1 — initial contract (Phase 2 context layer)
 */

export const CONTEXT_VERSION = 1;

// ── Prompt Modes ──────────────────────────────────────────────────────────────
// Drives which Claude prompt template gets selected in Phase 3.

export const PROMPT_MODE = {
  /** Improve existing text (meta, title, keyword). Before/after rendering expected. */
  CONTENT_REWRITE: 'content_rewrite',

  /** Add a missing element that currently does not exist on the page. */
  ELEMENT_ADD: 'element_add',

  /** Fix a structural problem (redirect chain, heading hierarchy, click depth). */
  STRUCTURAL_FIX: 'structural_fix',

  /** Reconcile two values that should match (canonical vs URL, OG table). */
  COMPARISON_FIX: 'comparison_fix',

  /** Fix or add items to a known list (broken links, internal links, orphan linkers). */
  LIST_FIX: 'list_fix',
};

// ── Objective Actions ─────────────────────────────────────────────────────────

export const OBJECTIVE_ACTION = {
  EXPAND:   'expand',
  SHORTEN:  'shorten',
  FIX:      'fix',
  ADD:      'add',
  REMOVE:   'remove',
  ALIGN:    'align',
  GENERATE: 'generate',
  IMPROVE:  'improve',
  REDUCE:   'reduce',
};

// ── Context Sections ──────────────────────────────────────────────────────────
// Tracks which optional sections were populated in a given RecommendationContext.

export const CONTEXT_SECTION = {
  CONTENT:          'contentContext',
  TECHNICAL:        'technicalContext',
  AI_VISIBILITY:    'aiVisibilityContext',
  MISSING_ELEMENT:  'missingElementContext',
};

// ── Display Type constants (mirrors ResolverRegistry DISPLAY_TYPE) ────────────

export const DISPLAY_TYPE = {
  TEXT:   'text',
  METRIC: 'metric',
  TABLE:  'table',
  LIST:   'list',
  CHAIN:  'chain',
  CODE:   'code',
  TREE:   'tree',
  ABSENT: 'absent',
};

// ── Max token-budget limits for context fields in prompts ─────────────────────

export const CONTEXT_LIMITS = {
  RAW_TEXT:         2000,   // rawText / meta / title content
  CONTENT_PREVIEW:   400,   // thin_content excerpt (word budget, not chars)
  TABLE_ROWS:         10,   // max rows sent to prompt
  LIST_ITEMS:         10,   // max list entries sent to prompt
  CHAIN_HOPS:          8,   // max chain hops
  CODE_SNIPPET:     1500,   // max code chars
  SUMMARY:           300,   // currentState.summary
};

// ── Cache configuration ───────────────────────────────────────────────────────

export const CACHE_CONFIG = {
  TTL_MS:       5 * 60 * 1000,   // 5 minutes — matches IssueContext staleTime
  MAX_ENTRIES:  500,              // max simultaneous cached contexts
};

/**
 * Empty/default RecommendationContext shell.
 * Used as the base that the builder fills in.
 * All fields present so consumers can safely destructure.
 */
export function emptyContext(issueId, pageUrl) {
  return {
    identity: {
      issueId: issueId || '',
      issueType: '',
      category: '',
      severity: '',
      displayType: '',
      pipeline: '',
    },
    currentState: {
      summary: '',
      rawText: null,
      measurement: {
        value: null,
        unit: null,
        threshold: null,
        maxThreshold: null,
        shortfall: null,
      },
      tableRows: null,
      listItems: null,
      chainHops: null,
      codeContent: null,
      label: null,
      isAbsent: false,
      checkedFor: null,
    },
    expectedState: {
      description: '',
      targetMin: null,
      targetMax: null,
      unit: null,
      targetRange: null,
    },
    pageContext: {
      pageUrl: pageUrl || '',
      pageType: 'Unknown',
      framework: 'unknown',
      cms: null,
      canonicalUrl: null,
    },
    contentContext:      null,
    technicalContext:    null,
    aiVisibilityContext: null,
    recommendationObjective: {
      action: OBJECTIVE_ACTION.FIX,
      target: '',
      constraint: '',
      preserveContext: '',
      successCriteria: '',
      promptMode: PROMPT_MODE.STRUCTURAL_FIX,
    },
    builderMeta: {
      version: CONTEXT_VERSION,
      builtAt: new Date().toISOString(),
      contextHash: '',
      issueContextReadiness: 0,
      hasRichContext: false,
      sectionsPopulated: [],
    },
  };
}
