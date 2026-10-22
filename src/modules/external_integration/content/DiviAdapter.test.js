import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DiviAdapter } from './DiviAdapter.js';
import { ContentAdapterError, CONTENT_UNSUPPORTED } from './ContentAdapter.js';
import { resolveContentAdapter, detectBuilder } from './contentAdapterRegistry.js';
import {
  DiviParseError, parseTags, attrValue, editTag, encodeAttrValue, decodeAttrValue, decodeDynamicContent,
} from './diviShortcodes.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// The real post_content of https://naxonify.com/seo-reseller (post 4721), captured before any change.
const REAL = fs.readFileSync(path.join(here, '__fixtures__', 'seo_reseller_divi_content.txt'), 'utf8');

const adapter = new DiviAdapter();
const NO_H1 = { h1Count: 0, h1NonEmpty: 0, h1Texts: [] };
const page = (raw, { title = 'SEO Reseller', rendered = NO_H1 } = {}) => ({ id: 1, content: { raw }, title: { raw: title }, meta: {}, rendered });

const heading = (attrs) => `[et_pb_heading ${attrs}][/et_pb_heading]`;
const section = (inner, label = 'Page Title Section') =>
  `[et_pb_section admin_label="${label}" _builder_version="4.27.6"][et_pb_row][et_pb_column type="4_4"]${inner}[/et_pb_column][/et_pb_row][/et_pb_section]`;
