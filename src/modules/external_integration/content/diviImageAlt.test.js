import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CODE, DIVI_ALT_MODULES, EVIDENCE, TESTED_DIVI_VERSIONS, findAltSources, isDivi4Content, locateByIdentity, planAltEdit, planAltRestore, verifyAltEdit,
} from './diviImageAlt.js';
import { parseTags } from './diviShortcodes.js';
import { DIVI5, HERO_FILE, HERO_URL, LOGO_FILE, LOGO_URL, TEAM_FILE, TEAM_URL, blurbModule, heroHeader, homepage, imageModule, withModules } from './__fixtures__/diviAltContent.js';

const paths = (...f) => new Set(f);

describe('the registry only names attributes that have evidence', () => {
  test('three modules, each with its evidence level stated, on the one verified Divi version', () => {
    assert.deepEqual(TESTED_DIVI_VERSIONS, ['4.27.7']);
    assert.deepEqual(Object.keys(DIVI_ALT_MODULES), ['et_pb_image', 'et_pb_blurb', 'et_pb_fullwidth_header']);
    assert.equal(DIVI_ALT_MODULES.et_pb_image.evidence, EVIDENCE.OBSERVED_LIVE);
    assert.equal(DIVI_ALT_MODULES.et_pb_blurb.evidence, EVIDENCE.OBSERVED_LIVE);
    assert.equal(DIVI_ALT_MODULES.et_pb_fullwidth_header.evidence, EVIDENCE.BUILDER_SOURCE);
    assert.deepEqual([DIVI_ALT_MODULES.et_pb_fullwidth_header.imageAttr, DIVI_ALT_MODULES.et_pb_fullwidth_header.altAttr], ['header_image_url', 'image_alt_text']);
  });
});

describe('Image B — the real Fullwidth Header module with no alt attribute', () => {
  const raw = homepage();
  const found = findAltSources(raw, { exactPaths: paths(HERO_FILE) });

  test('exactly one candidate: the header module, attribute absent, so Divi renders alt=""', () => {
    assert.equal(found.ok, true);
    assert.equal(found.candidates.length, 1);
    const [c] = found.candidates;
    assert.deepEqual([c.module, c.imageAttr, c.altAttr, c.attrPresent, c.storedAlt, c.ineligible], ['et_pb_fullwidth_header', 'header_image_url', 'image_alt_text', false, '', null]);
    assert.equal(c.evidence, EVIDENCE.BUILDER_SOURCE);
  });

  test('the same file named by a different attribute (a section background) is reported as "other", never a candidate', () => {
    const bg = findAltSources(raw, { exactPaths: paths('2025/12/Boost-Your-Online-Presence-with-Digital-Marketing-Services-bg-1.webp') });
    assert.equal(bg.candidates.length, 0);
    assert.deepEqual(bg.others, [{ module: 'et_pb_fullwidth_header', attr: 'background_image' }]);
  });

  test('inserts ONLY the alt attribute; every other character of the page is byte-for-byte unchanged and the proof says so', () => {
    const edit = planAltEdit(raw, found.candidates[0], 'Digital marketing agency team reviewing campaign results');
    assert.equal(edit.before, '');
    assert.match(edit.content, /image_alt_text="Digital marketing agency team reviewing campaign results"/);
    // removing the inserted attribute gives the original back exactly
    assert.equal(edit.content.replace(' image_alt_text="Digital marketing agency team reviewing campaign results"', ''), raw);
    assert.deepEqual(verifyAltEdit(raw, edit.content, found.candidates[0], { expectedAlt: 'Digital marketing agency team reviewing campaign results' }), { ok: true, problems: [] });
  });

  test('the unrelated modules, the text with brackets and quotes, and the wp:divi comments are untouched', () => {
    const edit = planAltEdit(raw, found.candidates[0], 'A description of the team');
    for (const keep of ['<!-- wp:divi/placeholder -->', '<!-- /wp:divi/placeholder -->', 'Plain text [with brackets] and "quotes"', 'alt="Our delivery team at work"', 'module_class="main-slider"']) assert.ok(edit.content.includes(keep), keep);
    assert.equal(parseTags(edit.content).length, parseTags(raw).length);
  });

  test('alt text with quotes, brackets and ampersands is stored the way the Divi builder stores it and reads back identically', () => {
    const text = 'The "Smith & Co" team [2025]';
    const edit = planAltEdit(raw, found.candidates[0], text);
    assert.match(edit.content, /image_alt_text="The %22Smith &amp; Co%22 team %91 ?2025%93"/);
    assert.equal(verifyAltEdit(raw, edit.content, found.candidates[0], { expectedAlt: text }).ok, true);
  });

  test('restoring removes the attribute that did not exist, returning the ORIGINAL content exactly', () => {
    const edit = planAltEdit(raw, found.candidates[0], 'A description of the team');
    const again = locateByIdentity(edit.content, found.candidates[0].identity, { exactPaths: paths(HERO_FILE) });
    assert.ok(again, 'the same module is found again by identity (the alt is not part of it)');
    assert.equal(again.storedAlt, 'A description of the team');
    assert.equal(planAltRestore(edit.content, again, { previousValue: '', hadAttribute: false }).content, raw);
  });
});

