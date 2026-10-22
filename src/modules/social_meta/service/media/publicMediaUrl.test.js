import { describe, test, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import crypto from 'crypto';

dotenv.config();

import mediaStorageService, { publicMediaOrigin, isOwnedUrl, publishableMediaProblem, storedMediaExists, upload, deleteByUrl } from './mediaStorageService.js';
import { isPubliclyReachableUrl } from '../../../../utils/publicUrlCheck.js';

/**
 * The media URL architecture: where Odito-generated media URLs point, what counts as "ours", and the strict rule a URL must
 * satisfy before it can be handed to Meta. Everything is judged from configuration + the URL string (nothing is fetched).
 */
const PROJECT = '507f1f77bcf86cd799439022';
const UUID = '123e4567-e89b-42d3-a456-426614174000';
const ROOT = path.resolve(process.cwd(), 'storage', 'social_media');
const PUBLIC = 'https://media.example.com';
const saved = { pub: process.env.PUBLIC_MEDIA_BASE_URL, backend: process.env.BACKEND_URL };

beforeEach(() => { process.env.BACKEND_URL = 'http://localhost:5000'; delete process.env.PUBLIC_MEDIA_BASE_URL; });
afterEach(() => { if (saved.pub === undefined) delete process.env.PUBLIC_MEDIA_BASE_URL; else process.env.PUBLIC_MEDIA_BASE_URL = saved.pub; process.env.BACKEND_URL = saved.backend; });
after(async () => { await fs.rm(path.join(ROOT, PROJECT), { recursive: true, force: true }); });

const url = (origin, rel = `${PROJECT}/${UUID}.jpg`) => `${origin}/storage/social_media/${rel}`;

describe('where generated media URLs point', () => {
  test('1: default: BACKEND_URL (unchanged behaviour); PUBLIC_MEDIA_BASE_URL, when set, wins; blanks and trailing slashes are normalised', () => {
    assert.equal(publicMediaOrigin(), 'http://localhost:5000');
    process.env.PUBLIC_MEDIA_BASE_URL = `${PUBLIC}/`;
    assert.equal(publicMediaOrigin(), PUBLIC);
    process.env.PUBLIC_MEDIA_BASE_URL = '   ';
    assert.equal(publicMediaOrigin(), 'http://localhost:5000');
  });

  test('2: upload() writes under storage/social_media/<project>/<uuid>.<ext> and returns a URL on the CURRENT public media origin', async () => {
    process.env.PUBLIC_MEDIA_BASE_URL = PUBLIC;
    const { url: u, filename } = await upload({ buffer: Buffer.from('x'), projectId: PROJECT, extension: '.jpg' });
    assert.equal(u, `${PUBLIC}/storage/social_media/${PROJECT}/${filename}`);
    assert.match(filename, /^[0-9a-f-]{36}\.jpg$/);
    assert.equal((await fs.readFile(path.join(ROOT, PROJECT, filename))).toString(), 'x');
    assert.equal(mediaStorageService.publishableMediaProblem(u), null);
    await deleteByUrl(u);
  });
});

describe('what counts as Odito-owned media', () => {
  test('3: the public origin AND the legacy BACKEND_URL origin are ours (rows written before the setting existed keep working, and can still be deleted)', async () => {
    process.env.PUBLIC_MEDIA_BASE_URL = PUBLIC;
    assert.equal(isOwnedUrl(url(PUBLIC)), true);
    assert.equal(isOwnedUrl(url('http://localhost:5000')), true);
    process.env.PUBLIC_MEDIA_BASE_URL = '';
    const legacy = await upload({ buffer: Buffer.from('legacy'), projectId: PROJECT, extension: '.png' });
    process.env.PUBLIC_MEDIA_BASE_URL = PUBLIC;
    assert.equal(isOwnedUrl(legacy.url), true);
    await deleteByUrl(legacy.url);
    await assert.rejects(() => fs.readFile(path.join(ROOT, PROJECT, legacy.filename)), { code: 'ENOENT' });
  });

  test('4: look-alikes, other hosts, other paths and non-http schemes are NOT ours', () => {
    process.env.PUBLIC_MEDIA_BASE_URL = PUBLIC;
    for (const bad of [
      url('https://media.example.com.evil.example'), url('https://evil.example'), 'https://media.example.com/storage/avatars/x.jpg', 'https://media.example.com/other/social_media/x.jpg',
      'https://media.example.com@evil.example/storage/social_media/a/b.jpg', 'file:///etc/passwd', 'data:image/png;base64,AAAA', 'blob:https://media.example.com/abc', '', null, undefined, 5,
    ]) assert.equal(isOwnedUrl(bad), false, String(bad));
  });
});

describe('the rule a URL must satisfy before Meta may fetch it (publishableMediaProblem)', () => {
  test('5: a stored file on the public HTTPS media origin is publishable', () => {
    process.env.PUBLIC_MEDIA_BASE_URL = PUBLIC;
    for (const ext of ['jpg', 'png', 'webp', 'mp4']) assert.equal(publishableMediaProblem(url(PUBLIC, `${PROJECT}/${UUID}.${ext}`)), null, ext);
  });

  test('6: HTTPS is required: an http public origin is NOT_PUBLIC', () => {
    process.env.PUBLIC_MEDIA_BASE_URL = 'http://media.example.com';
    assert.equal(publishableMediaProblem(url('http://media.example.com')), 'NOT_PUBLIC');
  });

  test('7: localhost / loopback origins are NOT_PUBLIC (the default development BACKEND_URL)', () => {
    assert.equal(publishableMediaProblem(url('http://localhost:5000')), 'NOT_PUBLIC');
    for (const origin of ['https://localhost', 'https://127.0.0.1', 'https://0.0.0.0', 'https://[::1]']) {
      process.env.PUBLIC_MEDIA_BASE_URL = origin;
      assert.equal(publishableMediaProblem(url(origin)), 'NOT_PUBLIC', origin);
    }
  });

  test('8: private and link-local address origins are NOT_PUBLIC', () => {
    for (const origin of ['https://10.0.0.5', 'https://192.168.1.20', 'https://172.16.0.1', 'https://172.31.255.254', 'https://169.254.169.254']) {
      process.env.PUBLIC_MEDIA_BASE_URL = origin;
      assert.equal(publishableMediaProblem(url(origin)), 'NOT_PUBLIC', origin);
    }
  });

  test('8b: the shared reachability check also covers IPv6 loopback/private/link-local, the whole 127/8 block, *.localhost, carrier-grade NAT and IPv4-mapped IPv6 - and still allows genuinely public hosts', () => {
    for (const bad of [
      'https://[::1]/a.jpg', 'https://[::]/a.jpg', 'https://127.0.0.2/a.jpg', 'https://127.255.255.254/a.jpg', 'https://0.1.2.3/a.jpg', 'https://foo.localhost/a.jpg', 'https://localhost./a.jpg', 'https://100.64.0.1/a.jpg', 'https://100.127.255.255/a.jpg',
      'https://[fc00::1]/a.jpg', 'https://[fd12:3456::1]/a.jpg', 'https://[fe80::1]/a.jpg', 'https://[::ffff:127.0.0.1]/a.jpg', 'https://[::ffff:10.0.0.1]/a.jpg',
      'https://2130706433/a.jpg', 'https://0x7f000001/a.jpg', 'https://0177.0.0.1/a.jpg', 'http://media.example.com/a.jpg', 'ftp://media.example.com/a.jpg', 'not a url', '',
    ]) assert.equal(isPubliclyReachableUrl(bad), false, bad);
    for (const good of ['https://media.example.com/a.jpg', 'https://cdn.example.co.uk/a.jpg', 'https://8.8.8.8/a.jpg', 'https://100.63.0.1/a.jpg', 'https://100.128.0.1/a.jpg', 'https://172.15.0.1/a.jpg', 'https://172.32.0.1/a.jpg', 'https://[2606:4700::1111]/a.jpg', 'https://xyz.ngrok-free.app/a.jpg']) {
      assert.equal(isPubliclyReachableUrl(good), true, good);
    }
  });

  test('9: a URL on a DIFFERENT origin than the configured public media origin is refused (WRONG_ORIGIN for our old origin, NOT_OWNED for anyone else\'s)', () => {
    process.env.PUBLIC_MEDIA_BASE_URL = PUBLIC;
    assert.equal(publishableMediaProblem(url('http://localhost:5000')), 'WRONG_ORIGIN', 'a row written under the old BACKEND_URL');
    assert.equal(publishableMediaProblem(url('https://cdn.attacker.example')), 'NOT_OWNED');
    assert.equal(publishableMediaProblem('https://169.254.169.254/latest/meta-data/'), 'NOT_OWNED');
  });

  test('10: the path must be exactly <24-hex project>/<uuid>.<jpg|png|webp|mp4>: traversal, queries, fragments, other names and extensions are BAD_PATH', () => {
    process.env.PUBLIC_MEDIA_BASE_URL = PUBLIC;
    for (const rel of [
      `${PROJECT}/${UUID}.jpg?x=1`, `${PROJECT}/${UUID}.jpg#f`, `${PROJECT}/../${UUID}.jpg`, `${PROJECT}/..%2f${UUID}.jpg`, `${PROJECT}/${UUID}.svg`, `${PROJECT}/${UUID}.html`, `${PROJECT}/${UUID}.jpg.php`,
      `${PROJECT}/photo.jpg`, `${PROJECT}/${UUID}`, `short/${UUID}.jpg`, `${PROJECT}/sub/${UUID}.jpg`, `${PROJECT}/${UUID}.JPG/`, '',
    ]) assert.equal(publishableMediaProblem(url(PUBLIC, rel)), 'BAD_PATH', rel);
  });

  test('11: a client cannot forge a publishable URL: only URLs that pass every check above ever qualify, whatever they claim', () => {
    process.env.PUBLIC_MEDIA_BASE_URL = PUBLIC;
    for (const forged of ['https://evil.example/storage/social_media/' + PROJECT + '/' + UUID + '.jpg', 'https://media.example.com.evil.example/storage/social_media/' + PROJECT + '/' + UUID + '.jpg', 'http://169.254.169.254/' + UUID + '.jpg', 'ftp://media.example.com/x.jpg']) {
      assert.notEqual(publishableMediaProblem(forged), null, forged);
    }
  });

  test('12: the check is a pure function of configuration + string: it never fetches anything', async () => {
    process.env.PUBLIC_MEDIA_BASE_URL = PUBLIC;
    const realFetch = globalThis.fetch;
    let touched = 0;
    globalThis.fetch = async () => { touched += 1; throw new Error('no network'); };
    try {
      publishableMediaProblem(url(PUBLIC));
      publishableMediaProblem(url('https://evil.example'));
      await storedMediaExists(url(PUBLIC));
    } finally { globalThis.fetch = realFetch; }
    assert.equal(touched, 0);
    assert.equal(isPubliclyReachableUrl(url(PUBLIC)), true);
  });
});

describe('stored files', () => {
  test('13: storedMediaExists is true for a written file, false for a missing one or a traversal attempt', async () => {
    process.env.PUBLIC_MEDIA_BASE_URL = PUBLIC;
    const { url: u } = await upload({ buffer: Buffer.from('there'), projectId: PROJECT, extension: '.jpg' });
    assert.equal(await storedMediaExists(u), true);
    assert.equal(await storedMediaExists(url(PUBLIC, `${PROJECT}/${crypto.randomUUID()}.jpg`)), false);
    assert.equal(await storedMediaExists(url(PUBLIC, `${PROJECT}/../../package.json`)), false);
    assert.equal(await storedMediaExists('https://evil.example/x.jpg'), false);
    await deleteByUrl(u);
    assert.equal(await storedMediaExists(u), false);
  });
});
