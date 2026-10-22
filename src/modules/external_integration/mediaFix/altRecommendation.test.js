import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REC_STATUS, evidenceFor, fileNameStem, loadRecommendationSource, mapLegacyByPosition, orderedEmptyAltSrcs, parseLegacyAltText,
  provenanceOf, recommendationForImage,
} from './altRecommendation.js';

const FB = 'https://www.facebook.com/tr?id=1064713942451011&ev=PageView&noscript=1';
const U = 'https://www.sapphiredigitalagency.com/wp-content/uploads/2025/12';
const SRCS = {
  logo: 'https://sapphiredigitalagency.com/wp-content/uploads/2025/12/sapphire-digital-Agency-1.webp',
  david: `${U}/david-peterson-testimonials-old-120x120.webp`,
  emily: `${U}/emily-tran-testimonial-120x120.webp`,
  michael: `${U}/Michael-Rodriguez-testimonials-120x120.webp`,
  jane: `${U}/jane-miller-testimonials-120x120.webp`,
  sophia: `${U}/sophia-Lee-testimonials-120x120.webp`,
};
const snap = (src, over = {}) => ({ type: 'image_alt', src, imageUrl: src, altState: 'empty', wpAttachmentId: null, srcsetUrls: [], lazySrc: null, figcaption: null, linkText: null, linkTitle: null, ...over });

const structured = (over = {}) => ({
  found: true, recommendationId: 'rec-1', generatedAt: new Date('2026-10-16T12:00:00Z'),
  proposals: [
    { src: SRCS.logo, alt: 'Sapphire Digital Agency logo', basis: 'file name', rejected: null },
    { src: SRCS.david, alt: 'David Peterson, Sapphire Digital Agency client', basis: 'file name', rejected: null },
    { src: SRCS.emily, alt: 'Emily Tran, Sapphire Digital Agency client', basis: 'file name', rejected: null },
    { src: SRCS.michael, alt: 'Michael Rodriguez, Sapphire Digital Agency client', basis: 'file name', rejected: null },
    { src: SRCS.jane, alt: 'Jane Miller, Sapphire Digital Agency client', basis: 'file name', rejected: null },
    { src: SRCS.sophia, alt: 'Sophia Lee, Sapphire Digital Agency client', basis: 'file name', rejected: null },
  ],
  legacyText: '', ...over,
});

describe('file name and evidence', () => {
  test('the stem drops folders, extension, size suffix, -scaled and edit suffixes', () => {
    assert.equal(fileNameStem(SRCS.david), 'david-peterson-testimonials-old');
    assert.equal(fileNameStem(`${U}/photo-scaled.jpg`), 'photo');
    assert.equal(fileNameStem(`${U}/a%20b-768x512.png`), 'a b');
  });

  test('confidence is computed from the site\'s own facts, never from what the model says', () => {
    const a = evidenceFor(snap(SRCS.david), 'David Peterson, Sapphire Digital Agency client');
    assert.equal(a.confidence, 'medium');
    assert.deepEqual(a.supportedBy, ['file_name']);
    assert.ok(a.evidence[0].includes('david-peterson-testimonials-old'));
    const b = evidenceFor(snap(SRCS.david), 'A smiling woman holding a trophy');
    assert.equal(b.confidence, 'low');
    assert.equal(evidenceFor(snap(SRCS.david, { figcaption: 'Our happy client' }), 'Happy client reviewing results').supportedBy.includes('caption'), true);
  });

  test('a wp-image id on the page is listed as evidence, never invented', () => {
    assert.ok(evidenceFor(snap(SRCS.david, { wpAttachmentId: 42 }), 'x').evidence.some((e) => e.includes('attachment 42')));
    assert.ok(!evidenceFor(snap(SRCS.david), 'x').evidence.some((e) => /attachment/.test(e)));
  });
});

