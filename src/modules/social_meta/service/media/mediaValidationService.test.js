import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { validateImage, validateVideo, MAX_IMAGE_BYTES, MAX_VIDEO_BYTES } from './mediaValidationService.js';

/**
 * No mocking of sharp or the file-signature check — these decode/inspect
 * REAL bytes, exactly as the actual upload endpoint will. This is the
 * authoritative server-side check Phase 2 requires: the client-supplied
 * mimetype/extension (multer's fileFilter layer) is never trusted alone.
 */

function fakeMp4Buffer(size = 32) {
  const buf = Buffer.alloc(size);
  buf.write('ftyp', 4, 'ascii');
  return buf;
}

describe('mediaValidationService.validateImage', () => {
  test('a real PNG is accepted, with its true decoded dimensions', async () => {
    const buffer = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#ff0000' } }).png().toBuffer();
    const result = await validateImage(buffer);
    assert.equal(result.type, 'image');
    assert.equal(result.mimeType, 'image/png');
    assert.equal(result.extension, '.png');
    assert.equal(result.width, 40);
    assert.equal(result.height, 30);
  });

  test('a real JPEG is accepted', async () => {
    const buffer = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#00ff00' } }).jpeg().toBuffer();
    const result = await validateImage(buffer);
    assert.equal(result.type, 'image');
    assert.equal(result.mimeType, 'image/jpeg');
  });

  test('a non-image buffer relabeled as an image is rejected on real content, not the claimed type', async () => {
    const result = await validateImage(Buffer.from('this is not an image, just text pretending to be one'));
    assert.equal(result.error.code, 'INVALID_MEDIA_TYPE');
  });

  test('an oversized image is rejected with MEDIA_TOO_LARGE before ever attempting to decode it', async () => {
    const oversized = Buffer.alloc(MAX_IMAGE_BYTES + 1);
    const result = await validateImage(oversized);
    assert.equal(result.error.code, 'MEDIA_TOO_LARGE');
  });

  test('a GIF (not in the allow-list) is rejected even though sharp can decode it', async () => {
    const buffer = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#0000ff' } }).gif().toBuffer();
    const result = await validateImage(buffer);
    assert.equal(result.error.code, 'INVALID_MEDIA_TYPE');
  });
});

describe('mediaValidationService.validateVideo', () => {
  test('a real MP4 file signature is accepted, with honestly-null dimensions (no video decoder in this stack)', async () => {
    const result = await validateVideo(fakeMp4Buffer());
    assert.equal(result.type, 'video');
    assert.equal(result.mimeType, 'video/mp4');
    assert.equal(result.width, null);
    assert.equal(result.height, null);
  });

  test('a buffer without the real MP4 "ftyp" signature is rejected even if small enough and named .mp4', async () => {
    const result = await validateVideo(Buffer.from('not actually an mp4 container'));
    assert.equal(result.error.code, 'INVALID_MEDIA_TYPE');
  });

  test('an oversized video is rejected with MEDIA_TOO_LARGE', async () => {
    const oversized = fakeMp4Buffer(MAX_VIDEO_BYTES + 1);
    const result = await validateVideo(oversized);
    assert.equal(result.error.code, 'MEDIA_TOO_LARGE');
  });
});
