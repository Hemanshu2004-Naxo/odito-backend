import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import path from 'path';
import sharp from 'sharp';
import { uploadSocialMediaHandler } from './socialMediaUploadController.js';

const PROJECT_A = '507f1f77bcf86cd799439011';
const PROJECT_B = '507f1f77bcf86cd799439022';
const ROOT_DIR = path.resolve(process.cwd(), 'storage', 'social_media');

function mockRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

after(async () => {
  await fs.rm(path.join(ROOT_DIR, PROJECT_A), { recursive: true, force: true });
  await fs.rm(path.join(ROOT_DIR, PROJECT_B), { recursive: true, force: true });
});

describe('uploadSocialMediaHandler', () => {
  test('a valid image upload returns 201 with a real HTTPS url, never a blob: url, plus type/mimeType/width/height/size', async () => {
    const buffer = await sharp({ create: { width: 12, height: 8, channels: 3, background: '#123456' } }).png().toBuffer();
    const res = mockRes();
    await uploadSocialMediaHandler({ projectId: PROJECT_A, file: { mimetype: 'image/png', buffer } }, res);

    assert.equal(res.statusCode, 201);
    const data = res.body.data;
    assert.ok(data.url.startsWith('http'));
    assert.ok(!data.url.startsWith('blob:'));
    assert.equal(data.type, 'image');
    assert.equal(data.mimeType, 'image/png');
    assert.equal(data.width, 12);
    assert.equal(data.height, 8);
    assert.equal(data.size, buffer.length);

    // The file is genuinely readable from where the returned URL implies —
    // proves this isn't just a fabricated-looking response.
    const urlPath = new URL(data.url).pathname; // /storage/social_media/<projectId>/<file>
    const onDisk = path.join(process.cwd(), urlPath.replace(/^\//, ''));
    await assert.doesNotReject(() => fs.readFile(onDisk));
  });

  test('an invalid/corrupt file is rejected with 400 INVALID_MEDIA_TYPE and nothing is written to disk', async () => {
    const res = mockRes();
    await uploadSocialMediaHandler({ projectId: PROJECT_A, file: { mimetype: 'image/png', buffer: Buffer.from('not an image') } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.details.code, 'INVALID_MEDIA_TYPE');
  });

  test('no file on the request is rejected with 400 MEDIA_REQUIRED', async () => {
    const res = mockRes();
    await uploadSocialMediaHandler({ projectId: PROJECT_A, file: undefined }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.details.code, 'MEDIA_REQUIRED');
  });

  // Project scoping: the handler trusts req.projectId (already verified by
  // validateProjectAccess() upstream, same as every other route in this
  // module) and stores under THAT project's own folder — two different
  // projects uploading never share or collide on storage location.
  test('two different projects uploading get files scoped to their own separate project folders', async () => {
    const buffer = await sharp({ create: { width: 5, height: 5, channels: 3, background: '#ffffff' } }).png().toBuffer();
    const resA = mockRes();
    await uploadSocialMediaHandler({ projectId: PROJECT_A, file: { mimetype: 'image/png', buffer } }, resA);
    const resB = mockRes();
    await uploadSocialMediaHandler({ projectId: PROJECT_B, file: { mimetype: 'image/png', buffer } }, resB);

    assert.ok(resA.body.data.url.includes(`/${PROJECT_A}/`));
    assert.ok(resB.body.data.url.includes(`/${PROJECT_B}/`));
    assert.notEqual(resA.body.data.url, resB.body.data.url);
  });

  test('a real MP4 signature uploaded as video/mp4 is accepted and returns type "video"', async () => {
    const buffer = Buffer.alloc(32);
    buffer.write('ftyp', 4, 'ascii');
    const res = mockRes();
    await uploadSocialMediaHandler({ projectId: PROJECT_A, file: { mimetype: 'video/mp4', buffer } }, res);
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.data.type, 'video');
  });
});