describe('exact per-image mapping — six recommendations resolved independently', () => {
  test('each image gets ITS OWN text; none leaks to another', () => {
    const source = structured();
    const got = Object.fromEntries(Object.entries(SRCS).map(([k, src]) => [k, recommendationForImage({ snapshot: snap(src), source })]));
    assert.equal(got.david.alt, 'David Peterson, Sapphire Digital Agency client');
    assert.equal(got.emily.alt, 'Emily Tran, Sapphire Digital Agency client');
    assert.equal(got.logo.alt, 'Sapphire Digital Agency logo');
    assert.equal(new Set(Object.values(got).map((r) => r.alt)).size, 6);
    for (const r of Object.values(got)) {
      assert.equal(r.status, REC_STATUS.AVAILABLE);
      assert.equal(r.match, 'exact_src');
      assert.equal(r.reviewStatus, 'needs_review');
      assert.equal(r.needsConfirmation, false);
      assert.equal(r.recommendationId, 'rec-1');
    }
  });

  test('a responsive/CDN variant of the same image (its srcset or lazy URL) resolves to the same proposal; a similar file name does not', () => {
    const source = structured();
    const viaSrcset = snap(`${U}/david-peterson-testimonials-old-300x300.webp`, { srcsetUrls: [SRCS.david] });
    assert.equal(recommendationForImage({ snapshot: viaSrcset, source }).alt, 'David Peterson, Sapphire Digital Agency client');
    const lookalike = snap(`${U}/david-peterson-testimonials-old-300x300.webp`);
    assert.equal(recommendationForImage({ snapshot: lookalike, source }).status, REC_STATUS.NO_MATCH);
  });

  test('a new image the recommendation never covered is NO_MATCH, with a way forward', () => {
    const r = recommendationForImage({ snapshot: snap(`${U}/brand-new.webp`), source: structured() });
    assert.equal(r.status, REC_STATUS.NO_MATCH);
    assert.equal(r.alt, null);
    assert.match(r.message, /Regenerate the recommendation, or write the description yourself/);
  });

  test('the model declining (alt null) and unpublishable text are said plainly and never prefilled', () => {
    const source = structured({ proposals: [
      { src: SRCS.david, alt: null, basis: 'nothing to go on', rejected: null },
      { src: SRCS.emily, alt: null, basis: '', rejected: 'Alt text is too generic ("image", "photo", …). Describe what the image shows.' },
    ] });
    const a = recommendationForImage({ snapshot: snap(SRCS.david), source });
    assert.deepEqual([a.status, a.alt], [REC_STATUS.NOT_PROVIDED, null]);
    const b = recommendationForImage({ snapshot: snap(SRCS.emily), source });
    assert.equal(b.status, REC_STATUS.NOT_PROVIDED);
    assert.match(b.message, /too generic/);
  });

  test('stored text that is no longer publishable is refused at read time too', () => {
    const source = structured({ proposals: [{ src: SRCS.david, alt: 'david-peterson.jpg', basis: '', rejected: null }] });
    const r = recommendationForImage({ snapshot: snap(SRCS.david), source });
    assert.deepEqual([r.status, r.alt], [REC_STATUS.NOT_PUBLISHABLE, null]);
  });

  test('a tracker never has a recommendation, even if one is stored for it', () => {
    const source = structured({ proposals: [{ src: FB, alt: 'Facebook pixel', basis: '', rejected: null }] });
    const r = recommendationForImage({ snapshot: snap(FB), source });
    assert.deepEqual([r.status, r.alt], [REC_STATUS.NONE, null]);
  });

  test('no recommendation at all, and an unreadable one, are different honest states', () => {
    assert.equal(recommendationForImage({ snapshot: snap(SRCS.david), source: { found: false } }).status, REC_STATUS.NONE);
    assert.equal(recommendationForImage({ snapshot: snap(SRCS.david), source: null }).status, REC_STATUS.UNAVAILABLE);
  });
});

describe('legacy text-only recommendations — a safe transitional parser', () => {
  const LEGACY = 'Image 1 (Facebook pixel): alt="" | Image 2 (Agency logo/hero): alt="Sapphire Digital Agency – Full-Service Digital Marketing Agency" | Image 3 (David Peterson): alt="David Peterson, client of Sapphire Digital Agency" | Image 4 (Emily Tran): alt="Emily Tran, Sapphire Digital Agency client testimonial" | Image 5 (Michael Rodriguez): alt="Michael Rodriguez, Sapphire Digital Agency client testimonial" | Image 6 (Jane Miller): alt="Jane Miller, Sapphire Digital Agency client testimonial"';

  test('parses the numbered entries of the real recommendation text', () => {
    const e = parseLegacyAltText(LEGACY);
    assert.equal(e.length, 6);
    assert.deepEqual([e[0].n, e[0].label, e[0].alt], [1, 'Facebook pixel', '']);
    assert.equal(e[2].alt, 'David Peterson, client of Sapphire Digital Agency');
    assert.deepEqual(parseLegacyAltText(''), []);
    assert.deepEqual(parseLegacyAltText('no entries here'), []);
  });

  test('the REAL case is ambiguous: 6 entries, but the page had 8 empty-alt images (2 trackers) — nothing is mapped', () => {
    const eight = [FB, SRCS.logo, SRCS.david, SRCS.emily, SRCS.michael, SRCS.jane, SRCS.sophia, 'https://px.ads.linkedin.com/collect/?pid=1&fmt=gif'];
    assert.equal(mapLegacyByPosition(parseLegacyAltText(LEGACY), eight), null);
    const source = { found: true, recommendationId: 'old', proposals: null, legacyText: LEGACY };
    const r = recommendationForImage({ snapshot: snap(SRCS.david), source, orderedSrcs: eight });
    assert.deepEqual([r.status, r.alt], [REC_STATUS.AMBIGUOUS_LEGACY, null]);
    assert.match(r.message, /cannot be matched to this image with certainty/);
  });

  test('when the count matches exactly, entry N is image N — offered as a suggestion that MUST be confirmed', () => {
    const six = [FB, SRCS.logo, SRCS.david, SRCS.emily, SRCS.michael, SRCS.jane];
    const source = { found: true, recommendationId: 'old', proposals: null, legacyText: LEGACY };
    const r = recommendationForImage({ snapshot: snap(SRCS.david), source, orderedSrcs: six });
    assert.equal(r.status, REC_STATUS.SUGGESTED_BY_POSITION);
    assert.equal(r.match, 'legacy_position');
    assert.equal(r.needsConfirmation, true);
    assert.equal(r.alt, 'David Peterson, client of Sapphire Digital Agency');
    // the empty alt of entry 1 (the pixel) is never usable text
    assert.equal(recommendationForImage({ snapshot: snap(FB), source, orderedSrcs: six }).status, REC_STATUS.NONE);
  });

  test('gaps, duplicates or a different count never map', () => {
    const e = (ns) => ns.map((n) => ({ n, label: '', alt: `t${n}` }));
    assert.equal(mapLegacyByPosition(e([1, 3]), ['a', 'b']), null, 'gap');
    assert.equal(mapLegacyByPosition(e([1, 1]), ['a', 'b']), null, 'duplicate');
    assert.equal(mapLegacyByPosition(e([1, 2, 3]), ['a', 'b']), null, 'count differs');
    assert.deepEqual([...mapLegacyByPosition(e([2, 1]), ['a', 'b']).keys()], ['a', 'b'], 'order in the text does not matter, numbering does');
  });

  test('ordered empty-alt sources come from the stored crawl in page order', () => {
    const doc = { images: [{ src: 'a', alt: '' }, { src: 'b', alt: 'has' }, { src: 'c' }, { src: 'd', alt: '  ' }] };
    assert.deepEqual(orderedEmptyAltSrcs(doc), ['a', 'c', 'd']);
    assert.deepEqual(orderedEmptyAltSrcs(null), []);
  });
});

