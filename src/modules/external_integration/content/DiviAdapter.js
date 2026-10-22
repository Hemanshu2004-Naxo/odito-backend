import { ContentAdapter, ContentAdapterError, CONTENT_UNSUPPORTED } from './ContentAdapter.js';
import {
  DiviParseError,
  attrValue,
  decodeAttrValue,
  decodeDynamicContent,
  editTag,
  encodeAttrValue,
  findSections,
  parseTags,
} from './diviShortcodes.js';

/**
 * Divi 4 (shortcode format) adapter — H1 only.
 *
 * Supported, deterministic cases:
 *
 *   A. The page has NO H1 and its top-of-page heading is an unambiguous "page title" heading
 *      module (exactly one et_pb_heading in the first section, first heading on the page,
 *      showing the page title — either Divi dynamic content `post_title` or the same static
 *      text). That module is PROMOTED to the H1: its level becomes h1 and its text becomes the
 *      recommended H1 (dynamic content is dropped; if the recommendation equals the page
 *      title, the text stays dynamic and only the level changes). No module is added or
 *      removed, so the layout cannot shift and no unrelated module is touched.
 *
 *   B. The page has an EMPTY H1 whose source is unambiguous: one et_pb_heading with
 *      title_level="h1" and no static/dynamic title, or one literal empty <h1></h1> in a text
 *      module. It is populated.
 *
 * Everything else is declined with a reason — a non-empty H1 already present (wrong H1 /
 * multiple H1), no unambiguous page-title heading, unparseable content, Divi 5 block format.
 * Nothing is inserted "at the top" of the content: that is exactly the change that breaks
 * layouts.
 */

const HEADING_MODULE = 'et_pb_heading';
const LEVEL_ATTR = 'title_level';
// Modules that render an <h1> by default when no explicit level is set. If one of these has no
// level attribute the source cannot tell us whether it is an H1, so we decline rather than guess.
const DEFAULT_H1_MODULES = new Set(['et_pb_fullwidth_header', 'et_pb_post_title', 'et_pb_fullwidth_post_title']);
const EDITABLE_ATTRS = new Set(['title', LEVEL_ATTR, '_dynamic_attributes']);
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

function decline(code, reason, state = 'unknown') {
  return { supported: false, builder: 'divi', state, code, reason };
}

/** Source-level look at the content: every construct that renders an H1, and the headings. */
function analyse(raw) {
  const tags = parseTags(raw);
  const sections = findSections(raw, tags);
  const headings = tags.filter((t) => t.name === HEADING_MODULE && !t.closing);

  const explicitH1Modules = tags.filter((t) => !t.closing && (attrValue(t, LEVEL_ATTR) === 'h1' || attrValue(t, 'header_level') === 'h1'));
  const ambiguousDefaults = tags.filter((t) => !t.closing && DEFAULT_H1_MODULES.has(t.name) && !attrValue(t, LEVEL_ATTR) && !attrValue(t, 'header_level'));
  // A heading module with NO level attribute uses Divi's default level; treat as ambiguous.
  const headingsWithoutLevel = headings.filter((t) => !attrValue(t, LEVEL_ATTR));
  const literalH1 = [...raw.matchAll(/<h1(\s[^>]*)?>([\s\S]*?)<\/h1>/gi)];

  return { tags, sections, headings, explicitH1Modules, ambiguousDefaults, headingsWithoutLevel, literalH1 };
}

const isEmptyHeading = (tag) => !norm(decodeAttrValue(attrValue(tag, 'title') || '')) && !decodeDynamicContent(attrValue(tag, 'title'));

export class DiviAdapter extends ContentAdapter {
  get name() { return 'divi'; }
  get label() { return 'Divi'; }

  canHandle(page) {
    const raw = page?.content?.raw || '';
    // Divi 5 stores blocks (wp:divi/section...), not shortcodes: recognised, but handled as unsupported below.
    return raw.includes('[et_pb_section') || /<!--\s*wp:divi\/(section|row|column)\b/.test(raw);
  }

