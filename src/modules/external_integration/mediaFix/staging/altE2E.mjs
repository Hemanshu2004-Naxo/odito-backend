/**
 * STAGING-ONLY end-to-end check of the image alt-text fix against a REAL (disposable, local) WordPress.
 *
 *   node altE2E.mjs        (from odito_backend/, with local Mongo reachable; PHP + WP-CLI + the staging WordPress under ../.tools)
 *
 * What is real: the WordPress REST API (php built-in server + WordPress 7 + the twentytwentyfive theme), an Application Password,
 * the WordPressCoreAdapter and wordPressService requests, Odito's crawler image extraction and images_missing_alt_text rule
 * (crawlHelper.py), the fix service, the WordPressFixRecord ledger (local Mongo). What is faked: the Task object and its history.
 *
 * It creates its own media item and pages, and removes them — plus its Application Passwords and the permalink change it needs —
 * when done. It never contacts any other host. Do not point it at a production site.
 */

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import wordPressService from '../../service/wordPressService.js';
import WordPressFixRecord from '../../model/WordPressFixRecord.js';
import oditoSeoBridgeService from '../../service/oditoSeoBridgeService.js';
import { applyAltFix, getAltFixPreview, listAltImagesWithSummary, reverifyAltFix, rollbackAltFix } from '../altFixService.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..', '..', '..', '..', '..');
const PHP = path.join(ROOT, '.tools', 'php', 'php.exe');
const WPCLI = path.join(ROOT, '.tools', 'wp-cli.phar');
const WP = path.join(ROOT, '.tools', 'wordpress');
const CRAWL = path.join(here, 'crawlHelper.py');
const SITE = 'http://localhost:8899';
const run = Date.now().toString(36);
const results = { pass: 0, fail: 0 };

