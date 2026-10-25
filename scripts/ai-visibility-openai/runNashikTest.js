#!/usr/bin/env node
/**
 * OpenAI AI-visibility research test (standalone; does not start the Odito server and does not use DataForSEO).
 *
 *   node scripts/ai-visibility-openai/runNashikTest.js                 # one paid request
 *   node scripts/ai-visibility-openai/runNashikTest.js --verify-urls   # also fetch each evidence URL to check it loads
 *
 * Env: OPENAI_API_KEY (required), OPENAI_MODEL (default gpt-4.1-mini), OPENAI_TIMEOUT_MS (default 180000). Read from backend/.env.
 * See README.md in this folder.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import { cleanUrl, extractResponseParts, normalizeResults, parseModelJson, MAX_RESULTS } from './normalize.js';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, '../../.env') });

const QUERY = 'Which software companies in Nashik offer AI automation?';
const LOCATION = { city: 'Nashik', state: 'Maharashtra', country: 'India', countryCode: 'IN' };
const MODEL = (process.env.OPENAI_MODEL || 'gpt-4.1-mini').trim();
const TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS) || 180_000;
const OUT_DIR = path.resolve(here, '../../test-results/ai-visibility');

const fail = (msg, code = 1) => { console.error(`\nERROR: ${msg}`); process.exit(code); };

const INSTRUCTIONS = [
  'You are a careful local-business researcher. Use web search to research the question for a user in Nashik, Maharashtra, India.',
  'Find software companies that genuinely OPERATE in Nashik and explicitly ADVERTISE AI automation services: AI agents, workflow automation,',
  'custom AI applications, chatbots / conversational AI, CRM/ERP automation, RPA, or AI integration with existing software.',
  'Rules: never invent company names, websites, addresses, phone numbers, reviews or services. Prefer official company websites as evidence.',
  'Only mark nashik_presence_verified / ai_automation_verified true when a source you found supports it, and list those sources in evidence_urls.',
  `Return at most ${MAX_RESULTS} companies. If fewer qualify, return fewer and say so in limitations; never pad the list.`,
  'Rank by relevance to AI automation, strength of evidence, and verified Nashik presence. The ranking is a research-based recommendation,',
  'not an audited quality ranking. Respond ONLY with JSON matching the schema.',
].join(' ');

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['query', 'total_results', 'results', 'limitations'],
  properties: {
    query: { type: 'string' },
    total_results: { type: 'integer' },
    limitations: { type: 'array', items: { type: 'string' } },
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['rank', 'company_name', 'website_url', 'location', 'ai_automation_services', 'evidence_summary', 'evidence_urls', 'nashik_presence_verified', 'ai_automation_verified', 'confidence', 'ranking_reason'],
        properties: {
          rank: { type: 'integer' },
          company_name: { type: 'string' },
          website_url: { type: 'string' },
          location: { type: 'string' },
          ai_automation_services: { type: 'array', items: { type: 'string' } },
          evidence_summary: { type: 'string' },
          evidence_urls: { type: 'array', items: { type: 'string' } },
          nashik_presence_verified: { type: 'boolean' },
          ai_automation_verified: { type: 'boolean' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          ranking_reason: { type: 'string' },
        },
      },
    },
  },
};

function classifyApiError(e) {
  const s = e?.status;
  if (s === 401) return 'Invalid OPENAI_API_KEY (401).';
  if (s === 403) return 'The API key is not allowed to use this model or tool (403).';
  if (s === 404 || /model/i.test(e?.message || '') && s === 400) return `Model "${MODEL}" is not available for this key or does not support this request. Set OPENAI_MODEL.`;
  if (s === 429) return 'Rate limited or out of quota (429). Retry later or check billing.';
  if (s >= 500) return `OpenAI server error (${s}). Retry later.`;
  if (e?.name === 'APIConnectionTimeoutError' || /timed? ?out/i.test(e?.message || '')) return `The request timed out after ${TIMEOUT_MS} ms.`;
  if (e?.name === 'APIConnectionError') return 'Network error: could not reach the OpenAI API.';
  return `OpenAI request failed${s ? ` (${s})` : ''}: ${(e?.message || 'unknown error').slice(0, 300)}`;
}

async function verifyUrls(urls) {
  const fetched = new Map();
  await Promise.all(urls.map(async (url) => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15_000);
      const res = await fetch(url, { redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': 'Odito-research-test/1.0' } });
      clearTimeout(t);
      const body = res.ok ? (await res.text()).slice(0, 500_000) : '';
      fetched.set(url, { ok: res.ok, status: res.status, mentionsNashik: /nashik/i.test(body) });
    } catch {
      fetched.set(url, { ok: false, status: null, mentionsNashik: null });
    }
  }));
  return fetched;
}

const stamp = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };
const pad = (v, n) => { const s = String(v ?? ''); return s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n); };

async function main() {
  if (!process.env.OPENAI_API_KEY?.trim()) fail('OPENAI_API_KEY is not set. Add it to backend/.env or your shell environment.', 2);
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY.trim(), timeout: TIMEOUT_MS, maxRetries: 1 });

  try { await client.models.retrieve(MODEL); } catch (e) { fail(classifyApiError(e.status === 404 ? e : e), 3); }

  const request = {
    model: MODEL,
    instructions: INSTRUCTIONS,
    input: QUERY,
    tools: [{ type: 'web_search', user_location: { type: 'approximate', city: LOCATION.city, region: LOCATION.state, country: LOCATION.countryCode } }],
    include: ['web_search_call.action.sources'],
    text: { format: { type: 'json_schema', name: 'nashik_ai_automation_companies', strict: true, schema: SCHEMA } },
  };

  console.log(`Query: ${QUERY}\nModel: ${MODEL} | web search: on | location: ${LOCATION.city}, ${LOCATION.state}, ${LOCATION.country}\nRequesting…`);
  const started = Date.now();
  let response;
  try {
    response = await client.responses.create(request);
  } catch (e) {
    // Some accounts/models reject the extra "include"; retry once without it (sources are then unavailable, citations still are).
    if (e?.status === 400 && /include/i.test(e?.message || '')) {
      delete request.include;
      try { response = await client.responses.create(request); } catch (e2) { fail(classifyApiError(e2), 4); }
    } else fail(classifyApiError(e), 4);
  }
  const elapsedMs = Date.now() - started;

  const parts = extractResponseParts(response);
  if (!parts.searchCalls) console.warn('WARNING: the model did not run a web search; results are not research-backed.');
  if (parts.searchFailed) console.warn('WARNING: a web search call did not complete.');

  let parsed;
  try { parsed = parseModelJson(parts.text); } catch (e) { fail(`${e.message} (${e.code}). Raw output saved for inspection.`, 5); }

  const cited = new Set(parts.citations.map((c) => cleanUrl(c.url)).filter(Boolean));
  const sources = new Set(parts.sources.map((s) => cleanUrl(s.url)).filter(Boolean));
  let fetched = new Map();
  if (process.argv.includes('--verify-urls')) {
    const all = [...new Set((parsed.results || []).flatMap((r) => [r.website_url, ...(r.evidence_urls || [])]).map(cleanUrl).filter(Boolean))];
    console.log(`Verifying ${all.length} URLs…`);
    fetched = await verifyUrls(all);
  }
  const { results, issues } = normalizeResults(parsed, { cited, sources, fetched });
  if (!parts.citations.length) issues.push('NO_URL_CITATIONS_IN_RESPONSE');
  if (!parts.searchCalls) issues.push('NO_WEB_SEARCH_PERFORMED');

  const usage = response.usage || {};
  const normalized = {
    query: QUERY,
    location: { city: LOCATION.city, state: LOCATION.state, country: LOCATION.country },
    provider: 'openai',
    model: response.model || MODEL,
    search_enabled: true,
    total_results: results.length,
    results,
    limitations: [...(Array.isArray(parsed.limitations) ? parsed.limitations : []), 'Rankings are research-based recommendations, not an audited quality ranking.'],
    validation_issues: issues,
    response_citations: parts.citations,
    search_sources: parts.sources,
    metrics: {
      execution_ms: elapsedMs,
      request_id: response._request_id || null,
      response_id: response.id || null,
      input_tokens: usage.input_tokens ?? null,
      output_tokens: usage.output_tokens ?? null,
      web_search_calls: parts.searchCalls,
      estimated_cost: null, // not exposed by the API; not estimated here
    },
    created_at: new Date().toISOString(),
  };

  // ── console ──
  console.log(`\n${pad('Rank', 5)}| ${pad('Company', 34)}| ${pad('Website', 34)}| ${pad('Nashik', 7)}| ${pad('AI auto', 8)}| Confidence`);
  console.log('-'.repeat(110));
  for (const r of results) console.log(`${pad(r.rank, 5)}| ${pad(r.company_name, 34)}| ${pad(r.website_url || '—', 34)}| ${pad(r.nashik_presence_verified ? 'yes' : 'no', 7)}| ${pad(r.ai_automation_verified ? 'yes' : 'no', 8)}| ${r.confidence}`);
  const lines = [];
  for (const r of results) {
    lines.push(`\n#${r.rank} ${r.company_name}`, `  Website: ${r.website_url || '—'}${r.website_cited ? ' (cited in the answer)' : ''}`, `  Location: ${r.location || 'not verified'}`,
      `  AI automation services: ${r.ai_automation_services.join('; ') || '—'}`, `  Evidence: ${r.evidence_summary || '—'}`,
      ...r.evidence_urls.map((e) => `    - ${e.url} [${e.labels.join(', ')}]`), `  Ranking reason: ${r.ranking_reason || '—'}`);
  }
  const summary = [
    `\nTotal companies: ${results.length}${results.length < MAX_RESULTS ? ` (fewer than ${MAX_RESULTS} qualified)` : ''}`,
    `Nashik presence verified: ${results.filter((r) => r.nashik_presence_verified).length}`,
    `AI automation verified: ${results.filter((r) => r.ai_automation_verified).length}`,
    `Execution time: ${(elapsedMs / 1000).toFixed(1)} s | input tokens: ${usage.input_tokens ?? 'n/a'} | output tokens: ${usage.output_tokens ?? 'n/a'}`,
    `Request id: ${normalized.metrics.request_id || 'n/a'} | cost: not exposed by the API`,
    issues.length ? `Validation notes: ${issues.join(', ')}` : 'Validation notes: none',
  ];
  console.log([...lines, ...summary].join('\n'));

  // ── save (never overwrites; never contains the key) ──
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const base = path.join(OUT_DIR, `nashik-ai-automation-${stamp()}`);
  fs.writeFileSync(`${base}.json`, JSON.stringify(normalized, null, 2));
  fs.writeFileSync(`${base}.raw.json`, JSON.stringify(response, null, 2));
  fs.writeFileSync(`${base}.txt`, [`Query: ${QUERY}`, `Model: ${normalized.model}`, ...lines, ...summary].join('\n'));
  console.log(`\nSaved:\n  ${base}.json (normalized)\n  ${base}.raw.json (full API response)\n  ${base}.txt (summary)`);
}

main().catch((e) => fail(e?.message || String(e)));
