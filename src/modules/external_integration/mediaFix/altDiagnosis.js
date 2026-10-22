/**
 * altDiagnosis — what is ACTUALLY true about one image's alt text, and which mechanism could change it. Pure (no I/O).
 *
 * The audit says "this image renders without alt text". Before anything is offered, three things are compared for the exact image:
 *   the rendered alt        what the page's markup carries (from the finding / the crawl / the live page)
 *   the media-library alt   what WordPress holds for the attachment
 *   the rendering source    what draws the <img>: the page's own HTML, a page-builder module, or a theme/template
 * They can disagree, and then a media-library write is the WRONG fix: it changes metadata the page is not using.
 *
 * States (what the person is told):
 *   stale_finding            the live page already renders alt text on every occurrence — the finding is out of date
 *   decorative               explicit evidence (role/aria-hidden, or a named link) — no fix required
 *   embedded                 the alt is inside the page's own HTML — edit it in the page editor
 *   library_alt_overridden   WordPress already holds meaningful alt text, yet the page renders alt="" — the page/builder/template overrides it
 *   link_without_name        the image is the only content of an unnamed link — it needs a description (never decorative)
 *   needs_review             alt="" and nothing says whether that is deliberate — a person decides
 *   missing                  no alt anywhere — a description is needed
 *
 * `fixMechanism`: 'media_library' (Odito's supported write), 'page_content' / 'theme_template' (Odito has NO editor for these: manual),
 * or 'none'. `supported` is true only for the media library.
 */

import { decorativeEvidence, normalizeAlt, validateProposedAlt } from './altText.js';
import { matchRenderedImages } from './imageIdentity.js';

export const STATE = Object.freeze({
  STALE: 'stale_finding',
  DECORATIVE: 'decorative',
  EMBEDDED: 'embedded',
  OVERRIDDEN: 'library_alt_overridden',
  LINK_NO_NAME: 'link_without_name',
  NEEDS_REVIEW: 'needs_review',
  MISSING: 'missing',
});

export const SOURCE = Object.freeze({
  MEDIA_LIBRARY: 'media_library',
  PAGE_CONTENT_HTML: 'page_content_html',
  PAGE_BUILDER_MODULE: 'page_builder_module',
  THEME_TEMPLATE: 'theme_template',
  UNKNOWN: 'unknown',
});

export const SOURCE_LABEL = Object.freeze({
  [SOURCE.MEDIA_LIBRARY]: 'WordPress media library',
  [SOURCE.PAGE_CONTENT_HTML]: "The page's own content",
  [SOURCE.PAGE_BUILDER_MODULE]: 'A page-builder module on this page',
  [SOURCE.THEME_TEMPLATE]: 'A theme or builder template (header, footer, widget area)',
  [SOURCE.UNKNOWN]: 'Not identifiable',
});

const linkNameOf = (img) => normalizeAlt(img?.link_label || img?.link_title || img?.link_text || img?.linkName);

/** One rendered occurrence of the image: its alt and whether it is the content of a (named) link. */
const toInstance = (img) => ({ alt: img?.alt == null ? null : normalizeAlt(img.alt), inLink: !!(img?.in_link ?? img?.inLink), linkName: linkNameOf(img) || null });

/** The crawl's occurrences of THIS attachment, matched only by the wp-image class or an exact upload path — never by file-name similarity. */
export function instancesFromPageDoc(pageDoc, { attachmentId, exactPaths }) {
  if (!Array.isArray(pageDoc?.images)) return null;
  return matchRenderedImages(pageDoc.images, { attachmentId, exactPaths }).matched.map(toInstance);
}

const MANUAL = {
  [SOURCE.PAGE_BUILDER_MODULE]: (b) => `Open this page in ${b || 'your page builder'} and set the alt text on the module that shows this image. Odito cannot edit builder modules, and the media library is not what this module renders.`,
  [SOURCE.THEME_TEMPLATE]: () => 'This image is not part of the page\'s own content: a theme or builder template (for example the header, footer or a widget area) renders it. Set the alt text in that template; changing the media library would not change it.',
  [SOURCE.PAGE_CONTENT_HTML]: () => 'The alt text is stored inside the page\'s own content. Edit the image\'s alt text in the page editor.',
  [SOURCE.UNKNOWN]: () => 'Odito could not identify what renders this image, so it cannot say where its alt text is set. Check the page editor and the theme templates.',
};

/**
 * @param {object} p
 * @param {object} p.snapshot        the finding's before_snapshot
 * @param {object|null} p.media      the WordPress media item (library alt, title)
 * @param {object|null} p.content    inspectContentEmbedding() result
 * @param {{alt: string|null, inLink: boolean, linkName: string|null}[]|null} p.instances  the crawl's occurrences of this image
 * @param {{status: string, instances?: object[]}|null} p.live  a fresh read of the live page ('checked' | 'unavailable' | 'not_found')
 * @param {string|null} p.builderLabel  detected page builder ("Divi"), only when it is a real builder
 */
