import { describe, test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();
// These tests exercise the MODEL path of organization_schema (normalizer, validator, output guard against model
// fabrications). The default path is deterministic from the schema intent; the kill switch selects the model path.
process.env.ODITO_ORG_SCHEMA_DETERMINISTIC = '0';

import recommendationService from './recommendationService.js';
import claudeService from './claudeService.js';
import IssueContextEngine from '../../issue-context/service/IssueContextEngine.js';
import Recommendation from '../model/Recommendation.js';

/**
 * Reproduces the production log for organization_schema: Claude answered with a
 * PHP wp_head() snippet in implementationCode (valid JSON-LD in
 * recommendedVersion), the schema validator rejected it as "not valid JSON" on
 * both attempts, and the user got the generic fallback recommendation.
 *
 * Real service + real IssueContextEngine + live Mongo (auto-skip if
 * unreachable); only the Claude API call is mocked.
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

const PAGE = 'https://org-schema-test.example/';
const ORG = { '@type': 'Organization', '@id': `${PAGE}#organization`, name: 'Naxonify', url: PAGE };
const SCHEMA_JSON = JSON.stringify({
  '@context': 'https://schema.org', '@type': 'Organization', '@id': `${PAGE}#organization`, name: 'Naxonify', url: PAGE,
}, null, 2);
const PHP = '<?php\nfunction odito_org_schema() {\n  echo \'<script type="application/ld+json">\' . json_encode(array("@type" => "Organization")) . \'</script>\';\n}\nadd_action("wp_head", "odito_org_schema");';

const rawOutput = (over = {}) => ({
  issueAnalysis: 'The Organization schema exists but is incomplete.',
  recommendedVersion: SCHEMA_JSON,
  beforeAfter: { before: 'Organization without address', after: 'Organization schema, address flagged as needing input' },
  implementationNotes: '1. Paste into your SEO plugin custom schema field. needs your input: address',
  implementationCode: PHP,
  impacts: ['Clearer entity data for AI engines', 'Fewer missing recommended fields'],
  recovery: { aiVisibility: 20, semanticTrust: 30, freshness: 0, accessibility: 0 },
  difficulty: 'easy',
  estimatedFixTime: '10 minutes',
  ...over,
});

describe('recommendationService — organization_schema (PHP implementationCode regression)', () => {
  let projectId; let generateCalls; let resolveSpy;

  beforeEach(async () => {
    mock.restoreAll();
    if (!mongoAvailable) return;
    projectId = new mongoose.Types.ObjectId();
    projectIds.push(projectId);
    const db = mongoose.connection.db;
    await db.collection('seo_page_data').insertOne({ projectId, url: PAGE, title: 'Naxonify', structured_data: [ORG] });
    await db.collection('seo_page_issues').insertOne({
      projectId, page_url: PAGE, issue_code: 'organization_schema', rule_id: 'organization_schema', status: 'open', severity: 'low',
      dedup_key: `org-schema-${projectId}`,
    });

    generateCalls = [];
    mock.method(claudeService, 'isAvailable', () => true);
    mock.method(claudeService, 'generate', async (...args) => {
      generateCalls.push(args);
      return { rawOutput: rawOutput(), tokensUsed: { input: 1, output: 1 }, generationTimeMs: 1, promptGroup: 4, modelUsed: 'test-model' };
    });
    resolveSpy = mock.method(IssueContextEngine, 'resolve', IssueContextEngine.resolve.bind(IssueContextEngine));
  });

  const request = (extra = {}) => recommendationService.getOrGenerate({
    projectId: projectId.toString(), issueId: 'organization_schema', pageUrl: PAGE, issueSource: 'on_page',
    ruleMetadata: { title: 'Organization schema incomplete', severity: 'low' }, ...extra,
  });

  test('valid JSON-LD in recommendedVersion + PHP in implementationCode is accepted — Claude output is stored, not the generic fallback, and no retry is needed', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const result = await request();

    assert.equal(result.source, 'claude');
    assert.notEqual(result.source, 'fallback');
    assert.equal(generateCalls.length, 1, 'accepted on the first attempt — no repair round trip');
    assert.equal(JSON.parse(result.recommendation.sections.recommendedVersion)['@type'], 'Organization');
  });

  test('a partial client issueContext (no identity/metadata, as the frontend sends it) is replaced by the server\'s own complete resolution', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const partial = { currentState: { displayType: 'code', rawValue: '{}', isAbsent: false }, expectedState: { description: 'x' }, pageContext: { pageUrl: PAGE } };
    await request({ issueContext: partial });

    assert.ok(resolveSpy.mock.callCount() >= 1, 'server resolved the context itself');
    const rc = generateCalls[0][4]; // recommendationContext passed to claudeService.generate
    assert.ok(rc.builderMeta.issueContextReadiness > 0, 'readiness reflects the real, resolved context — not 0%');
    assert.equal(rc.identity.issueId, 'organization_schema');
  });

  test('a complete client context (identity + metadata) is still honoured — no second resolution', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const complete = await IssueContextEngine.resolve(projectId.toString(), 'organization_schema', PAGE);
    resolveSpy.mock.resetCalls();
    await request({ issueContext: complete });
    assert.equal(resolveSpy.mock.callCount(), 0);
  });

  test('output with NO JSON-LD anywhere is still rejected (falls back) — the validator did not become permissive', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    mock.method(claudeService, 'generate', async () => ({
      rawOutput: rawOutput({ recommendedVersion: 'Add address, phone and logo to your Organization schema.', implementationCode: PHP }),
      tokensUsed: { input: 1, output: 1 }, generationTimeMs: 1, promptGroup: 4, modelUsed: 'test-model',
    }));

    const result = await request();
    assert.equal(result.source, 'fallback');
  });
});
