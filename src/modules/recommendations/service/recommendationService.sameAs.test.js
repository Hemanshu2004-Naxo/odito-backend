import { describe, test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import recommendationService from './recommendationService.js';
import claudeService from './claudeService.js';
import Recommendation from '../model/Recommendation.js';
import { clearDiscoveryCache } from '../../schema-evidence/sameAs/sameAsDiscovery.js';

/**
 * sameas_array end to end: real service, real IssueContext pipeline, real discovery over the stored crawl, live local Mongo
 * (auto-skip when unreachable). The model is mocked and must NEVER be called. The site is http:// so discovery makes no network
 * request (it fetches only public HTTPS pages); TEST DATA ONLY: ".example" domain, fictional business.
 */

let mongoAvailable = false;
before(async () => {
  try { await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 }); mongoAvailable = true; } catch { mongoAvailable = false; }
});
const projectIds = [];
after(async () => {
  if (mongoAvailable) {
    const db = mongoose.connection.db;
    await Recommendation.deleteMany({ projectId: { $in: projectIds } });
    for (const c of ['seo_page_data', 'seo_page_issues', 'seo_social_links', 'tasks']) await db.collection(c).deleteMany({ projectId: { $in: projectIds } });
    await mongoose.connection.close();
  }
});

const ORIGIN = 'http://sameas-reco-test.example';
const ORG_ID = `${ORIGIN}/#organization`;
const LI = 'https://www.linkedin.com/company/sameas-reco-test';
const FB = 'https://www.facebook.com/sameasrecotest';
const org = (extra = {}) => ({ '@type': 'Organization', '@id': ORG_ID, name: 'SameAs Reco Test', url: `${ORIGIN}/`, logo: { '@type': 'ImageObject', url: `${ORIGIN}/logo.png` }, ...extra });
const doc = (path, graphNode) => ({ url: `${ORIGIN}${path}`, structured_data: [{ '@context': 'https://schema.org', '@graph': graphNode ? [graphNode] : [] }], meta_tags: {}, page_type: 'generic' });

async function seed(projectId, pages, socialLinks = []) {
  const db = mongoose.connection.db;
  for (const c of ['seo_page_data', 'seo_page_issues', 'seo_social_links']) await db.collection(c).deleteMany({ projectId });
  await db.collection('seo_page_data').insertMany(pages.map((p) => ({ projectId, ...p })));
  await db.collection('seo_page_issues').insertMany(pages.map((p) => ({ projectId, page_url: p.url, issue_code: 'sameas_array', rule_id: 'sameas_array', status: 'open', severity: 'low', dedup_key: `sameas-${projectId}-${p.url}` })));
  if (socialLinks.length) await db.collection('seo_social_links').insertMany(socialLinks.map((l) => ({ projectId, discoveredAt: new Date(), ...l })));
}