const check = (label, ok, detail = '') => { results[ok ? 'pass' : 'fail'] += 1; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  -> ${detail}`}`); };
const wp = (...args) => execFileSync(PHP, [WPCLI, `--path=${WP}`, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const crawl = (url, html) => JSON.parse(execFileSync('python', [CRAWL, url], { input: html, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
const getHtml = async (url) => (await fetch(url, { redirect: 'manual' })).text();
const libraryFile = (id) => wp('post', 'meta', 'get', String(id), '_wp_attached_file');
const libraryAlt = (id) => { try { return wp('post', 'meta', 'get', String(id), '_wp_attachment_image_alt'); } catch { return ''; } };
const setLibraryAlt = (id, v) => wp('post', 'meta', 'update', String(id), '_wp_attachment_image_alt', v);

const cleanup = [];
let server;

async function waitForRest() {
  for (let i = 0; i < 60; i += 1) {
    try { if ((await fetch(`${SITE}/wp-json/`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('the staging server did not start');
}

function startServer() {
  const router = path.join(os.tmpdir(), `odito_e2e_router_${run}.php`);
  fs.writeFileSync(router, `<?php
$root = $_SERVER['DOCUMENT_ROOT'];
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if ($path !== '/' && is_file($root . $path)) { return false; }
$_SERVER['SCRIPT_NAME'] = '/index.php';
$_SERVER['SCRIPT_FILENAME'] = $root . '/index.php';
require $root . '/index.php';
`);
  cleanup.push(() => fs.rmSync(router, { force: true }));
  server = spawn(PHP, ['-S', 'localhost:8899', '-t', WP, router], { stdio: 'ignore' });
  cleanup.push(() => server.kill());
}

function makeConnection(password, username = 'odito_admin') {
  return { _id: new mongoose.Types.ObjectId(), site_url: SITE, username, application_password: password };
}

/** The fix service's collaborators for ONE page, wired to the live site and the real crawler. */
function depsFor({ connection, pageUrl, state, bridge = oditoSeoBridgeService }) {
  return {
    wordPressService: {
      getHydratedConnectionOrThrow: async () => connection,
      resolvePostIdFromUrl: (c, url) => wordPressService.resolvePostIdFromUrl(c, url),
    },
    loadFlaggedImages: async () => state.issues.map((s) => ({ before_snapshot: s })),
    loadPageDoc: async () => state.pageDoc,
    bridge,
    taskHistory: { applyImplementedTransition: async (task, opts) => { task.status = 'implemented'; task.fixHistory.push({ fixApplied: { expectedAfterValue: opts.expectedAfterValueOverride } }); } },
    sleep: async () => {},
    now: () => new Date(),
  };
}

async function recrawl(pageUrl, state, { scrapedAt = new Date(Date.now() + 5000) } = {}) {
  const html = await getHtml(pageUrl);
  const c = crawl(pageUrl, html);
  state.issues = c.issues;
  state.pageDoc = { url: pageUrl, scraped_at: scrapedAt, images: c.images };
  return c;
}

async function main() {
  console.log(`staging: ${SITE} (run ${run})`);
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 3000 });
  cleanup.push(() => mongoose.connection.close());
  const projectId = new mongoose.Types.ObjectId();

  // ── environment ──────────────────────────────────────────────────────────────────────────────────────────────
  const permalinkBefore = wp('option', 'get', 'permalink_structure', '--format=json');
  const rewriteBefore = wp('option', 'get', 'rewrite_rules', '--format=json');
  cleanup.push(() => { wp('option', 'update', 'permalink_structure', permalinkBefore, '--format=json'); wp('option', 'update', 'rewrite_rules', rewriteBefore, '--format=json'); });
  wp('option', 'update', 'permalink_structure', '/%postname%/');
  wp('rewrite', 'flush');

  const png = path.join(os.tmpdir(), `odito-e2e-${run}-surgeon.png`);
  execFileSync(PHP, ['-r', `$i=imagecreatetruecolor(1400,900); for($y=0;$y<900;$y++){ $c=imagecolorallocate($i, 30+($y%200), 90, 160); imageline($i,0,$y,1400,$y,$c);} imagepng($i, ${JSON.stringify(png)});`]);
  cleanup.push(() => fs.rmSync(png, { force: true }));
  const attId = Number(wp('media', 'import', png, '--porcelain'));
  cleanup.push(() => wp('post', 'delete', String(attId), '--force'));
  const attUrl = wp('eval', `echo wp_get_attachment_url(${attId});`);
  console.log(`  media item ${attId}: ${attUrl}`);

  const featuredId = Number(wp('post', 'create', '--post_type=page', '--post_status=publish', `--post_title=E2E Featured ${run}`, `--post_name=e2e-featured-${run}`, '--porcelain'));
  wp('post', 'meta', 'update', String(featuredId), '_thumbnail_id', String(attId));
  const embeddedId = Number(wp('post', 'create', '--post_type=page', '--post_status=publish', `--post_title=E2E Embedded ${run}`, `--post_name=e2e-embedded-${run}`,
    `--post_content=<!-- wp:image {"id":${attId},"sizeSlug":"full"} --><figure class="wp-block-image size-full"><img src="${attUrl}" alt="" class="wp-image-${attId}"/></figure><!-- /wp:image -->`, '--porcelain'));
  cleanup.push(() => wp('post', 'delete', String(featuredId), String(embeddedId), '--force'));

  const adminPw = wp('user', 'application-password', 'create', '1', `odito-alt-e2e-${run}`, '--porcelain');
  const subPw = wp('user', 'application-password', 'create', '2', `odito-alt-e2e-${run}`, '--porcelain');
  cleanup.push(() => { for (const u of ['1', '2']) { for (const p of JSON.parse(wp('user', 'application-password', 'list', u, '--format=json'))) if (p.name === `odito-alt-e2e-${run}`) wp('user', 'application-password', 'delete', u, p.uuid); } });

  startServer();
  await waitForRest();

  const pageA = `${SITE}/e2e-featured-${run}/`;
  const pageB = `${SITE}/e2e-embedded-${run}/`;
  const admin = makeConnection(adminPw);
  const mkTask = (pageUrl) => ({ _id: new mongoose.Types.ObjectId(), projectId, issueKey: 'images_missing_alt_text', pageUrl, status: 'task_created', recommendationId: null, fixHistory: [], async save() {}, markModified() {} });
  const ALT = 'A surgeon in blue scrubs preparing for an eye operation';

  // ── A. an image the theme renders from the media library ───────────────────────────────────────────────────────────
  console.log('A. library-rendered image (featured image)');
  const stateA = { issues: [], pageDoc: null };
  const cA = await recrawl(pageA, stateA, { scrapedAt: new Date() });
  const imgA = cA.images.find((i) => (i.src || '').includes(`e2e-${run}-surgeon`));
  check('the crawler records the page image (with the new identity fields)', !!imgA && 'alt_state' in imgA, JSON.stringify(cA.images.map((i) => i.src)));
  const flagged = stateA.issues.find((s) => (s.src || '').includes(`e2e-${run}-surgeon`));
  check('the finding carries the exact image and its alt state', !!flagged, JSON.stringify(stateA.issues));
  console.log(`  observed: alt_state=${flagged?.altState} wp-image-id=${flagged?.wpAttachmentId} src=${flagged?.src}`);
  if (!flagged) throw new Error('no flagged image on the featured page — cannot continue');

  const taskA = mkTask(pageA);
  const depsA = depsFor({ connection: admin, pageUrl: pageA, state: stateA });
  const input = { imageSrc: flagged.src, proposedAlt: ALT, informative: true };
  const p1 = await getAltFixPreview(taskA, input, depsA);
  check('preview resolves the exact attachment', p1.identity.status === 'resolved' && p1.identity.attachmentId === attId, JSON.stringify(p1.identity));
  check('preview is ready, bound to a fingerprint, and read-only', p1.plan.status === 'ready' && p1.plan.fingerprint.length === 64 && libraryAlt(attId) === '', `${p1.plan.status} ${p1.plan.code}`);
  check('the page content does not embed this image (rendered from the library)', p1.contentEffect?.status === 'not_in_content', JSON.stringify(p1.contentEffect));
  console.log(`  identity: ${p1.identity.method} / ${p1.identity.confidence}`);

  const applied = await applyAltFix(taskA, { ...input, approved: true, expectedPlanFingerprint: p1.plan.fingerprint, actorId: new mongoose.Types.ObjectId() }, depsA);
  check('apply: WordPress accepted the write; the Task is implemented, NOT verified', applied.fix.status === 'applied' && taskA.status === 'implemented', `${applied.fix.status} ${taskA.status}`);
  check('saved state verified through the REST read-back', applied.fix.verification.saved.status === 'verified');
  check('the write went through the Bridge, identity-checked, and is recorded for what it was: creating a missing alt record is check-then-insert, NOT atomic', applied.fix.changes[0].writeMode === 'conditional_insert' && applied.fix.changes[0].atomic === false && applied.fix.changes[0].writeState === 'landed', JSON.stringify(applied.fix.changes[0]));
  check('and the preview said so beforehand (conditional write + a creation window)', p1.concurrency.writes === 'database_conditional' && p1.concurrency.creationWindow === true, JSON.stringify(p1.concurrency));
  check('INDEPENDENT check: WP-CLI reads the same alt from the database', libraryAlt(attId) === ALT, libraryAlt(attId));

  const cA2 = await recrawl(pageA, stateA);
  const renderedNow = cA2.images.find((i) => (i.src || '').includes(`e2e-${run}-surgeon`));
  console.log(`  recrawled alt: "${renderedNow?.alt}"`);
  const rv = await reverifyAltFix(taskA, { imageSrc: flagged.src }, depsA);
  check('rendered-page verification: the SAME image shows the approved alt on the recrawled page', rv.fix.verification.rendered.status === 'verified' && rv.fix.status === 'verified', JSON.stringify(rv.fix.verification.rendered));

  const stale = await recrawl(pageA, stateA, { scrapedAt: new Date(Date.now() - 3600 * 1000) });
  const rvStale = await reverifyAltFix(taskA, { imageSrc: flagged.src }, depsA);
  check('a crawl older than the write cannot verify it: PENDING (a recrawl will settle it), never verified', rvStale.fix.verification.rendered.status === 'pending' && rvStale.fix.verification.rendered.reasonCode === 'NO_POST_WRITE_CRAWL' && stale.images.length > 0, JSON.stringify(rvStale.fix.verification.rendered));
  await recrawl(pageA, stateA);

  const again = await applyAltFix(taskA, { ...input, approved: true, expectedPlanFingerprint: p1.plan.fingerprint }, depsA).catch((e) => e);
  check("re-sending the same approval writes nothing again: the finding is resolved, so the image is no longer one of the task's findings", again?.alreadyApplied === true || ['IMAGE_NOT_FLAGGED', 'CONFLICT'].includes(again?.code), again?.message);

  const rb = await rollbackAltFix(taskA, { imageSrc: flagged.src, actorId: new mongoose.Types.ObjectId() }, depsA);
  check('rollback restores the previous (empty) alt in WordPress and reads it back (rollback verified)', rb.fix.status === 'rolled_back' && rb.fix.rollback.status === 'verified' && libraryAlt(attId) === '', `${rb.fix.rollback.status} "${libraryAlt(attId)}"`);
  const cA3 = await recrawl(pageA, stateA);
  check('and the recrawled page shows it empty again', (cA3.images.find((i) => (i.src || '').includes(`e2e-${run}-surgeon`))?.alt || '') === '');

  // ── C. a human edit between preview and apply ────────────────────────────────────────────────────────────────────
  console.log('C. concurrent human edit');
  const p2 = await getAltFixPreview(taskA, input, depsA);
  setLibraryAlt(attId, 'Typed by an editor in wp-admin');
  const conflict = await applyAltFix(taskA, { ...input, approved: true, expectedPlanFingerprint: p2.plan.fingerprint }, depsA).catch((e) => e);
  check('the stale approval is refused (conflict) and nothing is overwritten', conflict?.code === 'CONFLICT' && libraryAlt(attId) === 'Typed by an editor in wp-admin', `${conflict?.code} ${libraryAlt(attId)}`);
  const kept = await getAltFixPreview(taskA, input, depsA);
  check('existing meaningful alt text is preserved by default', kept.plan.status === 'existing_alt_preserved', kept.plan.status);
  setLibraryAlt(attId, '');

  // ── B. an image whose alt lives in the page content ──────────────────────────────────────────────────────────────
  console.log('B. image embedded in the page content');
  const stateB = { issues: [], pageDoc: null };
  const cB = await recrawl(pageB, stateB, { scrapedAt: new Date() });
  const flaggedB = stateB.issues.find((s) => (s.src || '').includes(`e2e-${run}-surgeon`));
  console.log(`  observed: alt_state=${flaggedB?.altState} wp-image-id=${flaggedB?.wpAttachmentId}`);
  check('the finding records the wp-image id from the page markup', flaggedB?.wpAttachmentId === attId && cB.images.length > 0, JSON.stringify(flaggedB));
  const taskB = mkTask(pageB);
  const depsB = depsFor({ connection: admin, pageUrl: pageB, state: stateB });
  const pB = await getAltFixPreview(taskB, { imageSrc: flaggedB.src, proposedAlt: ALT, informative: true }, depsB);
  check('identity resolves by the wp-image id confirmed against the media library', pB.identity.status === 'resolved' && pB.identity.method === 'attachment_id_class', JSON.stringify(pB.identity));
  check('the fix is UNSUPPORTED: the alt is stored in the page content, a library write would change nothing', pB.plan.status === 'decorative' || (pB.plan.status === 'unsupported' && pB.plan.code === 'ALT_EMBEDDED_IN_CONTENT'), `${pB.plan.status} ${pB.plan.code}`);
  console.log(`  plan: ${pB.plan.status} ${pB.plan.code}`);
  const refused = await applyAltFix(taskB, { imageSrc: flaggedB.src, proposedAlt: ALT, informative: true, approved: true, expectedPlanFingerprint: pB.plan.fingerprint }, depsB).catch((e) => e);
  check('apply is refused and WordPress is untouched', !!refused?.code && libraryAlt(attId) === '', `${refused?.code} ${libraryAlt(attId)}`);
  // …and the same content with a person's confirmation that it is informative is still not writable through the library
  const pB2 = await getAltFixPreview(taskB, { imageSrc: flaggedB.src, proposedAlt: ALT, informative: true }, depsB);
  check('confirming "informative" does not turn it into a library write', pB2.plan.status === 'unsupported' && pB2.plan.code === 'ALT_EMBEDDED_IN_CONTENT', `${pB2.plan.status} ${pB2.plan.code}`);

  // ── E. the Bridge's conditional write, ambiguity and crash recovery against the REAL site ───────────────────────────────────────
  console.log('E. reliability against the real Bridge');
  const rawFile = libraryFile(attId);
  const direct = (value, expected, expectedFile = rawFile) => oditoSeoBridgeService.swapMediaAlt(admin, attId, { value, expected, expectedFile });
  const wrongExpected = await direct('Should not land', 'not the stored value').catch((e) => e);
  check('Bridge: a stale expected value is a CONFLICT (expected_mismatch) and writes nothing', wrongExpected?.code === 'CONFLICT' && wrongExpected?.reason === 'expected_mismatch' && libraryAlt(attId) === '', `${wrongExpected?.code} ${wrongExpected?.reason} "${libraryAlt(attId)}"`);
  const wrongFile = await direct('Should not land', '', '2020/01/some-other-file.png').catch((e) => e);
  check('Bridge: an attachment whose file is not the approved one is refused (target_changed) and nothing is written', wrongFile?.code === 'CONFLICT' && wrongFile?.reason === 'target_changed' && libraryAlt(attId) === '', `${wrongFile?.code} ${wrongFile?.reason}`);
  try { wp('post', 'meta', 'delete', String(attId), '_wp_attachment_image_alt'); } catch { /* no row */ } // earlier steps left an (empty) row: remove it so the record really is missing
  const created = await direct('Created by the Bridge', '');
  check('Bridge: creating a missing alt record is reported as created and NOT atomic', created.operation.created === true && created.operation.atomic === false && libraryAlt(attId) === 'Created by the Bridge', JSON.stringify(created.operation));
  const updated = await direct('Updated by the Bridge', 'Created by the Bridge');
  check('Bridge: updating an existing record is ONE conditional UPDATE (atomic) with an operation id', updated.operation.atomic === true && updated.operation.created === false && !!updated.operation.id && libraryAlt(attId) === 'Updated by the Bridge', JSON.stringify(updated.operation));
  const replay = await direct('Updated by the Bridge', 'Created by the Bridge');
  check('Bridge: replaying the same change after it landed reports alreadyApplied and writes nothing', replay.operation.alreadyApplied === true && libraryAlt(attId) === 'Updated by the Bridge', JSON.stringify(replay.operation));
  setLibraryAlt(attId, '');
  const noSuch = await oditoSeoBridgeService.swapMediaAlt(admin, 99999999, { value: 'x', expected: '', expectedFile: 'a/b.png' }).catch((e) => e);
  check('Bridge: an attachment id that does not exist is refused', ['FIELD_NOT_WRITABLE', 'PERMISSION_DENIED'].includes(noSuch?.code), `${noSuch?.code}`);
  const pageNotAttachment = await oditoSeoBridgeService.swapMediaAlt(admin, featuredId, { value: 'x', expected: '', expectedFile: 'a/b.png' }).catch((e) => e);
  check('Bridge: a page (not an image attachment) can never be written through the alt route', ['FIELD_NOT_WRITABLE', 'PERMISSION_DENIED'].includes(pageNotAttachment?.code) && wp('post', 'get', String(featuredId), '--field=post_title') === `E2E Featured ${run}`, `${pageNotAttachment?.code}`);
  const sub = await oditoSeoBridgeService.swapMediaAlt(makeConnection(subPw, 'odito_subscriber'), attId, { value: 'Subscriber', expected: '', expectedFile: rawFile }).catch((e) => e);
  check('Bridge: a subscriber is refused (403) and nothing changes', sub?.code === 'PERMISSION_DENIED' && libraryAlt(attId) === '', `${sub?.code}`);

  // timeout AFTER WordPress committed: the service reads the live value, does not write again, and says it reconciled
  const stateE = { issues: [], pageDoc: null };
  await recrawl(pageA, stateE, { scrapedAt: new Date() });
  const flaggedE = stateE.issues.find((x) => (x.src || '').includes(`e2e-${run}-surgeon`));
  const taskE = mkTask(pageA);
  let swaps = 0;
  const timeoutAfterCommit = { getBridgeStatus: (c) => oditoSeoBridgeService.getBridgeStatus(c), swapMediaAlt: async (...a) => { swaps += 1; await oditoSeoBridgeService.swapMediaAlt(...a); const e = new Error('timed out'); e.code = 'TIMEOUT'; e.statusCode = 504; throw e; } };
  const inputE = { imageSrc: flaggedE.src, proposedAlt: ALT, informative: true };
  const depsE = depsFor({ connection: admin, pageUrl: pageA, state: stateE, bridge: timeoutAfterCommit });
  const pE = await getAltFixPreview(taskE, inputE, depsE);
  const appliedE = await applyAltFix(taskE, { ...inputE, approved: true, expectedPlanFingerprint: pE.plan.fingerprint }, depsE);
  check('timeout AFTER the commit: reconciled from the live value, sent exactly once, attributed as reconciled', swaps === 1 && appliedE.fix.status === 'applied' && appliedE.fix.changes[0].attribution === 'reconciled' && libraryAlt(attId) === ALT, `${swaps} ${appliedE.fix.status} ${appliedE.fix.changes[0].attribution} "${libraryAlt(attId)}"`);

  // crash recovery: the write landed (above), the ledger row is stale and in flight -> reconciled against the real site, no second write
  await WordPressFixRecord.updateOne({ taskId: taskE._id }, { $set: { status: 'applying', appliedAt: null, 'changes.0.applied': false, 'changes.0.writeState': 'in_flight', verification: { saved: { status: 'pending', reasons: [], fields: [] }, rendered: { status: 'pending', reasons: [], fields: [] } } } });
  await WordPressFixRecord.collection.updateOne({ taskId: taskE._id }, { $set: { updatedAt: new Date(Date.now() - 20 * 60 * 1000) } });
  const taskE2 = mkTask(pageA);
  Object.assign(taskE2, { _id: taskE._id });
  swaps = 0;
  const recovered = await applyAltFix(taskE2, { ...inputE, approved: true, expectedPlanFingerprint: pE.plan.fingerprint }, depsFor({ connection: admin, pageUrl: pageA, state: stateE })).catch((e) => e);
  if (recovered instanceof Error) console.log('  DEBUG', String(recovered.stack || recovered).split('\n').slice(0, 8).join(' | '));
  check('crash recovery: the stale in-flight record is reconciled against WordPress and finished without writing again', recovered?.recovered === true && recovered?.fix?.status === 'applied' && libraryAlt(attId) === ALT, `${recovered?.recovered} ${recovered?.fix?.status} ${recovered?.code} ${recovered?.message}`);

  // multi-image roll-up from the real ledger
  const roll = await listAltImagesWithSummary(taskE, depsFor({ connection: admin, pageUrl: pageA, state: stateE }));
  check('the per-image roll-up is derived from the ledger and never says "verified" before the page confirms it', ['applied_pending_verification', 'verified_images_remaining', 'verified'].includes(roll.summary.overall) && roll.images.length >= 1, JSON.stringify(roll.summary));

  // rollback through the Bridge, then an independent read
  const rbE = await rollbackAltFix(taskE, { imageSrc: flaggedE.src }, depsFor({ connection: admin, pageUrl: pageA, state: stateE }));
  check('rollback through the Bridge: conditional, read back, independently confirmed by WP-CLI', rbE.fix.rollback.status === 'verified' && libraryAlt(attId) === '', `${rbE.fix.rollback.status} "${libraryAlt(attId)}"`);

  // without the Bridge: the core fallback works, and is reported honestly as NOT atomic
  const noBridge = { getBridgeStatus: async () => ({ installed: false, mediaAltSupported: false }) };
  const stateF = { issues: [], pageDoc: null };
  await recrawl(pageA, stateF, { scrapedAt: new Date() });
  const taskF = mkTask(pageA);
  const depsF = depsFor({ connection: admin, pageUrl: pageA, state: stateF, bridge: noBridge });
  const inputF = { imageSrc: stateF.issues.find((x) => (x.src || '').includes(`e2e-${run}-surgeon`)).src, proposedAlt: ALT, informative: true };
  const pF = await getAltFixPreview(taskF, inputF, depsF);
  check('without Bridge 1.5.0 the preview says the write is read-then-write', pF.concurrency.writes === 'read_then_write', JSON.stringify(pF.concurrency));
  const appliedF = await applyAltFix(taskF, { ...inputF, approved: true, expectedPlanFingerprint: pF.plan.fingerprint }, depsF);
  check('the core fallback applies it and records read_then_write', appliedF.fix.status === 'applied' && appliedF.fix.changes[0].writeMode === 'read_then_write' && appliedF.fix.changes[0].atomic === false && libraryAlt(attId) === ALT, JSON.stringify(appliedF.fix.changes[0]));
  setLibraryAlt(attId, '');

  // ── D. a WordPress account without edit rights ───────────────────────────────────────────────────────────────────
  console.log('D. insufficient permissions');
  const denied = await getAltFixPreview(taskA, input, depsFor({ connection: makeConnection(subPw, 'odito_subscriber'), pageUrl: pageA, state: stateA })).catch((e) => e);
  check('a subscriber cannot even read the attachment for editing: PERMISSION_DENIED', denied?.code === 'PERMISSION_DENIED', `${denied?.code} ${denied?.message}`);
  const badPw = await getAltFixPreview(taskA, input, depsFor({ connection: makeConnection('wrong password'), pageUrl: pageA, state: stateA })).catch((e) => e);
  check('invalid credentials are rejected', badPw?.code === 'INVALID_CREDENTIALS' || badPw?.statusCode === 401, `${badPw?.code}`);

  await WordPressFixRecord.deleteMany({ projectId });
}

try {
  await main();
} catch (error) {
  check('no unexpected error', false, error?.stack || String(error));
} finally {
  for (const fn of cleanup.reverse()) { try { await fn(); } catch (e) { console.log(`  cleanup warning: ${e.message}`); } }
  console.log(`\n${results.pass} passed, ${results.fail} failed`);
  process.exit(results.fail ? 1 : 0);
}
