/**
 * STAGING-ONLY end-to-end check of the Organization ADDRESS fix against a REAL (disposable, local) WordPress with the REAL Rank Math
 * plugin and the REAL Odito SEO Bridge (1.6.0), driven by the real evidence -> recommendation -> plan -> apply -> verify pipeline.
 *
 *   node organizationAddressNodeE2E.mjs      (from odito_backend/, local Mongo reachable; PHP + WP-CLI + the staging WordPress under ../.tools)
 *
 * What is real: WordPress, Rank Math 1.0.278, the Bridge, an Application Password, wpRequest, the Bridge client, the evidence builder,
 * the address assessment, the contract, the planner, the fix service, the ledger (local Mongo) and the rendered-page verification.
 * The "crawled page" is NOT a fixture: it is the JSON-LD Rank Math really prints into the front page <head> (rendered in-process by
 * WP-CLI), before and after the fix. What is supplied: the Task object, the owner's confirmed address, and the image probe (no network).
 *
 * All names and addresses are fictional test data. It snapshots and restores the options it touches and removes its Application
 * Password. It never contacts another host. Do not point it at a production site.
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
import { applyImageProbes, buildSchemaEvidence } from '../../../schema-evidence/schemaEvidence.js';
import { analyzeSiteEntity } from '../../../schema-evidence/siteEntity.js';
import { verifySchemaFix } from '../../../schema-evidence/schemaVerification.js';
import { buildOrganizationAddressContract } from '../../../recommendations/service/organizationAddressContract.js';
import { buildOrganizationSections } from '../../../recommendations/service/organizationRecommendation.js';
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

const ADDRESS = { streetAddress: '14 Lakeview Road', addressLocality: 'Rivertown', addressRegion: 'Karnataka', postalCode: '560001', addressCountry: 'IN' };
const OTHER = { streetAddress: '9 Harbour Street', addressLocality: 'Portville', addressRegion: 'Goa', postalCode: '403001', addressCountry: 'IN' };

const check = (label, ok, detail = '') => { results[ok ? 'pass' : 'fail'] += 1; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  -> ${detail}`}`); };
const wp = (...args) => execFileSync(PHP, [WPCLI, `--path=${WP}`, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const stored = () => JSON.parse(wp('option', 'get', OPT, '--format=json'));
const setStored = (patch) => { const o = { ...stored(), ...patch }; wp('option', 'update', OPT, JSON.stringify(o), '--format=json'); };
const cleanup = [];

async function waitForRest() {
  for (let i = 0; i < 60; i += 1) {
    try { if ((await fetch(`${SITE}/wp-json/`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('the staging server did not start');
}

function startServer() {
  const router = path.join(os.tmpdir(), `odito_addr_e2e_router_${run}.php`);
  // RANK_MATH_REGISTRATION_SKIP is Rank Math's own "skip registration" constant: without it, an unconnected staging site never loads
  // Rank Math's module manager, so Helper::is_module_active() (and therefore the Bridge's localSeoActive) is false in an HTTP request
  // even with the module enabled. A connected production site loads it normally. Staging only.
  fs.writeFileSync(router, `<?php
define( 'RANK_MATH_REGISTRATION_SKIP', true );
$root = $_SERVER['DOCUMENT_ROOT'];
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if ($path !== '/' && is_file($root . $path)) { return false; }
$_SERVER['SCRIPT_NAME'] = '/index.php';
$_SERVER['SCRIPT_FILENAME'] = $root . '/index.php';
require $root . '/index.php';
`);
  cleanup.push(() => fs.rmSync(router, { force: true }));
  const server = spawn(PHP, ['-S', 'localhost:8899', '-t', WP, router], { stdio: 'ignore' });
  cleanup.push(() => server.kill());
}

/** What Rank Math REALLY prints into the front page <head> right now, as the crawler would store it (a list of JSON-LD objects). */
function renderFrontPage() {
  const helper = path.join(os.tmpdir(), `odito_addr_e2e_render_${run}.php`);
  fs.writeFileSync(helper, `<?php
$_SERVER['REQUEST_URI'] = '/';
$_SERVER['SERVER_NAME'] = 'localhost';
$GLOBALS['wp']->main();
ob_start();
do_action( 'wp_head' );
$html = ob_get_clean();
preg_match_all( '#<script[^>]*type="application/ld\\+json"[^>]*>(.*?)</script>#s', $html, $m );
$blocks = array();
foreach ( $m[1] as $block ) { $d = json_decode( $block, true ); if ( is_array( $d ) ) { $blocks[] = $d; } }
echo "\\n<<JSONLD>>" . json_encode( $blocks ) . "<<END>>\\n";
`);
  try {
    const out = execFileSync(PHP, [WPCLI, `--path=${WP}`, '--exec=define("RANK_MATH_REGISTRATION_SKIP", true);', 'eval-file', helper], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const m = out.match(/<<JSONLD>>([\s\S]*?)<<END>>/);
    return m ? JSON.parse(m[1]) : [];
  } finally { fs.rmSync(helper, { force: true }); }
}

const pageDocFrom = (structured_data, scrapedAt = null) => ({
  url: `${SITE}/`, title: 'Eye Hospital Test Site', structured_data, meta_tags: {}, images: [], word_count: 300, page_type: { name: 'homepage' }, ...(scrapedAt ? { scraped_at: scrapedAt } : {}),
});
const orgNodeOf = (blocks) => blocks.flatMap((b) => (b['@graph'] ? b['@graph'] : [b])).find((n) => [].concat(n['@type'] || []).includes('Organization'));

function evidenceFrom(pageDoc, confirmed = ADDRESS) {
  return applyImageProbes(buildSchemaEvidence({
    issueId: 'organization_schema', pageUrl: pageDoc.url, pageData: pageDoc, pageType: 'homepage', site: analyzeSiteEntity([pageDoc]), profile: null,
    addressSources: confirmed ? { confirmed: { fields: confirmed, confirmedAt: new Date() } } : null,
  }), []);
}

async function main() {
  console.log(`staging: ${SITE} (run ${run})`);
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 3000 });
  cleanup.push(() => mongoose.connection.close());
  const projectId = new mongoose.Types.ObjectId();
  const connectionId = new mongoose.Types.ObjectId();
  mock.method(Recommendation, 'findById', () => ({ select: () => ({ lean: async () => ({ projectId }) }) }));

  // ── environment: remember and restore everything touched ────────────────────────────────────────────────────────
  const before = wp('option', 'get', OPT, '--format=json');
  cleanup.push(() => wp('option', 'update', OPT, before, '--format=json'));
  const modulesBefore = wp('option', 'get', 'rank_math_modules', '--format=json');
  cleanup.push(() => wp('option', 'update', 'rank_math_modules', modulesBefore, '--format=json'));
  const setLocalSeo = (on) => {
    const modules = JSON.parse(modulesBefore).filter((m) => m !== 'local-seo');
    wp('option', 'update', 'rank_math_modules', JSON.stringify(on ? [...modules, 'local-seo'] : modules), '--format=json');
  };
  const clean = ({ localSeo = true, address = {} } = {}) => {
    setLocalSeo(localSeo);
    setStored({ knowledgegraph_type: 'company', knowledgegraph_name: 'Eye Hospital Test Site', knowledgegraph_logo: '', knowledgegraph_logo_id: '', local_business_type: 'Organization', local_address: address });
  };
  clean();

  const adminPw = wp('user', 'application-password', 'create', '1', `odito-addr-e2e-${run}`, '--porcelain');
  cleanup.push(() => { for (const p of JSON.parse(wp('user', 'application-password', 'list', '1', '--format=json'))) if (p.name === `odito-addr-e2e-${run}`) wp('user', 'application-password', 'delete', '1', p.uuid); });
  startServer();
  await waitForRest();

  const connection = { _id: connectionId, site_url: SITE, username: 'odito_admin', application_password: adminPw };
  const mkTask = () => ({ _id: new mongoose.Types.ObjectId(), projectId, issueKey: 'organization_schema', pageUrl: `${SITE}/`, status: 'task_created', recommendationId: new mongoose.Types.ObjectId(), fixHistory: [], async save() {}, markModified() {} });
  const world = (pageDoc, { confirmed = ADDRESS, bridge = oditoSeoBridgeService } = {}) => {
    const state = { pageDoc };
    const deps = {
      wordPressService: { getHydratedConnectionOrThrow: async () => connection },
      bridge,
      collectEvidence: async () => evidenceFrom(state.pageDoc, confirmed),
      taskHistory: { applyImplementedTransition: async (t, opts) => { t.status = 'implemented'; t.fixHistory.push({ fixApplied: { externalWrite: opts.externalWrite } }); } },
      loadPageDoc: async () => state.pageDoc,
      loadSite: async () => analyzeSiteEntity([state.pageDoc]),
      // the REAL rendered verification (only the image fetch, a network call, is stubbed — this site declares no logo)
      verifyRendered: (args) => verifySchemaFix({ ...args, verifyImages: async (urls) => urls.map((url) => ({ url, ok: true, conclusive: true, status: 200, format: 'png' })) }),
      inspectAfterRollback: async () => ({ status: 'unverifiable', code: 'NO_POST_WRITE_CRAWL', reasons: ['not recrawled'] }),
    };
    return { state, deps };
  };

  // ── A. the whole path on a page rendered by the real Rank Math ───────────────────────────────────────────────────
  console.log('A. real page -> recommendation -> preview -> apply -> real re-render -> verification -> rollback');
  const blocksBefore = renderFrontPage();
  const orgBefore = orgNodeOf(blocksBefore);
  check('SETUP: Rank Math really publishes an Organization entity WITHOUT an address (the finding)', !!orgBefore && !orgBefore.address && orgBefore['@id'] === `${SITE}/#organization`, JSON.stringify(orgBefore));
  const docBefore = pageDocFrom(blocksBefore);
  const ev = evidenceFrom(docBefore);
  check('the recommendation no longer says "reuse": the entity lacks an address and a confirmed one exists -> extend the existing entity', ev.organization.intent.addressDemand === true && ev.organization.intent.action === 'generate' && ev.organization.intent.mode === 'extend_existing', JSON.stringify({ a: ev.organization.intent.action, m: ev.organization.intent.mode }));
  const contract = buildOrganizationAddressContract({ evidence: ev, projectId: String(projectId) });
  check('the contract is READY, valid, requires approval and does not modify the website', contract.state === 'ready' && contract.validation.valid && contract.requiresApproval && !contract.modifiesWebsite, JSON.stringify(contract.validation));
  check('the exact diff is the address and nothing else', contract.diff.changes.length === 1 && contract.diff.changes[0].path === 'address' && contract.diff.lines.filter((l) => l.type === 'remove').length === 0);
  check('the text states the missing property and does NOT claim a duplicate-entity problem', /address property of your existing Organization/.test(buildOrganizationSections(ev).recommendedFix) && !/second copy would create a duplicate/i.test(JSON.stringify(buildOrganizationSections(ev))));

  const taskA = mkTask();
  const w = world(docBefore);
  const pA = await getOrganizationFixPreview(taskA, w.deps);
  check('preview: ready, one change (address), read-only', pA.plan.status === 'ready' && pA.plan.changes.map((c) => c.field).join() === 'address' && JSON.stringify(JSON.parse(pA.plan.changes[0].after)) === JSON.stringify(ADDRESS), `${pA.plan.status} ${pA.plan.changes.map((c) => c.field)}`);
  check('preview wrote nothing: Rank Math still has no address', Object.keys(stored().local_address || {}).length === 0);
  check('the expected entity (validated) is the existing one plus the address', pA.validation.valid && pA.expectedEntity['@id'] === `${SITE}/#organization` && JSON.stringify(pA.expectedEntity.address) === JSON.stringify({ '@type': 'PostalAddress', ...ADDRESS }), JSON.stringify(pA.validation.errors));

  const rA = await applyOrganizationFix(taskA, { approved: true, expectedPlanFingerprint: pA.plan.fingerprint, actorId: new mongoose.Types.ObjectId() }, w.deps);
  check('apply: "applied" through ONE conditional UPDATE, with an operation id', rA.fix.status === 'applied' && rA.fix.changes[0].atomic === true && rA.fix.changes[0].writeMode === 'conditional_update', JSON.stringify(rA.fix.changes));
  check('INDEPENDENT: WP-CLI reads Rank Math\'s option and finds exactly the approved address', JSON.stringify(stored().local_address) === JSON.stringify(ADDRESS), JSON.stringify(stored().local_address));
  check('the other Rank Math settings were not touched', stored().knowledgegraph_name === 'Eye Hospital Test Site' && stored().knowledgegraph_type === 'company');
  check('the task is "implemented" — never verified_fixed by the apply itself', taskA.status === 'implemented' && rA.fix.verification.saved.status === 'verified' && rA.fix.verification.rendered.status === 'pending');

  const rvPending = await reverifyOrganizationFix(taskA, w.deps);
  check('before any re-crawl the rendered page is PENDING (the stored page still has no address)', rvPending.fix.verification.rendered.status === 'pending' || rvPending.fix.verification.rendered.status === 'failed', rvPending.fix.verification.rendered.status);

  const blocksAfter = renderFrontPage();
  const orgAfter = orgNodeOf(blocksAfter);
  check('INDEPENDENT RENDER: the real front page now publishes the address on the SAME entity (same @id, one entity)', orgAfter?.['@id'] === orgBefore['@id'] && JSON.stringify(orgAfter.address) === JSON.stringify({ '@type': 'PostalAddress', ...ADDRESS }), JSON.stringify(orgAfter));
  const orgCount = blocksAfter.flatMap((b) => (b['@graph'] ? b['@graph'] : [b])).filter((n) => [].concat(n['@type'] || []).includes('Organization')).length;
  check('still exactly one Organization entity (no duplicate)', orgCount === 1, String(orgCount));
  const typesBefore = blocksBefore.flatMap((b) => (b['@graph'] ? b['@graph'] : [b])).map((n) => `${n['@id'] || ''}|${[].concat(n['@type'] || []).join('+')}`).sort();
  const typesAfter = blocksAfter.flatMap((b) => (b['@graph'] ? b['@graph'] : [b])).map((n) => `${n['@id'] || ''}|${[].concat(n['@type'] || []).join('+')}`).sort();
  check('every other structured-data entity is still there', typesBefore.every((k) => typesAfter.includes(k)), JSON.stringify(typesBefore.filter((k) => !typesAfter.includes(k))));

  w.state.pageDoc = pageDocFrom(blocksAfter, new Date(Date.now() + 1000));
  const rvDone = await reverifyOrganizationFix(taskA, w.deps);
  check('VERIFIED: the re-crawled page carries the approved address, nothing else disappeared, no duplicate -> saved AND rendered verified', rvDone.fix.verification.rendered.status === 'verified' && rvDone.fix.verification.saved.status === 'verified' && rvDone.fix.status === 'verified', JSON.stringify(rvDone.fix.verification.rendered));

  const rb = await rollbackOrganizationFix(taskA, { actorId: new mongoose.Types.ObjectId() }, w.deps);
  check('rollback: the address is cleared through the Bridge and read back (status verified)', rb.fix.rollback.status === 'verified' && Object.keys(stored().local_address || {}).length === 0, `${rb.fix.rollback.status} ${JSON.stringify(stored().local_address)}`);
  check('INDEPENDENT RENDER after rollback: the address is gone again, the entity remains', !orgNodeOf(renderFrontPage())?.address && !!orgNodeOf(renderFrontPage()));
  check('the rest of Rank Math\'s settings survived apply and rollback', stored().knowledgegraph_name === 'Eye Hospital Test Site');

  // ── B. a stale approval ──────────────────────────────────────────────────────────────────────────────────────────
  console.log('B. stale approvals are refused');
  clean();
  const taskB = mkTask();
  const wB = world(pageDocFrom(renderFrontPage()));
  const pB = await getOrganizationFixPreview(taskB, wB.deps);
  setStored({ local_address: OTHER }); // an editor saves a different address after the preview was shown
  const eB = await applyOrganizationFix(taskB, { approved: true, expectedPlanFingerprint: pB.plan.fingerprint }, wB.deps).catch((e) => e);
  check('apply with the old fingerprint -> CONFLICT preview_stale, nothing overwritten', eB?.code === 'CONFLICT' && eB?.details?.reason === 'preview_stale' && JSON.stringify(stored().local_address) === JSON.stringify(OTHER), `${eB?.code} ${eB?.details?.reason}`);
  check('and no task transition', taskB.status === 'task_created');

  // ── C. an editor saves between plan and write ───────────────────────────────────────────────────────────────────
  console.log('C. concurrent edit between plan and write');
  clean();
  const taskC = mkTask();
  const humanEdit = { ...oditoSeoBridgeService, updateSiteSchemaField: async (c, entity, field, ...rest) => { if (field === 'address') setStored({ local_address: OTHER }); return oditoSeoBridgeService.updateSiteSchemaField(c, entity, field, ...rest); } };
  const wC = world(pageDocFrom(renderFrontPage()), { bridge: humanEdit });
  const pC = await getOrganizationFixPreview(taskC, wC.deps);
  const eC = await applyOrganizationFix(taskC, { approved: true, expectedPlanFingerprint: pC.plan.fingerprint }, wC.deps).catch((e) => e);
  check('the REAL Bridge refuses the stale write (compare-and-set on the address); the editor\'s address is untouched', eC?.code === 'CONFLICT' && JSON.stringify(stored().local_address) === JSON.stringify(OTHER), `${eC?.code} ${JSON.stringify(stored().local_address)}`);
  check('recorded as conflict_detected, nothing applied, task untouched', (await WordPressFixRecord.findOne({ taskId: taskC._id }))?.status === 'conflict_detected' && taskC.status === 'task_created');

  // ── D. Local SEO is off ──────────────────────────────────────────────────────────────────────────────────────────
  console.log('D. Rank Math\'s Local SEO module is off');
  clean({ localSeo: false });
  const taskD = mkTask();
  const wD = world(pageDocFrom(renderFrontPage()));
  const pD = await getOrganizationFixPreview(taskD, wD.deps);
  check('the address is HELD BACK with the reason and the instruction (nothing to approve)', pD.plan.blocked.some((b) => b.code === 'LOCAL_SEO_REQUIRED') && pD.plan.changes.length === 0 && pD.approvalStatus === 'not_available', JSON.stringify(pD.plan.blocked));
  const eD = await applyOrganizationFix(taskD, { approved: true, expectedPlanFingerprint: pD.plan.fingerprint }, wD.deps).catch((e) => e);
  check('apply is refused and writes nothing', eD?.code === 'VALIDATION_FAILED' && Object.keys(stored().local_address || {}).length === 0, `${eD?.code}`);

  // ── E. Rank Math already has a different address ────────────────────────────────────────────────────────────────
  console.log('E. an existing, different address is never overwritten');
  // The stored crawl predates an editor's change: the page (as crawled) has no address, but Rank Math now holds a different one.
  // (A page rendered AFTER that change would already show the address, and the finding would not exist.)
  clean();
  const staleCrawl = pageDocFrom(renderFrontPage());
  setStored({ local_address: OTHER });
  const taskE = mkTask();
  const wE = world(staleCrawl);
  const pE = await getOrganizationFixPreview(taskE, wE.deps);
  check('kept and reported; no change is planned', pE.plan.changes.length === 0 && pE.plan.preserved.some((p) => p.field === 'address'), JSON.stringify(pE.plan));
  const eE = await applyOrganizationFix(taskE, { approved: true, expectedPlanFingerprint: pE.plan.fingerprint }, wE.deps).catch((e) => e);
  check('apply refused; the existing address is untouched', !!eE?.code && JSON.stringify(stored().local_address) === JSON.stringify(OTHER), `${eE?.code}`);
}

main()
  .catch((e) => { check('no unexpected exception', false, e?.stack || String(e)); })
  .finally(() => {
    for (const fn of cleanup.reverse()) { try { fn(); } catch { /* best effort */ } }
    // eslint-disable-next-line no-console
    console.log(`\n${results.pass} passed, ${results.fail} failed`);
    process.exit(results.fail ? 1 : 0);
  });
