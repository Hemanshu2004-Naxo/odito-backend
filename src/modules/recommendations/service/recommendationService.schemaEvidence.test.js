import { describe, test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();
// These tests exercise the MODEL path of organization_schema (normalizer, validator, output guard against model
// fabrications). The default path is deterministic from the schema intent; the kill switch selects the model path.
process.env.ODITO_ORG_SCHEMA_DETERMINISTIC = '0';

import recommendationService from './recommendationService.js';
import claudeService from './claudeService.js';
import Recommendation from '../model/Recommendation.js';
import promptBuilder from '../prompts/PromptBuilder.js';
import { resetImageProbeCache } from '../../schema-evidence/imageVerificationClient.js';
import {
  ABOUT_CANONICAL, ABOUT_CRAWL_KEY, HOME, INVENTED_LOGO, ORG_ID, ORIGIN, REAL_LOGO, aboutPageData, probe404, probeOk,
} from '../../schema-evidence/__fixtures__/clinicSite.js';

/**
 * End-to-end regression for the audited defect: a site that ALREADY has a valid
 * ["Hospital","Organization"] entity with a working logo got a recommendation containing a
 * generic Organization, an invented /wp-content/uploads/logo.png (404), a made-up phone number
 * and a second @id.
 *
 * Real service + real IssueContextEngine + real schema-evidence pipeline + live local Mongo
 * (auto-skip if unreachable). Only two things are replaced: the Claude API call, and the Python
 * worker's /api/verify-logo-candidates endpoint, which is a tiny local HTTP server here so the
 * test never touches a real website or the network.
 */

let mongoAvailable = false;
before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
  } catch { mongoAvailable = false; }
});

const projectIds = [];
after(async () => {
  if (mongoAvailable) {
    const db = mongoose.connection.db;
    await Recommendation.deleteMany({ projectId: { $in: projectIds } });
    for (const c of ['seo_page_data', 'seo_page_issues']) await db.collection(c).deleteMany({ projectId: { $in: projectIds } });
    await mongoose.connection.close();
  }
});

// A stand-in for the Python worker.
async function startWorker(answer) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const urls = JSON.parse(body || '{}').urls || [];
      requests.push(urls);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, data: { results: urls.map((u) => answer(u)) } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((r) => server.close(r)) };
}

const fabricated = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  '@id': `${ORIGIN}/#org`,
  name: 'Clinic Eye Centre',
  url: HOME,
  logo: { '@type': 'ImageObject', url: INVENTED_LOGO, width: 600, height: 60 },
  telephone: '+1-555-0100',
  contactPoint: { '@type': 'ContactPoint', telephone: '+1-555-0100', contactType: 'customer service' },
  sameAs: ['https://www.facebook.com/clinic-made-up'],
};
const script = (o) => `<script type="application/ld+json">\n${JSON.stringify(o, null, 2)}\n</script>`;
const rawOutput = () => ({
  issueAnalysis: 'Organization schema is incomplete.',
  recommendedVersion: JSON.stringify(fabricated, null, 2),
  beforeAfter: { before: 'Organization without contact data', after: 'Organization with logo and contact' },
  implementationNotes: '1. Paste into your SEO plugin custom schema field.',
  implementationCode: script(fabricated),
  impacts: ['Clearer entity data for AI engines', 'Fewer missing recommended fields'],
  recovery: { aiVisibility: 20, semanticTrust: 30, freshness: 0, accessibility: 0 },
  difficulty: 'easy',
  estimatedFixTime: '10 minutes',
});

