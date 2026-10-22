import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attachmentExactPaths, evaluateIdentity, exactMatches, matchRenderedImages, observedUrlsOf, searchTermFor, uploadsPath,
} from './imageIdentity.js';
import { SITE, UPLOADS, mediaItem, snapshot } from './__fixtures__/media.js';

describe('uploadsPath', () => {
  test('reads the path below wp-content/uploads, ignoring host, query and fragment; decodes it; drops a multisite prefix', () => {
    assert.equal(uploadsPath(`${UPLOADS}/2024/10/a.jpg?ver=2#x`), '2024/10/a.jpg');
    assert.equal(uploadsPath('https://cdn.example/wp-content/uploads/2024/10/a%20b.jpg'), '2024/10/a b.jpg');
    assert.equal(uploadsPath(`${SITE}/wp-content/uploads/sites/3/2024/10/a.jpg`), '2024/10/a.jpg');
  });
  test('anything that is not an uploads file is null', () => {
    assert.equal(uploadsPath(`${SITE}/wp-content/themes/x/logo.png`), null);
    assert.equal(uploadsPath('not a url'), null);
    assert.equal(uploadsPath('https://other.example/img/a.jpg'), null);
  });
});

describe('attachmentExactPaths — only files WordPress itself lists', () => {
  test('the original, every generated size and the original behind a -scaled copy', () => {
    const m = mediaItem(7, '2024/10/photo-scaled.jpg');
    m.media_details.original_image = 'photo.jpg';
    const p = attachmentExactPaths(m);
    for (const f of ['2024/10/photo-scaled.jpg', '2024/10/photo.jpg', '2024/10/photo-scaled-300x200.jpg', '2024/10/photo-scaled-768x512.jpg']) assert.ok(p.has(f), f);
    assert.ok(!p.has('2024/10/photo-1024x683.jpg'), 'a size WordPress did not list is not an attachment file');
  });
});