  getH1Context(page) {
    const raw = page?.content?.raw || '';

    if (!raw.includes('[et_pb_section')) {
      return decline(CONTENT_UNSUPPORTED.BUILDER_NOT_SUPPORTED, 'This page uses Divi 5\'s block format. Odito currently supports only Divi 4\'s shortcode format for H1 changes.');
    }

    let a;
    try {
      a = analyse(raw);
    } catch (err) {
      if (err instanceof DiviParseError) {
        return decline(CONTENT_UNSUPPORTED.CONTENT_UNPARSEABLE, `The Divi content could not be parsed safely (${err.message}), so it will not be modified.`);
      }
      throw err;
    }

    const rendered = page.rendered || {};
    const nonEmpty = rendered.h1NonEmpty ?? null;
    const total = rendered.h1Count ?? null;
    if (nonEmpty === null) {
      return decline(CONTENT_UNSUPPORTED.CONTENT_UNPARSEABLE, 'The page\'s rendered H1 could not be read, so its current state is unknown.');
    }

    if (nonEmpty > 1) {
      return decline(CONTENT_UNSUPPORTED.MULTIPLE_H1, `The page already has ${nonEmpty} H1 headings. Odito does not change multiple H1s automatically.`, 'multiple');
    }
    if (nonEmpty === 1) {
      return decline(CONTENT_UNSUPPORTED.H1_ALREADY_PRESENT, `The page already has an H1 (“${rendered.h1Texts?.[0] || ''}”). Odito does not replace an existing H1 automatically.`, 'present');
    }

    // ── no non-empty H1 on the rendered page ───────────────────────────────
    if ((total || 0) > 0) return this._contextForEmptyH1(a, raw);
    return this._contextForMissingH1(a, page);
  }

  // Case A ---------------------------------------------------------------
  _contextForMissingH1(a, page) {
    if (a.explicitH1Modules.length || a.literalH1.length || a.ambiguousDefaults.length || a.headingsWithoutLevel.length) {
      return decline(
        CONTENT_UNSUPPORTED.NO_SAFE_TARGET,
        'The content contains a heading that may render an H1 but could not be identified, so Odito will not add another one.',
        'missing'
      );
    }
    const target = this._findPageTitleHeading(a, page);
    if (!target.ok) return decline(CONTENT_UNSUPPORTED.NO_SAFE_TARGET, target.reason, 'missing');

    const { tag, dynamic, currentText, sectionLabel, currentLevel } = target;
    return {
      supported: true,
      builder: 'divi',
      state: 'missing',
      plan: {
        strategy: 'divi_promote_page_title_heading',
        target: { module: HEADING_MODULE, offset: tag.start, sectionLabel, currentLevel, currentText, dynamic },
        summary: `The page-title heading${sectionLabel ? ` in “${sectionLabel}”` : ''} (currently an ${currentLevel.toUpperCase()} reading “${currentText}”) becomes the page's H1 with the recommended text. No module is added or removed.`,
        changes: [
          `Heading level ${currentLevel.toUpperCase()} → H1`,
          dynamic ? `Text: dynamic page title “${currentText}” → the recommended H1` : `Text: “${currentText}” → the recommended H1`,
        ],
      },
    };
  }

