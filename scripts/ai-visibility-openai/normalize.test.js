import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCompanyName, cleanUrl, parseModelJson, normalizeResults, extractResponseParts, classifyEvidenceUrl } from './normalize.js';

// A mocked Responses API object (shape of output items: web_search_call + message with url_citation annotations). No API call is made.
const mockResponse = (results, { extra = [] } = {}) => ({
  id: 'resp_mock', model: 'gpt-4.1-mini', usage: { input_tokens: 100, output_tokens: 200 },
  output: [
    { type: 'web_search_call', status: 'completed', action: { sources: [{ url: 'https://acme.example/services', title: 'Acme services' }] } },
    { type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ query: 'q', total_results: results.length, results, limitations: [] }), annotations: [
      { type: 'url_citation', url: 'https://acme.example/?utm_source=openai', title: 'Acme', start_index: 0, end_index: 5 }, ...extra,
    ] }] },
  ],
});
const company = (o = {}) => ({ rank: 1, company_name: 'Acme Technologies Pvt. Ltd.', website_url: 'https://acme.example/', location: 'College Road, Nashik', ai_automation_services: ['AI chatbots'], evidence_summary: 'Lists AI services', evidence_urls: ['https://acme.example/services'], nashik_presence_verified: true, ai_automation_verified: true, confidence: 'high', ranking_reason: 'r', ...o });
const run = (results) => {
  const parts = extractResponseParts(mockResponse(results));
  const parsed = parseModelJson(parts.text);
  return normalizeResults(parsed, { cited: new Set(parts.citations.map((c) => cleanUrl(c.url))), sources: new Set(parts.sources.map((s) => cleanUrl(s.url))) });
};

test('parses the mocked response and extracts citations and search sources', () => {
  const parts = extractResponseParts(mockResponse([company()]));
  assert.equal(parts.searchCalls, 1);
  assert.equal(parts.citations[0].url, 'https://acme.example/?utm_source=openai');
  assert.equal(parts.sources[0].url, 'https://acme.example/services');
  assert.equal(parseModelJson(parts.text).results.length, 1);
});

test('malformed JSON is reported with a code, never guessed', () => {
  assert.throws(() => parseModelJson('not json at all'), (e) => e.code === 'MALFORMED_JSON');
  assert.throws(() => parseModelJson(''), (e) => e.code === 'EMPTY_OUTPUT');
  assert.equal(parseModelJson('```json\n{"results":[]}\n```').results.length, 0);
});

test('duplicates, including legal-suffix and same-website variants, are removed; ranks are sequential', () => {
  const { results, issues } = run([
    company(),
    company({ rank: 2, company_name: 'ACME TECHNOLOGIES' }),
    company({ rank: 3, company_name: 'Acme Tech Labs', website_url: 'https://www.acme.example/about' }),
    company({ rank: 4, company_name: 'Beta Soft', website_url: 'https://beta.example' }),
  ]);
  assert.deepEqual(results.map((r) => r.company_name), ['Acme Technologies Pvt. Ltd.', 'Beta Soft']);
  assert.deepEqual(results.map((r) => r.rank), [1, 2]);
  assert.ok(issues.filter((i) => i.startsWith('DUPLICATE_COMPANY')).length === 2);
  assert.equal(normalizeCompanyName('Acme Technologies Pvt. Ltd.'), normalizeCompanyName('acme technologies'));
});

test('never more than 10 results; fewer are allowed and reported', () => {
  const many = Array.from({ length: 14 }, (_, i) => company({ rank: i + 1, company_name: `Company ${i}`, website_url: `https://c${i}.example` }));
  const a = run(many);
  assert.equal(a.results.length, 10);
  assert.ok(a.issues.includes('TRUNCATED_TO_10'));
  const b = run([company()]);
  assert.equal(b.results.length, 1);
  assert.ok(b.issues.some((i) => i.startsWith('FEWER_THAN_10_QUALIFIED_RESULTS')));
});

test('every result has a name; invalid website URLs are dropped and reported', () => {
  const { results, issues } = run([company({ company_name: '  ' }), company({ rank: 2, company_name: 'Gamma', website_url: 'javascript:alert(1)' })]);
  assert.equal(results.length, 1);
  assert.equal(results[0].website_url, null);
  assert.ok(issues.includes('MISSING_COMPANY_NAME'));
  assert.ok(issues.some((i) => i.startsWith('INVALID_WEBSITE_URL')));
  assert.equal(cleanUrl('ftp://x.example'), null);
  assert.equal(cleanUrl('https://x.example/p?utm_source=a#f'), 'https://x.example/p');
});

test('evidence URLs are preserved and labelled by real support: cited / found / model_only', () => {
  const { results } = run([company({ evidence_urls: ['https://acme.example/services', 'https://unknown.example/page'] })]);
  const labels = Object.fromEntries(results[0].evidence_urls.map((e) => [e.url, e.labels]));
  assert.deepEqual(labels['https://acme.example/'], ['cited']);
  assert.deepEqual(labels['https://acme.example/services'], ['found']);
  assert.deepEqual(labels['https://unknown.example/page'], ['model_only']);
  assert.equal(results[0].website_cited, true);
});

test('verification flags are downgraded when no evidence backs them (the model saying "verified" is not evidence)', () => {
  const { results, issues } = run([company({ company_name: 'Ghost Corp', website_url: 'https://ghost.example', evidence_urls: ['https://ghost.example/x'] })]);
  assert.equal(results[0].nashik_presence_verified, false);
  assert.equal(results[0].ai_automation_verified, false);
  assert.equal(results[0].confidence, 'low');
  assert.ok(issues.some((i) => i.startsWith('VERIFICATION_WITHOUT_EVIDENCE')));
  assert.deepEqual(classifyEvidenceUrl('https://z.example', { fetched: new Map([['https://z.example', { ok: true, status: 200, mentionsNashik: true }]]) }).labels, ['fetched']);
});
