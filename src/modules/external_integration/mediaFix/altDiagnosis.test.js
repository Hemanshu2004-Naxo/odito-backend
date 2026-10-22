import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { STATE, SOURCE, diagnoseAlt, instancesFromPageDoc } from './altDiagnosis.js';
import { planAltFix, ALT_PLAN_VERSION } from './altFixPlan.js';
import { attachmentExactPaths } from './imageIdentity.js';
import { checkLiveImageAlt, clearLiveAltCache, imagesFromHtml } from './liveAlt.js';

/**
 * Two REAL cases from the Sapphire homepage (traced against the live page, the crawl and the WordPress media library):
 *   #130  the header logo   — rendered 3x with alt="" by a theme-builder header inside an unnamed link, 1x in the footer with the library alt
 *   #301  the hero image    — named inside a Divi module in the page content, rendered alt="" alt/title, library alt is meaningful
 */
const LOGO_SRC = 'https://sapphiredigitalagency.com/wp-content/uploads/2025/12/sapphire-digital-Agency-1.webp';
const HERO_SRC = 'https://sapphiredigitalagency.com/wp-content/uploads/2025/12/Digital-Marketing-Agency-That-Delivers-Real-Results.webp';
const logoSnap = { type: 'image_alt', src: LOGO_SRC, imageUrl: LOGO_SRC, altState: 'empty', wpAttachmentId: 130, inLink: true, linkText: null, linkTitle: null, linkLabel: null, role: null, ariaHidden: false, srcsetUrls: [] };
const heroSnap = { type: 'image_alt', src: HERO_SRC, imageUrl: HERO_SRC, altState: 'empty', wpAttachmentId: 301, inLink: false, linkText: null, linkTitle: null, role: null, ariaHidden: false, srcsetUrls: [] };
const logoMedia = { id: 130, alt_text: 'Sapphire Digital Agency', source_url: LOGO_SRC, media_details: { file: '2025/12/sapphire-digital-Agency-1.webp', sizes: {} } };
const heroMedia = { id: 301, alt_text: 'Professional digital marketing agency team providing global SEO services in US, UK, India, Dubai, Australia', source_url: HERO_SRC, media_details: { file: '2025/12/Digital-Marketing-Agency-That-Delivers-Real-Results.webp', sizes: {} } };
const logoInstances = [{ alt: '', inLink: true, linkName: null }, { alt: '', inLink: true, linkName: null }, { alt: '', inLink: true, linkName: null }, { alt: 'Sapphire Digital Agency', inLink: false, linkName: null }];

describe('Example B — #130, the header logo: the library alt works elsewhere but the header template overrides it', () => {
  const d = diagnoseAlt({ snapshot: logoSnap, media: logoMedia, content: { status: 'not_in_content' }, instances: logoInstances, builderLabel: 'Divi' });
  test('diagnosed as an override by a theme/builder template, not a missing library alt — and NOT writable', () => {
    assert.equal(d.state, STATE.OVERRIDDEN);
    assert.equal(d.source, SOURCE.THEME_TEMPLATE);
    assert.equal(d.fixMechanism, 'theme_template');
    assert.equal(d.supported, false);
    assert.equal(d.libraryAlt, 'Sapphire Digital Agency');
    assert.equal(d.renderedAlt, '');
  });
  test('the evidence is the page\'s own: 4 occurrences, 1 with alt; the logo link has no accessible name', () => {
    const e = d.evidence.join(' ');
    assert.match(e, /appears 4 times on the page; 1 of them render alt text and 3 render none/);
    assert.match(e, /templat/);
    assert.match(e, /only content of a link with no name/);
    assert.match(d.manual, /template/);
    assert.match(d.manual, /would not change it/);
  });
  test('the plan is rendered_mismatch: no change, nothing approvable, the media library value is not touched', () => {
    const plan = planAltFix({ snapshot: logoSnap, identity: { status: 'resolved', attachmentId: 130, media: logoMedia }, content: { status: 'not_in_content' }, diagnosis: d, proposedAlt: 'Sapphire Digital Agency logo' });
    assert.equal(plan.status, 'rendered_mismatch');
    assert.equal(plan.code, 'RENDERED_ALT_OVERRIDES_LIBRARY');
    assert.equal(plan.change, null);
    assert.match(plan.message, /Sapphire Digital Agency/);
    assert.match(plan.message, /never overwrites meaningful alt text/);
  });
});