  _findPageTitleHeading(a, page) {
    const first = a.sections[0];
    if (!first) return { ok: false, reason: 'The page has no Divi section to place an H1 in.' };

    const inFirst = a.headings.filter((h) => h.start > first.open.end && h.start < first.closeStart);
    if (inFirst.length !== 1) {
      return { ok: false, reason: `The first section has ${inFirst.length} heading modules, so there is no single, unambiguous page-title heading to promote to H1.` };
    }
    const tag = inFirst[0];

    // Nothing that looks like a heading may come before it in the content.
    const before = page.content.raw.slice(0, tag.start);
    if (/<h[1-6][\s>]/i.test(before) || a.headings.some((h) => h.start < tag.start)) {
      return { ok: false, reason: 'Another heading appears before the page-title heading, so the top-of-page heading is ambiguous.' };
    }

    const level = attrValue(tag, LEVEL_ATTR);
    if (!/^h[2-6]$/.test(level || '')) {
      return { ok: false, reason: 'The page-title heading has no explicit H2–H6 level.' };
    }

    const titleAttr = attrValue(tag, 'title') || '';
    const dynamicDesc = decodeDynamicContent(titleAttr);
    const pageTitle = page.title?.raw ?? page.title ?? '';
    const isDynamicPostTitle = dynamicDesc?.content === 'post_title' && !dynamicDesc?.settings?.before && !dynamicDesc?.settings?.after;
    const staticText = decodeAttrValue(titleAttr);
    const isStaticPageTitle = !dynamicDesc && norm(staticText) && norm(staticText) === norm(pageTitle);

    if (!isDynamicPostTitle && !isStaticPageTitle) {
      return { ok: false, reason: 'The first heading is not the page title (it is neither the dynamic post title nor the same text), so Odito will not turn it into the H1.' };
    }

    const sectionLabel = attrValue(first.open, 'admin_label') || null;
    return { ok: true, tag, dynamic: isDynamicPostTitle, currentText: isDynamicPostTitle ? String(pageTitle) : staticText, sectionLabel, currentLevel: level };
  }

  // Case B ---------------------------------------------------------------
  _contextForEmptyH1(a, raw) {
    const emptyModules = a.explicitH1Modules.filter((t) => t.name === HEADING_MODULE && attrValue(t, LEVEL_ATTR) === 'h1' && isEmptyHeading(t));
    const emptyLiterals = a.literalH1.filter((m) => !norm(m[2].replace(/<[^>]*>/g, '')));
    const candidates = emptyModules.length + emptyLiterals.length;
    if (candidates !== 1 || a.explicitH1Modules.length + a.literalH1.length !== 1) {
      return decline(
        CONTENT_UNSUPPORTED.EMPTY_H1_NOT_LOCATABLE,
        'The page has an empty H1 but Odito cannot locate it unambiguously in the page content (it may come from a theme or template), so it will not modify it.',
        'empty'
      );
    }
    const viaModule = emptyModules.length === 1;
    return {
      supported: true,
      builder: 'divi',
      state: 'empty',
      plan: {
        strategy: viaModule ? 'divi_populate_empty_heading' : 'divi_populate_empty_h1_element',
        target: viaModule ? { module: HEADING_MODULE, offset: emptyModules[0].start } : { element: 'h1', offset: emptyLiterals[0].index },
        summary: 'The page\'s empty H1 is filled with the recommended text. No module is added or removed.',
        changes: ['Empty H1 → the recommended H1'],
      },
    };
  }

  // Writes ---------------------------------------------------------------
  addH1(page, value) {
    const ctx = this.getH1Context(page);
    if (!ctx.supported || ctx.state !== 'missing') {
      throw new ContentAdapterError(ctx.code || CONTENT_UNSUPPORTED.NO_SAFE_TARGET, ctx.reason || 'This page cannot be given an H1 safely.');
    }
    const raw = page.content.raw;
    const a = analyse(raw);
    const target = this._findPageTitleHeading(a, page);
    const encoded = encodeAttrValue(value);
    const pageTitle = String(page.title?.raw ?? page.title ?? '');

    const edits = [{ name: LEVEL_ATTR, value: 'h1' }];
    if (target.dynamic && norm(value) === norm(pageTitle)) {
      // The recommendation IS the page title: keep it dynamic, change only the level.
    } else {
      edits.push({ name: 'title', value: encoded });
      if (target.dynamic) {
        const dyn = attrValue(target.tag, '_dynamic_attributes');
        const remaining = String(dyn || '').split(',').map((s) => s.trim()).filter((s) => s && s !== 'title');
        edits.push({ name: '_dynamic_attributes', value: remaining.length ? remaining.join(',') : null });
      }
    }
    return { content: editTag(raw, target.tag, edits), plan: ctx.plan };
  }