describe('recommendationService — Organization schema from verified evidence (krishnaeyecentre-style regression)', () => {
  let projectId; let generateCalls; let worker = null; let savedWorkerUrl;

  beforeEach(async () => {
    mock.restoreAll();
    resetImageProbeCache();
    savedWorkerUrl = process.env.PYTHON_WORKER_URL;
    if (!mongoAvailable) return;
    projectId = new mongoose.Types.ObjectId();
    projectIds.push(projectId);
    const db = mongoose.connection.db;
    await db.collection('seo_page_data').insertOne({ projectId, ...aboutPageData() });
    await db.collection('seo_page_issues').insertOne({
      projectId, page_url: ABOUT_CRAWL_KEY, issue_code: 'organization_schema', rule_id: 'organization_schema', status: 'open', severity: 'low', dedup_key: `ev-${projectId}`,
    });
    generateCalls = [];
    mock.method(claudeService, 'isAvailable', () => true);
    mock.method(claudeService, 'generate', async (...args) => {
      generateCalls.push(args);
      return { rawOutput: rawOutput(), tokensUsed: { input: 1, output: 1 }, generationTimeMs: 1, promptGroup: 4, modelUsed: 'test-model' };
    });
  });

  const done = async () => {
    if (worker) { await worker.close(); worker = null; }
    if (savedWorkerUrl === undefined) delete process.env.PYTHON_WORKER_URL; else process.env.PYTHON_WORKER_URL = savedWorkerUrl;
  };

  const request = () => recommendationService.getOrGenerate({
    projectId: projectId.toString(), issueId: 'organization_schema', pageUrl: ABOUT_CRAWL_KEY, issueSource: 'on_page',
    ruleMetadata: { title: 'Organization schema incomplete', severity: 'low' },
  });
  const storedJsonLd = (result) => JSON.parse(result.recommendation.sections.implementationExample.content.replace(/<\/?script[^>]*>/g, ''));

  test('the site\'s working logo is verified, reused with MEASURED size; the invented logo, phone, contactPoint, profile and second @id never reach the customer', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    worker = await startWorker((u) => (u === REAL_LOGO ? probeOk(u, { width: 178, height: 59 }) : probe404(u)));
    process.env.PYTHON_WORKER_URL = worker.url;
    try {
      const result = await request();
      assert.equal(result.source, 'claude');

      // the prompt the model saw carried the evidence — including the real logo and the forbidden invented path
      const rc = generateCalls[0][4];
      assert.equal(rc.schemaEvidence.organization.logo.status, 'verified');
      const built = promptBuilder.build(rc, { title: 'x' });
      const promptText = typeof built === 'string' ? built : built.prompt;
      assert.match(promptText, /VERIFIED SCHEMA EVIDENCE \(the ONLY facts you may publish/);
      assert.match(promptText, /Logo: VERIFIED "https:\/\/clinic\.example\/wp-content\/uploads\/2019\/05\/clinic-logo\.png" - png, measured 178x59px/);
      assert.match(promptText, /Existing entity \(reuse it - do NOT create a second Organization\)/);

      // the stored recommendation
      const code = result.recommendation.sections.implementationExample.content;
      const jsonLd = storedJsonLd(result);
      assert.equal(jsonLd.logo.url, REAL_LOGO);
      assert.deepEqual([jsonLd.logo.width, jsonLd.logo.height], [178, 59]);
      assert.equal(jsonLd['@id'], ORG_ID);
      assert.deepEqual(jsonLd['@type'], ['Hospital', 'Organization']);
      for (const forbidden of [INVENTED_LOGO, '+1-555-0100', 'clinic-made-up', `${ORIGIN}/#org"`]) {
        assert.ok(!code.includes(forbidden), `implementationCode still contains ${forbidden}`);
        assert.ok(!result.recommendation.sections.recommendedVersion.includes(forbidden), `recommendedVersion still contains ${forbidden}`);
      }
      assert.match(result.recommendation.sections.recommendedFix, /ODITO verification notes/);

      // exactly one verification request, for the candidates the SITE itself exposed (no URL from the model)
      assert.equal(worker.requests.length, 1);
      assert.ok(worker.requests[0].includes(REAL_LOGO));
      assert.ok(!worker.requests[0].includes(INVENTED_LOGO));
    } finally { await done(); }
  });

  test('the site\'s logo returns 404: the logo is omitted and the user is told it needs their input — nothing broken is published', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    worker = await startWorker((u) => probe404(u));
    process.env.PYTHON_WORKER_URL = worker.url;
    try {
      const result = await request();
      assert.equal(result.source, 'claude');
      const jsonLd = storedJsonLd(result);
      assert.equal(jsonLd.logo, undefined);
      assert.match(result.recommendation.sections.recommendedFix, /Logo:.*returns an error or is not an image/);
      assert.equal(generateCalls[0][4].schemaEvidence.organization.logo.status, 'existing_broken');
    } finally { await done(); }
  });

  test('the verification service is unreachable: the logo is omitted (never trusted, never declared broken)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    process.env.PYTHON_WORKER_URL = 'http://127.0.0.1:1';
    try {
      const result = await request();
      const jsonLd = storedJsonLd(result);
      assert.equal(jsonLd.logo, undefined);
      assert.equal(generateCalls[0][4].schemaEvidence.organization.logo.status, 'unverified');
      assert.match(result.recommendation.sections.recommendedFix, /could not be verified right now/);
    } finally { await done(); }
  });

  test('a recommendation generated for different evidence is never served from cache', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    worker = await startWorker((u) => (u === REAL_LOGO ? probeOk(u) : probe404(u)));
    process.env.PYTHON_WORKER_URL = worker.url;
    try {
      const first = await request();
      assert.equal(first.cached, false);
      resetImageProbeCache();
      await worker.close();
      worker = await startWorker((u) => probe404(u));
      process.env.PYTHON_WORKER_URL = worker.url;
      const second = await request();
      assert.equal(second.cached, false, 'the logo status changed, so the earlier recommendation must not be reused');
      assert.equal(storedJsonLd(second).logo, undefined);
    } finally { await done(); }
  });
});

describe('canonical URL is what breadcrumb/entity markup uses, not the crawl key', () => {
  test('evidence for the about page publishes the canonical with its trailing slash', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { collectSchemaEvidence } = await import('../../schema-evidence/schemaEvidenceService.js');
    const pid = new mongoose.Types.ObjectId();
    projectIds.push(pid);
    await mongoose.connection.db.collection('seo_page_data').insertOne({ projectId: pid, ...aboutPageData() });
    const ev = await collectSchemaEvidence({ projectId: pid.toString(), issueId: 'breadcrumblist_schema', pageUrl: ABOUT_CRAWL_KEY }, { verify: async () => [] });
    assert.equal(ev.url.display, ABOUT_CANONICAL);
    assert.equal(ev.url.crawlKey, ABOUT_CRAWL_KEY);
    assert.equal(ev.breadcrumb.hierarchy.status, 'unknown');
  });
});