describe('Example A — #301, the hero image: a builder module overrides a meaningful library alt', () => {
  const d = diagnoseAlt({ snapshot: heroSnap, media: heroMedia, content: { status: 'builder_reference' }, instances: [{ alt: '', inLink: false, linkName: null }], builderLabel: 'Divi' });
  test('diagnosed as a page-builder module override (named Divi), manual, and NOT "decorative"', () => {
    assert.equal(d.state, STATE.OVERRIDDEN);
    assert.equal(d.source, SOURCE.PAGE_BUILDER_MODULE);
    assert.equal(d.supported, false);
    assert.equal(d.fixMechanism, 'page_content');
    assert.match(d.manual, /Divi/);
    assert.match(d.manual, /cannot edit builder modules/);
    assert.notEqual(d.state, STATE.DECORATIVE);
  });
  test('the old behaviour is gone: an empty alt is not "decorative" and the plan never leaves an empty After as a proposal', () => {
    const plan = planAltFix({ snapshot: heroSnap, identity: { status: 'resolved', attachmentId: 301, media: heroMedia }, content: { status: 'builder_reference' }, diagnosis: d });
    assert.equal(plan.status, 'rendered_mismatch');
    assert.equal(plan.classification.decorative, false);
    assert.equal(plan.change, null);
  });
});

