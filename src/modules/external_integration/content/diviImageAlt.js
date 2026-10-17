/**
 * diviImageAlt — which Divi 4 page-builder module controls an image's rendered alt text, and a minimal, provable edit of that ONE attribute.
 * Pure (no I/O): it takes the page's raw content string.
 *
 * WHY THIS EXISTS: the Divi Image / Blurb / Fullwidth Header modules render the alt text stored IN THE MODULE (a shortcode attribute in
 * the page's post_content), not the media-library alt. WordPress copies the library alt in only when an image is picked in the builder, so
 * a later library change never reaches the page and a blank module attribute renders alt="". A media-library write cannot fix that; the
 * module attribute can.
 *
 * WHAT IS CONFIRMED (never guessed) — all on Divi 4.27.7, the only version this has been checked against:
 *   observed_live        read-only, on the connected site: 203 stored modules (64 et_pb_image `src`->`alt`, 139 et_pb_blurb `image`->`alt`)
 *                        were compared with the live rendered page; the rendered alt equals the stored attribute (169 exactly, 34 differ
 *                        only by a trailing <br /> that WordPress's auto-paragraph filter appends to the rendered value).
 *   divi_builder_source  the attribute names come from Divi 4.27.7's own Visual Builder source (served publicly by the theme): the
 *                        Fullwidth Header renders its header image with `alt = image_alt_text`, `title = image_title`. No stored instance
 *                        with a value exists on the connected site yet, so the first real write is also the first live proof; the
 *                        post-write rendered check is what establishes it, and a failed check is reported, never hidden.
 *
 * NOT SUPPORTED, and said so: Theme Builder templates (header/footer/body layouts live in et_*_layout posts that WordPress does not expose
 * over REST), global/saved modules, dynamic content, Divi 5 block content, any module not in the registry, any Divi version not listed.
 *
 * Nothing here treats the content as HTML and nothing is regex-replaced across the document: tags are located by exact offsets
 * (diviShortcodes.parseTags) and an edit replaces only the target attribute's value, or inserts/removes that single attribute.
 */

import crypto from 'crypto';
import { DiviParseError, decodeAttrValue, decodeDynamicContent, editTag, encodeAttrValue, getAttr, parseTags } from './diviShortcodes.js';
import { uploadsPath } from '../mediaFix/imageIdentity.js';

export const TESTED_DIVI_VERSIONS = Object.freeze(['4.27.7']);

export const EVIDENCE = Object.freeze({ OBSERVED_LIVE: 'observed_live', BUILDER_SOURCE: 'divi_builder_source' });

export const DIVI_ALT_MODULES = Object.freeze({
  et_pb_image: { label: 'Divi Image module', imageAttr: 'src', altAttr: 'alt', evidence: EVIDENCE.OBSERVED_LIVE },
  et_pb_blurb: { label: 'Divi Blurb module', imageAttr: 'image', altAttr: 'alt', evidence: EVIDENCE.OBSERVED_LIVE },
  et_pb_fullwidth_header: { label: 'Divi Fullwidth Header module', imageAttr: 'header_image_url', altAttr: 'image_alt_text', evidence: EVIDENCE.BUILDER_SOURCE },
});

export const CODE = Object.freeze({
  FORMAT_UNSUPPORTED: 'DIVI_FORMAT_UNSUPPORTED',
  CONTENT_UNPARSEABLE: 'DIVI_CONTENT_UNPARSEABLE',
  VERSION_NOT_VERIFIED: 'DIVI_VERSION_NOT_VERIFIED',
  NO_SUPPORTED_MODULE: 'NO_SUPPORTED_DIVI_MODULE',
  MULTIPLE_MODULES: 'MULTIPLE_DIVI_MODULES_MATCH',
  OTHER_SOURCE_ALSO_EMPTY: 'OTHER_SOURCE_ALSO_RENDERS_EMPTY',
  RENDER_NOT_VERIFIED: 'RENDERED_OCCURRENCE_NOT_VERIFIED',
  NOT_ELIGIBLE: 'DIVI_MODULE_NOT_EDITABLE',
});

