import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import { applyAltFix, getAltFixPreview, reverifyAltFix, rollbackAltFix } from './altFixService.js';
import { renderedOccurrenceCheck } from './diviAltFix.js';
import WordPressFixRecord from '../model/WordPressFixRecord.js';
import { WordPressConnectionError } from '../service/wordPressService.js';
import { attachmentExactPaths } from './imageIdentity.js';
import { findAltSources, planAltEdit } from '../content/diviImageAlt.js';
import { fingerprintOf } from '../content/wordPressContentService.js';
import { mediaItem, snapshot } from './__fixtures__/media.js';
import {
  DIVI5, HERO_FILE, HERO_URL, LOGO_FILE, LOGO_URL, blurbModule, heroHeader, homepage, imageModule, withModules,
} from '../content/__fixtures__/diviAltContent.js';

/**
 * The Divi page-module alt fix end to end — preview, approval, conditional write, read-back, live-occurrence verification, rollback —
 * against a STATEFUL double of WordPress (page content, a media library, a model of what the live page renders). Fixtures follow the
 * real Sapphire homepage (Divi 4.27.7). Nothing here touches a real site; no write format is tested against production.
 */

let mongoAvailable = false;
before(async () => {
  try { await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 }); mongoAvailable = true; } catch { mongoAvailable = false; }
});
const projectIds = [];
after(async () => {
  if (mongoAvailable) {
    await WordPressFixRecord.deleteMany({ projectId: { $in: projectIds } });
    await mongoose.connection.close();
  }
});
const skip = (t) => { if (!mongoAvailable) { t.skip('local MongoDB not reachable'); return true; } return false; };

const SITE = 'https://www.sapphiredigitalagency.com';
const PAGE = `${SITE}/`;
const HERO_LIB_ALT = 'Professional digital marketing agency team providing global SEO services in US, UK, India, Dubai, Australia';
const AI = 'Digital marketing agency team reviewing campaign results';
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** One WordPress page whose content can be edited, concurrently edited, rewritten by WordPress, or fail to save. */
function makePage(raw) {
  const p = {
    id: 6, postType: 'pages', raw, rev: 1, writes: [], reads: 0, failWrite: null, landThenFail: null, rewriteOnSave: null, readError: null,
    beforeNextRead: null, // () => void — a human edit that lands just before the next read
    state() { return { id: 6, type: 'page', postType: 'pages', status: 'publish', link: PAGE, slug: 'home', title: { raw: 'Home' }, content: { raw: p.raw }, meta: {}, modifiedGmt: `2026-10-16T10:00:0${p.rev}` }; },
    humanEdit(fn) { p.raw = fn(p.raw); p.rev += 1; },
  };
  return p;
}

/** The media library: only reads — a Divi write must NEVER call writeAltTextForAttachment. */
function makeMedia(items) {
  const lib = new Map(items.map((i) => [i.id, structuredClone(i)]));
  return {
    lib, writes: [],
    async readMediaById(id) { const it = lib.get(Number(id)); return it ? structuredClone(it) : null; },
    async searchMedia(term, page) { if (page > 1) return []; return [...lib.values()].filter((m) => (m.media_details.file || '').includes(term)).map((m) => structuredClone(m)); },
    async writeAltTextForAttachment(id, alt) { this.writes.push({ id, alt }); lib.get(id).alt_text = alt; return { httpStatus: 200, wordpressPostId: id }; },
  };
}

/** What the live page renders for an attachment: each Divi module that shows it prints its stored alt (+ any other occurrences, e.g. a template). */
function makeLive(page, file, { extra = [], stale = false } = {}) {
  const paths = new Set([file]);
  const render = () => [...findAltSources(page.raw, { exactPaths: paths }).candidates.map((c) => ({ alt: c.storedAlt })), ...extra.map((alt) => ({ alt }))];
  let frozen = null;
  const fn = async () => {
    const now = render();
    if (stale) { frozen = frozen || now; return { status: 'checked', instances: frozen }; }
    return { status: 'checked', instances: now };
  };
  fn.render = render; fn.calls = 0;
  return fn;
}