describe('the other states', () => {
  const lib = (alt) => ({ id: 1, alt_text: alt, media_details: { file: '2024/10/a.jpg' } });
  const snap = (o = {}) => ({ src: 'https://c.example/wp-content/uploads/2024/10/a.jpg', altState: 'missing', inLink: false, ...o });

  test('truly missing alt (library empty too) on a library-rendered image: missing, and the media library IS the supported fix', () => {
    const d = diagnoseAlt({ snapshot: snap(), media: lib(''), content: { status: 'not_in_content' } });
    assert.deepEqual([d.state, d.supported, d.fixMechanism, d.source], [STATE.MISSING, true, 'media_library', SOURCE.MEDIA_LIBRARY]);
  });

  test('alt="" produced by the library\'s own emptiness is missing; alt="" from an unknown/builder source is a review', () => {
    assert.equal(diagnoseAlt({ snapshot: snap({ altState: 'empty' }), media: lib(''), content: { status: 'not_in_content' } }).state, STATE.MISSING);
    assert.equal(diagnoseAlt({ snapshot: snap({ altState: 'empty' }), media: lib(''), content: { status: 'unknown' } }).state, STATE.NEEDS_REVIEW);
    const b = diagnoseAlt({ snapshot: snap({ altState: 'empty' }), media: lib(''), content: { status: 'builder_reference' } });
    assert.equal(b.state, STATE.NEEDS_REVIEW);
    assert.equal(b.builderMayOverride, true, 'a write is allowed but flagged: the rendered check decides');
  });

  test('a decorative image on evidence is decorative even when the library has alt text (decorative wins over override)', () => {
    const d = diagnoseAlt({ snapshot: snap({ role: 'presentation' }), media: lib('A meaningful description'), content: { status: 'not_in_content' } });
    assert.equal(d.state, STATE.DECORATIVE);
  });

  test('a library alt that is not meaningful (a file name, "image") does not count as existing alt text', () => {
    for (const junk of ['image', 'dr-rao.jpg']) {
      const d = diagnoseAlt({ snapshot: snap(), media: lib(junk), content: { status: 'not_in_content' } });
      assert.equal(d.libraryMeaningful, false, junk);
      assert.equal(d.state, STATE.MISSING, junk);
    }
    // and a reviewed change may replace it, showing the real before value
    const plan = planAltFix({ snapshot: snap(), identity: { status: 'resolved', attachmentId: 1, media: lib('image') }, content: { status: 'not_in_content' }, proposedAlt: 'Dr Rao examining a patient' });
    assert.equal(plan.status, 'ready');
    assert.deepEqual([plan.change.before, plan.change.after], ['image', 'Dr Rao examining a patient']);
  });

  test('alt embedded in the page content: unsupported, edited in the page editor', () => {
    const d = diagnoseAlt({ snapshot: snap({ altState: 'empty' }), media: lib(''), content: { status: 'embedded', hasAltAttr: true, embeddedAlt: '' } });
    assert.deepEqual([d.state, d.source, d.supported], [STATE.EMBEDDED, SOURCE.PAGE_CONTENT_HTML, false]);
  });

  test('STALE: a live read showing alt on every occurrence makes the finding stale; nothing is offered and nothing is changed', () => {
    const live = { status: 'checked', instances: [{ alt: 'Sapphire Digital Agency' }, { alt: 'Sapphire Digital Agency' }] };
    const d = diagnoseAlt({ snapshot: logoSnap, media: logoMedia, content: { status: 'not_in_content' }, instances: logoInstances, live });
    assert.equal(d.state, STATE.STALE);
    const plan = planAltFix({ snapshot: logoSnap, identity: { status: 'resolved', attachmentId: 130, media: logoMedia }, content: { status: 'not_in_content' }, diagnosis: d, proposedAlt: 'x y' });
    assert.equal(plan.status, 'stale_finding');
    assert.equal(plan.change, null);
    assert.match(plan.message, /leaves the audit on the next recrawl; nothing was changed/);
  });

  test('NOT stale: one occurrence still empty, or the live page unreadable / image not found, keeps the mismatch', () => {
    for (const live of [{ status: 'checked', instances: [{ alt: 'x' }, { alt: '' }] }, { status: 'unavailable', instances: [] }, { status: 'not_found', instances: [] }, null]) {
      assert.equal(diagnoseAlt({ snapshot: logoSnap, media: logoMedia, content: { status: 'not_in_content' }, live }).state, STATE.OVERRIDDEN);
    }
  });

  test('the plan fingerprint is bound to the diagnosis: an approval from before cannot be replayed under a different diagnosis or planner version', () => {
    assert.equal(ALT_PLAN_VERSION, 4); // bumped when the Divi page-module write target was added: older approvals can never replay
    const id = { status: 'resolved', attachmentId: 1, media: lib('') };
    const a = planAltFix({ snapshot: snap(), identity: id, content: { status: 'not_in_content' }, proposedAlt: 'Dr Rao at work' });
    const b = planAltFix({ snapshot: snap({ altState: 'empty' }), identity: id, content: { status: 'builder_reference' }, proposedAlt: 'Dr Rao at work', informative: true });
    assert.notEqual(a.fingerprint, b.fingerprint);
  });
});

describe('matching the crawl\'s occurrences — exact evidence only', () => {
  const paths = attachmentExactPaths({ media_details: { file: '2025/12/sapphire-digital-Agency-1.webp', sizes: {} } });
  const doc = { images: [
    { src: LOGO_SRC, alt: '', in_link: true, wp_attachment_id: 130 },
    { src: 'https://www.sapphiredigitalagency.com/wp-content/uploads/2025/12/sapphire-digital-Agency-1.webp', alt: 'Sapphire Digital Agency', in_link: false },
    { src: 'https://sapphiredigitalagency.com/wp-content/uploads/2025/12/sapphire-digital-Agency-1-copy.webp', alt: 'A similarly named file', wp_attachment_id: null },
    { src: LOGO_SRC.replace('Agency-1', 'Agency-2'), alt: 'Another image', wp_attachment_id: 999 },
  ] };
  test('only the wp-image id or an exact upload path matches; a similar file name never does', () => {
    const inst = instancesFromPageDoc(doc, { attachmentId: 130, exactPaths: paths });
    assert.deepEqual(inst.map((i) => i.alt), ['', 'Sapphire Digital Agency']);
  });
  test('no crawl data is "unknown", not "zero occurrences"', () => {
    assert.equal(instancesFromPageDoc(null, { attachmentId: 130, exactPaths: paths }), null);
  });
});

