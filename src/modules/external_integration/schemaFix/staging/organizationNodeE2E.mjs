/**
 * STAGING-ONLY end-to-end check of the Organization fix's reliability behaviour against a REAL (disposable, local) WordPress with the
 * REAL Rank Math plugin and the REAL Odito SEO Bridge, driven by the real fix service over real HTTP.
 *
 *   node organizationNodeE2E.mjs      (from odito_backend/, local Mongo reachable; PHP + WP-CLI + the staging WordPress under ../.tools)
 *
 * What is real: WordPress, Rank Math 1.0.278, the Bridge (1.5.0), an Application Password, wpRequest, the Bridge client, the Organization
 * service and the WordPressFixRecord ledger (local Mongo). What is supplied: the page evidence (a fixture) and the Task object.
 * Independent checks read Rank Math's option straight from the database with WP-CLI. It snapshots and restores the options it touches and
 * removes its Application Passwords. It never contacts another host. Do not point it at a production site.
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
import { WordPressConnectionError } from '../../service/wordPressService.js';
import Recommendation from '../../../recommendations/model/Recommendation.js';
import { applyImageProbes, buildSchemaEvidence } from '../../../schema-evidence/schemaEvidence.js';
import { analyzeSiteEntity } from '../../../schema-evidence/siteEntity.js';
import { REAL_LOGO, probeOk } from '../../../schema-evidence/__fixtures__/clinicSite.js';
import { page } from '../../../schema-evidence/__fixtures__/hospitalSite.js';
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
  const router = path.join(os.tmpdir(), `odito_org_e2e_router_${run}.php`);
  fs.writeFileSync(router, `<?php
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

const evidence = applyImageProbes(
  buildSchemaEvidence({ issueId: 'organization_schema', pageUrl: `${SITE}/`, pageData: page('/', [], { meta_tags: { 'og:site_name': ['Clinic Eye Centre'] }, images: [{ src: REAL_LOGO, alt: 'Clinic logo' }] }), pageType: 'homepage', site: analyzeSiteEntity([]), profile: null }),
  [probeOk(REAL_LOGO)],
);

const timeout = () => new WordPressConnectionError('TIMEOUT', 'The WordPress site took too long to respond.', 504);

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
  const modules = JSON.parse(modulesBefore);
  wp('option', 'update', 'rank_math_modules', JSON.stringify([...new Set([...modules, 'local-seo'])]), '--format=json');
  const clean = () => setStored({ knowledgegraph_type: 'company', knowledgegraph_name: '', knowledgegraph_logo: '', knowledgegraph_logo_id: '', local_business_type: 'Organization', local_address: { streetAddress: '2-A Trust House', addressLocality: 'Parel', addressRegion: 'MH', postalCode: '400012', addressCountry: 'IN' } });
  clean();

  const adminPw = wp('user', 'application-password', 'create', '1', `odito-org-e2e-${run}`, '--porcelain');
  cleanup.push(() => { for (const p of JSON.parse(wp('user', 'application-password', 'list', '1', '--format=json'))) if (p.name === `odito-org-e2e-${run}`) wp('user', 'application-password', 'delete', '1', p.uuid); });
  startServer();
  await waitForRest();

  const connection = { _id: connectionId, site_url: SITE, username: 'odito_admin', application_password: adminPw };
  const mkTask = () => ({ _id: new mongoose.Types.ObjectId(), projectId, issueKey: 'organization_schema', pageUrl: `${SITE}/`, status: 'task_created', recommendationId: new mongoose.Types.ObjectId(), fixHistory: [], async save() {}, markModified() {} });
  const depsFor = (bridge = oditoSeoBridgeService, extra = {}) => ({
    wordPressService: { getHydratedConnectionOrThrow: async () => connection },
    bridge,
    collectEvidence: async () => evidence,
    taskHistory: { applyImplementedTransition: async (t, opts) => { t.status = 'implemented'; t.fixHistory.push({ fixApplied: { externalWrite: opts.externalWrite } }); } },
    loadPageDoc: async () => null,
    loadSite: async () => analyzeSiteEntity([]),
    verifyRendered: async () => ({ status: 'unverifiable', code: 'NO_POST_WRITE_CRAWL', reasons: ['The page has not been re-crawled since the fix was applied.'] }),
    inspectAfterRollback: async () => ({ status: 'unverifiable', code: 'NO_POST_WRITE_CRAWL', reasons: ['not recrawled'] }),
    ...extra,
  });
  const approveNow = async (task, deps) => {
    const p = await getOrganizationFixPreview(task, deps);
    return { p, run: (over = {}) => applyOrganizationFix(task, { approved: true, expectedPlanFingerprint: p.plan.fingerprint, actorId: new mongoose.Types.ObjectId(), ...over }, deps) };
  };

  // ── A. the plain path ────────────────────────────────────────────────────────────────────────────────────────────
  console.log('A. preview, apply, independent read-back, rollback');
  const taskA = mkTask();
  const depsA = depsFor();
  const { p: pA, run: applyA } = await approveNow(taskA, depsA);
  check('preview is ready, read-only, and states the guarantee (Bridge 1.5.0 = conditional writes)', pA.plan.status === 'ready' && pA.concurrency.writes === 'database_conditional' && stored().knowledgegraph_name === '', `${pA.plan.status} ${JSON.stringify(pA.concurrency)}`);
  check('the plan covers name and logo', pA.plan.changes.map((c) => c.field).join() === 'name,logo', pA.plan.changes.map((c) => c.field).join());
  const rA = await applyA();
  check('apply: applied; every write was one conditional UPDATE with an operation id', rA.fix.status === 'applied' && rA.fix.changes.every((c) => c.atomic === true && c.writeMode === 'conditional_update'), JSON.stringify(rA.fix.changes));
  check('INDEPENDENT: WP-CLI reads Rank Math\'s option and sees the name and logo', stored().knowledgegraph_name === 'Clinic Eye Centre' && stored().knowledgegraph_logo === REAL_LOGO, JSON.stringify({ n: stored().knowledgegraph_name, l: stored().knowledgegraph_logo }));
  check('the task is implemented (never verified by this fix)', taskA.status === 'implemented' && rA.fix.verification.saved.status === 'verified' && rA.fix.verification.rendered.status === 'pending', `${taskA.status}`);
  const rv = await reverifyOrganizationFix(taskA, depsA);
  check('re-verify: no post-write crawl -> rendered is PENDING (not failed, not verified)', rv.fix.verification.rendered.status === 'pending' && rv.fix.verification.rendered.reasonCode === 'NO_POST_WRITE_CRAWL', JSON.stringify(rv.fix.verification.rendered));
  setStored({ knowledgegraph_phone_unrelated: 'a human setting' });
  const rb = await rollbackOrganizationFix(taskA, { actorId: new mongoose.Types.ObjectId() }, depsA);
  check('rollback: restored through the Bridge, read back, status verified', rb.fix.rollback.status === 'verified' && stored().knowledgegraph_name === '' && stored().knowledgegraph_logo === '', `${rb.fix.rollback.status} ${JSON.stringify({ n: stored().knowledgegraph_name })}`);
  check('rollback touched only Odito\'s fields: an unrelated Rank Math setting survived both the apply and the rollback', stored().knowledgegraph_phone_unrelated === 'a human setting');
  const rb2 = await rollbackOrganizationFix(taskA, {}, depsA).catch((e) => e);
  check('a second rollback does nothing and says so', rb2?.statusCode === 404);

  // ── B. a person edits one field between preview and write ───────────────────────────────────────────────────────
  console.log('B. concurrent human edit during apply');
  clean();
  const taskB = mkTask();
  const humanEdit = { ...oditoSeoBridgeService, updateSiteSchemaField: async (c, entity, field, ...rest) => { if (field === 'logo') setStored({ knowledgegraph_logo: 'https://clinic.example/chosen-by-the-editor.png' }); return oditoSeoBridgeService.updateSiteSchemaField(c, entity, field, ...rest); } };
  const depsB = depsFor(humanEdit);
  const { run: applyB } = await approveNow(taskB, depsB);
  const eB = await applyB().catch((e) => e);
  check('the real Bridge refuses the stale write (CONFLICT), nothing is overwritten', eB?.code === 'CONFLICT' && stored().knowledgegraph_logo === 'https://clinic.example/chosen-by-the-editor.png', `${eB?.code} ${stored().knowledgegraph_logo}`);
  check('the field Odito had already written is put back', stored().knowledgegraph_name === '' && (await WordPressFixRecord.findOne({ taskId: taskB._id })).status === 'conflict_detected', stored().knowledgegraph_name);
  check('the task is untouched', taskB.status === 'task_created');

  // ── C. ambiguous outcomes against the real site ──────────────────────────────────────────────────────────────────
  console.log('C. timeout after commit, and a lost answer with WordPress unreachable');
  clean();
  const taskC = mkTask();
  let sentName = 0;
  const lostAnswer = { ...oditoSeoBridgeService, updateSiteSchemaField: async (c, entity, field, ...rest) => { const r = await oditoSeoBridgeService.updateSiteSchemaField(c, entity, field, ...rest); if (field === 'name' && sentName === 0) { sentName += 1; throw timeout(); } return r; } };
  const depsC = depsFor(lostAnswer);
  const { run: applyC } = await approveNow(taskC, depsC);
  const rC = await applyC();
  check('timeout AFTER the Bridge committed: the live value is read, the name is NOT sent again, attributed as reconciled', sentName === 1 && rC.fix.status === 'applied' && rC.fix.changes.find((c) => c.field === 'name').attribution === 'reconciled' && stored().knowledgegraph_name === 'Clinic Eye Centre', `${sentName} ${rC.fix.changes.find((c) => c.field === 'name').attribution}`);

  clean();
  const taskD = mkTask();
  let unreadable = false;
  const darkAfterCommit = {
    ...oditoSeoBridgeService,
    getSiteSchema: async (c) => { if (unreadable) throw timeout(); return oditoSeoBridgeService.getSiteSchema(c); },
    updateSiteSchemaField: async (c, entity, field, ...rest) => { const r = await oditoSeoBridgeService.updateSiteSchemaField(c, entity, field, ...rest); if (field === 'logo') { unreadable = true; throw timeout(); } return r; },
  };
  const depsD = depsFor(darkAfterCommit);
  const { p: pD, run: applyD } = await approveNow(taskD, depsD);
  const eD = await applyD().catch((e) => e);
  const recD = await WordPressFixRecord.findOne({ taskId: taskD._id });
  check('commit, lost answer, WordPress unreadable: apply_uncertain, nothing repeated, nothing undone', eD?.code === 'OUTCOME_UNKNOWN' && recD.status === 'apply_uncertain' && stored().knowledgegraph_logo === REAL_LOGO && stored().knowledgegraph_name === 'Clinic Eye Centre', `${eD?.code} ${recD?.status}`);
  unreadable = false;
  const fixed = await applyOrganizationFix(taskD, { approved: true, expectedPlanFingerprint: pD.plan.fingerprint }, depsD);
  check('the next request reconciles it against the real settings and finishes: applied, task implemented once, no extra write', fixed.recovered === true && fixed.fix.status === 'applied' && taskD.fixHistory.length === 1, `${fixed.recovered} ${fixed.fix?.status} ${taskD.fixHistory.length}`);

  // ── D. a crash mid-apply (record left in flight, one field landed) ───────────────────────────────────────────────
  console.log('D. crash recovery');
  clean();
  const taskE = mkTask();
  const depsE = depsFor();
  const { p: pE } = await approveNow(taskE, depsE);
  const { idempotencyKeyFor } = await import('../organizationFixService.js');
  const seeded = await WordPressFixRecord.create({
    projectId, connectionId, taskId: taskE._id, fixType: 'organization_schema', targetUrl: taskE.pageUrl, provider: 'rank_math', scope: 'site',
    planFingerprint: pE.plan.fingerprint, idempotencyKey: idempotencyKeyFor(taskE._id, pE.plan.fingerprint), status: 'applying', approvedAt: new Date(),
    changes: pE.plan.changes.map((c) => ({ field: c.field, before: c.before, after: c.after, source: c.source, writeState: 'in_flight' })),
  });
  await WordPressFixRecord.collection.updateOne({ _id: seeded._id }, { $set: { updatedAt: new Date(Date.now() - 20 * 60 * 1000) } });
  setStored({ knowledgegraph_name: 'Clinic Eye Centre' }); // the first write committed before the "crash"
  const writes = [];
  const spy = { ...oditoSeoBridgeService, updateSiteSchemaField: async (c, entity, field, ...rest) => { writes.push(field); return oditoSeoBridgeService.updateSiteSchemaField(c, entity, field, ...rest); } };
  const rE = await applyOrganizationFix(taskE, { approved: true, expectedPlanFingerprint: pE.plan.fingerprint }, depsFor(spy));
  check('the same approval resumes: only the field that had not landed is written', writes.join() === 'logo' && rE.fix.status === 'applied' && stored().knowledgegraph_logo === REAL_LOGO, `${writes.join()} ${rE.fix.status}`);
  check('the field found already landed is attributed as reconciled', rE.fix.changes.find((c) => c.field === 'name').attribution === 'reconciled');

  // ── E. the connected site's boundary ─────────────────────────────────────────────────────────────────────────────
  console.log('E. page outside the connected site');
  const taskX = mkTask();
  taskX.pageUrl = 'https://not-this-site.example/';
  const eX = await getOrganizationFixPreview(taskX, depsFor()).catch((e) => e);
  check('a page of another site is refused before anything is read or written', eX?.details?.reason === 'page_not_on_connected_site', `${eX?.code}`);

  await WordPressFixRecord.deleteMany({ projectId });
}

try {
  await main();
} catch (error) {
  check('no unexpected error', false, error?.stack || String(error));
} finally {
  mock.restoreAll();
  for (const fn of cleanup.reverse()) { try { await fn(); } catch (e) { console.log(`  cleanup warning: ${e.message}`); } }
  console.log(`\n${results.pass} passed, ${results.fail} failed`);
  process.exit(results.fail ? 1 : 0);
}
