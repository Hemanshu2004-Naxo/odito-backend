import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import mediaStorageService, { isOwnedUrl, isPubliclyReachableUrl, upload, deleteByUrl } from './mediaStorageService.js';

dotenv.config();

const TEST_PROJECT_ID = '507f1f77bcf86cd799439011'; // a syntactically-real 24-hex ObjectId string
const ROOT_DIR = path.resolve(process.cwd(), 'storage', 'social_media');

after(async () => {
  // Best-effort cleanup of this test's project subfolder only — never
  // touches anything else under storage/social_media/.
  await fs.rm(path.join(ROOT_DIR, TEST_PROJECT_ID), { recursive: true, force: true });
});

describe('mediaStorageService.upload / deleteByUrl', () => {
  test('writes the buffer to a real file under storage/social_media/<projectId>/ and returns a matching public URL', async () => {
    const buffer = Buffer.from('fake image bytes');
    const { url, filename } = await upload({ buffer, projectId: TEST_PROJECT_ID, extension: '.png' });

    assert.ok(url.includes(`/storage/social_media/${TEST_PROJECT_ID}/`));
    assert.ok(url.endsWith('.png'));
    assert.equal(isOwnedUrl(url), true);

    const onDisk = await fs.readFile(path.join(ROOT_DIR, TEST_PROJECT_ID, filename));
    assert.equal(onDisk.toString(), 'fake image bytes');
  });

  test('the generated filename is a fresh UUID, never the caller-supplied name (there is none to leak/collide/traverse with)', async () => {
    const { filename } = await upload({ buffer: Buffer.from('a'), projectId: TEST_PROJECT_ID, extension: '.jpg' });
    assert.match(filename, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/i);
  });

  test('two uploads to the same project never collide (different UUIDs)', async () => {
    const a = await upload({ buffer: Buffer.from('a'), projectId: TEST_PROJECT_ID, extension: '.png' });
    const b = await upload({ buffer: Buffer.from('b'), projectId: TEST_PROJECT_ID, extension: '.png' });
    assert.notEqual(a.url, b.url);
  });

  test('deleteByUrl actually removes the file from disk', async () => {
    const { url, filename } = await upload({ buffer: Buffer.from('to be deleted'), projectId: TEST_PROJECT_ID, extension: '.png' });
    await deleteByUrl(url);
    await assert.rejects(() => fs.readFile(path.join(ROOT_DIR, TEST_PROJECT_ID, filename)), { code: 'ENOENT' });
  });

  test('deleteByUrl on a URL this service never issued (a foreign/external URL) is a safe no-op', async () => {
    await assert.doesNotReject(() => deleteByUrl('https://evil.example.com/../../etc/passwd'));
  });

  test('isOwnedUrl rejects a blob: URL and any external URL — these must NEVER be treated as ours', async () => {
    assert.equal(isOwnedUrl('blob:http://localhost:3000/abc-123'), false);
    assert.equal(isOwnedUrl('https://cdn.example.com/photo.jpg'), false);
  });

  test('a path-traversal attempt embedded in an otherwise-owned-looking URL is refused, not resolved outside storage/social_media/', async () => {
    const { url } = await upload({ buffer: Buffer.from('victim'), projectId: TEST_PROJECT_ID, extension: '.png' });
    const prefixEnd = url.lastIndexOf('/');
    const maliciousUrl = `${url.slice(0, prefixEnd)}/../../../evil.txt`;
    // Still "owned" by prefix (starts with the real storage URL prefix),
    // but safeFilePath's strict two-segment/24-hex-project + no-traversal
    // check must refuse to resolve it to any real path, so this must not
    // throw and must not delete anything real.
    assert.equal(isOwnedUrl(maliciousUrl), true);
    await assert.doesNotReject(() => deleteByUrl(maliciousUrl));
  });
});

test('default export exposes the same four functions', () => {
  assert.equal(typeof mediaStorageService.upload, 'function');
  assert.equal(typeof mediaStorageService.deleteByUrl, 'function');
  assert.equal(typeof mediaStorageService.isOwnedUrl, 'function');
  assert.equal(typeof mediaStorageService.isPubliclyReachableUrl, 'function');
});

// Root-cause regression coverage for a real bug: a genuine Instagram
// container-creation call against "http://localhost:5000/storage/..."
// (BACKEND_URL was localhost) was rejected by the real Meta Graph API as
// OAuthException code 9004 ("Only photo or video can be accepted as media
// type") — a completely valid, already-validated JPEG, rejected purely
// because Meta's servers cannot reach localhost. isPubliclyReachableUrl()
// exists so the adapters can catch this BEFORE ever calling Meta, instead
// of trying to divine the cause from Meta's ambiguous response.
describe('isPubliclyReachableUrl', () => {
  test('rejects localhost and common loopback hosts, even over https', () => {
    assert.equal(isPubliclyReachableUrl('http://localhost:5000/storage/social_media/x/y.jpg'), false);
    assert.equal(isPubliclyReachableUrl('https://localhost/storage/x.jpg'), false);
    assert.equal(isPubliclyReachableUrl('http://127.0.0.1:5000/x.jpg'), false);
    assert.equal(isPubliclyReachableUrl('http://[::1]:5000/x.jpg'), false);
  });

  test('rejects RFC1918 private network hosts', () => {
    assert.equal(isPubliclyReachableUrl('https://10.0.0.5/storage/x.jpg'), false);
    assert.equal(isPubliclyReachableUrl('https://192.168.1.20/storage/x.jpg'), false);
    assert.equal(isPubliclyReachableUrl('https://172.16.0.1/storage/x.jpg'), false);
    assert.equal(isPubliclyReachableUrl('https://172.31.255.255/storage/x.jpg'), false);
    // Outside the 172.16.0.0/12 range — a real public-looking address, not private.
    assert.equal(isPubliclyReachableUrl('https://172.32.0.1/storage/x.jpg'), true);
  });

  test('rejects plain http even on a real public hostname (production must be HTTPS)', () => {
    assert.equal(isPubliclyReachableUrl('http://cdn.odito.example.com/storage/x.jpg'), false);
  });

  test('accepts a real public HTTPS hostname', () => {
    assert.equal(isPubliclyReachableUrl('https://cdn.odito.example.com/storage/social_media/x/y.jpg'), true);
  });

  test('rejects a malformed URL rather than throwing', () => {
    assert.equal(isPubliclyReachableUrl('not a url at all'), false);
    assert.equal(isPubliclyReachableUrl(''), false);
    assert.equal(isPubliclyReachableUrl(undefined), false);
  });
});