export function diagnoseAlt({ snapshot, media = null, content = null, instances = null, live = null, builderLabel = null }) {
  const libraryAlt = normalizeAlt(media?.alt_text);
  const libraryMeaningful = !!libraryAlt && validateProposedAlt(libraryAlt).ok;
  const renderedAlt = snapshot?.altState === 'missing' ? null : snapshot?.altState === 'empty' || snapshot?.altState === 'blank' ? '' : undefined;
  const evidence = [];
  const out = (state, extra = {}) => ({
    state, source: SOURCE.MEDIA_LIBRARY, fixMechanism: 'media_library', supported: true, manual: null, builder: builderLabel || null,
    renderedAlt, libraryAlt: libraryAlt || null, libraryMeaningful, evidence,
    instances: { crawl: instances || [], live: live ? { status: live.status, occurrences: live.instances || [] } : null }, ...extra,
  });

  const withAlt = (list) => (list || []).filter((i) => i.alt);

  // Other occurrences of the SAME image: one that renders the library alt proves the library alt works somewhere.
  if (instances?.length > 1 && withAlt(instances).length > 0 && withAlt(instances).length < instances.length) {
    evidence.push(`This image appears ${instances.length} times on the page; ${withAlt(instances).length} of them render alt text and ${instances.length - withAlt(instances).length} render none.`);
  }

  // The crawler also recorded how this image file's uses split when it raised the finding (available even without the page's crawl record).
  if (!(instances?.length > 1) && snapshot?.occurrences?.total > 1) {
    const o = snapshot.occurrences;
    evidence.push(`This image file is used ${o.total} times on the page; ${o.withoutAlt} of those uses render no alt text${o.withAlt ? ' and ' + o.withAlt + ' do' : ''}.`);
  }

  // 1. The live page already has it everywhere: the finding is out of date.
  if (live?.status === 'checked' && live.instances?.length > 0 && live.instances.every((i) => i.alt)) {
    evidence.push('A fresh read of the live page shows alt text on every occurrence of this image.');
    return out(STATE.STALE, { source: SOURCE.UNKNOWN, fixMechanism: 'none', supported: false });
  }

  // 2. Decorative — only on evidence, never because the alt is empty.
  const decor = decorativeEvidence(snapshot);
  if (decor) {
    evidence.push(decor.signal);
    return out(STATE.DECORATIVE, { fixMechanism: 'none', supported: false });
  }

  // 3. The alt is inside the page's own HTML.
  if (content?.status === 'embedded') {
    evidence.push('An <img> or image block for this attachment is in the page content, with its own alt attribute.');
    return out(STATE.EMBEDDED, { source: SOURCE.PAGE_CONTENT_HTML, fixMechanism: 'page_content', supported: false, manual: MANUAL[SOURCE.PAGE_CONTENT_HTML]() });
  }

  // 4. WordPress already holds meaningful alt text but the page renders none: something else controls the rendered attribute.
  if (libraryMeaningful) {
    evidence.push(`WordPress holds the alt text “${libraryAlt}” for this attachment, yet the page renders ${renderedAlt === null ? 'no alt attribute' : renderedAlt === '' ? 'alt=""' : 'no alt text'} on this image.`);
    const source = content?.status === 'builder_reference' ? SOURCE.PAGE_BUILDER_MODULE : content?.status === 'not_in_content' ? SOURCE.THEME_TEMPLATE : SOURCE.UNKNOWN;
    if (source === SOURCE.PAGE_BUILDER_MODULE) evidence.push('The page content names this file inside a builder shortcode, and the module renders its own alt value instead of the library\'s.');
    if (source === SOURCE.THEME_TEMPLATE) evidence.push('The page\'s own content does not contain this image, so a theme or builder template renders it.');
    if (snapshotIsOnlyLinkContent(snapshot)) evidence.push('It is the only content of a link with no name, so that link has no accessible name today.');
    return out(STATE.OVERRIDDEN, { source, fixMechanism: source === SOURCE.THEME_TEMPLATE ? 'theme_template' : 'page_content', supported: false, manual: MANUAL[source](builderLabel) });
  }

  // 5. The only content of an unnamed link: a real problem, never decorative.
  if (snapshotIsOnlyLinkContent(snapshot)) {
    evidence.push('The image is the only content of a link that has no text or label, so with no alt text the link has no accessible name.');
    return out(STATE.LINK_NO_NAME, builderCaveat(content));
  }

  // 6. alt="". On an image the theme renders straight from the media library, the empty alt IS the library's emptiness: missing, not a
  //    choice. Anywhere else (a builder module, an unknown source) nothing says whether it was deliberate: a person decides.
  if (snapshot?.altState === 'empty' && content?.status === 'not_in_content') {
    evidence.push('The page renders alt="" because the media library has no alt text for this image (the theme prints the library value).');
    return out(STATE.MISSING);
  }
  if (snapshot?.altState === 'empty') {
    evidence.push('The page renders alt="". Nothing in the markup (role, aria-hidden, a named link) says whether that was deliberate, and the media library has no alt text either.');
    return out(STATE.NEEDS_REVIEW, builderCaveat(content));
  }

  evidence.push('The page renders no alt text for this image and the media library has none.');
  return out(STATE.MISSING, builderCaveat(content));
}

const snapshotIsOnlyLinkContent = (snapshot) => !!snapshot?.inLink && !normalizeAlt(snapshot?.linkLabel || snapshot?.linkTitle || snapshot?.linkText);

/** A builder shortcode names the file: a library write is allowed, but the page may not use it — the rendered check decides. */
function builderCaveat(content) {
  return content?.status === 'builder_reference' ? { source: SOURCE.PAGE_BUILDER_MODULE, builderMayOverride: true } : {};
}

export default { STATE, SOURCE, SOURCE_LABEL, diagnoseAlt, instancesFromPageDoc };