describe('recommendationService — sameas_array (deterministic, discovery-driven)', () => {
  let projectId; let claudeCalls;
  beforeEach(async () => {
    mock.restoreAll();
    clearDiscoveryCache();
    claudeCalls = 0;
    mock.method(claudeService, 'isAvailable', () => true);
    mock.method(claudeService, 'generate', async () => { claudeCalls += 1; throw new Error('the model must not be called for sameas_array'); });
    if (!mongoAvailable) return;
    projectId = new mongoose.Types.ObjectId();
    projectIds.push(projectId);
  });

  const request = (pageUrl = `${ORIGIN}/contact`) => recommendationService.getOrGenerate({
    projectId: projectId.toString(), issueId: 'sameas_array', pageUrl, issueSource: 'on_page',
    ruleMetadata: { title: 'Organization schema missing sameAs array', severity: 'low' },
  });
  const sections = (r) => r.recommendation.sections;

  test('nothing found: an honest explanation — never "not provided in context", never an empty array or a placeholder URL', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seed(projectId, [doc('/', org()), doc('/contact', org())]);
    const r = await request();
    assert.equal(claudeCalls, 0); assert.equal(r.source, 'template');
    const s = sections(r);
    assert.doesNotMatch(s.recommendedVersion, /not provided in context/i);
    assert.match(s.recommendedVersion, /No organization profile links were found/);
    assert.match(s.recommendedVersion, /will not invent one/);
    assert.doesNotMatch(s.recommendedVersion, /sameAs"\s*:\s*\[\s*\]/);
    assert.doesNotMatch(JSON.stringify(s), /example\.(com|org)|your-?company/i);
    assert.equal(r.recommendation.changeSummary.items[0].field, 'Organization.sameAs');
    assert.equal(r.recommendation.sourceAttribution.promptPath, 'deterministic_same_as');
    assert.equal(r.recommendation.sourceAttribution.contextSources.llmUsed, false);
  });

  test('profiles the site itself declares become valid JSON-LD for the EXISTING Organization with only sameAs added', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    // The home page already declares LI on the same Organization; this page lacks it.
    await seed(projectId, [doc('/', org({ sameAs: [LI] })), doc('/contact', org())]);
    const r = await request();
    assert.equal(claudeCalls, 0);
    const s = sections(r);
    const json = JSON.parse(s.recommendedVersion);
    assert.equal(json['@id'], ORG_ID); assert.equal(json.name, 'SameAs Reco Test');
    assert.deepEqual(json.logo, { '@type': 'ImageObject', url: `${ORIGIN}/logo.png` });
    assert.deepEqual(json.sameAs, [LI]);
    assert.match(s.implementationExample.content, /<script type="application\/ld\+json">/);
    assert.match(s.recommendedFix, /do not add a second Organization/);
    assert.equal(r.recommendation.sourceAttribution.contextSources.confident, 1);
  });

  test('links that only the stored crawl saw need confirmation: listed with why, NOT written into the markup', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seed(projectId, [doc('/', org()), doc('/contact', org())], [
      { platform: 'linkedin', url: LI, sourceUrl: `${ORIGIN}/` }, { platform: 'linkedin', url: LI, sourceUrl: `${ORIGIN}/contact` },
      { platform: 'facebook', url: FB, sourceUrl: `${ORIGIN}/` },
    ]);
    const r = await request();
    const s = sections(r);
    assert.match(s.recommendedVersion, /could not confirm/);
    assert.ok(s.recommendedVersion.includes(LI) && s.recommendedVersion.includes(FB));
    assert.match(s.recommendedVersion, /Nothing is added until you do/);
    assert.throws(() => JSON.parse(s.recommendedVersion));
    assert.equal(s.implementationExample.type, 'text');
    assert.equal(r.recommendation.sourceAttribution.contextSources.needConfirmation, 2);
  });

  test('a second Organization entity is refused (user-facing 409), nothing stored', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seed(projectId, [{ ...doc('/contact'), structured_data: [{ '@graph': [org(), { ...org(), '@id': `${ORIGIN}/#second` }] }] }]);
    await assert.rejects(request(), (e) => e.userFacing === true && e.code === 'SAMEAS_DUPLICATE_ENTITIES' && e.statusCode === 409);
    assert.equal(await Recommendation.countDocuments({ projectId }), 0);
  });

  test('no Organization at all is refused with a clear message', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seed(projectId, [doc('/contact')]);
    await assert.rejects(request(), (e) => e.code === 'SAMEAS_NO_ORGANIZATION');
  });

  test('cached while the site is unchanged; a changed site (new declared profile) produces a new recommendation', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seed(projectId, [doc('/', org()), doc('/contact', org())]);
    const first = await request(); assert.equal(first.cached, false);
    assert.equal((await request()).cached, true);
    await seed(projectId, [doc('/', org({ sameAs: [LI] })), doc('/contact', org())]);
    clearDiscoveryCache();
    const changed = await request();
    assert.equal(changed.cached, false);
    assert.deepEqual(JSON.parse(sections(changed).recommendedVersion).sameAs, [LI]);
  });
});