function world({ raw = homepage(), file = HERO_FILE, src = HERO_URL, attachment = 301, libAlt = HERO_LIB_ALT, extraLive = [], diviVersion = '4.27.7', snap = {}, liveStale = false, content } = {}) {
  const projectId = new mongoose.Types.ObjectId(); projectIds.push(projectId);
  const page = makePage(raw);
  const media = makeMedia([mediaItem(attachment, file, { alt_text: libAlt })]);
  const live = makeLive(page, file, { extra: extraLive, stale: liveStale });
  const task = { _id: new mongoose.Types.ObjectId(), projectId, issueKey: 'images_missing_alt_text', pageUrl: PAGE, status: 'task_created', recommendationId: null, fixHistory: [], async save() {}, markModified() {} };
  const transitions = [];
  const connectionId = new mongoose.Types.ObjectId();
  const adapter = { ...media, readPostRawContent: async () => (page.readError ? null : page.raw), writeAltTextForAttachment: media.writeAltTextForAttachment.bind(media) };
  let liveCalls = 0;
  const deps = {
    wordPressService: {
      getHydratedConnectionOrThrow: async () => ({ _id: connectionId, site_url: SITE, application_password: 'secret' }),
      resolvePostIdFromUrl: async () => ({ postId: 6, postType: 'pages' }),
    },
    makeAdapter: () => adapter,
    bridge: { getBridgeStatus: async () => ({ installed: false, mediaAltSupported: false }) },
    loadFlaggedImages: async () => [{ before_snapshot: snapshot({ src, imageUrl: src, altState: 'empty', wpAttachmentId: attachment, ...snap }) }],
    loadPageDoc: async () => null,
    loadRecommendation: async () => ({ found: false }),
    taskHistory: { applyImplementedTransition: async (t, opts) => { transitions.push(opts); t.status = 'implemented'; t.fixHistory.push({ fixApplied: { expectedAfterValue: opts.expectedAfterValueOverride } }); } },
    sleep: async () => {},
    checkLiveAlt: async (args) => { liveCalls += 1; return live(args); },
    diviVersion: async () => ({ installed: true, version: diviVersion, tested: diviVersion === '4.27.7', testedVersions: ['4.27.7'] }),
    loadPage: async () => ({ ok: true, page: page.state(), resolved: { postId: 6, postType: 'pages' } }),
    readPage: async () => {
      page.reads += 1;
      if (page.readError) throw page.readError;
      if (page.beforeNextRead) { const fn = page.beforeNextRead; page.beforeNextRead = null; fn(); }
      return page.state();
    },
    writePage: async (_c, _p, newContent) => {
      page.writes.push(newContent);
      if (page.failWrite) throw page.failWrite;
      const landed = page.rewriteOnSave ? page.rewriteOnSave(newContent) : newContent;
      page.raw = landed; page.rev += 1;
      if (page.landThenFail) { const e = page.landThenFail; page.landThenFail = null; throw e; }
    },
  };
  void content;
  return { page, media, live, task, deps, transitions, projectId, liveCalls: () => liveCalls };
}

const INPUT = { imageSrc: HERO_URL, proposedAlt: AI };
const preview = (w, input = INPUT) => getAltFixPreview(w.task, input, w.deps);
const apply = async (w, input = INPUT, over = {}) => {
  const fp = (await preview(w, input)).plan.fingerprint;
  return applyAltFix(w.task, { ...input, approved: true, expectedPlanFingerprint: fp, actorId: new mongoose.Types.ObjectId(), ...over }, w.deps);
};
const rec = (w) => WordPressFixRecord.findOne({ taskId: w.task._id });
const stripAttr = (raw, attr, value) => raw.replace(` ${attr}="${value}"`, '');

