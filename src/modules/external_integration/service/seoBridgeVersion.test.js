import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

import {
  BRIDGE_CAPABILITY_MIN_VERSIONS,
  SEO_BRIDGE_MAIN_FILE,
  compareVersions,
  getLatestBridgeVersion,
  getSeoBridgeSourceDir,
  isValidBridgeVersion,
  isVersionAtLeast,
  parsePluginHeaderVersion,
  parseReadmeStableTag,
} from './seoBridgeVersion.js';
import { makeFakeBridgeSource, removeDir, withBridgeSourceDir } from './seoBridgeTestFixtures.js';

describe('compareVersions — semantic, never string order', () => {
  test('orders the versions named in the requirement correctly', () => {
    assert.equal(compareVersions('1.0.0', '1.2.0'), -1);
    assert.equal(compareVersions('1.1.0', '1.2.0'), -1);
    assert.equal(compareVersions('1.2.0', '1.2.0'), 0);
    assert.equal(compareVersions('1.2.1', '1.2.0'), 1);
    assert.equal(compareVersions('1.10.0', '1.2.0'), 1);
  });

  test('a naive string comparison gets 1.10.0 vs 1.2.0 wrong — this one does not', () => {
    assert.ok('1.10.0' < '1.2.0', 'sanity: string order really is wrong for this pair');
    assert.equal(compareVersions('1.10.0', '1.2.0'), 1);
  });

  test('missing trailing components are zero; a leading v is tolerated', () => {
    assert.equal(compareVersions('1.2', '1.2.0'), 0);
    assert.equal(compareVersions('v1.2.0', '1.2.0'), 0);
  });

  test('a prerelease sorts below its release', () => {
    assert.equal(compareVersions('1.2.0-beta.1', '1.2.0'), -1);
    assert.equal(compareVersions('1.2.0', '1.2.0-rc.1'), 1);
    assert.equal(compareVersions('1.2.0-beta.2', '1.2.0-beta.10'), -1);
  });

  test('unparseable input yields null rather than a guess', () => {
    assert.equal(compareVersions('abc', '1.2.0'), null);
    assert.equal(compareVersions('1.2.0', null), null);
    assert.equal(compareVersions(undefined, undefined), null);
  });
});

describe('isVersionAtLeast — the gate for "requires Bridge 1.2.0 or newer"', () => {
  const MIN = '1.2.0';
  test('1.0.0 and 1.1.0 are rejected when the minimum is 1.2.0', () => {
    assert.equal(isVersionAtLeast('1.0.0', MIN), false);
    assert.equal(isVersionAtLeast('1.1.0', MIN), false);
  });
  test('1.2.0 is accepted', () => assert.equal(isVersionAtLeast('1.2.0', MIN), true));
  test('1.2.1 is accepted', () => assert.equal(isVersionAtLeast('1.2.1', MIN), true));
  test('1.10.0 is accepted', () => assert.equal(isVersionAtLeast('1.10.0', MIN), true));
  test('the current 1.3.0 satisfies a 1.2.0 minimum', () => assert.equal(isVersionAtLeast('1.3.0', MIN), true));

  test('an unknown version follows the caller-chosen policy (floor gate never blocks; capability messaging is strict)', () => {
    assert.equal(isVersionAtLeast(null, MIN), true);
    assert.equal(isVersionAtLeast(null, MIN, { unknownIs: false }), false);
    assert.equal(isVersionAtLeast('garbage', MIN, { unknownIs: false }), false);
  });
});

describe('plugin header / readme parsing', () => {
  test('parsePluginHeaderVersion reads the Version line and ignores comment decoration', () => {
    assert.equal(parsePluginHeaderVersion('<?php\n/**\n * Version:           1.3.0\n */'), '1.3.0');
    assert.equal(parsePluginHeaderVersion('<?php\n/* Plugin Name: X\nVersion: 2.0.1 */'), '2.0.1');
  });
  test('a missing or malformed version is null, never a default', () => {
    assert.equal(parsePluginHeaderVersion('<?php\n/** Plugin Name: X */'), null);
    assert.equal(parsePluginHeaderVersion('<?php\n/** Version: latest */'), null);
    assert.equal(parsePluginHeaderVersion(undefined), null);
  });
  test('isValidBridgeVersion is strict x.y.z[-pre]', () => {
    assert.ok(isValidBridgeVersion('1.3.0'));
    assert.ok(isValidBridgeVersion('1.3.0-rc.1'));
    assert.ok(!isValidBridgeVersion('1.3'));
    assert.ok(!isValidBridgeVersion('v1.3.0'));
  });
  test('parseReadmeStableTag', () => {
    assert.equal(parseReadmeStableTag('=== X ===\nStable tag: 1.3.0\nLicense: GPL'), '1.3.0');
    assert.equal(parseReadmeStableTag('=== X ==='), null);
  });
});

