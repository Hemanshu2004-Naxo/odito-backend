/**
 * STAGING-ONLY end-to-end check of the breadcrumb fix against a REAL (disposable, local) WordPress with the REAL Rank Math plugin and the
 * REAL Odito SEO Bridge, driven by the real fix service, the real WordPress URL resolver, the real page-hierarchy prediction and the real
 * rendered-page verification over HTTP.
 *
 *   node breadcrumbNodeE2E.mjs      (from odito_backend/, local Mongo reachable; PHP + WP-CLI + the staging WordPress under ../.tools)
 *
 * What is real: WordPress, Rank Math, the Bridge, an Application Password, wpRequest, the Bridge client, the REST resolver, the ancestors read,
 * the engine, the ledger (local Mongo) and the page fetch + JSON-LD inspection. What is supplied: the Task object, the owner-confirmed trail
 * and the "open findings" list. Independent checks read Rank Math's option with WP-CLI and fetch the page themselves. It snapshots and
 * restores everything it touches, deletes the pages it creates and removes its Application Password. It never contacts another host.
 * Do not point it at a production site.
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
import { inspectPagesBreadcrumbs, discoverBreadcrumbs, clearBreadcrumbDiscoveryCache } from '../../../schema-evidence/breadcrumbs/breadcrumbDiscovery.js';
import { jsonLdFromHtml } from '../../../schema-evidence/sameAs/sameAsVerification.js';
import { applyOrganizationFix, getOrganizationFixPreview, reverifyOrganizationFix, rollbackOrganizationFix } from '../organizationFixService.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..', '..', '..', '..', '..');
const PHP = path.join(ROOT, '.tools', 'php', 'php.exe');
const WPCLI = path.join(ROOT, '.tools', 'wp-cli.phar');
const WP = path.join(ROOT, '.tools', 'wordpress');
const SITE = 'http://localhost:8899';
const OPT = 'rank-math-options-general';
const run = Date.now().toString(36);
const results = { pass: 0, fail: 0 };

const check = (label, ok, detail = '') => { results[ok ? 'pass' : 'fail'] += 1; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  -> ${detail}`}`); };
const wp = (...args) => execFileSync(PHP, [WPCLI, `--path=${WP}`, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const breadcrumbsOption = () => String(JSON.parse(wp('option', 'get', OPT, '--format=json')).breadcrumbs || '');
const setBreadcrumbs = (v) => { const o = JSON.parse(wp('option', 'get', OPT, '--format=json')); o.breadcrumbs = v; wp('option', 'update', OPT, JSON.stringify(o), '--format=json'); };
const cleanup = [];

async function waitForRest() {
  for (let i = 0; i < 60; i += 1) {
    try { if ((await fetch(`${SITE}/wp-json/`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('the staging server did not start');
}

function startServer() {
  const router = path.join(os.tmpdir(), `odito_bc_e2e_router_${run}.php`);
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

const noSlash = (u) => String(u).replace(/\/+$/, '');
const pageHtml = async (url) => (await fetch(`${url}${url.includes('?') ? '&' : '?'}nocache=${Date.now()}`)).text();
const renderedCrumbs = async (url) => {
  const { values } = jsonLdFromHtml(await pageHtml(url));
  const nodes = [];
  const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') { if (v['@graph']) walk(v['@graph']); if (v['@type']) nodes.push(v); } };
  values.forEach(walk);
  return nodes.filter((n) => [].concat(n['@type']).includes('BreadcrumbList'));
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
  setBreadcrumbs('off');

  // (Rank Math prints item as {"@id": url, "name": ...}, string positions and the home URL without a trailing slash: the engine handles all three.)
  // A real child page under the default "Sample Page", so the page hierarchy is real: Home > Sample Page > Child.
  const parentId = wp('post', 'list', '--post_type=page', '--name=sample-page', '--field=ID');
  const childId = wp('post', 'create', '--post_type=page', '--post_status=publish', `--post_title=Child ${run}`, `--post_parent=${parentId}`, '--porcelain');
  const topId = wp('post', 'create', '--post_type=page', '--post_status=publish', `--post_title=Top ${run}`, '--porcelain');
  cleanup.push(() => { for (const id of [childId, topId]) { try { wp('post', 'delete', id, '--force'); } catch { /* already gone */ } } });
  const permalink = (id) => wp('post', 'get', id, '--field=url');
  const parentUrl = permalink(parentId); const childUrl = permalink(childId); const topUrl = permalink(topId);

  const adminPw = wp('user', 'application-password', 'create', '1', `odito-bc-e2e-${run}`, '--porcelain');
  cleanup.push(() => { for (const p of JSON.parse(wp('user', 'application-password', 'list', '1', '--format=json'))) if (p.name === `odito-bc-e2e-${run}`) wp('user', 'application-password', 'delete', '1', p.uuid); });
  startServer();
  await waitForRest();

  const connection = { _id: connectionId, site_url: SITE, username: 'odito_admin', application_password: adminPw };
  const home = `${SITE}/`;
  const mkTask = (pageUrl) => ({ _id: new mongoose.Types.ObjectId(), projectId, issueKey: 'breadcrumblist_schema', pageUrl, status: 'task_created', recommendationId: new mongoose.Types.ObjectId(), fixHistory: [], async save() {}, markModified() {} });
  const depsFor = ({ trail, affected, bridge = oditoSeoBridgeService } = {}) => ({
    wordPressService: { getHydratedConnectionOrThrow: async () => connection },
    bridge,
    loadBreadcrumbEvidence: async () => (trail ? { items: trail.map((t, i) => ({ position: i + 1, ...t })) } : null),
    loadPageDoc: async (_p, url) => ({ url, canonical: url }),
    // The staging site is plain http on localhost: the discovery helpers' public-HTTPS gate is lifted for THIS disposable site only.
    inspectBreadcrumbPages: ({ urls }) => inspectPagesBreadcrumbs({ urls }, { isFetchable: () => true, limits: { cacheTtlMs: 0 } }),
    loadAffectedPages: async () => affected || [],
    taskHistory: { applyImplementedTransition: async (t, opts) => { t.status = 'implemented'; t.fixHistory.push({ fixApplied: { externalWrite: opts.externalWrite, expectedAfterValue: opts.expectedAfterValueOverride } }); } },
  });

  // ── A. nothing is published before the fix ─────────────────────────────────────────────────────────────────────
  console.log('A. before: no BreadcrumbList, discovery reports it honestly');
  check('the real child page publishes no BreadcrumbList while breadcrumbs are off', (await renderedCrumbs(childUrl)).length === 0);
  clearBreadcrumbDiscoveryCache();
  const disc = await discoverBreadcrumbs({ projectId, pageUrl: childUrl }, { loadPage: async () => ({ url: childUrl, canonical: childUrl, title: `Child ${run}`, structured_data: [] }), loadPages: async () => [{ url: home }, { url: parentUrl }, { url: childUrl }], loadSaved: async () => null, isFetchable: () => true, limits: { cacheTtlMs: 0 } });
  check('discovery fetched the real page and home, found no JSON-LD trail and invented nothing', disc.existing.count === 0 && disc.status !== 'already_valid' && disc.status !== 'conflict', `${disc.status} ${JSON.stringify(disc.sources.fetched.map((f) => f.status))}`);
  check('discovery output only names URLs of this site', JSON.stringify(disc).match(/https?:\/\/[^"\s)]+/g).every((u) => u.startsWith(SITE) || u.startsWith('https://schema.org')), '');

  // ── B. the real hierarchy is predicted from WordPress, and a mismatching confirmed trail is refused ─────────────────
  console.log('B. prediction from the real page hierarchy');
  const trailChild = [{ name: 'Home', url: home }, { name: 'Sample Page', url: parentUrl }, { name: `Child ${run}`, url: childUrl }];
  const wrong = [{ name: 'Home', url: home }, { name: 'Our Services', url: `${SITE}/services/` }, { name: `Child ${run}`, url: childUrl }];
  const taskWrong = mkTask(childUrl);
  const pWrong = await getOrganizationFixPreview(taskWrong, depsFor({ trail: wrong }));
  check('a confirmed trail Rank Math would NOT build is unsupported (TRAIL_WOULD_DIFFER) and shows the real predicted trail', pWrong.plan.code === 'TRAIL_WOULD_DIFFER' && pWrong.plan.message.includes(parentUrl) && pWrong.approvalStatus === 'not_available', `${pWrong.plan.code}`);
  check('and still offers the exact JSON-LD and manual steps; nothing was written', !!pWrong.breadcrumb.jsonLd && pWrong.breadcrumb.manual.steps.length >= 2 && breadcrumbsOption() !== 'on');

  // ── C. apply, independent read-back, real page ────────────────────────────────────────────────────────────────
  console.log('C. preview → apply → saved + rendered verification on the real site');
  const task = mkTask(childUrl);
  const deps = depsFor({ trail: trailChild, affected: [childUrl, topUrl] });
  const p = await getOrganizationFixPreview(task, deps);
  check('preview is ready; the predicted trail came from WordPress (Home › Sample Page › Child); nothing written', p.plan.status === 'ready' && JSON.stringify(p.breadcrumb.predicted.urls) === JSON.stringify([home, parentUrl, childUrl]) && breadcrumbsOption() !== 'on', `${p.plan.status} ${JSON.stringify(p.breadcrumb.predicted)}`);
  const r = await applyOrganizationFix(task, { approved: true, expectedPlanFingerprint: p.plan.fingerprint, actorId: new mongoose.Types.ObjectId() }, deps);
  check('INDEPENDENT: WP-CLI sees Rank Math breadcrumbs switched on', breadcrumbsOption() === 'on', breadcrumbsOption());
  const crumbs = await renderedCrumbs(childUrl);
  check('INDEPENDENT: the real child page now publishes exactly one BreadcrumbList with the confirmed trail', crumbs.length === 1 && JSON.stringify(crumbs[0].itemListElement.map((i) => noSlash(i.item?.['@id'] || i.item))) === JSON.stringify([home, parentUrl, childUrl].map(noSlash)) && crumbs[0].itemListElement.every((i, n) => Number(i.position) === n + 1), JSON.stringify(crumbs.map((c) => c.itemListElement)).slice(0, 300));
  check('the engine verified both parts itself', r.fix.status === 'verified' && r.fix.verification.saved.status === 'verified' && r.fix.verification.rendered.status === 'verified' && r.immediateVerification === 'success', JSON.stringify({ s: r.fix.status, r: r.fix.verification.rendered }).slice(0, 400));
  check('the other affected page was verified on its own', r.fix.verification.rendered.fields.some((f) => f.field === `page:${topUrl}` && f.ok), JSON.stringify(r.fix.verification.rendered.fields.filter((f) => f.field.startsWith('page:'))));
  check('task implemented (never verified_fixed by this fix); typed externalWrite', task.status === 'implemented' && task.fixHistory[0].fixApplied.externalWrite.field === 'breadcrumb_setting');

  // ── D. already valid now: stale finding, nothing to change ─────────────────────────────────────────────────────
  console.log('D. the finding is now stale');
  const again = await getOrganizationFixPreview(mkTask(childUrl), deps);
  check('a fresh preview says the page already outputs a valid BreadcrumbList (no second one is offered)', again.plan.code === 'STALE_FINDING' && again.breadcrumb.panelState === 'already_valid', `${again.plan.code}`);
  const dAfter = await discoverBreadcrumbs({ projectId, pageUrl: childUrl, refresh: true }, { loadPage: async () => ({ url: childUrl, canonical: childUrl, title: 'x', structured_data: [] }), loadPages: async () => [{ url: home }], loadSaved: async () => null, isFetchable: () => true, limits: { cacheTtlMs: 0 } });
  check('discovery reads the live Rank Math JSON-LD and reports already_valid with the stale finding flagged', dAfter.status === 'already_valid' && dAfter.staleFinding === true, `${dAfter.status}`);

  // ── E. rollback ─────────────────────────────────────────────────────────────────────────────────────────────────
  console.log('E. rollback');
  const rb = await rollbackOrganizationFix(task, { actorId: new mongoose.Types.ObjectId() }, deps);
  check('rollback switched it off, read it back and confirmed the page no longer publishes the trail', breadcrumbsOption() !== 'on' && rb.fix.status === 'rolled_back' && rb.fix.rollback.status === 'verified' && rb.fix.rollback.rendered.status === 'verified', `${rb.fix.rollback.status} ${rb.fix.rollback.rendered?.status}`);
  check('INDEPENDENT: the real page has no BreadcrumbList again', (await renderedCrumbs(childUrl)).length === 0);

  // ── F. unsupported plugin, foreign page ────────────────────────────────────────────────────────────────────────
  console.log('F. unsupported source / outside the site');
  const yoast = { ...oditoSeoBridgeService, getBridgeStatus: async (c) => ({ ...(await oditoSeoBridgeService.getBridgeStatus(c)), provider: 'yoast' }) };
  const pY = await getOrganizationFixPreview(mkTask(childUrl), depsFor({ trail: trailChild, bridge: yoast }));
  check('another SEO plugin: manual steps, no change possible, nothing written', pY.plan.status === 'unsupported' && pY.breadcrumb.manual.steps.join(' ').includes('Yoast') && breadcrumbsOption() !== 'on');
  const foreign = mkTask('https://not-this-site.example/x');
  const eF = await getOrganizationFixPreview(foreign, depsFor({ trail: trailChild })).catch((e) => e);
  check('a page of another site is refused before anything is read or written', eF?.details?.reason === 'page_not_on_connected_site', `${eF?.code}`);

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