describe('provenance is decided on the server', () => {
  const rec = { status: REC_STATUS.AVAILABLE, alt: 'David Peterson, client' };
  test('the exact AI text, the AI text edited, and the person\'s own text', () => {
    assert.equal(provenanceOf('David Peterson, client', rec), 'ai_recommendation');
    assert.equal(provenanceOf('  David   Peterson, client ', rec), 'ai_recommendation', 'whitespace is not an edit');
    assert.equal(provenanceOf('David Peterson, our client', rec), 'ai_recommendation_edited');
    assert.equal(provenanceOf('anything', { status: REC_STATUS.NONE, alt: null }), 'human_input');
    assert.equal(provenanceOf('anything', null), 'human_input');
  });
});

describe('loading the recommendation to reuse', () => {
  const fake = (docs, linked = null) => {
    const calls = [];
    return {
      calls,
      Recommendation: {
        find(q) { calls.push(['find', q]); return { sort: () => ({ limit: () => ({ lean: async () => docs }) }) }; },
        findOne(q) { calls.push(['findOne', q]); return { lean: async () => linked }; },
      },
    };
  };
  const task = { projectId: 'p1', pageUrl: 'https://site.example/about-us', recommendationId: 'linked-1' };
  const doc = (id, withProposals) => ({ _id: id, updatedAt: new Date(), sections: { recommendedVersion: 'v', ...(withProposals ? { imageAltProposals: [{ src: 'a', alt: 'x y' }] } : {}) } });

  test('scoped by project, page and issue; invalidated recommendations are excluded', async () => {
    const f = fake([doc('r1', true)]);
    await loadRecommendationSource(task, f);
    const q = f.calls[0][1];
    assert.deepEqual([q.projectId, q.pageUrl, q.ruleId, q.invalidatedAt], ['p1', 'https://site.example/about-us', 'images_missing_alt_text', null]);
  });

  test('prefers the newest one WITH structured proposals over a newer legacy one', async () => {
    const s = await loadRecommendationSource(task, fake([doc('legacy-new', false), doc('struct-old', true)]));
    assert.equal(s.recommendationId, 'struct-old');
    assert.equal(Array.isArray(s.proposals), true);
  });

  test('falls back to the task\'s linked recommendation (scoped to the same project), then the newest legacy one', async () => {
    const f = fake([], doc('linked-1', false));
    const s = await loadRecommendationSource(task, f);
    assert.equal(s.recommendationId, 'linked-1');
    assert.equal(s.proposals, null);
    assert.equal(f.calls[1][1].projectId, 'p1', 'the linked id is still scoped to the project');
    const legacy = await loadRecommendationSource({ ...task, recommendationId: null }, fake([doc('l1', false)]));
    assert.equal(legacy.recommendationId, 'l1');
  });

  test('none at all -> found:false', async () => {
    assert.deepEqual(await loadRecommendationSource({ ...task, recommendationId: null }, fake([])), { found: false });
  });
});
