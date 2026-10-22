/**
 * Recommendation Engine Constants
 * 
 * Central definitions for the AI recommendation system.
 * Controls types, categories, severity mappings, and section structure.
 */

export const RECOMMENDATION_VERSION = 1;

// Implementation example types — drives frontend code rendering
export const IMPLEMENTATION_TYPES = {
  HTML: 'html',
  JSX: 'jsx',
  JSON: 'json',
  TEXT: 'text',
};

// Generation source tracking
export const GENERATION_SOURCE = {
  TEMPLATE: 'template',
  CLAUDE: 'claude',
  HYBRID: 'hybrid', // template base + Claude enhancement
  FALLBACK: 'fallback', // generic fallback when Claude unavailable
};

// Difficulty levels
export const DIFFICULTY = {
  EASY: 'easy',
  MEDIUM: 'medium',
  HARD: 'hard',
};

// Issue sources (which MongoDB collection the issue comes from)
export const ISSUE_SOURCE = {
  AI_VISIBILITY: 'ai_visibility',   // seo_ai_visibility_issues (rule_id)
  ON_PAGE: 'on_page',               // seo_page_issues (issue_code)
};

// AI Visibility issue categories (maps to Python rule categories)
export const ISSUE_CATEGORIES = {
  AI_IMPACT: 'ai_impact',
  CITATION_PROBABILITY: 'citation_probability',
  LLM_READINESS: 'llm_readiness',
  AEO_SCORE: 'aeo_score',
  TOPICAL_AUTHORITY: 'topical_authority',
  VOICE_INTENT: 'voice_intent',
};

// On-page SEO issue categories (maps to page_analysis.py categories)
export const ONPAGE_CATEGORIES = {
  META: 'Meta',
  CONTENT: 'Content',
  HEADINGS: 'Headings',
  IMAGES: 'Images',
  LINKS: 'Links',
  SCHEMA: 'Schema',
  PERFORMANCE: 'Performance',
  SECURITY: 'Security',
};

// Page types (from Python scoring engine detection)
export const PAGE_TYPES = {
  HOMEPAGE: 'Homepage',
  ARTICLE: 'Article',
  SERVICE: 'Service',
  PRODUCT: 'Product',
  LISTING: 'Listing',
  UNKNOWN: 'Unknown',
};

// Framework types for implementation targeting
export const FRAMEWORKS = {
  WORDPRESS: 'wordpress',
  NEXTJS: 'nextjs',
  REACT: 'react',
  SHOPIFY: 'shopify',
  CUSTOM: 'custom',
  UNKNOWN: 'unknown',
};

// Recommendation section keys — defines the 7 rendered sections
export const SECTION_KEYS = [
  'whyThisMatters',
  'recommendedFix',
  'implementationExample',
  'expectedImpact',
  'estimatedRecovery',
  'difficulty',
  'estimatedFixTime',
];

// Recovery metric keys (structured scoring)
export const RECOVERY_METRICS = {
  AI_VISIBILITY: 'aiVisibility',
  SEMANTIC_TRUST: 'semanticTrust',
  FRESHNESS: 'freshness',
  ACCESSIBILITY: 'accessibility',
};

// Invalidation reasons
export const INVALIDATION_REASONS = {
  RULE_VERSION_CHANGE: 'rule_version_change',
  TEMPLATE_UPDATE: 'template_update',
  SCORING_LOGIC_CHANGE: 'scoring_logic_change',
  MANUAL: 'manual',
  TTL_EXPIRED: 'ttl_expired',
};

// Max content lengths (enforced by normalizer)
export const CONTENT_LIMITS = {
  WHY_THIS_MATTERS: 500,
  RECOMMENDED_FIX: 800,
  IMPLEMENTATION_EXAMPLE: 2000,
  EXPECTED_IMPACT_ITEM: 200,
  EXPECTED_IMPACT_MAX_ITEMS: 6,
  ESTIMATED_FIX_TIME: 50,
  // The actual rewritten page content for content_rewrite recommendations
  // (recommendedVersion, contentRewrite.after/optimized, afterState.rawText)
  // — distinct from IMPLEMENTATION_EXAMPLE (a code/HTML snippet demo, which
  // is legitimately short). A full paragraph rewrite easily runs
  // 1500-4000+ characters; this must not be capped anywhere near that.
  FULL_CONTENT: 8000,
};