describe('Image B — the Divi Fullwidth Header module that shows attachment #301', () => {
  test('PREVIEW names the exact source, the exact write target, what the page renders now and what the module holds — and offers nothing for the media library', async (t) => {
    if (skip(t)) return;
    const w = world();
    const p = await preview(w);
    assert.equal(p.plan.status, 'ready');
    assert.equal(p.plan.change.field, 'divi_module_alt');
    assert.deepEqual([p.plan.change.before, p.plan.change.after], ['', AI]);
    const s = p.source;
    assert.equal(s.kind, 'divi_page_module');
    assert.equal(s.module, 'et_pb_fullwidth_header');
    assert.deepEqual([s.imageAttribute, s.altAttribute, s.attributePresent, s.storedValue], ['header_image_url', 'image_alt_text', false, '']);
    assert.equal(s.identifier, 'pages/6:et_pb_fullwidth_header[0]');
    assert.equal(s.diviVersion, '4.27.7');
    assert.equal(s.evidence, 'divi_builder_source');
    assert.match(s.evidenceNote, /first change is also the first proof/);
    assert.match(s.writeTarget, /image_alt_text attribute of the et_pb_fullwidth_header module/);
    assert.match(s.verification, /fetches the live page/);
    assert.equal(s.writeMode, 'read_then_write');
    assert.equal(p.targetUrl, PAGE);
    assert.equal(p.identity.attachmentId, 301);
    assert.equal(p.image.sourceUrl, HERO_URL);
    assert.equal(p.current.alt, '');
    assert.match(p.current.note, /no alt attribute of its own/);
    assert.match(p.setting, /Divi page module → et_pb_fullwidth_header \(pages\/6\) → image_alt_text/);
    assert.equal(p.diagnosis.libraryAlt, HERO_LIB_ALT, 'the library value is shown but is NOT what changes');
    assert.equal(p.approvalStatus, 'awaiting_approval');
    assert.equal(w.page.writes.length, 0);
    assert.equal(w.media.writes.length, 0);
  });

  test('without text the plan needs input (and says where it would be written); an empty After is never a proposal', async (t) => {
    if (skip(t)) return;
    const w = world();
    const p = await preview(w, { imageSrc: HERO_URL });
    assert.equal(p.plan.status, 'needs_input');
    assert.match(p.plan.message, /Divi Fullwidth Header module/);
    assert.match(p.plan.message, /media library is not changed/);
    assert.equal(p.proposed.alt, null);
    assert.equal(p.approvalStatus, 'not_available');
    assert.equal(p.source.kind, 'divi_page_module');
  });

  test('the existing AI recommendation for THIS image is reused (read-only) and is not treated as proof of the picture', async (t) => {
    if (skip(t)) return;
    const w = world();
    w.deps.loadRecommendation = async () => ({ found: true, recommendationId: 'rec-9', generatedAt: new Date(), proposals: [{ src: HERO_URL, alt: AI, basis: 'file name', rejected: null }], legacyText: '' });
    const p = await preview(w, { imageSrc: HERO_URL });
    assert.equal(p.recommendation.alt, AI);
    assert.equal(p.recommendation.reviewStatus, 'needs_review');
    assert.equal(p.plan.status, 'needs_input', 'a suggestion alone never makes the plan ready');
  });

  test('APPLY writes ONLY the module alt attribute: the page differs from the original by exactly that attribute, the media library is untouched, everything verifies', async (t) => {
    if (skip(t)) return;
    const w = world();
    const original = w.page.raw;
    const r = await apply(w);
    assert.equal(w.page.writes.length, 1);
    assert.equal(stripAttr(w.page.raw, 'image_alt_text', AI), original, 'removing the one attribute gives the original page back byte for byte');
    assert.equal(w.media.writes.length, 0, 'the media library is never written for a module target');
    assert.equal(w.media.lib.get(301).alt_text, HERO_LIB_ALT);
    assert.equal(r.fix.status, 'verified');
    assert.equal(r.fix.verification.saved.status, 'verified');
    assert.equal(r.fix.verification.rendered.status, 'verified');
    assert.equal(r.immediateVerification, 'success');
    assert.equal(w.task.status, 'implemented', 'the task is implemented; the FINDING is resolved only by the next successful analysis');
    const row = await rec(w);
    assert.equal(row.target.sourceKind, 'divi_page_module');
    assert.equal(row.target.module, 'et_pb_fullwidth_header');
    assert.equal(row.target.altAttr, 'image_alt_text');
    assert.equal(row.target.attachmentId, 301);
    assert.deepEqual(row.changes.map((c) => [c.field, c.before, c.after, c.applied, c.writeMode, c.atomic]), [['divi_module_alt', '', AI, true, 'read_then_write', false]]);
    assert.equal(row.changes[0].source, 'human_input');
  });

  test('the task bookkeeping records the occurrence: the recrawl must show the text on THIS use while the others keep their own', async (t) => {
    if (skip(t)) return;
    const w = world({ extraLive: [] });
    await apply(w);
    const entry = w.transitions[0].expectedAfterValueOverride.images[0];
    assert.deepEqual([entry.attachmentId, entry.alt], [301, AI]);
    assert.equal(entry.occurrence.mode, 'one_use');
    assert.equal(w.transitions[0].externalWrite.field, 'image_alt');
    assert.equal(w.transitions[0].externalWrite.wordpressPostId, 6, 'the written object is the PAGE');
  });

  test('provenance is decided by the server: the AI text exactly, an edited AI text, or the person\'s own', async (t) => {
    if (skip(t)) return;
    const w = world();
    w.deps.loadRecommendation = async () => ({ found: true, recommendationId: 'rec-9', generatedAt: new Date(), proposals: [{ src: HERO_URL, alt: AI, basis: '', rejected: null }], legacyText: '' });
    await apply(w);
    assert.equal((await rec(w)).changes[0].source, 'ai_recommendation');
    assert.equal((await rec(w)).target.recommendationId, 'rec-9');
    const w2 = world();
    w2.deps.loadRecommendation = w.deps.loadRecommendation;
    await apply(w2, { imageSrc: HERO_URL, proposedAlt: `${AI} in a meeting` });
    assert.equal((await rec(w2)).changes[0].source, 'ai_recommendation_edited');
  });
});

describe('Image A — the Divi Theme Builder header logo (attachment #130)', () => {
  // The page's own content does not mention the logo file: the Theme Builder header template draws it.
  const headerWorld = () => world({
    raw: withModules(imageModule('https://sapphiredigitalagency.com/wp-content/uploads/2025/12/unrelated.webp', 'Unrelated')),
    file: LOGO_FILE, src: LOGO_URL, attachment: 130, libAlt: 'Sapphire Digital Agency', snap: { inLink: true },
  });

  test('stays manual with the PRECISE blocker: Theme Builder layouts are not exposed over REST; names the setting to change by hand', async (t) => {
    if (skip(t)) return;
    const w = headerWorld();
    const p = await preview(w, { imageSrc: LOGO_URL, proposedAlt: 'Sapphire Digital Agency logo' });
    assert.equal(p.plan.status, 'rendered_mismatch');
    assert.equal(p.source.kind, 'manual');
    assert.equal(p.source.code, 'THEME_TEMPLATE_NOT_EDITABLE');
    assert.match(p.source.message, /Theme Builder/);
    assert.match(p.source.message, /REST API/);
    assert.match(p.source.message, /logo_alt/);
    assert.equal(p.approvalStatus, 'not_available');
    assert.equal(p.plan.change, null);
  });

  test('apply is refused, and NOTHING is written anywhere (page or media library)', async (t) => {
    if (skip(t)) return;
    const w = headerWorld();
    const input = { imageSrc: LOGO_URL, proposedAlt: 'Sapphire Digital Agency logo' };
    const fp = (await preview(w, input)).plan.fingerprint;
    await assert.rejects(applyAltFix(w.task, { ...input, approved: true, expectedPlanFingerprint: fp, actorId: new mongoose.Types.ObjectId() }, w.deps), (e) => e.code === 'FIELD_NOT_WRITABLE');
    assert.equal(w.page.writes.length, 0);
    assert.equal(w.media.writes.length, 0);
  });
});