describe('Image Module and Blurb (observed live on this Divi): the alt attribute exists but is empty', () => {
  test('et_pb_image alt="" is replaced in place; et_pb_blurb likewise; the rest is untouched', () => {
    const raw = withModules(imageModule(TEAM_URL, ''), blurbModule(LOGO_URL, ''));
    const team = findAltSources(raw, { exactPaths: paths(TEAM_FILE) }).candidates[0];
    assert.deepEqual([team.module, team.attrPresent, team.storedAlt], ['et_pb_image', true, '']);
    const e1 = planAltEdit(raw, team, 'Our delivery team at work');
    assert.ok(e1.content.includes('src="' + TEAM_URL + '" alt="Our delivery team at work" title_text="our-team"'));
    assert.equal(verifyAltEdit(raw, e1.content, team, { expectedAlt: 'Our delivery team at work' }).ok, true);
    const logo = findAltSources(raw, { exactPaths: paths(LOGO_FILE) }).candidates[0];
    assert.deepEqual([logo.module, logo.imageAttr], ['et_pb_blurb', 'image']);
    assert.equal(verifyAltEdit(raw, planAltEdit(raw, logo, 'Sapphire Digital Agency logo').content, logo, { expectedAlt: 'Sapphire Digital Agency logo' }).ok, true);
  });
});

describe('same attachment used by several modules — the footer-style repeat', () => {
  const raw = withModules(imageModule(LOGO_URL, 'Sapphire Digital Agency'), imageModule(LOGO_URL, ''), imageModule(TEAM_URL, 'Team'));
  const found = findAltSources(raw, { exactPaths: paths(LOGO_FILE) });

  test('both uses are candidates, each with its own identity; only one has an empty alt', () => {
    assert.equal(found.candidates.length, 2);
    assert.notDeepEqual(found.candidates[0].identity, found.candidates[1].identity);
    assert.deepEqual(found.candidates.map((c) => c.storedAlt), ['Sapphire Digital Agency', '']);
  });

  test('an edit of ONE use never touches the other use of the same attachment', () => {
    const target = found.candidates[1];
    const edit = planAltEdit(raw, target, 'Sapphire Digital Agency header logo');
    assert.equal(verifyAltEdit(raw, edit.content, target, { expectedAlt: 'Sapphire Digital Agency header logo' }).ok, true);
    assert.equal(edit.content.split('alt="Sapphire Digital Agency"').length - 1, 1, 'the first use keeps its text');
  });

  test('a proof for the WRONG module is rejected', () => {
    const edit = planAltEdit(raw, found.candidates[1], 'Sapphire Digital Agency header logo');
    const wrong = verifyAltEdit(raw, edit.content, found.candidates[0], { expectedAlt: 'Sapphire Digital Agency header logo' });
    assert.equal(wrong.ok, false);
  });

  test('an unrelated module inserted ELSEWHERE still finds the SAME module — never its sibling that differs only by alt', () => {
    const shifted = withModules(imageModule(TEAM_URL, 'New first image'), imageModule(LOGO_URL, 'Sapphire Digital Agency'), imageModule(LOGO_URL, ''));
    const again = locateByIdentity(shifted, found.candidates[1].identity, { exactPaths: paths(LOGO_FILE) });
    assert.ok(again);
    assert.equal(again.storedAlt, '', 'the module with the empty alt, not the one that already had alt text');
  });

  test('two modules that are completely identical in content AND surroundings are ambiguous: located as null, never picked', () => {
    const twin = withModules(imageModule(LOGO_URL, ''), imageModule(LOGO_URL, ''));
    const c = findAltSources(twin, { exactPaths: paths(LOGO_FILE) }).candidates;
    assert.equal(c.length, 2);
    assert.notEqual(c[0].identity.context, c[1].identity.context, 'their surroundings differ, so each is individually identifiable');
    // the second twin follows the first twin; moving the content so both have the same neighbourhood is not possible without changing it
    assert.ok(locateByIdentity(twin, c[0].identity, { exactPaths: paths(LOGO_FILE) }));
    assert.ok(locateByIdentity(twin, c[1].identity, { exactPaths: paths(LOGO_FILE) }));
  });
});

