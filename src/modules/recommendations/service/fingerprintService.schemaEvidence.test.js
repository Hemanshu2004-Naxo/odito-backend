import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import fingerprintService from './fingerprintService.js';
import RecommendationContextBuilder from '../context/RecommendationContextBuilder.js';
import { applyImageProbes, buildSchemaEvidence } from '../../schema-evidence/schemaEvidence.js';
import { ABOUT_CRAWL_KEY, REAL_LOGO, aboutPageData, probe404, probeOk } from '../../schema-evidence/__fixtures__/clinicSite.js';

const evidence = (probes) => applyImageProbes(buildSchemaEvidence({ issueId: 'organization_schema', pageUrl: ABOUT_CRAWL_KEY, pageData: aboutPageData(), headingsByTag: { h1: ['About'] }, pageType: 'about' }), probes);
const rcWith = (schemaEvidence) => ({ recommendationObjective: { promptMode: 'element_add', promptGroup: 4 }, pageContext: { pageUrl: ABOUT_CRAWL_KEY }, schemaEvidence });
const fp = (rc) => fingerprintService.computeFingerprint('organization_schema', { pageType: 'About', framework: 'unknown' }, null, rc, null, ABOUT_CRAWL_KEY);

describe('fingerprint includes the schema evidence', () => {
  test('a recommendation built without evidence (pre-fix cache entry) never matches one built with it', () => {
    assert.notEqual(fp(rcWith(null)), fp(rcWith(evidence([probeOk(REAL_LOGO)]))));
  });

  test('different verification results -> different fingerprints; identical -> identical', () => {
    assert.notEqual(fp(rcWith(evidence([probeOk(REAL_LOGO)]))), fp(rcWith(evidence([probe404(REAL_LOGO)]))));
    assert.equal(fp(rcWith(evidence([probeOk(REAL_LOGO)]))), fp(rcWith(evidence([probeOk(REAL_LOGO)]))));
  });

  test('issues without evidence keep their fingerprint', () => {
    assert.equal(fp(rcWith(null)), fp({ ...rcWith(null), schemaEvidence: undefined }));
  });
});

describe('RecommendationContextBuilder carries the evidence', () => {
  const issueContext = (schemaEvidence) => ({
    identity: { issueId: 'organization_schema', issueType: 'on_page', category: 'Schema' },
    currentState: { displayType: 'code', rawValue: '{"@type":"Organization"}', isAbsent: false, codeContent: '{"@type":"Organization"}' },
    expectedState: { description: 'x', measurement: {} },
    pageContext: { pageUrl: ABOUT_CRAWL_KEY, pageType: 'About', framework: 'unknown', cms: null, canonicalUrl: null },
    metadata: { readinessScore: 80 },
    schemaEvidence,
  });

  test('schemaEvidence reaches the RecommendationContext', () => {
    const ev = evidence([probeOk(REAL_LOGO)]);
    assert.equal(RecommendationContextBuilder.build(issueContext(ev)).schemaEvidence.organization.logo.status, 'verified');
  });

  test('the context cache does not serve a context built with other evidence', () => {
    const a = RecommendationContextBuilder.build(issueContext(evidence([probeOk(REAL_LOGO)])));
    const b = RecommendationContextBuilder.build(issueContext(evidence([probe404(REAL_LOGO)])));
    assert.equal(a.schemaEvidence.organization.logo.status, 'verified');
    assert.equal(b.schemaEvidence.organization.logo.status, 'existing_broken');
    assert.notEqual(a.builderMeta.contextHash, b.builderMeta.contextHash);
  });

  test('absent for issues that have none', () => {
    assert.equal(RecommendationContextBuilder.build({ ...issueContext(undefined), identity: { issueId: 'title_missing', issueType: 'on_page', category: 'Content' } }).schemaEvidence, null);
  });
});