describe('the same attachment used by several modules (header-style empty use + footer-style use with alt)', () => {
  const FOOTER_ALT = 'Sapphire Digital Agency';
  const twoUses = () => world({
    raw: withModules(imageModule(LOGO_URL, FOOTER_ALT), imageModule(LOGO_URL, ''), blurbModule('https://sapphiredigitalagency.com/wp-content/uploads/2025/12/other.webp', 'Other')),
    file: LOGO_FILE, src: LOGO_URL, attachment: 130, libAlt: FOOTER_ALT,
  });
  const IN = { imageSrc: LOGO_URL, proposedAlt: 'Sapphire Digital Agency header logo' };

  test('the finding targets EXACTLY the module that lacks alt; the footer module and the media library are never touched', async (t) => {
    if (skip(t)) return;
    const w = twoUses();
    const before = w.page.raw;
    const p = await preview(w, IN);
    assert.equal(p.plan.status, 'ready');
    assert.equal(p.source.module, 'et_pb_image');
    assert.equal(p.source.identifier, 'pages/6:et_pb_image[1]', 'the SECOND image module (the one without alt)');
    const r = await apply(w, IN);
    assert.equal(r.fix.status, 'verified');
    assert.ok(w.page.raw.includes(`alt="${FOOTER_ALT}"`));
    assert.equal(w.page.raw.split(`alt="${FOOTER_ALT}"`).length - 1, 1, 'the footer-style use still carries exactly its own alt');
    assert.ok(w.page.raw.includes('alt="Sapphire Digital Agency header logo"'));
    assert.equal(w.page.raw.replace('alt="Sapphire Digital Agency header logo"', 'alt=""'), before);
    assert.equal(w.media.writes.length, 0);
    assert.deepEqual((await rec(w)).target.renderedBefore.alts, ['Sapphire Digital Agency', '']);
    assert.deepEqual(w.transitions[0].expectedAfterValueOverride.images[0].occurrence.otherAlts, ['Sapphire Digital Agency']);
  });

  test('two modules that BOTH lack alt cannot be told apart: ambiguous, manual, nothing offered', async (t) => {
    if (skip(t)) return;
    const w = world({ raw: withModules(imageModule(LOGO_URL, ''), imageModule(LOGO_URL, '')), file: LOGO_FILE, src: LOGO_URL, attachment: 130, libAlt: '' });
    const p = await preview(w, IN);
    assert.equal(p.source.kind, 'manual');
    assert.equal(p.source.code, 'MULTIPLE_DIVI_MODULES_MATCH');
    assert.equal(p.source.status, 'ambiguous');
    assert.notEqual(p.plan.status, 'ready');
    assert.equal(w.page.writes.length, 0);
  });

  test('another place (a template) ALSO renders the image without alt: a module change alone would not fix every occurrence — manual', async (t) => {
    if (skip(t)) return;
    const w = world({ raw: withModules(imageModule(LOGO_URL, '')), file: LOGO_FILE, src: LOGO_URL, attachment: 130, libAlt: FOOTER_ALT, extraLive: [''] });
    const p = await preview(w, IN);
    assert.equal(p.source.code, 'OTHER_SOURCE_ALSO_RENDERS_EMPTY');
    assert.notEqual(p.plan.status, 'ready');
  });
});