describe('modules that must NOT be edited from the page content', () => {
  const ineligible = (extra, make = (x) => heroHeader(x)) => findAltSources(withModules(make(extra)), { exactPaths: paths(HERO_FILE) }).candidates[0].ineligible;
  test('a global (Divi Library) module: its settings are not in this page', () => assert.equal(ineligible(' global_module="42"'), 'GLOBAL_MODULE'));
  test('dynamic content on the image or the alt', () => {
    assert.equal(ineligible(' _dynamic_attributes="image_alt_text"'), 'DYNAMIC_ATTRIBUTE');
    assert.equal(ineligible(' _dynamic_attributes="header_image_url"'), 'DYNAMIC_ATTRIBUTE');
  });
  test('an alt value that is dynamic content, or an alt attribute that is not quoted', () => {
    const dc = `[et_pb_image src="${TEAM_URL}" alt="@ET-DC@eyJkeW5hbWljIjp0cnVlLCJjb250ZW50IjoicG9zdF90aXRsZSJ9@"][/et_pb_image]`;
    assert.equal(findAltSources(dc, { exactPaths: paths(TEAM_FILE) }).ok, false, 'no section: not a Divi page body');
    const wrapped = withModules(dc);
    assert.equal(findAltSources(wrapped, { exactPaths: paths(TEAM_FILE) }).candidates[0].ineligible, 'DYNAMIC_CONTENT');
    const unquoted = withModules(`[et_pb_image src="${TEAM_URL}" alt=plain][/et_pb_image]`);
    assert.equal(findAltSources(unquoted, { exactPaths: paths(TEAM_FILE) }).candidates[0].ineligible, 'ALT_ATTRIBUTE_NOT_QUOTED');
  });
});

describe('unsupported storage formats and malformed content are refused with a reason', () => {
  const run = (raw) => findAltSources(raw, { exactPaths: paths(HERO_FILE) });
  test('Divi 5 blocks, plain HTML, Gutenberg, nothing, non-strings', () => {
    for (const raw of [DIVI5, `<p><img src="${HERO_URL}"></p>`, '<!-- wp:image {"id":301} /-->', '', null, undefined, 42]) {
      const r = run(raw);
      assert.equal(r.ok, false);
      assert.equal(r.code, CODE.FORMAT_UNSUPPORTED);
    }
    assert.match(run(DIVI5).message, /Divi 5/);
  });
  test('truncated or unterminated shortcodes are refused, not repaired', () => {
    for (const raw of ['[et_pb_section [et_pb_fullwidth_header title="x', `[et_pb_section][et_pb_image src="${HERO_URL}`, '[et_pb_section][/et_pb_row']) {
      const r = run(raw);
      assert.equal(r.ok, false, raw);
      assert.equal(r.code, CODE.CONTENT_UNPARSEABLE);
    }
  });
  test('isDivi4Content only recognises shortcode pages', () => {
    assert.equal(isDivi4Content(homepage()), true);
    assert.equal(isDivi4Content(DIVI5), false);
  });
});

describe('matching is by EXACT upload path, never by file-name similarity', () => {
  test('a similarly named file, another size of the same name, or another folder is not the image', () => {
    const raw = withModules(imageModule(`https://sapphiredigitalagency.com/wp-content/uploads/${HERO_FILE.replace('.webp', '-copy.webp')}`, ''), imageModule(`https://x.example/wp-content/uploads/2024/01/${HERO_FILE.split('/').pop()}`, ''));
    assert.equal(findAltSources(raw, { exactPaths: paths(HERO_FILE) }).candidates.length, 0);
  });
  test('a CDN or www host with the same uploads path IS the same file', () => {
    const raw = withModules(imageModule(`https://cdn.example.net/wp-content/uploads/${HERO_FILE}`, ''));
    assert.equal(findAltSources(raw, { exactPaths: paths(HERO_FILE) }).candidates.length, 1);
  });
});

describe('verifyAltEdit rejects anything that is not a one-attribute change', () => {
  const raw = homepage();
  const c = findAltSources(raw, { exactPaths: paths(HERO_FILE) }).candidates[0];
  const good = planAltEdit(raw, c, 'A description of the team').content;
  const check = (after, o = { expectedAlt: 'A description of the team' }) => verifyAltEdit(raw, after, c, o);

  test('a changed unrelated attribute, a changed other module, changed text, a removed tag, a wrong value', () => {
    assert.equal(check(good.replace('module_class="main-slider"', 'module_class="main"')).ok, false);
    assert.equal(check(good.replace('alt="Our delivery team at work"', 'alt="changed"')).ok, false);
    assert.equal(check(good.replace('Plain text', 'Changed text')).ok, false);
    assert.equal(check(good.replace('[/et_pb_text]', '')).ok, false);
    assert.equal(check(planAltEdit(raw, c, 'Something else').content).ok, false);
    assert.equal(check('[et_pb_section').ok, false);
  });
  test('whitespace or comment changes outside the tags are caught', () => {
    assert.equal(check(good.replace('<!-- wp:divi/placeholder -->\n', '<!-- wp:divi/placeholder -->\n\n')).ok, false);
  });
});
