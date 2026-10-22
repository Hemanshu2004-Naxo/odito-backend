/**
 * LIVE check (real external services). Not part of routine test runs: run it manually.
 *
 *   node src/modules/ai-investigation/integration/liveCheck.mjs [pageUrl] [issueId]
 *
 * Needs: a running Odito server (default http://localhost:5055) pointed at the isolated test database, ANTHROPIC_API_KEY in .env,
 * and network access. It fetches the real site through the SSRF-safe path and makes a real Claude call. It only READS the website and
 * never applies anything. The printed report contains no secrets.
 */
import { connectTestDb, seedTenant, apiClient, poll, cleanupTenant } from './harness.mjs';
import mongoose from 'mongoose';

const PAGE = process.argv[2] || 'https://www.sapphiredigitalagency.com/about-us';
const ISSUE = process.argv[3] || 'breadcrumblist_schema';
const BASE = process.env.INVESTIGATION_IT_BASE || 'http://localhost:5055';
const origin = new URL(PAGE).origin;

await connectTestDb();
const tenant = await seedTenant({ label: 'live', siteUrl: `${origin}/` });
const api = apiClient(BASE, tenant.token);
try {
  const started = await api('POST', '/recommendations/investigations', {
    projectId: tenant.projectId, issueId: ISSUE, pageUrl: PAGE, issueSource: 'on_page',
    ruleMetadata: { title: 'BreadcrumbList schema missing', category: 'Structured Data', severity: 'medium' },
  });
  console.log('start ->', started.status, started.json?.data?.status, 'joined=', started.json?.meta?.joinedExisting);
  if (started.status !== 202) { console.log(JSON.stringify(started.json)); process.exit(1); }
  const id = started.json.data.id;
  const out = await poll(api, tenant.projectId, id, { onTick: () => {} });
  console.log('stages seen:', out.seen.join(' > '));
  const d = out.data;
  if (!d) { console.log('poll failed', JSON.stringify(out)); process.exit(1); }
  console.log('final status:', d.status, '| model:', d.model || '(see below)', '| prompt v', d.promptVersion, '| family', d.planFamily);
  console.log('\n— evidence ledger —');
  const dec = d.evidence.find((e) => e.kind === 'render_decision'); console.log('render decision:', dec?.summary);
  for (const e of d.evidence) console.log(` ${e.id.padEnd(4)} ${e.kind.padEnd(20)} ${e.status.padEnd(11)} ${e.source.padEnd(14)} http=${e.httpStatus ?? '-'}  ${e.summary}${e.error ? `  [${e.error.code}]` : ''}`);
  const r = d.result;
  if (r) {
    console.log('\n— result —');
    console.log({ investigationStatus: r.investigationStatus, issueStatus: r.issueStatus, confidence: r.confidence, eligible: r.automaticFixEligibility, approval: r.requiresHumanApproval, lifecycle: r.lifecycle });
    console.log('proposal fingerprint:', r.proposal?.fingerprint?.slice(0, 16), '| bound to', JSON.stringify(r.proposal?.boundTo?.issueId), r.proposal?.boundTo?.pageUrl);
    console.log('\n— findings (basis decided by the server) —');
    for (const f of r.findings || []) console.log(` [${f.basis}${f.claimedBasis !== f.basis ? ` (model claimed ${f.claimedBasis})` : ''}${f.absence ? ', absence' : ''}] ${f.statement.slice(0, 150)}  ${f.evidenceIds.join(',')}${f.note ? `  !! ${f.note}` : ''}`);
    console.log('\n— server safety checks —');
    for (const c of r.safetyChecks || []) console.log(` ${c.passed ? 'PASS' : 'FAIL'}  ${c.name}  ${c.detail.slice(0, 140)}`);
    if (r.reviewItems?.length) console.log('\n— needs review —', JSON.stringify(r.reviewItems, null, 1).slice(0, 1500));
    console.log('summary:', r.summary);
    console.log('rootCause:', r.rootCause);
    console.log('solution:', r.recommendedSolution);
    console.log('evidence cited:', r.evidence.map((e) => `${e.evidenceId}(${e.kind})`).join(', '));
    console.log('limitations:', r.limitations, '| needs:', r.additionalEvidenceRequested);
    for (const c of r.codeOrConfiguration) console.log(`code[${c.language}] valid=${c.jsonLd?.valid} notes=${JSON.stringify(c.notes)}\n${c.content.slice(0, 900)}`);
  }
  console.log('\nwarnings:', d.warnings);
  // Fix lifecycle on the REAL server. The isolated project has no WordPress connection and no crawl, so the correct answers are refusals.
  const prep = await api('POST', `/recommendations/investigations/${id}/prepare-fix`, { projectId: tenant.projectId });
  console.log('\nprepare-fix ->', prep.status, prep.json?.code || '', '|', prep.json?.message || '', '| manual steps offered:', prep.json?.details?.manualPlan?.length ?? 0);
  const tasks = await mongoose.connection.db.collection('tasks').countDocuments({ projectId: tenant.project._id });
  console.log('tasks created by prepare-fix refusal:', tasks);
  const ver = await api('POST', `/recommendations/investigations/${id}/verify`, { projectId: tenant.projectId });
  console.log('verify (real startUrlVerification guard) ->', ver.status, ver.json?.code || '', '|', ver.json?.message || '');
  const other = await seedTenant({ label: 'other', siteUrl: 'https://other-tenant.example/' });
  const apiOther = apiClient(BASE, other.token);
  const x = await apiOther('GET', `/recommendations/investigations/${id}?projectId=${other.projectId}`);
  console.log('other tenant GET ->', x.status, '(expect 404)');
  const y = await apiOther('GET', `/recommendations/investigations/${id}?projectId=${tenant.projectId}`);
  console.log('other tenant naming this project ->', y.status, '(expect 403)');
  await cleanupTenant(other);
  // The persisted document, read straight from MongoDB (not through the API):
  const doc = await mongoose.connection.db.collection('ai_investigations').findOne({ _id: new mongoose.Types.ObjectId(id) });
  console.log('\nMongoDB document:', { status: doc.status, activeKey: doc.activeKey, tokens: doc.tokens, model: doc.model, evidenceTrace: doc.evidenceTrace?.length, hasResult: !!doc.result });
} finally {
  await cleanupTenant(tenant);
  await mongoose.disconnect();
}