/** Divi 4 stores a page as [et_pb_section …] shortcodes (possibly wrapped in wp:divi/placeholder comments). Divi 5 stores wp:divi/* blocks. */
export function isDivi4Content(raw) {
  return typeof raw === 'string' && raw.includes('[et_pb_section');
}

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** Attributes that make a module's alt NOT editable from this page's content. @returns {string|null} the reason code */
function ineligibleReason(tag, def) {
  if (getAttr(tag, 'global_module')) return 'GLOBAL_MODULE'; // its settings live in a Divi Library item, not in this page
  const dyn = (getAttr(tag, '_dynamic_attributes')?.value || '').split(',').map((s) => s.trim());
  if (dyn.includes(def.imageAttr) || dyn.includes(def.altAttr)) return 'DYNAMIC_ATTRIBUTE';
  if (decodeDynamicContent(getAttr(tag, def.imageAttr)?.value) || decodeDynamicContent(getAttr(tag, def.altAttr)?.value)) return 'DYNAMIC_CONTENT';
  const alt = getAttr(tag, def.altAttr);
  if (alt && !alt.quoted) return 'ALT_ATTRIBUTE_NOT_QUOTED';
  return null;
}

const CONTEXT_CHARS = 160;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/**
 * A stable description of THIS module (not of the image): its name, everything it sets except the alt, and the text just BEFORE it. The
 * surroundings (not a position counter) are what tell two otherwise-identical modules apart, so inserting or removing an unrelated module
 * elsewhere does not move the identity onto a sibling. `ordinal` is informational only and never used for matching.
 */
function identityOf(raw, tags, index, def) {
  const tag = tags[index];
  const ordinal = tags.slice(0, index).filter((t) => !t.closing && t.name === tag.name).length;
  const rest = tag.attrs.filter((a) => a.name !== def.altAttr).map((a) => [a.name, a.value]);
  return {
    module: tag.name, ordinal, signature: sha(JSON.stringify(rest)),
    context: sha(raw.slice(Math.max(0, tag.start - CONTEXT_CHARS), tag.start)),
  };
}

/**
 * Every module in the content that names one of the image's exact files, split into registered candidates and everything else.
 * The image is matched by EXACT upload path (the same rule the media-library identity uses), never by file-name similarity.
 * @returns {{ok: false, code: string, message: string} | {ok: true, candidates: object[], others: {module: string, attr: string}[]}}
 */
export function findAltSources(raw, { exactPaths }) {
  if (!isDivi4Content(raw)) {
    return { ok: false, code: CODE.FORMAT_UNSUPPORTED, message: typeof raw === 'string' && raw.includes('wp:divi/') ? 'This page uses Divi 5 block content, which Odito does not edit.' : 'This page is not stored in Divi 4 shortcode format.' };
  }
  let tags;
  try { tags = parseTags(raw); } catch (e) {
    if (e instanceof DiviParseError) return { ok: false, code: CODE.CONTENT_UNPARSEABLE, message: `The page's Divi content could not be parsed safely (${e.message}).` };
    throw e;
  }
  const files = new Set([...(exactPaths || [])].filter(Boolean));
  const candidates = []; const others = [];
  tags.forEach((tag, index) => {
    if (tag.closing) return;
    for (const attr of tag.attrs) {
      const p = uploadsPath(decodeAttrValue(attr.value));
      if (!p || !files.has(p)) continue;
      const def = DIVI_ALT_MODULES[tag.name];
      if (!def || attr.name !== def.imageAttr) { others.push({ module: tag.name, attr: attr.name }); continue; }
      const altAttr = getAttr(tag, def.altAttr);
      const stored = altAttr ? norm(decodeAttrValue(altAttr.value)) : '';
      candidates.push({
        tagIndex: index, module: tag.name, label: def.label, imageAttr: def.imageAttr, altAttr: def.altAttr, evidence: def.evidence,
        imageValue: decodeAttrValue(attr.value), attrPresent: !!altAttr, storedAlt: stored, storedRaw: altAttr ? altAttr.value : null,
        ineligible: ineligibleReason(tag, def), identity: identityOf(raw, tags, index, def),
      });
    }
  });
  return { ok: true, candidates, others };
}

/** Finds the SAME module again in (possibly newer) content by its identity. null when it is missing or ambiguous. */
export function locateByIdentity(raw, identity, { exactPaths }) {
  const found = findAltSources(raw, { exactPaths });
  if (!found.ok) return null;
  const hits = found.candidates.filter((c) => c.identity.module === identity.module && c.identity.signature === identity.signature && c.identity.context === identity.context);
  return hits.length === 1 ? hits[0] : null;
}

/** The new content with ONLY this module's alt attribute set (inserted when absent). */
export function planAltEdit(raw, candidate, newAlt) {
  const tags = parseTags(raw);
  const tag = tags[candidate.tagIndex];
  if (!tag || tag.closing || tag.name !== candidate.module) throw new DiviParseError('The module is no longer where it was found.');
  const content = editTag(raw, tag, [{ name: candidate.altAttr, value: encodeAttrValue(newAlt) }]);
  return { content, before: candidate.storedAlt, after: norm(newAlt) };
}

