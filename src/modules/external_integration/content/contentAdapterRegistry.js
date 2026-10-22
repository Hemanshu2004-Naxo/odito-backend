import { DiviAdapter } from './DiviAdapter.js';
import { ElementorAdapter, GenericHtmlAdapter, GutenbergAdapter } from './UnsupportedBuilderAdapters.js';

/**
 * Picks the content adapter for a page. Order matters: the most specific builder first, the
 * generic (always-declining) adapter last, so every page resolves to exactly one adapter and
 * an unrecognised page is declined rather than handled by guesswork.
 */
const ADAPTERS = [new DiviAdapter(), new ElementorAdapter(), new GutenbergAdapter(), new GenericHtmlAdapter()];

export function resolveContentAdapter(page) {
  return ADAPTERS.find((adapter) => adapter.canHandle(page)) || ADAPTERS[ADAPTERS.length - 1];
}

/** Builder id + label for a page (what the UI shows as "Page builder"). */
export function detectBuilder(page) {
  const adapter = resolveContentAdapter(page);
  return { name: adapter.name, label: adapter.label };
}

export const CONTENT_ADAPTERS = Object.freeze(ADAPTERS.map((a) => a.name));

export default { resolveContentAdapter, detectBuilder, CONTENT_ADAPTERS };
