import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

import {
  SEO_BRIDGE_ARTIFACT_PATH,
  assertSeoBridgeVersionConsistency,
  buildSeoBridgePackage,
  checkSeoBridgeArtifactFresh,
  getDownloadableBridgeVersion,
  inspectSeoBridgePackage,
  isExcludedFromPackage,
  readZipEntries,
  resolveSeoBridgeDownload,
} from './seoBridgePackage.js';
import { getSeoBridgeSourceDir, parsePluginHeaderVersion } from './seoBridgeVersion.js';
import { makeFakeBridgeSource, removeDir, withBridgeSourceDir } from './seoBridgeTestFixtures.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../../../');
const PHP = path.join(REPO_ROOT, '.tools', 'php', process.platform === 'win32' ? 'php.exe' : 'php');
const WP_CORE = path.join(REPO_ROOT, '.tools', 'wordpress');
const hasPhp = fs.existsSync(PHP);
const hasWpCore = fs.existsSync(path.join(WP_CORE, 'wp-includes', 'functions.php'));

const sourceDir = getSeoBridgeSourceDir();
const sourceVersion = parsePluginHeaderVersion(fs.readFileSync(path.join(sourceDir, 'odito-seo-bridge.php'), 'utf8'));

function extractTo(entries, dir) {
  for (const entry of entries) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory) fs.mkdirSync(target, { recursive: true });
    else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, entry.content);
    }
  }
}