  updateH1(page, value) {
    const ctx = this.getH1Context(page);
    if (!ctx.supported || ctx.state !== 'empty') {
      throw new ContentAdapterError(ctx.code || CONTENT_UNSUPPORTED.NO_SAFE_TARGET, ctx.reason || 'This page\'s H1 cannot be populated safely.');
    }
    const raw = page.content.raw;
    const a = analyse(raw);
    if (ctx.plan.strategy === 'divi_populate_empty_heading') {
      const tag = a.explicitH1Modules.find((t) => t.name === HEADING_MODULE && isEmptyHeading(t));
      return { content: editTag(raw, tag, [{ name: 'title', value: encodeAttrValue(value) }]), plan: ctx.plan };
    }
    const m = a.literalH1.find((x) => !norm(x[2].replace(/<[^>]*>/g, '')));
    const openLen = m[0].indexOf('>') + 1;
    const start = m.index + openLen;
    const escaped = value.replace(/&/g, '&amp;');
    return { content: raw.slice(0, start) + escaped + raw.slice(start + m[2].length), plan: ctx.plan };
  }

  // Verification of the CONTENT after a write ---------------------------------
  verifyH1(page, expected) {
    const problems = [];
    const raw = page?.content?.raw || '';
    let a;
    try {
      a = analyse(raw);
    } catch (err) {
      return { ok: false, h1Count: 0, problems: [`content no longer parses: ${err.message}`] };
    }

    const h1Modules = a.explicitH1Modules;
    const h1Count = h1Modules.length + a.literalH1.length;
    if (h1Count !== 1) problems.push(`expected exactly one H1 in the content, found ${h1Count}`);

    if (h1Modules.length === 1) {
      const tag = h1Modules[0];
      const title = attrValue(tag, 'title');
      const dyn = decodeDynamicContent(title);
      const text = dyn ? String(page.title?.raw ?? '') : decodeAttrValue(title || '');
      if (norm(text) !== norm(expected.text)) problems.push(`H1 text is “${text}”, expected “${expected.text}”`);
    } else if (a.literalH1.length === 1) {
      const text = a.literalH1[0][2].replace(/<[^>]*>/g, '').replace(/&amp;/g, '&');
      if (norm(text) !== norm(expected.text)) problems.push(`H1 text is “${text}”, expected “${expected.text}”`);
    }

    // Nothing else may have changed: undoing the planned edit must reproduce the original.
    if (expected.originalContent != null && expected.plan) {
      const same = this._onlyPlannedEditChanged(expected.originalContent, raw);
      if (!same) problems.push('content changed somewhere other than the targeted heading');
    }
    return { ok: problems.length === 0, h1Count, problems };
  }

  /** Original and new content may differ only inside ONE tag's title/title_level/_dynamic_attributes attributes (or one empty H1's text). */
  _onlyPlannedEditChanged(original, after) {
    if (original === after) return false;
    let i = 0;
    while (i < original.length && i < after.length && original[i] === after[i]) i += 1;
    let j = 0;
    while (j < original.length - i && j < after.length - i && original[original.length - 1 - j] === after[after.length - 1 - j]) j += 1;
    const oldMid = original.slice(i, original.length - j);
    const newMid = after.slice(i, after.length - j);

    // A tag-level edit: the differing region lies within ONE tag, and that tag's other
    // attributes (everything except title / title_level / _dynamic_attributes) are unchanged.
    const tags = parseTags(original);
    const within = tags.find((t) => !t.closing && i >= t.start && original.length - j <= t.end);
    if (within) {
      const twin = parseTags(after).find((t) => !t.closing && t.start === within.start && t.name === within.name);
      if (!twin) return false;
      const keep = (t) => t.attrs.filter((x) => !EDITABLE_ATTRS.has(x.name)).map((x) => `${x.name}=${x.value}`).join('|');
      return keep(within) === keep(twin);
    }
    // A literal empty-<h1> edit: only whitespace was replaced by plain text.
    return /^\s*$/.test(oldMid) && !/[<>[\]]/.test(newMid);
  }
}

export default DiviAdapter;
