/**
 * STAGING-ONLY end-to-end check of the Organization sameAs fix against a REAL (disposable, local) WordPress with the REAL Rank Math
 * plugin and the REAL Odito SEO Bridge, driven by the real discovery, planner, fix service and verification over real HTTP.
 *
 *   node sameAsNodeE2E.mjs      (from odito_backend/, local Mongo reachable; PHP + WP-CLI + the staging WordPress under ../.tools)
 *
 * What is real: WordPress, Rank Math 1.0.278, the Bridge, an Application Password, wpRequest, the Bridge client, discovery (it reads the
 * REAL rendered front page and its REAL footer), entity resolution from Rank Math's REAL JSON-LD, the engine, the ledger (local Mongo)
 * and the rendered-page verification (a real same-site GET of the front page). What is supplied: the Task object, and a footer with
 * social links that a staging-only mu-plugin prints. Independent checks read Rank Math's option with WP-CLI and fetch the front page
 * themselves. It snapshots and restores everything it touches and removes its Application Password and mu-plugin. It never contacts
 * another host. Do not point it at a production site.
 */

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mock } from 'node:test';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import WordPressFixRecord from '../../model/WordPressFixRecord.js';
import oditoSeoBridgeService from '../../service/oditoSeoBridgeService.js';
import Recommendation from '../../../recommendations/model/Recommendation.js';
import { discoverSameAsProfiles, clearDiscoveryCache } from '../../../schema-evidence/sameAs/sameAsDiscovery.js';
import { jsonLdFromHtml } from '../../../schema-evidence/sameAs/sameAsVerification.js';
import { applyOrganizationFix, getOrganizationFixPreview, reverifyOrganizationFix, rollbackOrganizationFix } from '../organizationFixService.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..', '..', '..', '..', '..');
const PHP = path.join(ROOT, '.tools', 'php', 'php.exe');
const WPCLI = path.join(ROOT, '.tools', 'wp-cli.phar');
const WP = path.join(ROOT, '.tools', 'wordpress');
const SITE = 'http://localhost:8899';
const OPT = 'rank-math-options-titles';
const run = Date.now().toString(36);
const results = { pass: 0, fail: 0 };

const FB = 'https://www.facebook.com/acmeclinicstaging';
const LI = 'https://www.linkedin.com/company/acme-clinic-staging';
const IG = 'https://www.instagram.com/acmeclinicstaging';
const TW_HANDLE = 'acmeclinicx';

