/**
 * Controlled validation of Odito's SERP ranking engine against ONE keyword, Desktop and Mobile independently.
 *
 *   Offline replay (free):   node scripts/serp-validation/validate-serp-ranking.mjs --domain example.com --fixture path/to/raw.json [--device desktop]
 *   Dry run (free, default): node scripts/serp-validation/validate-serp-ranking.mjs --keyword "x" --domain example.com --location-code 1007785
 *                            -> prints the exact request payloads and the estimated number of paid requests. Sends nothing.
 *   LIVE (PAID):             add --confirm-paid  (one request per device; both devices = 2 requests, ~USD 0.006 each at depth 100
 *                            - verify current pricing). Requires DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD in the environment.
 *
 * Options: --keyword, --domain, --location-code (required for live), --language (default en), --device desktop|mobile|both
 *          (default both), --out <dir> (default scripts/serp-validation/output). Raw responses and reports are written there.
 * Credentials are read from the environment by DataForSeoService and are never printed or written; saved raw responses
 * contain only what the provider returned (no Authorization header).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSerpOrganicPayload } from '../../src/modules/ranking/services/DataForSeoService.js';
import { buildSerpValidationReport, formatSerpValidationReport } from '../../src/modules/ranking/services/serpValidationReport.js';

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    out[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return out;
}

const a = args(process.argv.slice(2));
const domain = a.domain;
if (!domain) { console.error('--domain is required'); process.exit(2); }
const devices = a.device === 'desktop' || a.device === 'mobile' ? [a.device] : ['desktop', 'mobile'];
const outDir = typeof a.out === 'string' ? a.out : new URL('./output', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

function emit(device, raw, meta) {
  const report = buildSerpValidationReport(raw, domain, { device, requestedDepth: meta.requestedDepth, providerCode: raw?.tasks?.[0]?.status_code });
  mkdirSync(outDir, { recursive: true });
  const base = join(outDir, `${stamp}-${device}`);
  writeFileSync(`${base}.raw.json`, JSON.stringify({ request: meta.payload ?? null, response: raw }, null, 2));
  writeFileSync(`${base}.report.json`, JSON.stringify(report, null, 2));
  const text = formatSerpValidationReport(report);
  writeFileSync(`${base}.report.txt`, text);
  console.log(`\n=== ${device} ===\n${text}\nSaved: ${base}.{raw.json,report.json,report.txt}`);
}

if (a.fixture) {
  const parsed = JSON.parse(readFileSync(a.fixture, 'utf8'));
  const raw = parsed.response ?? parsed; // accepts a file saved by this script or a bare provider response
  emit(devices[0], raw, { requestedDepth: raw?.tasks?.[0]?.data?.depth ?? null, payload: parsed.request });
  process.exit(0);
}

if (!a.keyword || !a['location-code']) { console.error('--keyword and --location-code are required'); process.exit(2); }
const location = Number(a['location-code']);
const language = typeof a.language === 'string' ? a.language : 'en';
const payloads = Object.fromEntries(devices.map((d) => [d, buildSerpOrganicPayload(a.keyword, location, language, d)]));

console.log('Request payloads (POST /v3/serp/google/organic/live/advanced):');
for (const d of devices) console.log(`  ${d}: ${JSON.stringify(payloads[d])}`);

if (!a['confirm-paid']) {
  console.log(`\nDRY RUN - nothing was sent. ${devices.length} PAID request(s) would be made. Re-run with --confirm-paid to execute.`);
  process.exit(0);
}
if (!process.env.DATAFORSEO_LOGIN || !process.env.DATAFORSEO_PASSWORD) {
  console.error('DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD are not set in the environment.');
  process.exit(2);
}

const { DataForSeoService } = await import('../../src/modules/ranking/services/DataForSeoService.js');
// Devices run independently: one failing never stops or alters the other.
for (const d of devices) {
  try {
    const raw = await DataForSeoService.getSerpOrganic(a.keyword, location, language, { device: d });
    emit(d, raw, { requestedDepth: payloads[d][0].depth, payload: payloads[d] });
  } catch (err) {
    console.error(`\n=== ${d} === FAILED (ranking unknown, nothing is "not found"): ${err.message} | code=${err.taskStatusCode ?? err.response?.status ?? 'n/a'} kind=${err.errorKind ?? 'n/a'} attempts=${err.attempts ?? 'n/a'}`);
  }
}
