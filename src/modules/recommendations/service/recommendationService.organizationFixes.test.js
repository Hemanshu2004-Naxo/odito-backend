import { describe, test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();
// These tests exercise the MODEL path of organization_schema (normalizer, validator, output guard against model
// fabrications). The default path is deterministic from the schema intent; the kill switch selects the model path.
process.env.ODITO_ORG_SCHEMA_DETERMINISTIC = '0';

import recommendationService from './recommendationService.js';
import recommendationNormalizer, { coerceStructuredFields } from './recommendationNormalizer.js';
import claudeService from './claudeService.js';
import Recommendation from '../model/Recommendation.js';
import validatorRegistry from '../validators/ValidatorRegistry.js';
import { GROUP } from '../prompts/GroupRegistry.js';
import { sanitizeGeneratedSchema } from '../../schema-evidence/schemaOutputGuard.js';
import { applyImageProbes, buildSchemaEvidence } from '../../schema-evidence/schemaEvidence.js';
import { resetImageProbeCache } from '../../schema-evidence/imageVerificationClient.js';
import { ABOUT_CRAWL_KEY, HOME, ORIGIN, aboutPageData, graphWithOrganization } from '../../schema-evidence/__fixtures__/clinicSite.js';

/**
 * Reproduces the production log for organization_schema on a page with NO entity schema:
 *
 *   NORMALIZER ... failed (non-fatal): content.trim is not a function
 *   Absent element — routing to MissingElementValidator | group=4
 *   recommendedFix contains placeholder text — Claude output not grounded   (twice)
 *   Context validation failed after 2 attempt(s) — falling back
 *
 * Causes: (1) the model returned recommendedVersion / implementationCode as a JSON OBJECT (the schema prompt asks for
 * "the actual JSON-LD object") — the normalizer turned it into '' and BeforeAfterBuilder crashed; (2) the placeholder
 * check ran over recommendedFix, which is guidance to the owner ("Add your phone number…"); (3) a LocalBusiness with no
 * verified address was not a valid thing to publish.
 */

const noEvidence = () => applyImageProbes(buildSchemaEvidence({ issueId: 'organization_schema', pageUrl: ABOUT_CRAWL_KEY, pageData: aboutPageData({ structured_data: [], images: [] }), pageType: 'about' }), []);
const withSite = () => applyImageProbes(buildSchemaEvidence({ issueId: 'organization_schema', pageUrl: ABOUT_CRAWL_KEY, pageData: aboutPageData(), pageType: 'about' }), []);

describe('coerceStructuredFields — structured model output becomes text instead of being lost', () => {
  const org = { '@context': 'https://schema.org', '@type': 'Organization', name: 'Clinic', url: HOME };

  test('object / array values become JSON; step lists become lines; before/after objects become text', () => {
    const out = coerceStructuredFields({
      recommendedVersion: org, implementationCode: [org], implementationNotes: ['1. Paste it.', '2. Save.'],
      issueAnalysis: ['a', 'b'], beforeAfter: { before: 'none', after: org },
    });
    assert.equal(typeof out.recommendedVersion, 'string');
    assert.deepEqual(JSON.parse(out.recommendedVersion), org);
    assert.deepEqual(JSON.parse(out.implementationCode), [org]);
    assert.equal(out.implementationNotes, '1. Paste it.\n2. Save.');
    assert.equal(out.issueAnalysis, 'a\nb');
    assert.deepEqual(JSON.parse(out.beforeAfter.after), org);
    assert.equal(out.beforeAfter.before, 'none');
  });

  test('strings, null and non-objects pass through; the input is never mutated', () => {
    const input = { recommendedVersion: org, implementationCode: 'x', impacts: ['a'] };
    const copy = JSON.parse(JSON.stringify(input));
    const out = coerceStructuredFields(input);
    assert.deepEqual(input, copy);
    assert.equal(out.implementationCode, 'x');
    assert.deepEqual(out.impacts, ['a']);
    assert.equal(coerceStructuredFields(null), null);
    assert.equal(coerceStructuredFields('s'), 's');
    assert.deepEqual(coerceStructuredFields({}), {});
  });

  test('normalize() keeps an object-valued recommendation: content present, valid JSON, no BeforeAfterBuilder crash', () => {
    const warn = mock.method(console, 'warn', () => {});
    try {
      const rc = { currentState: { displayType: 'absent', isAbsent: true, checkedFor: 'Organization schema' }, expectedState: { description: 'x', measurement: {} }, recommendationObjective: { action: 'add', target: 'Organization schema', constraint: 'c', preserveContext: 'p', successCriteria: 's', promptMode: 'element_add' }, identity: { issueId: 'organization_schema' }, pageContext: { pageUrl: HOME } };
      const sections = recommendationNormalizer.normalize({
        issueAnalysis: 'The Organization schema is missing.', recommendedVersion: org, implementationCode: org, implementationNotes: ['1. Paste it into the head.'],
        beforeAfter: { before: 'none', after: org }, impacts: ['Clearer entity'], recovery: { aiVisibility: 10, semanticTrust: 10, freshness: 0, accessibility: 0 }, difficulty: 'easy', estimatedFixTime: '10 minutes',
      }, {}, {}, rc);
      assert.deepEqual(JSON.parse(sections.recommendedVersion.replace(/\s+/g, ' ')), org);
      assert.deepEqual(JSON.parse(sections.implementationExample.content), org);
      assert.equal(sections.recommendedFix, '1. Paste it into the head.');
      assert.equal(sections.afterState.isAbsent, false);
      assert.ok(!warn.mock.calls.some((c) => /BeforeAfterBuilder\/ChangeSummaryBuilder failed/.test(String(c[0]))));
    } finally { warn.mock.restore(); }
  });
});

describe('placeholder checks apply to the published code, not to guidance', () => {
  const sections = (over = {}) => ({
    whyThisMatters: 'Entity data helps AI answers. Add your phone number to complete it.',
    recommendedFix: '1. Paste the markup. 2. Add your logo URL and replace this note with your real address. needs your input: telephone',
    implementationExample: { content: JSON.stringify({ '@context': 'https://schema.org', '@type': 'Organization', name: 'Clinic Eye Centre', url: HOME }) },
    recommendedVersion: JSON.stringify({ '@context': 'https://schema.org', '@type': 'Organization', name: 'Clinic Eye Centre', url: HOME }),
    expectedImpact: ['Clearer entity'], estimatedRecovery: { aiVisibility: 5, semanticTrust: 5, freshness: 0, accessibility: 0 },
    ...over,
  });
  const absentCtx = (issueId = 'organization_schema', extra = {}) => ({ identity: { issueId }, currentState: { isAbsent: true }, pageContext: { pageUrl: HOME }, missingElementContext: { isRich: true, businessName: 'Clinic Eye Centre', primaryTopic: 'About' }, ...extra });

  test('REGRESSION: guidance such as "Add your phone number…" in recommendedFix no longer fails an absent Organization schema', () => {
    const r = validatorRegistry.validate(sections(), absentCtx(), GROUP.SCHEMA);
    assert.deepEqual(r.errors, []);
    assert.equal(r.valid, true);
    assert.equal(r.satisfiesConstraint, true);
  });

  test('a placeholder inside the published JSON-LD still fails — in code and in recommendedVersion', () => {
    const bad = JSON.stringify({ '@context': 'https://schema.org', '@type': 'Organization', name: '[Business Name]', url: HOME });
    for (const over of [{ implementationExample: { content: bad } }, { recommendedVersion: bad, implementationExample: { content: bad } }]) {
      const r = validatorRegistry.validate(sections(over), absentCtx(), GROUP.SCHEMA);
      assert.equal(r.valid, false);
      assert.equal(r.satisfiesConstraint, false);
    }
    const generic = JSON.stringify({ '@context': 'https://schema.org', '@type': 'Organization', name: 'Your Company Name', url: 'https://yourdomain.com' });
    assert.equal(validatorRegistry.validate(sections({ recommendedVersion: generic, implementationExample: { content: generic } }), absentCtx(), GROUP.SCHEMA).valid, false);
  });

  test('non-schema absent elements keep the strict prose check (the relaxation is schema-only)', () => {
    const r = validatorRegistry.validate(sections({ recommendedVersion: 'A real H1 for this page' }), absentCtx('h1_missing'), GROUP.TEXT_OPTIMIZATION);
    assert.ok(r.errors.some((e) => /recommendedFix contains placeholder text/.test(e)));
  });

  test('the same finding is reported once, not twice (merged validator results are de-duplicated)', () => {
    const bad = JSON.stringify({ '@context': 'https://schema.org', '@type': 'Organization', name: '[Business Name]', url: HOME });
    const r = validatorRegistry.validate(sections({ implementationExample: { content: bad }, recommendedVersion: bad }), absentCtx(), GROUP.SCHEMA);
    assert.equal(new Set(r.errors).size, r.errors.length);
  });

  test('an empty recommendedVersion explains itself, so the repair prompt is never given a blank reason', () => {
    const r = validatorRegistry.validate(sections({ recommendedVersion: '' }), absentCtx('h1_missing'), GROUP.TEXT_OPTIMIZATION);
    assert.ok(r.warnings.some((w) => /recommendedVersion is empty/.test(w)));
  });
});

describe('LocalBusiness', () => {
  const generated = (type, extra = {}) => ({ '@context': 'https://schema.org', '@type': type, name: 'Clinic Eye Centre', url: HOME, telephone: '+1-555-0100', address: { '@type': 'PostalAddress', streetAddress: '1 Made Up Road' }, openingHours: 'Mo-Fr 09:00-18:00', geo: { '@type': 'GeoCoordinates', latitude: 1, longitude: 2 }, priceRange: '$$', ...extra });

  test('a NEW LocalBusiness with no verified address is published as an Organization, with the invented facts removed and a clear note', () => {
    for (const type of ['LocalBusiness', ['LocalBusiness', 'Dentist'], 'Dentist', 'MedicalClinic', 'Restaurant']) {
      const { schema, removed, notes } = sanitizeGeneratedSchema(generated(type), noEvidence());
      assert.equal(schema['@type'], 'Organization', JSON.stringify(type));
      for (const f of ['telephone', 'address', 'openingHours', 'geo', 'priceRange']) assert.equal(schema[f], undefined, `${JSON.stringify(type)} ${f}`);
      assert.ok(removed.length >= 5);
      assert.ok(notes.some((n) => /published as an Organization/.test(n) && /street address/.test(n)));
    }
  });

  test('an Organization stays an Organization (no note about LocalBusiness)', () => {
    const { schema, notes } = sanitizeGeneratedSchema(generated('Organization'), noEvidence());
    assert.equal(schema['@type'], 'Organization');
    assert.ok(!notes.some((n) => /LocalBusiness/.test(n)));
  });

  test('when the site already publishes the business (type, address, phone), those are kept and the type is NOT downgraded', () => {
    const { schema, notes } = sanitizeGeneratedSchema({ '@type': 'LocalBusiness', name: 'Clinic Eye Centre', url: HOME }, withSite());
    assert.deepEqual(schema['@type'], ['Hospital', 'Organization']);
    assert.equal(schema.telephone, '+918447637606');
    assert.equal(schema.address.postalCode, undefined);
    assert.equal(schema.address.addressLocality, 'Parel');
    assert.ok(!notes.some((n) => /published as an Organization/.test(n)));
  });

  test('an existing LocalBusiness-typed entity keeps its type and its address', () => {
    const pd = aboutPageData({ structured_data: graphWithOrganization({ '@type': ['LocalBusiness', 'Dentist'] }) });
    const ev = applyImageProbes(buildSchemaEvidence({ issueId: 'organization_schema', pageUrl: ABOUT_CRAWL_KEY, pageData: pd, pageType: 'about' }), []);
    const { schema } = sanitizeGeneratedSchema(generated('LocalBusiness'), ev);
    assert.deepEqual(schema['@type'], ['LocalBusiness', 'Dentist']);
    assert.equal(schema.address.streetAddress, '2-A Trust House');
  });
});

// ── end to end: the real service, the real validators, live local Mongo (auto-skip), only Claude is replaced ──
let mongoAvailable = false;
before(async () => {
  try { await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 }); mongoAvailable = true; } catch { mongoAvailable = false; }
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

describe('recommendationService — organization_schema on a page with no entity schema (the production log)', () => {
  let projectId; let calls; let savedWorker;
  beforeEach(async () => {
    mock.restoreAll();
    resetImageProbeCache();
    savedWorker = process.env.PYTHON_WORKER_URL;
    delete process.env.PYTHON_WORKER_URL;
    if (!mongoAvailable) return;
    projectId = new mongoose.Types.ObjectId();
    projectIds.push(projectId);
    const db = mongoose.connection.db;
    await db.collection('seo_page_data').insertOne({ projectId, url: `${ORIGIN}/`, canonical: `${ORIGIN}/`, title: 'Clinic Eye Centre', structured_data: [], meta_tags: {}, images: [], word_count: 400 });
    await db.collection('seo_page_issues').insertOne({ projectId, page_url: `${ORIGIN}/`, issue_code: 'organization_schema', rule_id: 'organization_schema', status: 'open', severity: 'high', dedup_key: `of-${projectId}` });
    calls = [];
    mock.method(claudeService, 'isAvailable', () => true);
  });
  const restore = () => { if (savedWorker === undefined) delete process.env.PYTHON_WORKER_URL; else process.env.PYTHON_WORKER_URL = savedWorker; };
  const request = () => recommendationService.getOrGenerate({ projectId: String(projectId), issueId: 'organization_schema', pageUrl: `${ORIGIN}/`, issueSource: 'on_page', ruleMetadata: { title: 'Missing Organization schema', category: 'Schema', severity: 'high' } });
  const stored = (r) => JSON.parse(r.recommendation.sections.implementationExample.content.replace(/<\/?script[^>]*>/g, ''));
  const model = (entity) => ({
    rawOutput: {
      issueAnalysis: 'No Organization or LocalBusiness schema was detected.',
      // exactly what the log shows going wrong: JSON OBJECTS where strings were expected, and a list of steps
      recommendedVersion: entity,
      beforeAfter: { before: 'No entity schema', after: entity },
      implementationNotes: ['1. Add your phone number and your logo URL.', '2. Replace this snippet\'s placeholder address with your real address.', '3. Paste the block into the <head>.'],
      implementationCode: entity,
      impacts: ['Clearer entity for AI answers', 'Knowledge Graph eligibility'],
      recovery: { aiVisibility: 30, semanticTrust: 30, freshness: 0, accessibility: 0 },
      difficulty: 'easy', estimatedFixTime: '10 minutes',
    },
    tokensUsed: { input: 1, output: 1 }, generationTimeMs: 1, promptGroup: 4, modelUsed: 'test-model',
  });

  test('Organization: object-valued output + "Add your…" guidance is ACCEPTED on the first attempt (no repair round, no fallback); invented values are removed', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const entity = { '@context': 'https://schema.org', '@type': 'Organization', name: 'Clinic Eye Centre', url: `${ORIGIN}/`, logo: `${ORIGIN}/wp-content/uploads/logo.png`, telephone: '+1-555-0100', sameAs: ['https://twitter.com/made-up'] };
    mock.method(claudeService, 'generate', async (...a) => { calls.push(a); return model(entity); });
    try {
      const r = await request();
      assert.equal(r.source, 'claude');
      assert.equal(calls.length, 1, 'accepted on the first attempt');
      const out = stored(r);
      assert.equal(out['@type'], 'Organization');
      assert.equal(out.name, 'Clinic Eye Centre');
      for (const f of ['logo', 'telephone', 'sameAs']) assert.equal(out[f], undefined, f);
      assert.ok(!JSON.stringify(out).includes('made-up'));
      assert.match(r.recommendation.sections.recommendedFix, /Add your phone number and your logo URL/);
      assert.match(r.recommendation.sections.recommendedFix, /ODITO verification notes/);
      assert.deepEqual(JSON.parse(r.recommendation.sections.recommendedVersion.replace(/\s+/g, ' ')).name, 'Clinic Eye Centre');
    } finally { restore(); }
  });

  test('LocalBusiness: an invented address/phone/hours are removed and, with no verified address, it is published as an Organization', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const entity = { '@context': 'https://schema.org', '@type': 'LocalBusiness', name: 'Clinic Eye Centre', url: `${ORIGIN}/`, telephone: '+1-555-0100', address: { '@type': 'PostalAddress', streetAddress: '1 Made Up Road', addressLocality: 'Mumbai' }, openingHours: 'Mo-Fr 09:00-18:00', geo: { '@type': 'GeoCoordinates', latitude: 19, longitude: 72 } };
    mock.method(claudeService, 'generate', async (...a) => { calls.push(a); return model(entity); });
    try {
      const r = await request();
      assert.equal(r.source, 'claude');
      assert.equal(calls.length, 1);
      const out = stored(r);
      assert.equal(out['@type'], 'Organization');
      for (const f of ['telephone', 'address', 'openingHours', 'geo']) assert.equal(out[f], undefined, f);
      assert.match(r.recommendation.sections.recommendedFix, /published as an Organization/);
      assert.match(r.recommendation.sections.recommendedFix, /street address/);
    } finally { restore(); }
  });

  test('a placeholder INSIDE the generated JSON-LD is still rejected (falls back after the repair attempt) — the relaxation is prose-only', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const entity = { '@context': 'https://schema.org', '@type': 'Organization', name: '[Business Name]', url: `${ORIGIN}/` };
    mock.method(claudeService, 'generate', async (...a) => { calls.push(a); return model(entity); });
    // the guard cannot fix a placeholder NAME when no name is verified from the site
    try {
      const r = await request();
      assert.equal(r.source, 'fallback');
      assert.equal(calls.length, 2);
    } finally { restore(); }
  });
});