const body = (...sections) => `<!-- wp:divi/placeholder -->${sections.join('')}<!-- /wp:divi/placeholder -->`;
const DYNAMIC_TITLE = '@ET-DC@eyJkeW5hbWljIjp0cnVlLCJjb250ZW50IjoicG9zdF90aXRsZSIsInNldHRpbmdzIjp7ImJlZm9yZSI6IiIsImFmdGVyIjoiIn19@';
const dynamicHeading = (level = 'h2') => heading(`title="${DYNAMIC_TITLE}" _dynamic_attributes="title" title_level="${level}" title_text_color="#fff"`);
const modules = (raw) => (raw.match(/\[\/?et_pb_[a-z_0-9]+/g) || []).join(',');

const VALUE = 'SEO Reseller Services by Naxonify';

describe('diviShortcodes — parser and single-tag editor', () => {
  test('parses attributes with their exact character ranges', () => {
    const raw = 'x[et_pb_heading title="Hi" title_level="h2"][/et_pb_heading]y';
    const [open] = parseTags(raw);
    assert.equal(attrValue(open, 'title'), 'Hi');
    assert.equal(raw.slice(open.attrs[1].valueStart, open.attrs[1].valueEnd), 'h2');
  });

  test('editTag changes only the named attributes: set, insert and remove', () => {
    const raw = 'A[et_pb_heading title="Hi" title_level="h2" _dynamic_attributes="title" z="1"][/et_pb_heading]B';
    const [open] = parseTags(raw);
    const out = editTag(raw, open, [
      { name: 'title_level', value: 'h1' },
      { name: '_dynamic_attributes', value: null },
      { name: 'extra', value: 'e' },
    ]);
    assert.equal(out, 'A[et_pb_heading title="Hi" title_level="h1" z="1" extra="e"][/et_pb_heading]B');
  });

  test('refuses to rewrite an unquoted attribute', () => {
    const raw = '[et_pb_heading title=Hi][/et_pb_heading]';
    const [open] = parseTags(raw);
    assert.throws(() => editTag(raw, open, [{ name: 'title', value: 'x' }]), DiviParseError);
  });

  test('an unterminated tag is a parse error, never a guess', () => {
    assert.throws(() => parseTags('[et_pb_section fb_built="1"'), DiviParseError);
  });

  test('attribute encoding round-trips quotes, brackets and ampersands', () => {
    const text = 'Rock & "Roll" [live]';
    const encoded = encodeAttrValue(text);
    assert.ok(!/["[\]]/.test(encoded));
    assert.equal(decodeAttrValue(encoded), text);
  });

  test('decodes Divi dynamic content', () => {
    assert.equal(decodeDynamicContent(DYNAMIC_TITLE).content, 'post_title');
    assert.equal(decodeDynamicContent('plain'), null);
  });
});

describe('DiviAdapter — the real naxonify.com/seo-reseller page (Case A)', () => {
  test('is recognised as Divi and can be given an H1 by promoting the dynamic page-title heading', () => {
    const p = page(REAL);
    assert.equal(adapter.canHandle(p), true);
    const ctx = adapter.getH1Context(p);
    assert.equal(ctx.supported, true);
    assert.equal(ctx.state, 'missing');
    assert.equal(ctx.plan.strategy, 'divi_promote_page_title_heading');
    assert.equal(ctx.plan.target.module, 'et_pb_heading');
    assert.equal(ctx.plan.target.currentLevel, 'h2');
    assert.equal(ctx.plan.target.currentText, 'SEO Reseller');
    assert.equal(ctx.plan.target.dynamic, true);
  });

  test('addH1 changes exactly one tag: same modules, same length outside that tag, no H1 inserted elsewhere', () => {
    const p = page(REAL);
    const { content } = adapter.addH1(p, VALUE);

    assert.equal(modules(content), modules(REAL), 'no module was added or removed');
    const target = parseTags(REAL).find((t) => t.name === 'et_pb_heading');
    // Everything before and after the targeted tag is byte-identical.
    assert.equal(content.slice(0, target.start), REAL.slice(0, target.start));
    const tailLen = REAL.length - target.end;
    assert.equal(content.slice(content.length - tailLen), REAL.slice(target.end));

    const [after] = parseTags(content).filter((t) => t.name === 'et_pb_heading');
    assert.equal(attrValue(after, 'title_level'), 'h1');
    assert.equal(decodeAttrValue(attrValue(after, 'title')), VALUE);
    assert.equal(attrValue(after, '_dynamic_attributes'), undefined, 'the dynamic title is dropped so the static text renders');
    // Unrelated attributes of that module survive.
    assert.equal(attrValue(after, 'title_text_color'), '#FFFFFF');
    assert.equal(attrValue(after, 'title_font_size'), '44px');
    assert.equal(/<h1/i.test(content), false, 'no literal <h1> was injected');
  });

  test('the resulting content passes the content verification', () => {
    const p = page(REAL);
    const change = adapter.addH1(p, VALUE);
    const check = adapter.verifyH1(page(change.content), { text: VALUE, originalContent: REAL, plan: change.plan });
    assert.deepEqual(check, { ok: true, h1Count: 1, problems: [] });
  });

  test('when the recommendation IS the page title the text stays dynamic and only the level changes', () => {
    const { content } = adapter.addH1(page(REAL), 'SEO Reseller');
    const [after] = parseTags(content).filter((t) => t.name === 'et_pb_heading');
    assert.equal(attrValue(after, 'title_level'), 'h1');
    assert.equal(attrValue(after, '_dynamic_attributes'), 'title');
    assert.equal(attrValue(after, 'title'), DYNAMIC_TITLE);
  });

  test('special characters in the H1 are encoded so they cannot break the shortcode', () => {
    const { content } = adapter.addH1(page(REAL), 'Rock & "Roll" SEO');
    const [after] = parseTags(content).filter((t) => t.name === 'et_pb_heading');
    assert.equal(attrValue(after, 'title'), 'Rock &amp; %22Roll%22 SEO');
    assert.equal(parseTags(content).length, parseTags(REAL).length, 'the shortcode structure is unchanged');
  });
});

describe('DiviAdapter — safe cases only', () => {
  test('Case C: multiple non-empty H1s are never changed', () => {
    const p = page(REAL, { rendered: { h1Count: 2, h1NonEmpty: 2, h1Texts: ['A', 'B'] } });
    const ctx = adapter.getH1Context(p);
    assert.equal(ctx.supported, false);
    assert.equal(ctx.code, CONTENT_UNSUPPORTED.MULTIPLE_H1);
    assert.equal(ctx.state, 'multiple');
    assert.throws(() => adapter.addH1(p, VALUE), ContentAdapterError);
  });

  test('Case D: an existing, different H1 is never replaced', () => {
    const p = page(REAL, { rendered: { h1Count: 1, h1NonEmpty: 1, h1Texts: ['Old heading'] } });
    const ctx = adapter.getH1Context(p);
    assert.equal(ctx.supported, false);
    assert.equal(ctx.code, CONTENT_UNSUPPORTED.H1_ALREADY_PRESENT);
    assert.match(ctx.reason, /Old heading/);
    assert.throws(() => adapter.addH1(p, VALUE), (e) => e instanceof ContentAdapterError && e.code === CONTENT_UNSUPPORTED.H1_ALREADY_PRESENT);
    assert.throws(() => adapter.updateH1(p, VALUE), ContentAdapterError);
  });

  test('declines when the page\'s rendered H1 state could not be read', () => {
    const ctx = adapter.getH1Context(page(REAL, { rendered: { h1Count: null, h1NonEmpty: null, h1Texts: [] } }));
    assert.equal(ctx.supported, false);
  });

  test('declines when the first section has more than one heading (no unambiguous page title)', () => {
    const raw = body(section(dynamicHeading() + heading('title="Another" title_level="h3"')));
    const ctx = adapter.getH1Context(page(raw));
    assert.equal(ctx.supported, false);
    assert.equal(ctx.code, CONTENT_UNSUPPORTED.NO_SAFE_TARGET);
  });

  test('declines when the first heading is not the page title', () => {
    const raw = body(section(heading('title="Welcome to our agency" title_level="h2"')));
    const ctx = adapter.getH1Context(page(raw));
    assert.equal(ctx.supported, false);
    assert.equal(ctx.code, CONTENT_UNSUPPORTED.NO_SAFE_TARGET);
  });

  test('declines a heading with no explicit level (Divi default is ambiguous)', () => {
    const raw = body(section(heading(`title="${DYNAMIC_TITLE}" _dynamic_attributes="title"`)));
    assert.equal(adapter.getH1Context(page(raw)).supported, false);
  });

  test('declines when another heading precedes the page-title heading', () => {
    const raw = body(section(heading('title="Banner" title_level="h4"'), 'Top'), section(dynamicHeading(), 'Second'));
    assert.equal(adapter.getH1Context(page(raw)).supported, false);
  });

  test('declines when the source contains a construct that may render an H1 but was not counted (e.g. a fullwidth header with no level)', () => {
    const raw = body(section(dynamicHeading() + '[et_pb_fullwidth_header title="Hero"][/et_pb_fullwidth_header]'));
    const ctx = adapter.getH1Context(page(raw));
    assert.equal(ctx.supported, false);
    assert.equal(ctx.code, CONTENT_UNSUPPORTED.NO_SAFE_TARGET);
  });

  test('a static heading with the same text as the page title is a valid target', () => {
    const raw = body(section(heading('title="SEO Reseller" title_level="h2"')));
    const ctx = adapter.getH1Context(page(raw));
    assert.equal(ctx.supported, true);
    assert.equal(ctx.plan.target.dynamic, false);
    const { content } = adapter.addH1(page(raw), VALUE);
    assert.equal(content, body(section(heading(`title="${VALUE}" title_level="h1"`))));
  });

  test('unparseable Divi content is declined, not guessed at', () => {
    const ctx = adapter.getH1Context(page('[et_pb_section admin_label="x"][et_pb_row'));
    assert.equal(ctx.supported, false);
    assert.equal(ctx.code, CONTENT_UNSUPPORTED.CONTENT_UNPARSEABLE);
  });

  test('Divi 5 block format is recognised but declined', () => {
    const raw = '<!-- wp:divi/section {"a":1} --><!-- wp:divi/row --><!-- wp:divi/heading /--><!-- /wp:divi/row --><!-- /wp:divi/section -->';
    const p = page(raw);
    assert.equal(adapter.canHandle(p), true);
    const ctx = adapter.getH1Context(p);
    assert.equal(ctx.supported, false);
    assert.equal(ctx.code, CONTENT_UNSUPPORTED.BUILDER_NOT_SUPPORTED);
  });
});

describe('DiviAdapter — Case B: an empty H1', () => {
  const empty = { h1Count: 1, h1NonEmpty: 0, h1Texts: [] };

  test('an empty H1 heading module is populated', () => {
    const raw = body(section(heading('title="" title_level="h1" title_text_color="#000"')));
    const p = page(raw, { rendered: empty });
    const ctx = adapter.getH1Context(p);
    assert.equal(ctx.supported, true);
    assert.equal(ctx.state, 'empty');
    const change = adapter.updateH1(p, VALUE);
    assert.equal(change.content, body(section(heading(`title="${VALUE}" title_level="h1" title_text_color="#000"`))));
    assert.equal(adapter.verifyH1(page(change.content), { text: VALUE, originalContent: raw, plan: change.plan }).ok, true);
  });

  test('a literal empty <h1></h1> is populated in place', () => {
    const raw = body(section('[et_pb_text]<h1></h1><p>Keep me</p>[/et_pb_text]'));
    const p = page(raw, { rendered: empty });
    const change = adapter.updateH1(p, 'Fish & Chips');
    assert.equal(change.content, body(section('[et_pb_text]<h1>Fish &amp; Chips</h1><p>Keep me</p>[/et_pb_text]')));
  });

  test('an empty H1 that is not in the page content (theme/template) is declined', () => {
    const p = page(REAL, { rendered: empty });
    const ctx = adapter.getH1Context(p);
    assert.equal(ctx.supported, false);
    assert.equal(ctx.code, CONTENT_UNSUPPORTED.EMPTY_H1_NOT_LOCATABLE);
  });
});

describe('DiviAdapter.verifyH1 — content checks after a write', () => {
  const p = page(REAL);
  const change = adapter.addH1(p, VALUE);
  const expected = { text: VALUE, originalContent: REAL, plan: change.plan };

  test('fails when the H1 text is wrong', () => {
    const wrong = change.content.replace(`title="${VALUE}"`, 'title="Something else"');
    const result = adapter.verifyH1(page(wrong), expected);
    assert.equal(result.ok, false);
    assert.match(result.problems.join(), /H1 text/);
  });

  test('fails when nothing became an H1', () => {
    const result = adapter.verifyH1(page(REAL), expected);
    assert.equal(result.ok, false);
    assert.equal(result.h1Count, 0);
  });

  test('fails when a second H1 exists', () => {
    const two = change.content.replace('[/et_pb_section]', '[et_pb_text]<h1>Extra</h1>[/et_pb_text][/et_pb_section]');
    const result = adapter.verifyH1(page(two), expected);
    assert.equal(result.ok, false);
    assert.match(result.problems.join(), /exactly one H1/);
  });

  test('fails when anything OTHER than the targeted heading changed', () => {
    const tampered = change.content.replace('admin_label="Page Title Section"', 'admin_label="Renamed"');
    const result = adapter.verifyH1(page(tampered), expected);
    assert.equal(result.ok, false);
    assert.match(result.problems.join(), /somewhere other than the targeted heading/);
  });

  test('fails when another attribute of the targeted heading itself changed', () => {
    const tampered = change.content.replace('title_font_size="44px"', 'title_font_size="12px"');
    assert.equal(adapter.verifyH1(page(tampered), expected).ok, false);
  });

  test('fails when the content no longer parses', () => {
    const result = adapter.verifyH1(page(change.content + '[et_pb_row'), expected);
    assert.equal(result.ok, false);
    assert.match(result.problems.join(), /no longer parses/);
  });
});

describe('content adapter registry — builder detection; nothing untested is claimed supported', () => {
  const at = (raw, extra = {}) => ({ content: { raw }, meta: {}, rendered: { bodyClass: '' }, ...extra });

  test('Divi shortcodes (wrapped in a placeholder block) resolve to Divi, not Gutenberg', () => {
    assert.equal(detectBuilder(at(REAL)).name, 'divi');
  });

  test('Elementor is detected (edit-mode meta, body class or data attribute) and declined', () => {
    for (const p of [at('x', { meta: { _elementor_edit_mode: 'builder' } }), at('x', { rendered: { bodyClass: 'page elementor-page' } }), at('<div data-elementor-type="wp-page"></div>')]) {
      const a = resolveContentAdapter(p);
      assert.equal(a.name, 'elementor');
      const ctx = a.getH1Context(p);
      assert.equal(ctx.supported, false);
      assert.match(ctx.reason, /Elementor/);
    }
  });

  test('Gutenberg blocks are detected and declined', () => {
    const p = at('<!-- wp:paragraph --><p>Hi</p><!-- /wp:paragraph -->');
    const a = resolveContentAdapter(p);
    assert.equal(a.name, 'gutenberg');
    assert.equal(a.getH1Context(p).supported, false);
    assert.throws(() => a.addH1(p, VALUE), ContentAdapterError);
  });

  test('plain / classic HTML is detected and declined — never edited generically', () => {
    const p = at('<p>Hello</p>');
    const a = resolveContentAdapter(p);
    assert.equal(a.name, 'generic_html');
    assert.equal(a.getH1Context(p).supported, false);
    assert.throws(() => a.addH1(p, VALUE), ContentAdapterError);
    assert.throws(() => a.updateH1(p, VALUE), ContentAdapterError);
  });
});