describe('unsupported storage formats and unverified versions stay manual, with the reason', () => {
  const cases = [
    ['Divi 5 block content', () => world({ raw: `${DIVI5}<!-- wp:divi/image {"src":"${HERO_URL}"} /-->` }), 'DIVI_FORMAT_UNSUPPORTED'],
    ['an unverified Divi version', () => world({ diviVersion: '4.28.0' }), 'DIVI_VERSION_NOT_VERIFIED'],
    ['a module type outside the verified registry', () => world({ raw: withModules(`[et_pb_slide image="${HERO_URL}" _builder_version="4.27.7"][/et_pb_slide]`) }), 'NO_SUPPORTED_DIVI_MODULE'],
    ['a global (Divi Library) module', () => world({ raw: withModules(heroHeader(' global_module="42"')) }), 'DIVI_MODULE_NOT_EDITABLE'],
    ['dynamic content', () => world({ raw: withModules(heroHeader(' _dynamic_attributes="image_alt_text"')) }), 'DIVI_MODULE_NOT_EDITABLE'],
    ['malformed shortcodes', () => world({ raw: `[et_pb_section][et_pb_fullwidth_header header_image_url="${HERO_URL}`, }), 'DIVI_CONTENT_UNPARSEABLE'],
  ];
  for (const [name, make, code] of cases) {
    test(`${name}: ${code}, no write offered`, async (t) => {
      if (skip(t)) return;
      const w = make();
      const p = await preview(w);
      assert.equal(p.source.kind, 'manual', name);
      assert.equal(p.source.code, code, name);
      assert.notEqual(p.plan.status, 'ready');
      assert.equal(p.approvalStatus, 'not_available');
      assert.equal(w.page.writes.length, 0);
    });
  }

  test('the live page cannot be read: the occurrence is unproven, so nothing is offered', async (t) => {
    if (skip(t)) return;
    const w = world();
    w.deps.checkLiveAlt = async () => ({ status: 'unavailable', instances: [] });
    const p = await preview(w);
    assert.equal(p.source.code, 'RENDERED_OCCURRENCE_NOT_VERIFIED');
    assert.notEqual(p.plan.status, 'ready');
  });

  test('page unreadable / not published: manual with the reason', async (t) => {
    if (skip(t)) return;
    const w = world();
    w.deps.loadPage = async () => ({ ok: false, code: 'PAGE_NOT_PUBLISHED', reason: 'Only published pages are changed automatically.' });
    assert.equal((await preview(w)).source.code, 'PAGE_NOT_PUBLISHED');
  });

  test('a non-Divi page builder (the image is named in an Elementor-style attribute): the media-library behaviour is unchanged', async (t) => {
    if (skip(t)) return;
    const w = world({ raw: `<div data-settings='{"image":{"url":"${HERO_URL}"}}'></div>` });
    const p = await preview(w);
    assert.equal(p.source.kind, 'manual');
    assert.equal(p.source.code, 'DIVI_FORMAT_UNSUPPORTED');
    assert.equal(p.plan.status, 'rendered_mismatch', 'exactly the earlier behaviour: no write is offered');
  });
});

describe('changed data after preview, concurrency and authorization', () => {
  test('the page changed after the preview: the approval is STALE and nothing is written', async (t) => {
    if (skip(t)) return;
    const w = world();
    const fp = (await preview(w)).plan.fingerprint;
    w.page.humanEdit((raw) => raw.replace('Plain text', 'An editor changed this paragraph'));
    await assert.rejects(applyAltFix(w.task, { ...INPUT, approved: true, expectedPlanFingerprint: fp, actorId: new mongoose.Types.ObjectId() }, w.deps), (e) => e.code === 'CONFLICT' && e.details.reason === 'preview_stale');
    assert.equal(w.page.writes.length, 0);
  });

  test('the module itself was edited after the preview (someone already gave it alt text): stale, never overwritten', async (t) => {
    if (skip(t)) return;
    const w = world();
    const fp = (await preview(w)).plan.fingerprint;
    w.page.humanEdit((raw) => raw.replace('header_image_url="' + HERO_URL + '"', 'header_image_url="' + HERO_URL + '" image_alt_text="Typed by an editor"'));
    await assert.rejects(applyAltFix(w.task, { ...INPUT, approved: true, expectedPlanFingerprint: fp, actorId: new mongoose.Types.ObjectId() }, w.deps), (e) => e.code === 'CONFLICT');
    assert.equal(w.page.writes.length, 0);
    assert.match(w.page.raw, /Typed by an editor/);
  });

  test('a human edit lands in the window AFTER the fingerprint check but BEFORE the write: conflict_detected, nothing overwritten', async (t) => {
    if (skip(t)) return;
    const w = world();
    const fp = (await preview(w)).plan.fingerprint;
    let reads = 0;
    const real = w.deps.readPage;
    w.deps.readPage = async (...args) => { reads += 1; if (reads === 1) { /* analyze's own read happens via loadPage; the apply re-read is this one */ w.page.humanEdit((raw) => raw.replace('Plain text', 'Edited in the window')); } return real(...args); };
    await assert.rejects(applyAltFix(w.task, { ...INPUT, approved: true, expectedPlanFingerprint: fp, actorId: new mongoose.Types.ObjectId() }, w.deps), (e) => e.code === 'CONFLICT');
    assert.equal(w.page.writes.length, 0);
    assert.match(w.page.raw, /Edited in the window/);
    assert.equal((await rec(w)).status, 'conflict_detected');
  });

  test('the page is not published any more: conflict, nothing written', async (t) => {
    if (skip(t)) return;
    const w = world();
    const fp = (await preview(w)).plan.fingerprint;
    const real = w.deps.readPage;
    w.deps.readPage = async (...a) => ({ ...(await real(...a)), status: 'draft' });
    await assert.rejects(applyAltFix(w.task, { ...INPUT, approved: true, expectedPlanFingerprint: fp, actorId: new mongoose.Types.ObjectId() }, w.deps), (e) => e.code === 'CONFLICT');
    assert.equal(w.page.writes.length, 0);
  });

  test('WordPress refuses the write for permissions: permission_denied, the page is unchanged, the task is not implemented', async (t) => {
    if (skip(t)) return;
    const w = world();
    w.page.failWrite = new WordPressConnectionError('PERMISSION_DENIED', 'This WordPress account may not edit this page.', 403);
    await assert.rejects(apply(w), (e) => e.code === 'PERMISSION_DENIED');
    assert.equal((await rec(w)).status, 'permission_denied');
    assert.equal(w.task.status, 'task_created');
    assert.equal(w.page.raw, homepage());
  });

  test('the page cannot be read with the connected credentials: permission_denied before any write', async (t) => {
    if (skip(t)) return;
    const w = world();
    const fp = (await preview(w)).plan.fingerprint;
    w.page.readError = new WordPressConnectionError('PERMISSION_DENIED', 'not allowed', 403);
    await assert.rejects(applyAltFix(w.task, { ...INPUT, approved: true, expectedPlanFingerprint: fp, actorId: new mongoose.Types.ObjectId() }, w.deps));
    assert.equal(w.page.writes.length, 0);
  });

  test('approval is required, the fingerprint is required, and another issue type is refused', async (t) => {
    if (skip(t)) return;
    const w = world();
    const fp = (await preview(w)).plan.fingerprint;
    await assert.rejects(applyAltFix(w.task, { ...INPUT, approved: false, expectedPlanFingerprint: fp }, w.deps), (e) => e.statusCode === 400);
    await assert.rejects(applyAltFix(w.task, { ...INPUT, approved: true }, w.deps), (e) => e.code === 'EXPECTED_STATE_REQUIRED');
    w.task.issueKey = 'title_missing';
    await assert.rejects(applyAltFix(w.task, { ...INPUT, approved: true, expectedPlanFingerprint: fp }, w.deps), (e) => e.code === 'FIELD_NOT_WRITABLE');
    assert.equal(w.page.writes.length, 0);
  });

  test('IDEMPOTENCY: two simultaneous identical approvals write exactly once', async (t) => {
    if (skip(t)) return;
    const w = world();
    const fp = (await preview(w)).plan.fingerprint;
    const go = () => applyAltFix(w.task, { ...INPUT, approved: true, expectedPlanFingerprint: fp, actorId: new mongoose.Types.ObjectId() }, w.deps);
    const results = await Promise.allSettled([go(), go()]);
    assert.equal(w.page.writes.length, 1);
    assert.ok(results.some((r) => r.status === 'fulfilled'));
  });
});

