import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { clearDiviVersionCache, detectDiviVersion, parseThemeHeader } from './diviVersion.js';
import { DIVI_ALT_MODULES, TESTED_DIVI_VERSIONS, describeDiviImageAltCapability } from './diviImageAlt.js';

const css = (name, version) => `/*!\nTheme Name: ${name}\nTheme URI: http://www.elegantthemes.com/gallery/divi/\nVersion: ${version}\nDescription: Smart. Flexible.\n*/\nbody{}`;

beforeEach(() => clearDiviVersionCache());

describe('Divi version detection (read from the theme header; same-site fetch only)', () => {
  test('parses the WordPress theme header block', () => {
    assert.deepEqual(parseThemeHeader(css('Divi', '4.27.7')), { themeName: 'Divi', version: '4.27.7' });
    assert.deepEqual(parseThemeHeader('body{}'), { themeName: null, version: null });
    assert.deepEqual(parseThemeHeader(null), { themeName: null, version: null });
  });

  test('a verified version is "tested"; any other version is installed but NOT tested; a different theme is not Divi', async () => {
    const mk = (text) => async () => ({ html: text });
    assert.deepEqual(await detectDiviVersion('https://s.example/', { fetchText: mk(css('Divi', '4.27.7')) }), { installed: true, version: '4.27.7', tested: true, testedVersions: ['4.27.7'] });
    clearDiviVersionCache();
    assert.deepEqual(await detectDiviVersion('https://s.example/', { fetchText: mk(css('Divi', '5.0.1')) }), { installed: true, version: '5.0.1', tested: false, testedVersions: ['4.27.7'] });
    clearDiviVersionCache();
    const other = await detectDiviVersion('https://s.example/', { fetchText: mk(css('Astra', '4.27.7')) });
    assert.deepEqual([other.installed, other.tested, other.version], [false, false, null]);
  });

  test('a failed read is "not verified" (never assumed supported); the host is the connected site only; results are remembered for 30 minutes', async () => {
    const failed = await detectDiviVersion('https://s.example', { fetchText: async () => { throw new Error('CROSS_SITE'); } });
    assert.deepEqual([failed.installed, failed.tested], [false, false]);
    clearDiviVersionCache();
    const calls = [];
    const fetchText = async (url, opts) => { calls.push([url, opts]); return { html: css('Divi', '4.27.7') }; };
    await detectDiviVersion('https://s.example/some/page', { fetchText, now: () => 1000 });
    await detectDiviVersion('https://s.example/', { fetchText, now: () => 2000 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'https://s.example/wp-content/themes/Divi/style.css');
    assert.deepEqual(calls[0][1], { siteUrl: 'https://s.example' });
    await detectDiviVersion('https://s.example/', { fetchText, now: () => 1000 + 31 * 60 * 1000 });
    assert.equal(calls.length, 2);
    assert.deepEqual(await detectDiviVersion('not a url', { fetchText }), { installed: false, version: null, tested: false, testedVersions: ['4.27.7'] });
  });
});

describe('the capability descriptor reports exactly what is and is not supported', () => {
  const cap = describeDiviImageAltCapability();
  test('formats, verified versions, modules with their evidence, and the explicit non-support list', () => {
    assert.equal(cap.format, 'divi4_shortcode');
    assert.deepEqual(cap.testedVersions, TESTED_DIVI_VERSIONS);
    assert.deepEqual(cap.modules.map((m) => [m.module, m.imageAttribute, m.altAttribute, m.evidence]), [
      ['et_pb_image', 'src', 'alt', 'observed_live'],
      ['et_pb_blurb', 'image', 'alt', 'observed_live'],
      ['et_pb_fullwidth_header', 'header_image_url', 'image_alt_text', 'divi_builder_source'],
    ]);
    assert.equal(cap.writeMode, 'read_then_write', 'honest: WordPress has no conditional post-content write');
    for (const topic of [/Theme Builder/, /global/, /dynamic/, /Divi 5/]) assert.ok(cap.notSupported.some((n) => topic.test(n)), String(topic));
    assert.equal(Object.keys(DIVI_ALT_MODULES).length, cap.modules.length);
  });
  test('the descriptor is a copy: callers cannot widen the support by mutating it', () => {
    cap.testedVersions.push('9.9.9');
    assert.deepEqual(describeDiviImageAltCapability().testedVersions, ['4.27.7']);
  });
});
