import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Structural guard: every route that can change WordPress (typed Organization fix, image alt fix) is throttled, and every
 * read route is throttled too. A new mutation route added without a limiter fails here instead of shipping unthrottled.
 */

const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'taskRoutes.js'), 'utf8');
const routes = [...src.matchAll(/^router\.(get|post|put|patch|delete)\('([^']+)',\s*([^)]*)\);/gm)].map((m) => ({ method: m[1], path: m[2], chain: m[3] }));
const typed = routes.filter((r) => /wordpress-fix|image-alt|apply-wordpress/.test(r.path));

test('the typed WordPress fix routes were found', () => {
  assert.ok(typed.length >= 9, `found ${typed.length}`);
});

test('every typed-fix route that changes anything (POST/PUT/PATCH/DELETE) uses the apply limiter', () => {
  for (const r of typed.filter((x) => x.method !== 'get' && !x.path.endsWith('/preview'))) {
    assert.match(r.chain, /applyWordPressFixLimiter/, `${r.method.toUpperCase()} ${r.path}`);
  }
});

test('every typed-fix read route is throttled as well', () => {
  for (const r of typed.filter((x) => x.method === 'get')) {
    assert.match(r.chain, /wordPressFixReadLimiter/, `GET ${r.path}`);
  }
});

test('the image-alt preview, although a POST, is read-only and uses the read limiter', () => {
  const preview = typed.find((r) => r.path === '/:taskId/image-alt/preview');
  assert.ok(preview);
  assert.match(preview.chain, /wordPressFixReadLimiter/);
});