describe('partial writes, ambiguous outcomes and verification failures — never reported as fixed', () => {
  test('the write LANDED but the response was lost: reconciled by reading the page; written exactly once', async (t) => {
    if (skip(t)) return;
    const w = world();
    w.page.landThenFail = new WordPressConnectionError('TIMEOUT', 'timed out', 504);
    const r = await apply(w);
    assert.equal(w.page.writes.length, 1, 'never repeated');
    assert.equal((await rec(w)).changes[0].attribution, 'reconciled');
    assert.equal(r.fix.status, 'verified');
  });

  test('a transient failure BEFORE anything saved is retried (bounded) and then succeeds', async (t) => {
    if (skip(t)) return;
    const w = world();
    let n = 0; const real = w.deps.writePage;
    w.deps.writePage = async (...a) => { n += 1; if (n === 1) { w.page.writes.push('failed-attempt'); throw new WordPressConnectionError('TIMEOUT', 'timed out', 504); } return real(...a); };
    const r = await apply(w);
    assert.equal(n, 2);
    assert.equal(r.fix.status, 'verified');
  });

  test('a write that never lands: three attempts at most, then apply_failed, the page untouched', async (t) => {
    if (skip(t)) return;
    const w = world();
    w.deps.writePage = async () => { w.page.writes.push('x'); throw new WordPressConnectionError('TIMEOUT', 'timed out', 504); };
    await assert.rejects(apply(w));
    assert.equal(w.page.writes.length, 3);
    assert.equal((await rec(w)).status, 'apply_failed');
    assert.equal(w.page.raw, homepage());
    assert.equal(w.task.status, 'task_created');
  });

  test('a person edits the page during the failed write window: conflict, THEIR change survives', async (t) => {
    if (skip(t)) return;
    const w = world();
    w.deps.writePage = async () => { w.page.humanEdit((raw) => raw.replace('Plain text', 'Human edit wins')); throw new WordPressConnectionError('TIMEOUT', 'timed out', 504); };
    await assert.rejects(apply(w), (e) => e.code === 'CONFLICT');
    assert.match(w.page.raw, /Human edit wins/);
    assert.equal((await rec(w)).status, 'conflict_detected');
  });

  test('the outcome cannot even be read back: apply_uncertain, nothing repeated or undone', async (t) => {
    if (skip(t)) return;
    const w = world();
    const fp = (await preview(w)).plan.fingerprint;
    let reads = 0; const real = w.deps.readPage;
    w.deps.readPage = async (...a) => { reads += 1; if (reads >= 2) throw new WordPressConnectionError('TIMEOUT', 'down', 504); return real(...a); };
    w.deps.writePage = async () => { w.page.writes.push('x'); throw new WordPressConnectionError('TIMEOUT', 'timed out', 504); };
    await assert.rejects(applyAltFix(w.task, { ...INPUT, approved: true, expectedPlanFingerprint: fp, actorId: new mongoose.Types.ObjectId() }, w.deps), (e) => e.details?.reason === 'outcome_unknown' || e.code === 'OUTCOME_UNKNOWN');
    assert.equal(w.page.writes.length, 1);
    assert.equal((await rec(w)).status, 'apply_uncertain');
  });

  test('WordPress stores DIFFERENT content than was sent: verification_failed (not "verified"), no automatic undo, the task still records the real write', async (t) => {
    if (skip(t)) return;
    const w = world();
    w.page.rewriteOnSave = (sent) => sent.replace('Our delivery team at work', 'Rewritten by a plugin');
    const r = await apply(w);
    assert.equal(r.fix.status, 'verification_failed');
    assert.equal(r.fix.verification.saved.status, 'failed');
    assert.equal(r.fix.verification.saved.reasonCode, 'CONTENT_MISMATCH');
    assert.equal(w.page.writes.length, 1, 'no second write: Odito never "fixes" a failed verification on its own');
    assert.equal(w.task.status, 'implemented');
    assert.equal(r.immediateVerification, 'failed');
  });

  test('the module holds the text but the LIVE page still renders none (a cache, or the theme ignores it): verification_failed, saved verified, explained', async (t) => {
    if (skip(t)) return;
    const w = world({ liveStale: true });
    const r = await apply(w);
    assert.equal(r.fix.verification.saved.status, 'verified');
    assert.equal(r.fix.verification.rendered.status, 'failed');
    assert.equal(r.fix.verification.rendered.reasonCode, 'RENDERED_UNCHANGED');
    assert.equal(r.fix.status, 'verification_failed');
    assert.match(r.fix.verification.rendered.reasons[0], /does not write it again/);
    assert.equal(w.page.writes.length, 1);
  });

  test('the live page cannot be read after the write: unverifiable, status stays applied (never verified)', async (t) => {
    if (skip(t)) return;
    const w = world();
    const real = w.deps.checkLiveAlt;
    w.deps.checkLiveAlt = async (a) => (w.page.writes.length > 0 ? { status: 'unavailable', instances: [] } : real(a)); // readable until the write lands
    const r = await apply(w);
    assert.equal(r.fix.verification.rendered.status, 'unverifiable');
    assert.equal(r.fix.status, 'applied');
    assert.equal(r.immediateVerification, 'unknown');
  });

  test('RE-VERIFY after the cache clears: the same record becomes verified', async (t) => {
    if (skip(t)) return;
    const w = world({ liveStale: true });
    await apply(w);
    assert.equal((await rec(w)).status, 'verification_failed');
    w.deps.checkLiveAlt = async () => ({ status: 'checked', instances: w.live.render() });
    const r = await reverifyAltFix(w.task, { imageSrc: HERO_URL }, w.deps);
    assert.equal(r.fix.status, 'verified');
    assert.equal(r.fix.verification.rendered.status, 'verified');
  });

  test('renderedOccurrenceCheck: exactly one empty use turns into the approved text, the others unchanged; anything else fails', () => {
    const before = { alts: ['', 'Sapphire Digital Agency'] };
    const ok = renderedOccurrenceCheck({ before, after: { status: 'checked', instances: [{ alt: 'Header logo' }, { alt: 'Sapphire Digital Agency' }] }, approved: 'Header logo', now: new Date() });
    assert.equal(ok.status, 'verified');
    assert.equal(renderedOccurrenceCheck({ before, after: { status: 'checked', instances: [{ alt: 'Header logo' }, { alt: 'Header logo' }] }, approved: 'Header logo', now: new Date() }).reasonCode, 'RENDERED_DIFFERS', 'another use changed too');
    assert.equal(renderedOccurrenceCheck({ before, after: { status: 'checked', instances: [{ alt: '' }, { alt: 'Sapphire Digital Agency' }] }, approved: 'Header logo', now: new Date() }).reasonCode, 'RENDERED_UNCHANGED');
    assert.equal(renderedOccurrenceCheck({ before, after: { status: 'checked', instances: [{ alt: 'Header logo<br />\n' }, { alt: 'Sapphire Digital Agency' }] }, approved: 'Header logo', now: new Date() }).status, 'verified', 'the trailing <br /> WordPress appends is normalised');
    assert.equal(renderedOccurrenceCheck({ before, after: { status: 'unavailable', instances: [] }, approved: 'x', now: new Date() }).status, 'unverifiable');
    assert.equal(renderedOccurrenceCheck({ before, after: { status: 'not_found', instances: [] }, approved: 'x', now: new Date() }).status, 'unverifiable');
  });
});

