import { normalizeUrl } from '../../shared/services/citationNormalizationService.js';
import { GoogleAioProviderError, GOOGLE_AIO_ERROR } from './providerErrors.js';

/**
 * Response validation, SERP normalization and AI Overview extraction for Google Organic SERP Live Advanced. Pure.
 *
 * Shape handled (docs.dataforseo.com/v3/serp/google/organic/live/advanced, checked 2026-10-28):
 *   tasks[0].result[0] { datetime, check_url, items_count, items[] }
 *   items[] is a mixed list (organic, people_also_ask, featured_snippet, ai_overview ...). The AI Overview is the item with
 *   type "ai_overview": { asynchronous_ai_overview, items[], references[] }.
 *   ai_overview.items[] elements: ai_overview_element {title,text,markdown,links[],references[]}, ai_overview_table_element
 *   {markdown,table,references[]}, ai_overview_expanded_element {title,text,components[],references[]}, ai_overview_video_element.
 *   ai_overview_reference {source, domain, url, title, text}.
 * The docs page describes the container under the name `knowledge_graph_ai_overview_item`; the top-level SERP item type is the plain
 * "ai_overview" (listed among the item types). Anything not recognised is skipped, never guessed.
 *
 * Three outcomes are kept apart on purpose:
 *   malformed response   -> throws MALFORMED_RESPONSE (a provider/transport problem, recorded as a failed question)
 *   no ai_overview item  -> { aiOverview: null }  (a VALID observation: Google showed no AI Overview)
 *   ai_overview present  -> { aiOverview: {...} } with whatever text and references could be extracted
 */

const MAX_TEXT = 20_000;
const MAX_REFERENCES = 100;
const str = (v, max = 500) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const finite = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const arr = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);

/** Provider timestamp "2026-10-28 10:15:30 +00:00" -> Date (null when it does not parse). */
export function parseProviderDatetime(value) {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?$/);
  if (!m) return null;
  const tz = !m[5] || m[5] === 'Z' ? 'Z' : (m[5].includes(':') ? m[5] : `${m[5].slice(0, 3)}:${m[5].slice(3)}`);
  const d = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}${tz}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** One provider reference/link -> a safe reference record, or null when it has no usable http(s) URL. */
function toReference(raw, kind) {
  const r = obj(raw);
  if (!r) return null;
  const url = str(r.url, 2000);
  if (!url) return null;
  const n = normalizeUrl(url);
  if (!n.ok) return { rejected: true };
  return {
    url: url.slice(0, 2000),
    normalizedUrl: n.url,
    host: n.host,
    title: str(r.title, 300),
    source: str(r.source, 200),
    domain: str(r.domain, 200),
    snippet: str(r.text ?? r.description, 500),
    kind,
  };
}

function* elementsOf(item) {
  for (const el of arr(item.items)) {
    const e = obj(el);
    if (!e) continue;
    yield e;
    // expanded elements carry their text in components
    for (const c of arr(e.components)) { const comp = obj(c); if (comp) yield { ...comp, type: comp.type || 'ai_overview_expanded_component' }; }
  }
}

/** The AI Overview carried by one `ai_overview` SERP item. */
export function extractAiOverview(item) {
  const texts = [];
  const markdowns = [];
  const elements = [];
  const seen = new Set();
  const references = [];
  let rejectedReferences = 0;

  const addRef = (raw, kind) => {
    const ref = toReference(raw, kind);
    if (!ref) return;
    if (ref.rejected) { rejectedReferences += 1; return; }
    if (seen.has(ref.normalizedUrl) || references.length >= MAX_REFERENCES) return;
    seen.add(ref.normalizedUrl);
    references.push(ref);
  };

  const top = str(item.text, MAX_TEXT);
  const topMd = str(item.markdown, MAX_TEXT);
  for (const el of elementsOf(item)) {
    const text = str(el.text, MAX_TEXT);
    const markdown = str(el.markdown, MAX_TEXT) ?? str(el.table?.markdown, MAX_TEXT);
    if (text) texts.push(text);
    if (markdown) markdowns.push(markdown);
    if (text || markdown || str(el.title)) {
      elements.push({ type: str(el.type, 60), title: str(el.title, 300), text, markdown });
    }
    for (const r of arr(el.references)) addRef(r, 'reference');
    for (const l of arr(el.links)) addRef(l, 'link');
  }
  for (const r of arr(item.references)) addRef(r, 'reference');

  const text = (top ? [top] : texts).join('\n\n').slice(0, MAX_TEXT);
  const markdown = (topMd ? [topMd] : markdowns).join('\n\n').slice(0, MAX_TEXT);
  return {
    asynchronous: typeof item.asynchronous_ai_overview === 'boolean' ? item.asynchronous_ai_overview : null,
    text: text || null,
    markdown: markdown || null,
    elements: elements.slice(0, 50),
    references,
    rejectedReferences,
    rankGroup: finite(item.rank_group),
    rankAbsolute: finite(item.rank_absolute),
    page: finite(item.page),
    position: str(item.position, 20),
    // Content = something a mention can be searched in. References are tracked separately.
    hasContent: Boolean(text || markdown),
  };
}

/**
 * Validate the envelope and normalize the SERP.
 * @returns {{requestId:string|null, cost:number|null, datetime:Date|null, checkUrl:string|null, itemsCount:number, itemTypes:Object<string,number>, aiOverview:object|null}}
 * @throws {GoogleAioProviderError} MALFORMED_RESPONSE when there is no task, no result object, or `items` is not a list/null
 */
export function parseGoogleAioResponse(data) {
  const task = obj(data?.tasks?.[0]);
  const result = Array.isArray(task?.result) ? obj(task.result[0]) : null;
  if (!task || !result) throw new GoogleAioProviderError(GOOGLE_AIO_ERROR.MALFORMED_RESPONSE);
  if (result.items != null && !Array.isArray(result.items)) throw new GoogleAioProviderError(GOOGLE_AIO_ERROR.MALFORMED_RESPONSE);

  const items = arr(result.items).filter((i) => obj(i));
  const itemTypes = {};
  for (const i of items) { const t = str(i.type, 60) || 'unknown'; itemTypes[t] = (itemTypes[t] || 0) + 1; }

  const aioItem = items.find((i) => i.type === 'ai_overview');
  return {
    requestId: typeof task.id === 'string' ? task.id : null,
    // Only the task cost: a missing cost stays null, never 0.
    cost: finite(task.cost),
    datetime: parseProviderDatetime(result.datetime),
    checkUrl: str(result.check_url, 1000),
    itemsCount: Number.isInteger(result.items_count) ? result.items_count : items.length,
    itemTypes,
    aiOverview: aioItem ? extractAiOverview(aioItem) : null,
  };
}

export default { parseGoogleAioResponse, extractAiOverview, parseProviderDatetime };
