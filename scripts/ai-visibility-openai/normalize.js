/**
 * Pure helpers for the OpenAI AI-visibility research test: parse the model's JSON, normalise and validate the company list, and label
 * every evidence URL by how it is actually supported. No network, no SDK - unit-tested with mocked responses.
 */

export const MAX_RESULTS = 10;
const CONFIDENCE = new Set(['high', 'medium', 'low']);
const LEGAL_SUFFIX = /\b(private|pvt|limited|ltd|llp|inc|incorporated|co|company|corp|corporation|opc)\b\.?/g;

/** "ABC Technologies Pvt. Ltd." and "abc technologies" are the same company. */
export function normalizeCompanyName(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(LEGAL_SUFFIX, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A usable http(s) URL, or null. */
export function cleanUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const u = new URL(value.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username || u.password || !u.hostname.includes('.')) return null;
    u.hash = '';
    for (const k of [...u.searchParams.keys()]) if (/^utm_/i.test(k)) u.searchParams.delete(k);
    return u.toString();
  } catch {
    return null;
  }
}

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; } };

/** Parse the model's output text as JSON; tolerates a fenced block. Throws a coded error when it is not JSON. */
export function parseModelJson(text) {
  if (typeof text !== 'string' || !text.trim()) throw Object.assign(new Error('The model returned no text'), { code: 'EMPTY_OUTPUT' });
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('The model did not return valid JSON'), { code: 'MALFORMED_JSON' });
  }
}

/**
 * Label each evidence URL by what actually supports it:
 *   cited        the URL (same page) appears in the response's url_citation annotations
 *   found        it appeared in the web-search sources but the answer did not cite it
 *   fetched      the script retrieved the page itself (only when --verify-urls was used and it loaded)
 *   model_only   none of the above: the model listed it, nothing in the API metadata backs it
 */
export function classifyEvidenceUrl(url, { cited = new Set(), sources = new Set(), fetched = new Map() } = {}) {
  const labels = [];
  if (cited.has(url)) labels.push('cited');
  if (sources.has(url) && !cited.has(url)) labels.push('found');
  const f = fetched.get(url);
  if (f?.ok) labels.push('fetched');
  if (!labels.length) labels.push('model_only');
  return { url, labels, fetchStatus: f ? f.status : null, mentionsNashik: f ? f.mentionsNashik : null };
}

/**
 * Validate and normalise the model's results. Duplicates (including "Pvt Ltd" variants) are removed, results are capped at 10 and
 * re-ranked 1..n, bad URLs are dropped, and the two "verified" flags are only kept true when there is at least one evidence URL that is
 * not model_only (a model saying "verified" is not evidence).
 * @returns {{ results: object[], issues: string[] }}
 */
export function normalizeResults(parsed, evidenceCtx = {}) {
  const issues = [];
  const list = Array.isArray(parsed?.results) ? parsed.results : [];
  if (!Array.isArray(parsed?.results)) issues.push('RESULTS_NOT_A_LIST');
  const seen = new Set();
  const out = [];
  const sorted = [...list].sort((a, b) => (Number(a?.rank) || 99) - (Number(b?.rank) || 99));
  for (const r of sorted) {
    const name = typeof r?.company_name === 'string' ? r.company_name.trim() : '';
    if (!name) { issues.push('MISSING_COMPANY_NAME'); continue; }
    const key = normalizeCompanyName(name);
    const site = cleanUrl(r.website_url);
    const siteKey = site ? hostOf(site) : null;
    if (seen.has(key) || (siteKey && seen.has(`host:${siteKey}`))) { issues.push(`DUPLICATE_COMPANY:${name}`); continue; }
    seen.add(key);
    if (siteKey) seen.add(`host:${siteKey}`);
    if (r.website_url && !site) issues.push(`INVALID_WEBSITE_URL:${name}`);

    const evidence = [...new Set([...(Array.isArray(r.evidence_urls) ? r.evidence_urls : []), ...(site ? [site] : [])].map(cleanUrl).filter(Boolean))]
      .map((u) => classifyEvidenceUrl(u, evidenceCtx));
    const backed = evidence.some((e) => !e.labels.includes('model_only'));
    const nashikVerified = Boolean(r.nashik_presence_verified) && backed;
    const aiVerified = Boolean(r.ai_automation_verified) && backed;
    if ((r.nashik_presence_verified || r.ai_automation_verified) && !backed) issues.push(`VERIFICATION_WITHOUT_EVIDENCE:${name}`);

    let confidence = CONFIDENCE.has(r.confidence) ? r.confidence : 'low';
    if (!backed && confidence !== 'low') confidence = 'low';

    out.push({
      rank: out.length + 1,
      company_name: name,
      website_url: site,
      location: typeof r.location === 'string' && r.location.trim() ? r.location.trim() : null,
      ai_automation_services: Array.isArray(r.ai_automation_services) ? r.ai_automation_services.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()) : [],
      evidence_summary: typeof r.evidence_summary === 'string' ? r.evidence_summary.trim() : '',
      evidence_urls: evidence,
      website_cited: Boolean(site && evidenceCtx.cited?.has(site)),
      nashik_presence_verified: nashikVerified,
      ai_automation_verified: aiVerified,
      confidence,
      ranking_reason: typeof r.ranking_reason === 'string' ? r.ranking_reason.trim() : '',
    });
    if (out.length >= MAX_RESULTS) break;
  }
  if (list.length > MAX_RESULTS) issues.push(`TRUNCATED_TO_${MAX_RESULTS}`);
  if (out.length < MAX_RESULTS) issues.push(`FEWER_THAN_${MAX_RESULTS}_QUALIFIED_RESULTS:${out.length}`);
  return { results: out, issues };
}

/** Pull answer text, url citations and search sources out of a Responses API response object. */
export function extractResponseParts(response) {
  const texts = [];
  const citations = [];
  const sources = [];
  let searchCalls = 0;
  let searchFailed = false;
  for (const item of response?.output || []) {
    if (item?.type === 'web_search_call') {
      searchCalls += 1;
      if (item.status && item.status !== 'completed') searchFailed = true;
      for (const s of item.action?.sources || []) if (s?.url) sources.push({ url: s.url, title: s.title || null });
    }
    if (item?.type === 'message') {
      for (const c of item.content || []) {
        if (typeof c?.text === 'string') texts.push(c.text);
        for (const a of c.annotations || []) {
          if (a?.type === 'url_citation' && a.url) citations.push({ url: a.url, title: a.title || null, start_index: a.start_index ?? null, end_index: a.end_index ?? null });
        }
      }
    }
  }
  return { text: response?.output_text || texts.join('\n'), citations, sources, searchCalls, searchFailed };
}

export default { normalizeCompanyName, cleanUrl, parseModelJson, classifyEvidenceUrl, normalizeResults, extractResponseParts, MAX_RESULTS };