describe('rollback — only the attribute Odito added, only while it still holds Odito\'s text', () => {
  test('restores the ORIGINAL page byte for byte (the attribute that did not exist is removed), verified on the page and the live render', async (t) => {
    if (skip(t)) return;
    const w = world();
    const original = w.page.raw;
    await apply(w);
    const r = await rollbackAltFix(w.task, { imageSrc: HERO_URL, actorId: new mongoose.Types.ObjectId() }, w.deps);
    assert.equal(w.page.raw, original);
    assert.equal(r.fix.status, 'rolled_back');
    assert.equal(r.fix.rollback.status, 'verified');
    assert.match(r.message, /only its alt attribute was touched/);
    assert.equal(w.media.writes.length, 0);
  });

  test('a newer human edit of the module wins: the rollback refuses and leaves it as it is now', async (t) => {
    if (skip(t)) return;
    const w = world();
    await apply(w);
    w.page.humanEdit((raw) => raw.replace(`image_alt_text="${AI}"`, 'image_alt_text="A human rewrote this"'));
    const before = w.page.raw;
    const r = await rollbackAltFix(w.task, { imageSrc: HERO_URL, actorId: new mongoose.Types.ObjectId() }, w.deps);
    assert.equal(w.page.raw, before);
    assert.equal(r.fix.rollback.status, 'failed');
    assert.match(r.message, /left as it is now/);
  });

  test('other content edited since the apply is preserved by the rollback (only the attribute is edited, never a stored snapshot restored)', async (t) => {
    if (skip(t)) return;
    const w = world();
    await apply(w);
    w.page.humanEdit((raw) => raw.replace('Plain text', 'Newer paragraph written after the fix'));
    await rollbackAltFix(w.task, { imageSrc: HERO_URL, actorId: new mongoose.Types.ObjectId() }, w.deps);
    assert.match(w.page.raw, /Newer paragraph written after the fix/);
    assert.ok(!w.page.raw.includes('image_alt_text'));
  });

  test('a module whose alt attribute existed (alt="") gets the empty attribute back, not a deleted one', async (t) => {
    if (skip(t)) return;
    const w = world({ raw: withModules(imageModule(HERO_URL, '')) });
    const original = w.page.raw;
    await apply(w);
    assert.ok(w.page.raw.includes(`alt="${AI}"`));
    await rollbackAltFix(w.task, { imageSrc: HERO_URL, actorId: new mongoose.Types.ObjectId() }, w.deps);
    assert.equal(w.page.raw, original);
  });

  test('a repeat rollback is idempotent; rolling back what was never applied is refused', async (t) => {
    if (skip(t)) return;
    const w = world();
    await assert.rejects(rollbackAltFix(w.task, { imageSrc: HERO_URL }, w.deps), (e) => e.statusCode === 404);
    await apply(w);
    await rollbackAltFix(w.task, { imageSrc: HERO_URL }, w.deps);
    const writes = w.page.writes.length;
    await assert.rejects(rollbackAltFix(w.task, { imageSrc: HERO_URL }, w.deps), (e) => e.statusCode === 404);
    assert.equal(w.page.writes.length, writes);
  });

  test('after a rollback the same plan can be approved and applied again', async (t) => {
    if (skip(t)) return;
    const w = world();
    await apply(w);
    await rollbackAltFix(w.task, { imageSrc: HERO_URL }, w.deps);
    w.task.status = 'task_created';
    const again = await apply(w);
    assert.equal(again.fix.status, 'verified');
  });
});

