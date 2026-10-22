/**
 * LIVE capture (real site + real Claude + real server), opt-in. Reproduces the Organization-address investigation and writes the exact
 * API payload to a file, so a symptom can be traced layer by layer instead of inferred from rendered text.
 *   node src/modules/ai-investigation/integration/liveOrgCapture.mjs <outFile> [pageUrl] [places|none]
 * "places" seeds the isolated project with an UNVERIFIED Google Places selection ("new york", no website) like the reported case.
 */
import fs from 'node:fs';
import mongoose from 'mongoose';
import { connectTestDb, seedTenant, apiClient, poll, cleanupTenant } from './harness.mjs';

const OUT = process.argv[2];
const PAGE = process.argv[3] || 'https://www.sapphiredigitalagency.com/';
const PLACES = (process.argv[4] || 'places') === 'places';
const BASE = process.env.INVESTIGATION_IT_BASE || 'http://localhost:5055';

await connectTestDb();
const tenant = await seedTenant({ label: 'org', siteUrl: `${new URL(PAGE).origin}/` });
if (PLACES) {
  await mongoose.connection.db.collection('seoprojects').updateOne({ _id: tenant.project._id }, { $set: { verified_business: { placeId: 'ChIJtest', name: 'Sapphire Digital', address: 'new york', city: 'new york' } } });
}
const api = apiClient(BASE, tenant.token);
try {
  const started = await api('POST', '/recommendations/investigations', {
    projectId: tenant.projectId, issueId: 'organization_schema', pageUrl: PAGE, issueSource: 'on_page',
    ruleMetadata: { title: 'Organization schema incomplete - missing recommended fields: address', category: 'Structured Data', severity: 'medium' },
  });
  if (started.status !== 202) { console.log('start failed', JSON.stringify(started.json)); process.exit(1); }
  const out = await poll(api, tenant.projectId, started.json.data.id);
  const prep = out.data?.result ? await api('POST', `/recommendations/investigations/${started.json.data.id}/prepare-fix`, { projectId: tenant.projectId }) : null;
  fs.writeFileSync(OUT, JSON.stringify({ investigation: out.data, prepare: prep?.json || null }, null, 2));
  console.log('status', out.data?.status, '| saved', OUT);
} finally {
  await cleanupTenant(tenant);
  await mongoose.disconnect();
}