describe('evaluateIdentity — exact equality, never similarity', () => {
  const siteHost = 'clinic.example';
  const photo = mediaItem(42, '2024/10/dr-rao.jpg');

  test('wp-image class + a URL that is a file of that attachment -> resolved, high, method attachment_id_class', () => {
    const r = evaluateIdentity({ snapshot: snapshot({ wpAttachmentId: 42 }), siteHost, hinted: photo });
    assert.equal(r.status, 'resolved');
    assert.equal(r.attachmentId, 42);
    assert.equal(r.confidence, 'high');
    assert.equal(r.method, 'attachment_id_class');
    assert.ok(r.evidence.length >= 2);
  });

  test('a RESPONSIVE variant only in srcset still resolves (the exact generated size is listed by WordPress)', () => {
    const r = evaluateIdentity({
      snapshot: snapshot({ src: `${UPLOADS}/2024/10/something-else.jpg`, wpAttachmentId: 42, srcsetUrls: [`${UPLOADS}/2024/10/dr-rao-768x512.jpg`] }), siteHost, hinted: photo,
    });
    assert.equal(r.status, 'resolved');
    assert.deepEqual(r.matchedUrls, [`${UPLOADS}/2024/10/dr-rao-768x512.jpg`]);
  });

  test('the class names an attachment that does not exist -> ambiguous_target, nothing guessed', () => {
    const r = evaluateIdentity({ snapshot: snapshot({ wpAttachmentId: 99 }), siteHost, hinted: null });
    assert.equal(r.status, 'ambiguous_target');
    assert.equal(r.code, 'ATTACHMENT_NOT_FOUND');
  });

  test('the class and the URL DISAGREE (the id belongs to a different file) -> ambiguous_target', () => {
    const r = evaluateIdentity({ snapshot: snapshot({ wpAttachmentId: 5 }), siteHost, hinted: mediaItem(5, '2023/01/other.jpg') });
    assert.equal(r.status, 'ambiguous_target');
    assert.equal(r.code, 'ID_AND_URL_DISAGREE');
  });

  test('no class, exactly one attachment lists the exact file -> resolved via exact_source_url', () => {
    const r = evaluateIdentity({ snapshot: snapshot(), siteHost, candidates: [photo, mediaItem(8, '2024/10/other.jpg')] });
    assert.equal(r.status, 'resolved');
    assert.equal(r.method, 'exact_source_url');
    assert.equal(r.attachmentId, 42);
  });

  test('DUPLICATE FILE NAMES in different folders are different files: only the exact folder matches, so it is NOT ambiguous', () => {
    const a = mediaItem(1, '2024/10/dr-rao.jpg');
    const b = mediaItem(2, '2023/05/dr-rao.jpg');
    const r = evaluateIdentity({ snapshot: snapshot(), siteHost, candidates: [b, a] });
    assert.equal(r.status, 'resolved');
    assert.equal(r.attachmentId, 1);
  });

  test('a look-alike name is NOT a match (dr-rao-2.jpg is not dr-rao.jpg)', () => {
    const r = evaluateIdentity({ snapshot: snapshot(), siteHost, candidates: [mediaItem(3, '2024/10/dr-rao-2.jpg'), mediaItem(4, '2024/11/dr-rao.jpg')] });
    assert.equal(r.status, 'unsupported');
    assert.equal(r.code, 'NOT_IN_MEDIA_LIBRARY');
  });

  test('two attachments that BOTH list the same file -> ambiguous_target', () => {
    const r = evaluateIdentity({ snapshot: snapshot(), siteHost, candidates: [mediaItem(1, '2024/10/dr-rao.jpg'), mediaItem(9, '2024/10/dr-rao.jpg')] });
    assert.equal(r.status, 'ambiguous_target');
    assert.equal(r.code, 'MULTIPLE_ATTACHMENTS_MATCH');
  });

  test('a CDN host with the same uploads path resolves with MEDIUM confidence; the site host is high', () => {
    const cdn = evaluateIdentity({ snapshot: snapshot({ src: 'https://cdn.example/wp-content/uploads/2024/10/dr-rao.jpg' }), siteHost, candidates: [photo] });
    assert.equal(cdn.status, 'resolved');
    assert.equal(cdn.confidence, 'medium');
    assert.equal(evaluateIdentity({ snapshot: snapshot(), siteHost, candidates: [photo] }).confidence, 'high');
  });

  test('not an upload is unsupported with the SPECIFIC reason, never resolved, and a tracker is never a media-library target', () => {
    const why = (src, extra = {}) => evaluateIdentity({ snapshot: snapshot({ src, imageUrl: null, ...extra }), siteHost, candidates: [photo] });
    const theme = why(`${SITE}/wp-content/themes/x/hero.jpg`);
    assert.deepEqual([theme.status, theme.code], ['unsupported', 'THEME_ASSET']);
    assert.equal(why(`${SITE}/wp-content/plugins/x/a.png`).code, 'PLUGIN_ASSET');
    assert.equal(why(`${SITE}/wp-includes/images/a.gif`).code, 'CORE_ASSET');
    assert.equal(why('https://images.example.org/hero.jpg').code, 'EXTERNAL_IMAGE');
    assert.equal(why(`${SITE}/images/plain.jpg`).code, 'NOT_A_MEDIA_LIBRARY_FILE', 'an ordinary non-upload file keeps the generic reason');
    const fb = why('https://www.facebook.com/tr?id=1064713942451011&ev=PageView&noscript=1');
    assert.deepEqual([fb.status, fb.code], ['unsupported', 'TRACKING_ENDPOINT']);
    assert.ok(!fb.message.includes('1064713942451011'), 'the tracking id is never echoed to the user');
    assert.equal(why('https://www.facebook.com/tr?id=1', { resourceKind: 'wp_media' }).code, 'TRACKING_ENDPOINT', 'a wrong recorded kind cannot make a tracker eligible');
  });

  test('no URL at all is unsupported; an inline data image says so', () => {
    assert.equal(evaluateIdentity({ snapshot: snapshot({ src: null, imageUrl: null }), siteHost }).code, 'NO_IMAGE_URL');
    assert.equal(evaluateIdentity({ snapshot: snapshot({ src: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=', imageUrl: null }), siteHost }).code, 'DATA_URL_IMAGE');
  });
});

describe('search term and observed URLs', () => {
  test('the search stem drops size, -scaled and edit suffixes; it only fetches candidates', () => {
    assert.equal(searchTermFor(snapshot({ src: `${UPLOADS}/2024/10/dr-rao-768x512.jpg` })), 'dr-rao');
    assert.equal(searchTermFor(snapshot({ src: `${UPLOADS}/2024/10/photo-scaled.jpg` })), 'photo');
    assert.equal(searchTermFor(snapshot({ src: `${SITE}/wp-content/themes/a.jpg`, imageUrl: null })), null);
  });
  test('observed URLs are src + lazy + srcset, absolute http(s) only, de-duplicated', () => {
    const urls = observedUrlsOf(snapshot({ lazySrc: `${UPLOADS}/2024/10/l.jpg`, srcsetUrls: [`${UPLOADS}/2024/10/l.jpg`, 'data:image/gif;base64,AAA', '/relative.jpg'] }));
    assert.deepEqual(urls, [`${UPLOADS}/2024/10/dr-rao.jpg`, `${UPLOADS}/2024/10/l.jpg`]);
  });
});

describe('matchRenderedImages — the same image on the recrawled page, by stable evidence', () => {
  const photo = mediaItem(42, '2024/10/dr-rao.jpg');
  const paths = attachmentExactPaths(photo);
  const img = (over) => ({ src: `${UPLOADS}/2024/10/dr-rao.jpg`, alt: '', ...over });

  test('matched by the wp-image id and/or an exact upload path; a different image is not', () => {
    const { matched } = matchRenderedImages([img({ wp_attachment_id: 42 }), img({ src: `${UPLOADS}/2024/10/other.jpg` }), img({ src: `${UPLOADS}/2024/10/dr-rao-768x512.jpg` })], { attachmentId: 42, exactPaths: paths });
    assert.equal(matched.length, 2);
  });
  test('a CDN URL, a lazy-loaded real URL and a srcset-only variant all match by path', () => {
    const { matched } = matchRenderedImages([
      img({ src: 'https://cdn.example/wp-content/uploads/2024/10/dr-rao.jpg' }),
      img({ src: 'data:image/gif;base64,AAA', lazy_src: `${UPLOADS}/2024/10/dr-rao.jpg` }),
      img({ src: `${UPLOADS}/2024/10/zzz.jpg`, srcset_urls: [`${UPLOADS}/2024/10/dr-rao-300x200.jpg`] }),
    ], { attachmentId: 42, exactPaths: paths });
    assert.equal(matched.length, 3);
  });
  test('a rendered image whose class names ANOTHER attachment is conflicting evidence, never a match', () => {
    const r = matchRenderedImages([img({ wp_attachment_id: 77 })], { attachmentId: 42, exactPaths: paths });
    assert.equal(r.matched.length, 0);
    assert.equal(r.conflicting.length, 1);
  });
  test('file-name similarity alone is never a match', () => {
    const r = matchRenderedImages([img({ src: `${UPLOADS}/2023/01/dr-rao.jpg` })], { attachmentId: 42, exactPaths: paths });
    assert.equal(r.matched.length, 0);
  });
  test('exactMatches reports which observed URLs equal an attachment file', () => {
    assert.deepEqual(exactMatches([`${UPLOADS}/2024/10/dr-rao-300x200.jpg`, `${UPLOADS}/2024/10/x.jpg`], photo), [`${UPLOADS}/2024/10/dr-rao-300x200.jpg`]);
  });
});