describe('malformed or unexpected content is never edited', () => {
  test('unterminated shortcodes anywhere in the page: manual, not repaired, not written', async (t) => {
    if (skip(t)) return;
    const w = world({ raw: `${homepage()}[et_pb_text title="never closed` });
    const p = await preview(w);
    assert.equal(p.source.code, 'DIVI_CONTENT_UNPARSEABLE');
    assert.equal(w.page.writes.length, 0);
  });

  test('sanity: a well-formed page proves as a one-attribute edit before the single write is sent (the refusal cases are covered by verifyAltEdit in diviImageAlt.test.js)', async (t) => {
    if (skip(t)) return;
    const w = world();
    const fp = (await preview(w)).plan.fingerprint;
    // make the edit helper's proof fail by having WordPress hand back content the parser reads differently between preview and apply
    const real = w.deps.readPage;
    w.deps.readPage = async (...a) => { const p = await real(...a); return { ...p, content: { raw: p.content.raw } }; };
    const r = await applyAltFix(w.task, { ...INPUT, approved: true, expectedPlanFingerprint: fp, actorId: new mongoose.Types.ObjectId() }, w.deps);
    assert.equal(r.fix.status, 'verified', 'sanity: a well-formed page proves cleanly');
    assert.equal(w.page.writes.length, 1);
  });
});

describe('capability facts exposed to the person', () => {
  test('the page store really matches the helpers the tests rely on (guard against a drifting double)', () => {
    const raw = homepage();
    const c = findAltSources(raw, { exactPaths: new Set([HERO_FILE]) }).candidates[0];
    const edit = planAltEdit(raw, c, 'x y z');
    assert.equal(fingerprintOf({ content: { raw }, modifiedGmt: 'a', status: 'publish' }) === fingerprintOf({ content: { raw: edit.content }, modifiedGmt: 'a', status: 'publish' }), false);
    assert.ok(attachmentExactPaths({ media_details: { file: HERO_FILE, sizes: {} } }).has(HERO_FILE));
    assert.equal(norm('  a  b '), 'a b');
  });
});
