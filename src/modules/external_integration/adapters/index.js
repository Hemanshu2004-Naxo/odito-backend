import WordPressCoreAdapter from './wordpressCoreAdapter.js';
import AioseoAdapter from './aioseoAdapter.js';
import SeopressAdapter from './seopressAdapter.js';
import RankMathAdapter from './rankMathAdapter.js';
import YoastAdapter from './yoastAdapter.js';

/**
 * Provider -> adapter map, keyed by WordPressConnection.detected_seo_provider.
 *
 * 'multiple' has no entry on purpose — see getAdapterForConnection() below,
 * which returns { adapter: null, ambiguous: true } for it instead of ever
 * silently picking one of the matched providers. 'none' maps to the core
 * adapter, which is also the correct fallback for any provider value this
 * map doesn't recognize (e.g. a future enum value added to the schema
 * before this map is updated to match).
 */
const ADAPTER_BY_PROVIDER = {
  none: WordPressCoreAdapter,
  aioseo: AioseoAdapter,
  seopress: SeopressAdapter,
  rank_math: RankMathAdapter,
  yoast: YoastAdapter,
};

/** Human-readable labels for the frontend — kept out of the adapters themselves. */
export const PROVIDER_LABELS = {
  none: 'WordPress Core',
  aioseo: 'AIOSEO',
  seopress: 'SEOPress',
  rank_math: 'Rank Math',
  yoast: 'Yoast SEO',
  multiple: 'Multiple SEO plugins detected',
};

/**
 * Resolves the one adapter to use for a connection's detected SEO provider.
 *
 * @param {import('../model/WordPressConnection.js').default} connection
 * @returns {{ adapter: import('./seoProviderAdapter.js').SeoProviderAdapter|null, ambiguous: boolean }}
 *   `ambiguous: true` (adapter: null) means detected_seo_provider is
 *   'multiple' — callers MUST surface this to the user and refuse to guess,
 *   per the locked architecture ("never silently choose one provider when
 *   multiple SEO plugins are active").
 */
export function getAdapterForConnection(connection) {
  const provider = connection.detected_seo_provider || 'none';
  if (provider === 'multiple') {
    return { adapter: null, ambiguous: true };
  }
  const AdapterClass = ADAPTER_BY_PROVIDER[provider] || WordPressCoreAdapter;
  return { adapter: new AdapterClass(connection), ambiguous: false };
}

export default { getAdapterForConnection, PROVIDER_LABELS };
