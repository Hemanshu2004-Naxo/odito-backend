import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { downloadSeoBridgePlugin } from './wordPressPluginController.js';
import { inspectSeoBridgePackage } from '../service/seoBridgePackage.js';
import { getLatestBridgeVersion } from '../service/seoBridgeVersion.js';
import { makeFakeBridgeSource, removeDir, withBridgeSourceDir } from '../service/seoBridgeTestFixtures.js';

function fakeRes() {
  const res = {
    statusCode: null, headers: {}, body: null, json: null,
    set(h) { Object.assign(res.headers, h); return res; },
    status(c) { res.statusCode = c; return res; },
    send(b) { res.body = b; return res; },
    json(b) { res.json = b; return res; },
  };
  return res;
}

describe('downloadSeoBridgePlugin — the endpoint behind the "Download Odito SEO Bridge" button', () => {
  test('serves a ZIP of the CURRENT source version, named for that version', async () => {
    const res = fakeRes();
    await downloadSeoBridgePlugin({}, res);
    const latest = getLatestBridgeVersion();

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Content-Type'], 'application/zip');
    assert.equal(res.headers['Content-Disposition'], `attachment; filename="odito-seo-bridge-${latest}.zip"`);
    assert.equal(res.headers['Content-Length'], String(res.body.length));
    assert.equal(res.headers['X-Odito-Bridge-Version'], latest);
    assert.equal(res.headers['X-Odito-Bridge-Package'], 'fresh');
    assert.equal(inspectSeoBridgePackage(res.body).version, latest);
  });

  test('is never cacheable by the browser, a proxy or a CDN', async () => {
    const res = fakeRes();
    await downloadSeoBridgePlugin({}, res);
    assert.match(res.headers['Cache-Control'], /no-store/);
    assert.match(res.headers['Cache-Control'], /no-cache/);
    assert.match(res.headers['Access-Control-Expose-Headers'], /Content-Disposition/);
  });

  test('two requests around a version bump return two different versions (no memoised package)', async () => {
    const dir = makeFakeBridgeSource({ version: '5.0.0' });
    try {
      const first = fakeRes();
      await withBridgeSourceDir(dir, () => downloadSeoBridgePlugin({}, first));
      assert.equal(first.headers['X-Odito-Bridge-Version'], '5.0.0');

      const fs = await import('fs');
      const path = await import('path');
      for (const f of ['odito-seo-bridge.php', 'readme.txt']) {
        const p = path.join(dir, f);
        fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/5\.0\.0/g, '5.1.0'));
      }
      const second = fakeRes();
      await withBridgeSourceDir(dir, () => downloadSeoBridgePlugin({}, second));
      assert.equal(second.headers['X-Odito-Bridge-Version'], '5.1.0');
      assert.equal(inspectSeoBridgePackage(second.body).version, '5.1.0');
    } finally {
      removeDir(dir);
    }
  });

  test('an inconsistent source (header vs readme) is a 500, never a silently mis-versioned ZIP', async () => {
    const dir = makeFakeBridgeSource({ version: '6.0.0', stableTag: '5.0.0' });
    const originalError = console.error;
    console.error = () => {};
    try {
      const res = fakeRes();
      await withBridgeSourceDir(dir, () => downloadSeoBridgePlugin({}, res));
      assert.equal(res.statusCode, 500);
      assert.equal(res.body, null);
    } finally {
      console.error = originalError;
      removeDir(dir);
    }
  });
});