describe('the package built from the real odito-seo-bridge source', async () => {
  const pkg = await buildSeoBridgePackage();
  const inspected = inspectSeoBridgePackage(pkg.buffer);

  test('carries the source\'s current version — not a stale one — in the package and its file name', () => {
    assert.equal(pkg.version, sourceVersion);
    assert.equal(inspected.version, sourceVersion);
    assert.equal(pkg.fileName, `odito-seo-bridge-${sourceVersion}.zip`);
    assert.notEqual(inspected.version, '1.1.0');
  });

  test('readme Stable tag inside the package equals the header version inside the package', () => {
    assert.equal(inspected.stableTag, inspected.version);
  });

  test('is WordPress-installable: ONE root folder, main file at <slug>/<slug>.php, forward slashes only', () => {
    assert.deepEqual(inspected.rootFolders, ['odito-seo-bridge']);
    assert.ok(inspected.hasMainFileAtExpectedPath);
    assert.equal(inspected.hasBackslash, false);
    assert.ok(!inspected.names.some((n) => n.startsWith('odito-seo-bridge/odito-seo-bridge/')), 'no nested duplicate folder');
  });

  test('contains every capability implementation the UI gates on', () => {
    const names = new Set(inspected.names);
    for (const required of [
      'odito-seo-bridge/odito-seo-bridge.php',
      'odito-seo-bridge/includes/class-rest-controller.php',
      'odito-seo-bridge/includes/class-security.php',
      'odito-seo-bridge/includes/class-faq-schema.php',
      'odito-seo-bridge/includes/class-rating-schema.php',
      'odito-seo-bridge/includes/Providers/ProviderInterface.php',
      'odito-seo-bridge/includes/Providers/SiteSchemaProviderInterface.php',
      'odito-seo-bridge/includes/Providers/RankMathProvider.php',
    ]) {
      assert.ok(names.has(required), `package is missing ${required}`);
    }
  });

  test('exposes the REST routes and capability flags each version added', () => {
    const rest = inspected.entries.find((e) => e.name.endsWith('class-rest-controller.php')).content.toString('utf8');
    assert.match(rest, /'\/seo\/site'/, 'site schema (sameAs/breadcrumbs) route');
    assert.match(rest, /faq-schema/, 'FAQ schema route');
    assert.match(rest, /rating-schema/, 'AggregateRating route');
    assert.match(rest, /'site_schema'\s*=>/);
    assert.match(rest, /'faq_schema'\s*=>/);
    assert.match(rest, /'rating_schema'\s*=>/);
    assert.match(rest, /'bridge_version'\s*=>\s*ODITO_SEO_BRIDGE_VERSION/);
    const security = inspected.entries.find((e) => e.name.endsWith('class-security.php')).content.toString('utf8');
    assert.match(security, /VALID_ROBOTS_WIRE_VALUES/, 'robots validation');
    assert.match(security, /manage_options/, 'site-level permission check');
  });

  test('every packaged file is byte-identical to the source', () => {
    for (const file of pkg.files) {
      const inZip = inspected.entries.find((e) => e.name === `odito-seo-bridge/${file.path}`);
      assert.ok(inZip, `${file.path} missing from the ZIP`);
      assert.ok(inZip.content.equals(fs.readFileSync(path.join(sourceDir, file.path))), `${file.path} differs from source`);
    }
  });

  test('ships no development, credential or temporary files', () => {
    for (const name of inspected.names) {
      assert.ok(!isExcludedFromPackage(name.replace(/^odito-seo-bridge\//, '')), `${name} should not be packaged`);
    }
  });

  test('every PHP file in the package passes `php -l` (real PHP)', { skip: !hasPhp && 'no local PHP at .tools/php' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odito-bridge-lint-'));
    try {
      extractTo(inspected.entries, dir);
      const phpFiles = inspected.names.filter((n) => n.endsWith('.php'));
      assert.ok(phpFiles.length >= 10);
      for (const name of phpFiles) {
        const out = execFileSync(PHP, ['-l', path.join(dir, name)], { encoding: 'utf8' });
        assert.match(out, /No syntax errors detected/, `${name}: ${out}`);
      }
    } finally {
      removeDir(dir);
    }
  });

  test('the packaged plugin reports the header version as bridge_version (evaluated with WordPress\'s real get_file_data)', { skip: !(hasPhp && hasWpCore) && 'no local PHP/WordPress core in .tools' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odito-bridge-const-'));
    try {
      extractTo(inspected.entries, dir);
      const probe = path.join(dir, 'probe.php');
      const core = WP_CORE.replace(/\\/g, '/');
      fs.writeFileSync(probe, [
        '<?php',
        `define('ABSPATH', '${core}/'); define('WPINC', 'wp-includes'); define('KB_IN_BYTES', 1024);`,
        "foreach (['compat','version','load','formatting','functions','plugin'] as $f) { require ABSPATH . WPINC . \"/$f.php\"; }",
        'require $argv[1];',
        'echo ODITO_SEO_BRIDGE_VERSION;',
      ].join('\n'));
      const reported = execFileSync(PHP, [probe, path.join(dir, 'odito-seo-bridge', 'odito-seo-bridge.php')], { encoding: 'utf8' });
      assert.equal(reported.trim(), sourceVersion);
    } finally {
      removeDir(dir);
    }
  });

  test('the packaged plugin refuses URLs that could inject an extra sameAs line (real PHP, WordPress\'s own wp_parse_url)', { skip: !(hasPhp && hasWpCore) && 'no local PHP/WordPress core in .tools' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odito-bridge-sec-'));
    try {
      extractTo(inspected.entries, dir);
      const probe = path.join(dir, 'probe.php');
      const core = WP_CORE.split(path.sep).join('/');
      const NS = String.fromCharCode(92); // PHP namespace separator
      const SECURITY = `${NS}Odito${NS}SeoBridge${NS}Security`;
      const cases = [
        ['https://www.linkedin.com/company/example', true],
        ['https://www.youtube.com/@example', true],
        ['https://x.com/example?ref=1', true],
        ['https://a.com/x\nhttps://evil.example.com', false],
        ['https://a.com/x\r\nhttps://evil.example.com', false],
        ['https://a.com/x https://evil.example.com', false],
        ['https://a.com/x\thttps://evil.example.com', false],
        ['javascript:alert(1)', false],
        ['data:text/html,x', false],
        ['/relative/path', false],
        ['https://a.com/"onmouseover=x', false],
        ['https://a.com/<b>', false],
      ];
      fs.writeFileSync(path.join(dir, 'cases.json'), JSON.stringify(cases));
      fs.writeFileSync(probe, [
        '<?php',
        `define('ABSPATH', '${core}/'); define('WPINC', 'wp-includes'); define('KB_IN_BYTES', 1024);`,
        "foreach (['compat','version','load','formatting','functions','plugin','http'] as $f) { require ABSPATH . WPINC . \"/$f.php\"; }",
        "require $argv[1] . '/odito-seo-bridge/includes/class-security.php';",
        "$cases = json_decode(file_get_contents($argv[1] . '/cases.json'), true);",
        '$out = array();',
        `foreach ($cases as $c) { $out[] = array($c[0], ${SECURITY}::is_valid_canonical_url($c[0]), ${SECURITY}::validate_site_field_value('organization', 'sameAs', $c[0])); }`,
        'echo json_encode($out);',
      ].join('\n'));
      const results = JSON.parse(execFileSync(PHP, [probe, dir], { encoding: 'utf8' }));
      for (const [i, [url, expected]] of cases.entries()) {
        assert.equal(results[i][1], expected, `is_valid_canonical_url(${JSON.stringify(url)})`);
        assert.equal(results[i][2] === true, expected, `validate_site_field_value(sameAs, ${JSON.stringify(url)})`);
      }
    } finally {
      removeDir(dir);
    }
  });
});

describe('the builder follows the source — there is no cache to go stale', () => {
  test('bumping the source version changes the next package, its file name and its readme tag', async () => {
    const dir = makeFakeBridgeSource({ version: '2.0.0' });
    try {
      const first = await buildSeoBridgePackage({ sourceDir: dir });
      assert.equal(first.version, '2.0.0');

      fs.writeFileSync(path.join(dir, 'odito-seo-bridge.php'), fs.readFileSync(path.join(dir, 'odito-seo-bridge.php'), 'utf8').replace('2.0.0', '2.1.0'));
      fs.writeFileSync(path.join(dir, 'readme.txt'), fs.readFileSync(path.join(dir, 'readme.txt'), 'utf8').replace(/2\.0\.0/g, '2.1.0'));

      const second = await buildSeoBridgePackage({ sourceDir: dir });
      assert.equal(second.version, '2.1.0');
      assert.equal(second.fileName, 'odito-seo-bridge-2.1.0.zip');
      assert.equal(inspectSeoBridgePackage(second.buffer).version, '2.1.0');
      assert.notEqual(first.contentSha256, second.contentSha256);
    } finally {
      removeDir(dir);
    }
  });

  test('identical source builds to the identical content hash', async () => {
    const dir = makeFakeBridgeSource();
    try {
      assert.equal((await buildSeoBridgePackage({ sourceDir: dir })).contentSha256, (await buildSeoBridgePackage({ sourceDir: dir })).contentSha256);
    } finally {
      removeDir(dir);
    }
  });

  test('leaves out .env files, tests, logs, VCS/OS files, keys, and zips — wherever they sit', async () => {
    const dir = makeFakeBridgeSource({
      extraFiles: {
        '.env': 'SECRET=1', '.gitignore': 'x', '.DS_Store': 'x', 'debug.log': 'x', 'backup.zip': 'x', 'private.pem': 'x',
        'node_modules/dep/index.js': 'x', 'tests/FooTest.php': 'x', 'includes/tests/BarTest.php': 'x', 'includes/.env.local': 'x',
        'includes/keep-me.php': '<?php\n',
      },
    });
    try {
      const { names } = inspectSeoBridgePackage((await buildSeoBridgePackage({ sourceDir: dir })).buffer);
      const files = names.filter((n) => !n.endsWith('/')).map((n) => n.replace('odito-seo-bridge/', ''));
      assert.deepEqual(files.sort(), ['includes/class-thing.php', 'includes/keep-me.php', 'odito-seo-bridge.php', 'readme.txt']);
    } finally {
      removeDir(dir);
    }
  });

  test('refuses to package when readme Stable tag disagrees with the header', async () => {
    const dir = makeFakeBridgeSource({ version: '3.0.0', stableTag: '2.9.0' });
    try {
      await assert.rejects(() => buildSeoBridgePackage({ sourceDir: dir }), /"Stable tag" \(2\.9\.0\) does not match the plugin header Version \(3\.0\.0\)/);
    } finally {
      removeDir(dir);
    }
  });

  test('refuses to package a second, divergent hardcoded version literal', () => {
    const dir = makeFakeBridgeSource({ version: '3.0.0', versionLiteral: '1.1.0' });
    try {
      assert.throws(() => assertSeoBridgeVersionConsistency(dir), /hardcoded as 1\.1\.0 but the plugin header says 3\.0\.0/);
    } finally {
      removeDir(dir);
    }
  });

  test('refuses a directory that is not the plugin', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odito-not-a-plugin-'));
    try {
      await assert.rejects(() => buildSeoBridgePackage({ sourceDir: dir }), /doesn't look like the odito-seo-bridge plugin/);
    } finally {
      removeDir(dir);
    }
  });
});

describe('resolveSeoBridgeDownload — what the Download button actually receives', () => {
  test('with the source present it builds fresh from it', async () => {
    const download = await resolveSeoBridgeDownload();
    assert.equal(download.kind, 'fresh');
    assert.equal(download.version, sourceVersion);
  });

  test('a version bump in the source is reflected by the very next download', async () => {
    const dir = makeFakeBridgeSource({ version: '8.1.0' });
    try {
      const download = await withBridgeSourceDir(dir, () => resolveSeoBridgeDownload());
      assert.equal(download.kind, 'fresh');
      assert.equal(download.version, '8.1.0');
      assert.equal(inspectSeoBridgePackage(download.buffer).version, '8.1.0');
    } finally {
      removeDir(dir);
    }
  });

  test('without the source it serves the artifact, reporting the version found INSIDE it', { skip: !fs.existsSync(SEO_BRIDGE_ARTIFACT_PATH) && 'no artifact present' }, async () => {
    const download = await withBridgeSourceDir('/definitely/not/here', () => resolveSeoBridgeDownload());
    assert.equal(download.kind, 'prebuilt');
    assert.equal(download.version, inspectSeoBridgePackage(fs.readFileSync(SEO_BRIDGE_ARTIFACT_PATH)).version);
  });
});

describe('getDownloadableBridgeVersion — the version the update prompt compares against', () => {
  test('equals what the Download button delivers (source present)', async () => {
    assert.equal(getDownloadableBridgeVersion(), (await resolveSeoBridgeDownload()).version);
  });

  test('source not deployed: the version inside the fallback artifact, matching what the download would serve', { skip: !fs.existsSync(SEO_BRIDGE_ARTIFACT_PATH) && 'no artifact present' }, async () => {
    await withBridgeSourceDir('/definitely/not/here', async () => {
      const download = await resolveSeoBridgeDownload();
      assert.equal(getDownloadableBridgeVersion(), download.version);
    });
  });
});

describe('the committed fallback artifact (storage/plugin/odito-seo-bridge.zip)', () => {
  test('is not stale relative to the source (run `npm run package:seo-bridge-plugin` if this fails)', { skip: !fs.existsSync(SEO_BRIDGE_ARTIFACT_PATH) && 'no artifact present' }, async () => {
    const result = await checkSeoBridgeArtifactFresh();
    assert.ok(result.ok, `${result.reason} — source ${result.sourceVersion}, artifact ${result.artifactVersion}`);
  });
});

describe('readZipEntries', () => {
  test('rejects a buffer that is not a ZIP', () => {
    assert.throws(() => readZipEntries(Buffer.from('this is not a zip file at all, definitely')), /Not a valid ZIP/);
  });
});
