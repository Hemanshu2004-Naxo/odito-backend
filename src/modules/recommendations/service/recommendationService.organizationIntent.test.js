import { describe, test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import recommendationService from './recommendationService.js';
import claudeService from './claudeService.js';
import Recommendation from '../model/Recommendation.js';
import BusinessProfileMetadata from '../../app_user/model/BusinessProfileMetadata.js';
import IssueContextEngine from '../../issue-context/service/IssueContextEngine.js';
import { ORIGIN, ORG_ID } from '../../schema-evidence/__fixtures__/clinicSite.js';
import { ADDRESS, hospitalGraph, hospitalSitePages, page } from '../../schema-evidence/__fixtures__/hospitalSite.js';

/**
 * End-to-end for the Organization / LocalBusiness / Hospital schema intent: real service, real IssueContextEngine, real
 * evidence pipeline, live local Mongo (auto-skip if unreachable). The model is mocked and must NEVER be called — the
 * organization recommendation is deterministic. No network, no production site, no Task is written or read by generation.
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
    await BusinessProfileMetadata.deleteMany({ project_id: { $in: projectIds } });
    for (const c of ['seo_page_data', 'seo_page_issues', 'tasks']) await db.collection(c).deleteMany({ projectId: { $in: projectIds } });
    await mongoose.connection.close();
  }
});

const PAGE_TYPE = { '/': 'homepage', '/contact': 'contact' };

async function seed(projectId, pages) {
  const db = mongoose.connection.db;
  await db.collection('seo_page_data').deleteMany({ projectId });
  await db.collection('seo_page_issues').deleteMany({ projectId });
  const path = (u) => new URL(u).pathname.replace(/\/+$/, '') || '/';
  await db.collection('seo_page_data').insertMany(pages.map((p) => ({ projectId, ...p, page_type: PAGE_TYPE[path(p.url)] || 'generic', meta_tags: { 'og:site_name': ['Clinic Eye Centre'] } })));
  await db.collection('seo_page_issues').insertMany(pages.map((p) => ({
    projectId, page_url: p.url, issue_code: 'organization_schema', rule_id: 'organization_schema', status: 'open', severity: 'low', dedup_key: `org-${projectId}-${p.url}`,
  })));
}

describe('recommendationService — organization schema intent (deterministic, evidence-driven)', () => {
  let projectId; let claudeCalls;

  beforeEach(async () => {
    mock.restoreAll();
    claudeCalls = 0;
    mock.method(claudeService, 'isAvailable', () => true);
    mock.method(claudeService, 'generate', async () => { claudeCalls += 1; throw new Error('the model must not be called for organization_schema'); });
    if (!mongoAvailable) return;
    projectId = new mongoose.Types.ObjectId();
    projectIds.push(projectId);
  });

  const request = (pageUrl) => recommendationService.getOrGenerate({
    projectId: projectId.toString(), issueId: 'organization_schema', pageUrl, issueSource: 'on_page',
    ruleMetadata: { title: 'Missing Organization or LocalBusiness Schema', severity: 'low' },
  });
  const code = (r) => r.recommendation.sections.implementationExample.content;
  const ld = (r) => JSON.parse(/<script[^>]*>([\s\S]*?)<\/script>/.exec(code(r))[1]);

  test('the 7-page case: a generic page on a hospital site is told to REFERENCE the Hospital entity — no new entity, no model call, nothing deployed', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seed(projectId, hospitalSitePages());
    const taskBefore = { projectId, issueKey: 'organization_schema', pageUrl: `${ORIGIN}/gallery`, status: 'task_created' };
    await mongoose.connection.db.collection('tasks').insertOne({ ...taskBefore });

    const r = await request(`${ORIGIN}/gallery`);

    assert.equal(claudeCalls, 0);
    assert.equal(r.source, 'template');
    assert.doesNotMatch(code(r), /<script/);
    assert.match(r.recommendation.sections.recommendedFix, /No new Hospital markup is needed/);
    assert.equal(r.recommendation.sourceAttribution.contextSources.schemaAction, 'reference');
    assert.equal(r.schemaEvidence.organization.intent.intent, 'schema_already_present');
    assert.equal(r.schemaEvidence.organization.site.primary.id, ORG_ID);
    const task = await mongoose.connection.db.collection('tasks').findOne({ projectId });
    assert.equal(task.status, 'task_created', 'generating a recommendation never implements or verifies a task');
  });

  test('a homepage missing its entity on a site whose other pages say Hospital -> a Hospital with the reused @id and the site\'s address', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seed(projectId, hospitalSitePages().filter((p) => p.url !== `${ORIGIN}/`).concat([page('/', [])]));
    const r = await request(`${ORIGIN}/`);
    assert.equal(claudeCalls, 0);
    const out = ld(r);
    assert.deepEqual(out['@type'], ['Hospital', 'Organization']);
    assert.equal(out['@id'], ORG_ID);
    assert.deepEqual(out.address, ADDRESS);
    assert.equal(r.schemaEvidence.organization.intent.intent, 'hospital_schema');
  });

  test('a location page with no address anywhere asks for it (no JSON-LD); once the address is on the site the NEXT request produces markup, and the old record is kept', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seed(projectId, [page('/', [{ '@type': 'Organization', '@id': ORG_ID, name: 'Clinic Eye Centre', url: `${ORIGIN}/` }]), page('/contact', [])]);

    const first = await request(`${ORIGIN}/contact`);
    assert.equal(first.cached, false);
    assert.doesNotMatch(code(first), /<script/);
    assert.equal(first.schemaEvidence.organization.intent.action, 'needs_input');
    assert.match(first.recommendation.sections.recommendedFix, /Street address of the location/);

    const again = await request(`${ORIGIN}/contact`);
    assert.equal(again.cached, true, 'unchanged evidence is served from the cache');

    await seed(projectId, [page('/', hospitalGraph({ '@type': ['LocalBusiness', 'Organization'] })), page('/contact', [])]);
    const fresh = await request(`${ORIGIN}/contact`);
    assert.equal(fresh.cached, false, 'the evidence changed -> the stale recommendation is bypassed');
    assert.equal(fresh.schemaEvidence.organization.intent.action, 'generate');
    assert.deepEqual(ld(fresh).address, ADDRESS);

    const kept = await Recommendation.countDocuments({ projectId, ruleId: 'organization_schema' });
    assert.equal(kept, 2, 'older recommendation records are bypassed, never deleted');
  });

  test("REGRESSION: a Business Profile for a DIFFERENT website is not used (its phone/address are never published); a matching one is", async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seed(projectId, [page('/', [])]);
    const profile = { user_id: new mongoose.Types.ObjectId(), project_id: projectId, business_account_id: 'a', business_location_id: 'l', business_name: 'ASG Eye Hospital', category: 'Hospital', phone: '+91 99999 00000', website: 'https://asg-other.example/', address: '1 Other Road', business_status: 'OPEN' };
    await BusinessProfileMetadata.create(profile);

    const wrong = await request(`${ORIGIN}/`);
    assert.equal(ld(wrong)['@type'], 'Organization');
    assert.equal(ld(wrong).telephone, undefined);
    assert.equal(ld(wrong).address, undefined);
    assert.equal(wrong.schemaEvidence.organization.businessProfile.trusted, false);

    await BusinessProfileMetadata.updateOne({ project_id: projectId }, { $set: { website: `${ORIGIN}/`, business_name: 'Clinic Eye Centre', phone: '+91 11 4000 0000', address: '2-A Trust House, Parel, Mumbai' } });
    const right = await request(`${ORIGIN}/`);
    assert.equal(right.cached, false);
    assert.equal(ld(right)['@type'], 'Hospital');
    assert.equal(ld(right).telephone, '+91 11 4000 0000');
    assert.equal(ld(right).address, '2-A Trust House, Parel, Mumbai');
  });

  test("another project's entity is never used (the site registry is project-scoped)", async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const other = new mongoose.Types.ObjectId();
    projectIds.push(other);
    await seed(other, hospitalSitePages());
    await seed(projectId, [page('/', []), page('/gallery', [])]);
    const r = await request(`${ORIGIN}/gallery`);
    assert.equal(r.schemaEvidence.organization.site.found, false);
    assert.equal(r.schemaEvidence.organization.intent.placement, 'homepage');
    assert.equal(ld(r)['@type'], 'Organization');
  });

  test("the detection's schema intent travels with the issue into the resolved context (Issue -> Resolver)", async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seed(projectId, [page('/contact', [])]);
    await mongoose.connection.db.collection('seo_page_issues').updateMany({ projectId }, { $set: { context: { schema_intent: 'local_business_schema', scope: 'location_page' } } });
    const ctx = await IssueContextEngine.resolve(projectId.toString(), 'organization_schema', `${ORIGIN}/contact`);
    assert.equal(ctx.detectedSchemaIntent, 'local_business_schema');
    assert.match(JSON.stringify(ctx.expectedState), /LocalBusiness/);
  });

  test('the kill switch ODITO_ORG_SCHEMA_DETERMINISTIC=0 sends the issue back through the model path', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seed(projectId, [page('/', [])]);
    process.env.ODITO_ORG_SCHEMA_DETERMINISTIC = '0';
    try {
      await request(`${ORIGIN}/`);
      assert.ok(claudeCalls >= 1, 'the model path was taken');
    } finally { delete process.env.ODITO_ORG_SCHEMA_DETERMINISTIC; }
  });
});