// These read the REAL plugin source in the repo: they are the guard that the
// version everywhere agrees and that nothing is left stale.
describe('the real odito-seo-bridge source — one authoritative version', () => {
  const sourceDir = getSeoBridgeSourceDir();
  const mainSource = fs.readFileSync(path.join(sourceDir, SEO_BRIDGE_MAIN_FILE), 'utf8');
  const readme = fs.readFileSync(path.join(sourceDir, 'readme.txt'), 'utf8');
  const version = parsePluginHeaderVersion(mainSource);

  test('the plugin header has a valid version, and it is not the stale 1.1.0', () => {
    assert.ok(isValidBridgeVersion(version), `header version ${version}`);
    assert.notEqual(version, '1.1.0');
  });

  test('the source is at least 1.2.0 — the version the FAQ schema capability requires', () => {
    assert.ok(isVersionAtLeast(version, '1.2.0', { unknownIs: false }), `source is ${version}`);
  });

  test('getLatestBridgeVersion (what the UI update prompt compares against) is the header version', () => {
    assert.equal(getLatestBridgeVersion(), version);
  });

  test('readme.txt Stable tag equals the header version', () => {
    assert.equal(parseReadmeStableTag(readme), version);
  });

  test('ODITO_SEO_BRIDGE_VERSION is derived from the header, never a second hardcoded literal', () => {
    assert.match(mainSource, /get_file_data\(/);
    assert.doesNotMatch(mainSource, /define\(\s*['"]ODITO_SEO_BRIDGE_VERSION['"]\s*,\s*['"]\d/);
  });

  test('the changelog documents the current version', () => {
    assert.match(readme, new RegExp(`^= ${version.replace(/\./g, '\\.')} =`, 'm'));
  });

  test('every capability minimum is not newer than the source, and is introduced under exactly that version in the changelog', () => {
    const sections = {};
    const parts = readme.split(/^= (\S+) =\s*$/m);
    for (let i = 1; i < parts.length; i += 2) sections[parts[i]] = parts[i + 1];

    const keywords = {
      robots: /robots/i,
      site_schema: /site-level|site_schema/i,
      faq_schema: /faq-schema|faqpage/i,
      rating_schema: /rating-schema|aggregaterating/i,
      organization_type: /organization type|organization-type|business type/i,
      media_alt: /media alt text|media\/<id>\/alt/i,
      conditional_writes: /conditional/i,
      organization_address: /organization address/i,
    };
    assert.deepEqual(Object.keys(keywords).sort(), Object.keys(BRIDGE_CAPABILITY_MIN_VERSIONS).sort());

    for (const [capability, minVersion] of Object.entries(BRIDGE_CAPABILITY_MIN_VERSIONS)) {
      assert.ok(isVersionAtLeast(version, minVersion, { unknownIs: false }), `${capability} requires ${minVersion} but source is ${version}`);
      assert.ok(sections[minVersion], `changelog has no section for ${minVersion} (${capability})`);
      assert.match(sections[minVersion], keywords[capability], `${capability} is not described under ${minVersion} in the changelog`);
    }
  });

  test('getLatestBridgeVersion follows the source directory — nothing is cached', async () => {
    const dir = makeFakeBridgeSource({ version: '4.5.6' });
    try {
      assert.equal(await withBridgeSourceDir(dir, () => getLatestBridgeVersion()), '4.5.6');
    } finally {
      removeDir(dir);
    }
    assert.equal(getLatestBridgeVersion(), version);
  });

  test('getLatestBridgeVersion is null when the source is not on this machine', async () => {
    assert.equal(await withBridgeSourceDir('/definitely/not/here', () => getLatestBridgeVersion()), null);
  });
});