const check = (label, ok, detail = '') => { results[ok ? 'pass' : 'fail'] += 1; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  -> ${detail}`}`); };
const wp = (...args) => execFileSync(PHP, [WPCLI, `--path=${WP}`, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const stored = () => JSON.parse(wp('option', 'get', OPT, '--format=json'));
const setStored = (patch) => { const o = { ...stored(), ...patch }; wp('option', 'update', OPT, JSON.stringify(o), '--format=json'); };
const additional = () => String(stored().social_additional_profiles || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const cleanup = [];

async function waitForRest() {
  for (let i = 0; i < 60; i += 1) {
    try { if ((await fetch(`${SITE}/wp-json/`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('the staging server did not start');
}

function startServer() {
  const router = path.join(os.tmpdir(), `odito_sameas_e2e_router_${run}.php`);
  fs.writeFileSync(router, `<?php
$root = $_SERVER['DOCUMENT_ROOT'];
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if ($path !== '/' && is_file($root . $path)) { return false; }
$_SERVER['SCRIPT_NAME'] = '/index.php';
$_SERVER['SCRIPT_FILENAME'] = $root . '/index.php';
define('RANK_MATH_REGISTRATION_SKIP', true);
require $root . '/index.php';
`);
  cleanup.push(() => fs.rmSync(router, { force: true }));
  const server = spawn(PHP, ['-S', 'localhost:8899', '-t', WP, router], { stdio: 'ignore' });
  cleanup.push(() => server.kill());
}

/** A footer like a Divi Theme Builder footer: follow icons for the organization, a share button and a team member's own account. */
function installFooter() {
  const dir = path.join(WP, 'wp-content', 'mu-plugins');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `odito_sameas_e2e_${run}.php`);
  const html = [
    '<footer class="et-l et-l--footer"><div class="et_pb_section"><ul class="et_pb_module et_pb_social_media_follow">',
    `<li class="et_pb_social_media_follow_network_0_tb_footer"><a href="${FB}?utm_source=footer&fbclid=zzz">Follow</a></li>`,
    `<li class="et_pb_social_media_follow_network_1_tb_footer"><a href="${LI}">Follow</a></li>`,
    '</ul></div></footer>',
    '<div class="sharedaddy"><a href="https://www.facebook.com/sharer/sharer.php?u=http://localhost:8899/">Share</a></div>',
    '<div class="et_pb_team_member"><a href="https://www.linkedin.com/in/some-employee">Employee</a></div>',
  ].join('');
  fs.writeFileSync(file, `<?php\nadd_action('wp_footer', function () { echo '${html}'; });\n`);
  cleanup.push(() => fs.rmSync(file, { force: true }));
}

const frontPage = async () => (await fetch(`${SITE}/?nocache=${Date.now()}`)).text();
const renderedOrg = async () => {
  const { values } = jsonLdFromHtml(await frontPage());
  const nodes = [];
  const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') { if (v['@graph']) walk(v['@graph']); if (v['@type']) nodes.push(v); } };
  values.forEach(walk);
  return nodes.find((n) => [].concat(n['@type']).includes('Organization')) || null;
};

async function main() {
  console.log(`staging: ${SITE} (run ${run})`);
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 3000 });
  cleanup.push(() => mongoose.connection.close());
  const projectId = new mongoose.Types.ObjectId();
  const connectionId = new mongoose.Types.ObjectId();
  mock.method(Recommendation, 'findById', () => ({ select: () => ({ lean: async () => ({ projectId }) }) }));

  const before = wp('option', 'get', OPT, '--format=json');
  cleanup.push(() => wp('option', 'update', OPT, before, '--format=json'));
  const clean = () => setStored({ knowledgegraph_type: 'company', knowledgegraph_name: 'Acme Clinic Staging', social_additional_profiles: '', social_url_facebook: '', twitter_author_names: '' });
  clean();
  installFooter();

  const adminPw = wp('user', 'application-password', 'create', '1', `odito-sameas-e2e-${run}`, '--porcelain');
  cleanup.push(() => { for (const p of JSON.parse(wp('user', 'application-password', 'list', '1', '--format=json'))) if (p.name === `odito-sameas-e2e-${run}`) wp('user', 'application-password', 'delete', '1', p.uuid); });
  startServer();
  await waitForRest();

  const connection = { _id: connectionId, site_url: SITE, username: 'odito_admin', application_password: adminPw };
  const pageDoc = async (p) => ({ url: `${SITE}${p}`, structured_data: jsonLdFromHtml(await (await fetch(`${SITE}${p}`)).text()).values });
  const loadSitePages = async () => [await pageDoc('/'), await pageDoc('/sample-page/').catch(() => null)].filter((d) => d && d.structured_data.length);
  const mkTask = () => ({ _id: new mongoose.Types.ObjectId(), projectId, issueKey: 'sameas_array', pageUrl: `${SITE}/`, status: 'task_created', recommendationId: new mongoose.Types.ObjectId(), fixHistory: [], async save() {}, markModified() {} });
  const depsFor = (bridge = oditoSeoBridgeService) => ({
    wordPressService: { getHydratedConnectionOrThrow: async () => connection },
    bridge,
    loadSitePages,
    taskHistory: { applyImplementedTransition: async (t, opts) => { t.status = 'implemented'; t.fixHistory.push({ fixApplied: { externalWrite: opts.externalWrite, expectedAfterValue: opts.expectedAfterValueOverride } }); } },
    loadPageDoc: async () => null,
  });
  const discover = async () => { clearDiscoveryCache(); return discoverSameAsProfiles({ projectId, pageUrl: `${SITE}/` }, { loadPages: loadSitePages, loadCrawlLinks: async () => [], loadIntegrationProfiles: async () => ({ profiles: [], notes: [] }), isFetchable: () => true, limits: { cacheTtlMs: 0, maxPages: 3 } }); };

  // ── A. discovery over the REAL rendered front page ────────────────────────────────────────────────────────────
  console.log('A. discovery from the real rendered page and Rank Math JSON-LD');
  const d = await discover();
  const urls = d.candidates.map((c) => c.url).sort();
  check('the real Rank Math Organization is found: absent sameAs, @id <home>#organization', d.entity.state === 'absent' && d.entity.id === `${SITE}/#organization` && d.entity.hasHomeOrganizationId === true, JSON.stringify({ s: d.entity.state, id: d.entity.id }));
  check('footer follow links are candidates (tracking parameters removed); share button and employee account are NOT', JSON.stringify(urls) === JSON.stringify([FB, LI].sort()), JSON.stringify(urls));
  check('every candidate says where it was seen and that reachability was not checked', d.candidates.every((c) => c.sources[0].placement === 'footer' && c.reachability === 'not_checked'), JSON.stringify(d.candidates.map((c) => c.sources[0])));
  check('the employee account is explained as rejected', d.rejected.some((r) => r.url.includes('some-employee')), JSON.stringify(d.rejected.map((r) => r.url)));
  check('discovery wrote nothing', additional().length === 0 && stored().social_url_facebook === '');

  // ── B. preview, apply, independent read-back, rendered verification ─────────────────────────────────────────────
  console.log('B. preview → apply → saved + rendered verification');
  const taskB = mkTask();
  const depsB = depsFor();
  const input = { urls: [FB, LI] };
  const pB = await getOrganizationFixPreview(taskB, depsB, input);
  check('preview is ready, read-only, honest about concurrency, and shows JSON-LD for the existing @id', pB.plan.status === 'ready' && pB.concurrency.writes === 'read_then_write' && JSON.parse(pB.sameAs.recommendedJsonLd)['@id'] === `${SITE}/#organization` && additional().length === 0, `${pB.plan.status} ${pB.concurrency.writes}`);
  const rB = await applyOrganizationFix(taskB, { approved: true, expectedPlanFingerprint: pB.plan.fingerprint, actorId: new mongoose.Types.ObjectId(), ...input }, depsB);
  check('INDEPENDENT: WP-CLI sees exactly the two approved profiles in Rank Math\'s option', JSON.stringify(additional()) === JSON.stringify([FB, LI]), JSON.stringify(additional()));
  const org = await renderedOrg();
  check('INDEPENDENT: the REAL front page\'s Organization (same @id) now publishes both', Array.isArray(org?.sameAs) && org.sameAs.includes(FB) && org.sameAs.includes(LI) && org['@id'] === `${SITE}/#organization`, JSON.stringify(org?.sameAs));
  check('the engine verified both parts itself: saved read-back AND a live fetch of the public page', rB.fix.status === 'verified' && rB.fix.verification.saved.status === 'verified' && rB.fix.verification.rendered.status === 'verified' && rB.immediateVerification === 'success', JSON.stringify({ s: rB.fix.status, r: rB.fix.verification.rendered }));
  check('task implemented (never verified_fixed by this fix); externalWrite uses the typed field; expected URLs recorded', taskB.status === 'implemented' && taskB.fixHistory[0].fixApplied.externalWrite.field === 'organization_same_as' && taskB.fixHistory[0].fixApplied.expectedAfterValue.urls.length === 2, JSON.stringify(taskB.fixHistory[0]));
  const dAfter = await discover();
  check('discovery now reports the profiles as already present and the state existing_present', dAfter.state === 'existing_present' && dAfter.candidates.every((c) => c.status === 'already_present'), `${dAfter.state}`);

  // ── C. idempotency ───────────────────────────────────────────────────────────────────────────────────────────────
  console.log('C. the same approval twice');
  const again = await applyOrganizationFix(taskB, { approved: true, expectedPlanFingerprint: pB.plan.fingerprint, ...input }, depsB).catch((e) => e);
  check('a second apply of the same plan writes nothing more (no duplicates in the option)', additional().length === 2 && new Set(additional()).size === 2, JSON.stringify(additional()));
  check('and is refused or reported as already applied — never a second ledger record', (again.alreadyApplied === true || again.statusCode >= 400) && (await WordPressFixRecord.countDocuments({ taskId: taskB._id })) === 1, JSON.stringify({ a: again.alreadyApplied, c: again.code }));

  // ── D. rollback ─────────────────────────────────────────────────────────────────────────────────────────────────
  console.log('D. rollback keeps everything else');
  setStored({ social_additional_profiles: `${additional().join('\n')}\n${IG}` }); // a person adds Instagram by hand afterwards
  const rb = await rollbackOrganizationFix(taskB, { actorId: new mongoose.Types.ObjectId() }, depsB);
  check('rollback removed only the two Odito added; the person\'s Instagram stays', JSON.stringify(additional()) === JSON.stringify([IG]) && rb.fix.status === 'rolled_back', JSON.stringify(additional()));
  const orgAfter = await renderedOrg();
  check('INDEPENDENT: the real page no longer shows them and still shows the person\'s', !orgAfter.sameAs.includes(FB) && !orgAfter.sameAs.includes(LI) && orgAfter.sameAs.includes(IG), JSON.stringify(orgAfter.sameAs));
  check('rollback was read back and the public page re-verified', rb.fix.rollback.status === 'verified' && rb.fix.rollback.rendered.status === 'verified', JSON.stringify(rb.fix.rollback));

  // ── E. protected (Facebook/Twitter-derived) values ───────────────────────────────────────────────────────────────
  console.log('E. protected values are preserved and cannot be removed');
  clean();
  setStored({ social_url_facebook: FB, twitter_author_names: TW_HANDLE });
  const taskE = mkTask();
  const depsE = depsFor();
  const pE = await getOrganizationFixPreview(taskE, depsE, { urls: [FB, LI] });
  check('the Facebook profile Rank Math already publishes is not added again; only LinkedIn is planned', pE.proposedChanges.map((c) => c.after).join() === LI && pE.sameAs.alreadyPresent.map((a) => a.url).join() === FB, JSON.stringify(pE.proposedChanges));
  const pEr = await getOrganizationFixPreview(taskE, depsE, { urls: [], removeUrls: [FB] });
  check('removing a protected value is blocked', pEr.plan.status === 'blocked' && pEr.plan.code === 'PROTECTED_PROFILE', `${pEr.plan.status} ${pEr.plan.code}`);
  await applyOrganizationFix(taskE, { approved: true, expectedPlanFingerprint: pE.plan.fingerprint, urls: [FB, LI] }, depsE);
  check('INDEPENDENT: protected options untouched; LinkedIn added to the additional list only', stored().social_url_facebook === FB && stored().twitter_author_names === TW_HANDLE && JSON.stringify(additional()) === JSON.stringify([LI]), JSON.stringify({ fb: stored().social_url_facebook, add: additional() }));
  const orgE = await renderedOrg();
  check('INDEPENDENT: the real page publishes protected + added values in Rank Math\'s own order', orgE.sameAs[0] === FB && orgE.sameAs.includes(`https://twitter.com/${TW_HANDLE}`) && orgE.sameAs.includes(LI), JSON.stringify(orgE.sameAs));

  // ── F. explicit removal and its rollback ─────────────────────────────────────────────────────────────────────────
  console.log('F. removal of a managed profile');
  clean();
  setStored({ social_additional_profiles: `${IG}\n${LI}` });
  const taskF = mkTask();
  const depsF = depsFor();
  const inF = { urls: [], removeUrls: [IG] };
  const pF = await getOrganizationFixPreview(taskF, depsF, inF);
  await applyOrganizationFix(taskF, { approved: true, expectedPlanFingerprint: pF.plan.fingerprint, ...inF }, depsF);
  check('only the selected value is removed', JSON.stringify(additional()) === JSON.stringify([LI]), JSON.stringify(additional()));
  await rollbackOrganizationFix(taskF, {}, depsF);
  check('rollback puts it back (the Bridge add is idempotent)', additional().includes(IG) && additional().includes(LI), JSON.stringify(additional()));

  // ── G. a person edits the list while the fix runs ────────────────────────────────────────────────────────────────
  console.log('G. concurrent human edit');
  clean();
  const taskG = mkTask();
  const humanEdit = { ...oditoSeoBridgeService, updateSiteSchemaField: async (c, entity, field, value, op, o) => { if (op === 'add' && value === LI) setStored({ social_additional_profiles: `${additional().join('\n')}\n${IG}`.trim() }); return oditoSeoBridgeService.updateSiteSchemaField(c, entity, field, value, op, o); } };
  const depsG = depsFor(humanEdit);
  const pG = await getOrganizationFixPreview(taskG, depsG, { urls: [LI] });
  await applyOrganizationFix(taskG, { approved: true, expectedPlanFingerprint: pG.plan.fingerprint, urls: [LI] }, depsG);
  check('the person\'s Instagram and Odito\'s LinkedIn are both there (nothing overwritten)', additional().includes(IG) && additional().includes(LI), JSON.stringify(additional()));

  // ── H. page cache: saved but the public page still serves the old copy ────────────────────────────────────────────
  console.log('H. saved but not on the public page');
  clean();
  const taskH = mkTask();
  const staleCopy = await frontPage();
  const depsH = { ...depsFor(), verifyLiveRendered: async ({ pageUrl, expected }) => (await import('../../../schema-evidence/sameAs/sameAsVerification.js')).inspectRenderedSameAs({ structuredData: jsonLdFromHtml(staleCopy).values, pageUrl, expected }) };
  const pH = await getOrganizationFixPreview(taskH, depsH, { urls: [LI] });
  const rH = await applyOrganizationFix(taskH, { approved: true, expectedPlanFingerprint: pH.plan.fingerprint, urls: [LI] }, depsH);
  check('WordPress holds it but the (cached) page does not: verification FAILED with the cache reason; task stays implemented, not verified', rH.fix.status === 'verification_failed' && rH.fix.verification.saved.status === 'verified' && rH.fix.verification.rendered.status === 'failed' && rH.fix.verification.rendered.reasonCode === 'NOT_IN_RENDERED_PAGE' && rH.immediateVerification === 'failed' && taskH.status === 'implemented', JSON.stringify(rH.fix.verification.rendered));
  const rvH = await reverifyOrganizationFix(taskH, depsFor());
  check('once the page is fresh a re-check verifies it — without writing again', rvH.fix.status === 'verified' && additional().length === 1, `${rvH.fix.status}`);

  // ── I. unsupported source and a foreign page ──────────────────────────────────────────────────────────────────────
  console.log('I. unsupported source / outside the site');
  clean();
  const yoast = { ...oditoSeoBridgeService, getBridgeStatus: async (c) => ({ ...(await oditoSeoBridgeService.getBridgeStatus(c)), provider: 'yoast' }) };
  const taskI = mkTask();
  const pI = await getOrganizationFixPreview(taskI, depsFor(yoast), { urls: [LI] });
  const eI = await applyOrganizationFix(taskI, { approved: true, expectedPlanFingerprint: pI.plan.fingerprint, urls: [LI] }, depsFor(yoast)).catch((e) => e);
  check('another SEO plugin: manual steps, no change possible, nothing written', pI.plan.status === 'unsupported' && pI.sameAs.manual.steps.join(' ').includes('Yoast') && eI.code === 'FIELD_NOT_WRITABLE' && additional().length === 0, `${pI.plan.status} ${eI.code}`);
  const taskX = mkTask(); taskX.pageUrl = 'https://not-this-site.example/';
  const eX = await getOrganizationFixPreview(taskX, depsFor(), { urls: [LI] }).catch((e) => e);
  check('a page of another site is refused before anything is read or written', eX?.details?.reason === 'page_not_on_connected_site', `${eX?.code}`);

  await WordPressFixRecord.deleteMany({ projectId });
}

try {
  await main();
} catch (error) {
  check('no unexpected error', false, error?.stack || String(error));
} finally {
  for (const fn of cleanup.reverse()) { try { await fn(); } catch { /* best effort */ } }
  console.log(`\n${results.pass} passed, ${results.fail} failed`);
  process.exit(results.fail ? 1 : 0);
}