describe('liveAlt — a fresh read of the public page', () => {
  const HTML = `<html><body>
    <header><a href="https://www.sapphiredigitalagency.com/"><img fetchpriority="high" width="500" height="193" src="${LOGO_SRC}" alt="" srcset="https://www.sapphiredigitalagency.com/wp-content/uploads/2025/12/sapphire-digital-Agency-1.webp 500w"></a></header>
    <noscript><img height="1" width="1" src="https://www.facebook.com/tr?id=1&ev=PageView&noscript=1"></noscript>
    <footer><img width="500" height="193" src="${LOGO_SRC}" alt="Sapphire Digital Agency" title="Sapphire Digital Agency"></footer>
    <img src="${HERO_SRC}" alt="" title="">
  </body></html>`;
  const paths = attachmentExactPaths({ media_details: { file: '2025/12/sapphire-digital-Agency-1.webp', sizes: {} } });
  const heroPaths = attachmentExactPaths({ media_details: { file: '2025/12/Digital-Marketing-Agency-That-Delivers-Real-Results.webp', sizes: {} } });

  test('parses img occurrences with alt, link and noscript handling', () => {
    const imgs = imagesFromHtml(HTML);
    assert.equal(imgs.length, 3, 'the noscript tracker is not an image');
    assert.deepEqual(imgs.map((i) => i.alt), ['', 'Sapphire Digital Agency', '']);
    assert.equal(imgs[0].in_link, true);
    assert.equal(imgs[1].in_link, false);
  });

  test('matches THIS attachment by exact path and reports each occurrence; a different attachment is not mixed in', async () => {
    clearLiveAltCache();
    const logo = await checkLiveImageAlt({ pageUrl: 'https://www.sapphiredigitalagency.com/', siteUrl: 'https://www.sapphiredigitalagency.com', attachmentId: 130, exactPaths: paths }, { fetchHtml: async () => ({ html: HTML }) });
    assert.equal(logo.status, 'checked');
    assert.deepEqual(logo.instances.map((i) => i.alt), ['', 'Sapphire Digital Agency']);
    const hero = await checkLiveImageAlt({ pageUrl: 'https://www.sapphiredigitalagency.com/', siteUrl: 'https://www.sapphiredigitalagency.com', attachmentId: 301, exactPaths: heroPaths }, { fetchHtml: async () => { throw new Error('must come from cache'); } });
    assert.deepEqual(hero.instances.map((i) => i.alt), ['']);
  });

  test('asks the safe fetcher for a fresh copy of the same-site page, remembers it briefly, and degrades to "unavailable" on any failure', async () => {
    clearLiveAltCache();
    const calls = [];
    const fetchHtml = async (url, opts) => { calls.push([url, opts]); return { html: HTML }; };
    const args = { pageUrl: 'https://www.sapphiredigitalagency.com/', siteUrl: 'https://www.sapphiredigitalagency.com', attachmentId: 130, exactPaths: paths };
    await checkLiveImageAlt(args, { fetchHtml, now: () => 1000 });
    await checkLiveImageAlt(args, { fetchHtml, now: () => 2000 });
    assert.equal(calls.length, 1, 'one download per page per minute');
    assert.deepEqual(calls[0][1], { siteUrl: 'https://www.sapphiredigitalagency.com', cacheBust: true });
    await checkLiveImageAlt(args, { fetchHtml, now: () => 70_000 });
    assert.equal(calls.length, 2);
    clearLiveAltCache();
    assert.deepEqual(await checkLiveImageAlt(args, { fetchHtml: async () => { throw new Error('CROSS_SITE'); } }), { status: 'unavailable', instances: [] });
  });

  test('an image that is not on the live page is "not_found", never "all good"', async () => {
    clearLiveAltCache();
    const r = await checkLiveImageAlt({ pageUrl: 'https://s.example/p', siteUrl: 'https://s.example', attachmentId: 5, exactPaths: attachmentExactPaths({ media_details: { file: '2024/01/other.jpg', sizes: {} } }) }, { fetchHtml: async () => ({ html: HTML }) });
    assert.equal(r.status, 'not_found');
  });
});