/** The content with ONLY this module's alt attribute put back: set to the previous value, or removed when it did not exist before. */
export function planAltRestore(raw, candidate, { previousValue, hadAttribute }) {
  const tags = parseTags(raw);
  const tag = tags[candidate.tagIndex];
  if (!tag || tag.closing || tag.name !== candidate.module) throw new DiviParseError('The module is no longer where it was found.');
  const content = editTag(raw, tag, [{ name: candidate.altAttr, value: hadAttribute ? encodeAttrValue(previousValue) : null }]);
  return { content };
}

const textBetweenTags = (raw, tags) => { let out = ''; let at = 0; for (const t of tags) { out += raw.slice(at, t.start); at = t.end; } return out + raw.slice(at); };

/**
 * Proves an edit touched ONE attribute of ONE module and nothing else: the same tags in the same order, every other module's attributes
 * identical, every other attribute of the target identical, and every character outside the tags (text, comments, whitespace) identical.
 * @param {{ expectedAlt: string|null, expectedAbsent?: boolean }} expect the value the target's alt attribute must have afterwards
 */
export function verifyAltEdit(beforeRaw, afterRaw, candidate, { expectedAlt = null, expectedAbsent = false } = {}) {
  const problems = [];
  let a; let b;
  try { a = parseTags(beforeRaw); b = parseTags(afterRaw); } catch (e) { return { ok: false, problems: [`The content no longer parses as Divi shortcodes (${e.message}).`] }; }
  if (a.length !== b.length) problems.push(`The number of module tags changed (${a.length} -> ${b.length}).`);
  else {
    a.forEach((ta, i) => {
      const tb = b[i];
      if (ta.name !== tb.name || ta.closing !== tb.closing) { problems.push(`Tag ${i} changed from [${ta.closing ? '/' : ''}${ta.name}] to [${tb.closing ? '/' : ''}${tb.name}].`); return; }
      const same = (x, y) => x.name === y.name && x.value === y.value;
      if (i !== candidate.tagIndex) {
        if (ta.attrs.length !== tb.attrs.length || !ta.attrs.every((x, k) => same(x, tb.attrs[k]))) problems.push(`Module ${ta.name} (tag ${i}) was changed.`);
        return;
      }
      const restA = ta.attrs.filter((x) => x.name !== candidate.altAttr); const restB = tb.attrs.filter((x) => x.name !== candidate.altAttr);
      if (restA.length !== restB.length || !restA.every((x, k) => same(x, restB[k]))) problems.push(`Other settings of the target ${ta.name} were changed.`);
      const altB = tb.attrs.find((x) => x.name === candidate.altAttr);
      if (expectedAbsent) { if (altB) problems.push('The alt attribute was expected to be absent.'); }
      else if (!altB || decodeAttrValue(altB.value) !== expectedAlt) problems.push('The target alt attribute does not hold the expected value.');
    });
    if (textBetweenTags(beforeRaw, a) !== textBetweenTags(afterRaw, b)) problems.push('Content outside the module tags was changed.');
  }
  return { ok: problems.length === 0, problems };
}

export const lf = (s) => String(s ?? '').replace(/\r\n/g, '\n');

/**
 * The capability as the capabilities API reports it (static: no network call per read). `supported` means "Odito has this write path";
 * whether a PARTICULAR image can use it is decided per image, at preview time, from the page and the live render.
 */
export function describeDiviImageAltCapability() {
  return {
    supported: true,
    format: 'divi4_shortcode',
    testedVersions: [...TESTED_DIVI_VERSIONS],
    modules: Object.entries(DIVI_ALT_MODULES).map(([module, d]) => ({ module, label: d.label, imageAttribute: d.imageAttr, altAttribute: d.altAttr, evidence: d.evidence })),
    writeMode: 'read_then_write',
    notSupported: [
      'Divi Theme Builder templates (header, footer, body layouts: not exposed over the WordPress REST API)',
      'global / Divi Library modules',
      'dynamic content',
      'Divi 5 block content',
      'modules outside the list above',
      'Divi versions outside testedVersions',
    ],
  };
}

export default { describeDiviImageAltCapability, TESTED_DIVI_VERSIONS, DIVI_ALT_MODULES, EVIDENCE, CODE, isDivi4Content, findAltSources, locateByIdentity, planAltEdit, planAltRestore, verifyAltEdit };
