import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import sharp from 'sharp';

import { prepareReferenceImage, prepareLogo, compositeLogo, processAndStoreDesign } from './designMedia.js';
import { LOGO_MAX_WIDTH_RATIO, LOGO_MARGIN_RATIO } from './designConfig.js';
import mediaStorageService from '../media/mediaStorageService.js';
import { removeProjectMedia } from '../../testSupport/designFixtures.js';
import { promises as fs } from 'fs';
import path from 'path';

/** Real sharp, real files: the REAL logo is composited (never drawn by the model) and real photos are prepared for the provider. */

/** Mean colour of a region (sharp's stats() ignores extract(), so the region is cut out first). */
const regionMean = async (image, region) => (await sharp(await sharp(image).extract(region).png().toBuffer()).stats()).channels.map((c) => c.mean);
const solid = (width, height, color, format = 'png') => sharp({ create: { width, height, channels: 3, background: color } })[format]().toBuffer();
const logoPng = (width, height, color) => sharp({ create: { width, height, channels: 4, background: color } }).png().toBuffer();

/** Bounding box of the pixels that differ between two same-size RGBA images. */
async function diffBox(a, b) {
  const [ra, rb] = await Promise.all([sharp(a).ensureAlpha().raw().toBuffer({ resolveWithObject: true }), sharp(b).ensureAlpha().raw().toBuffer({ resolveWithObject: true })]);
  const { width, height } = ra.info;
  let minX = width; let minY = height; let maxX = -1; let maxY = -1;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const i = (y * width + x) * 4;
    if (ra.data[i] !== rb.data[i] || ra.data[i + 1] !== rb.data[i + 1] || ra.data[i + 2] !== rb.data[i + 2]) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  }
  return maxX < 0 ? null : { left: minX, top: minY, right: maxX, bottom: maxY, width: maxX - minX + 1, height: maxY - minY + 1, imageWidth: width, imageHeight: height };
}

describe('reference photos and the logo are prepared before use', () => {
  test('1: a real product photo is decoded, bounded to 1536px, re-encoded as JPEG and stripped of metadata', async () => {
    const big = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#cc8844' } }).withExif({ IFD0: { Copyright: 'SECRET-EXIF-MARKER' } }).jpeg().toBuffer();
    assert.ok((await sharp(big).metadata()).exif, 'the fixture really carries EXIF');
    const out = await prepareReferenceImage(big);
    assert.equal(out.mimeType, 'image/jpeg');
    const meta = await sharp(out.buffer).metadata();
    assert.equal(meta.format, 'jpeg');
    assert.deepEqual([meta.width, meta.height], [1536, 1024]);
    assert.equal(meta.exif, undefined);
    assert.equal(out.buffer.includes(Buffer.from('SECRET-EXIF-MARKER')), false);
  });

  test('2: a small photo is not enlarged; a PNG with transparency is flattened onto white', async () => {
    const small = await prepareReferenceImage(await solid(400, 300, '#336699'));
    assert.deepEqual([(await sharp(small.buffer).metadata()).width, (await sharp(small.buffer).metadata()).height], [400, 300]);
    const transparent = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    const flat = await prepareReferenceImage(transparent);
    const px = await sharp(flat.buffer).raw().toBuffer();
    assert.ok(px[0] > 240 && px[1] > 240 && px[2] > 240, 'transparent pixels became white');
  });

  test('3: anything that is not a plain raster photo is refused (SVG with scripts, GIF, PDF, text, empty, garbage)', async () => {
    const gif = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#fff' } }).gif().toBuffer();
    for (const bad of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><script>alert(1)</script></svg>'), gif, Buffer.from('%PDF-1.4'), Buffer.from('text'), Buffer.alloc(0), crypto.randomBytes(512)]) {
      assert.equal(await prepareReferenceImage(bad), null);
      assert.equal(await prepareLogo(bad), null);
    }
  });

  test('4: the logo is kept as a bounded PNG with its transparency; a huge logo is scaled down', async () => {
    const logo = await prepareLogo(await logoPng(2400, 1200, { r: 10, g: 20, b: 200, alpha: 0.5 }));
    const meta = await sharp(logo).metadata();
    assert.equal(meta.format, 'png');
    assert.equal(meta.hasAlpha, true);
    assert.deepEqual([meta.width, meta.height], [600, 300]);
  });
});

describe('compositeLogo — the real logo, placed subtly', () => {
  test('5: bottom-right, scaled by the picture, aspect ratio untouched, margin from the edge, rest of the picture unchanged', async () => {
    const base = await solid(1024, 1024, '#ffffff');
    const logo = await prepareLogo(await logoPng(400, 200, '#101820')); // high contrast on white: no chip
    const { buffer, applied } = await compositeLogo(base, logo);
    assert.equal(applied, true);
    const box = await diffBox(base, buffer);
    const maxWidth = Math.round(1024 * LOGO_MAX_WIDTH_RATIO);
    assert.ok(box.width <= maxWidth, `logo width ${box.width} <= ${maxWidth}`);
    assert.ok(Math.abs(box.width / box.height - 2) < 0.05, `aspect ratio kept (${box.width}x${box.height})`);
    const margin = Math.round(1024 * LOGO_MARGIN_RATIO);
    assert.equal(box.right, 1024 - margin - 1);
    assert.equal(box.bottom, 1024 - margin - 1);
    assert.ok(box.left > 1024 * 0.7 && box.top > 1024 * 0.8, 'in the bottom-right corner only');
  });

  test('6: a logo is never enlarged beyond its own pixels', async () => {
    const base = await solid(1024, 1024, '#ffffff');
    const { buffer } = await compositeLogo(base, await prepareLogo(await logoPng(40, 20, '#101820')));
    const box = await diffBox(base, buffer);
    assert.deepEqual([box.width, box.height], [40, 20]);
  });

  test('7: a logo that would vanish into the background gets a small contrast chip; one that stands out does not', async () => {
    const dark = await solid(1024, 1024, '#1b1b1b');
    const darkLogo = await prepareLogo(await logoPng(300, 150, '#101010'));
    const chipped = await compositeLogo(dark, darkLogo);
    const chipBox = await diffBox(dark, chipped.buffer);
    assert.ok(chipBox.width > 143 || chipBox.height > 72, 'the chip extends beyond the logo itself');
    const [chipRed] = await regionMean(chipped.buffer, { left: chipBox.left + 5, top: chipBox.top + Math.round(chipBox.height / 2), width: 2, height: 2 });
    assert.ok(chipRed > 200, 'the chip behind a dark logo is light');

    const light = await solid(1024, 1024, '#f5f5f5');
    const lightLogo = await prepareLogo(await logoPng(300, 150, '#f0f0f0'));
    const chipLight = await compositeLogo(light, lightLogo);
    const lightBox = await diffBox(light, chipLight.buffer);
    const [chipDarkRed] = await regionMean(chipLight.buffer, { left: lightBox.left + 5, top: lightBox.top + Math.round(lightBox.height / 2), width: 2, height: 2 });
    assert.ok(chipDarkRed < 60, 'the chip behind a light logo is dark');

    const white = await solid(1024, 1024, '#ffffff');
    const standout = await compositeLogo(white, await prepareLogo(await logoPng(300, 150, '#101010')));
    const box = await diffBox(white, standout.buffer);
    assert.ok(box.width <= 143, 'no chip when the logo already contrasts');
  });

  test('7b: the contrast decision looks at the patch BEHIND the logo, not the whole picture (a light layout with a dark corner still needs a chip)', async () => {
    const base = await sharp(await solid(1024, 1024, '#ffffff')).composite([{ input: await solid(512, 1024, '#161616'), left: 512, top: 0 }]).png().toBuffer();
    const { buffer } = await compositeLogo(base, await prepareLogo(await logoPng(300, 150, '#101010')));
    const box = await diffBox(base, buffer);
    assert.ok(box.width > 143, `a chip was added behind the dark logo on the dark corner (${box.width}px wide)`);
    const lightCorner = await sharp(await solid(1024, 1024, '#161616')).composite([{ input: await solid(512, 1024, '#ffffff'), left: 512, top: 0 }]).png().toBuffer();
    const noChip = await compositeLogo(lightCorner, await prepareLogo(await logoPng(300, 150, '#101010')));
    assert.ok((await diffBox(lightCorner, noChip.buffer)).width <= 143, 'a dark logo on a light corner needs no chip, even though most of the picture is dark');
  });

  test('8: the logo is composited on the picture the model made; if it cannot be (a broken logo) the picture is returned unchanged', async () => {
    const base = await solid(1024, 1024, '#ffffff');
    const broken = await compositeLogo(base, crypto.randomBytes(256));
    assert.equal(broken.applied, false);
    assert.equal(Buffer.compare(broken.buffer, base), 0);
    const tiny = await compositeLogo(await solid(64, 64, '#ffffff'), await prepareLogo(await logoPng(200, 100, '#000000')));
    assert.equal(typeof tiny.applied, 'boolean');
  });
});

describe('processAndStoreDesign with the real logo', () => {
  const projects = [];
  const newProject = () => { const id = crypto.randomBytes(12).toString('hex'); projects.push(id); return id; };
  afterEach(async () => { for (const id of projects.splice(0)) await removeProjectMedia(id); });
  const read = async (pid, url) => fs.readFile(path.resolve(process.cwd(), 'storage', 'social_media', pid, url.split('/').pop()));

  test('9: the stored design carries the logo in its corner and is still a metadata-free JPEG; without a logo the corner is untouched', async () => {
    const pid = newProject();
    const picture = await solid(1024, 1024, '#ffffff');
    const logo = await prepareLogo(await logoPng(300, 150, '#101820'));
    const withLogo = await processAndStoreDesign({ buffer: picture, projectId: pid, platform: 'instagram', logo });
    const without = await processAndStoreDesign({ buffer: picture, projectId: pid, platform: 'instagram' });
    assert.equal(withLogo.logoApplied, true);
    assert.equal(without.logoApplied, false);
    assert.equal(mediaStorageService.isOwnedUrl(withLogo.url), true);
    const a = await read(pid, withLogo.url);
    const b = await read(pid, without.url);
    assert.equal((await sharp(a).metadata()).format, 'jpeg');
    assert.equal((await sharp(a).metadata()).exif, undefined);
    const corner = { left: 1024 - 41 - 143, top: 1024 - 41 - 72, width: 143, height: 72 };
    const [ca, cb, tl] = await Promise.all([regionMean(a, corner), regionMean(b, corner), regionMean(a, { left: 0, top: 0, width: 200, height: 200 })]);
    assert.ok(ca[0] < cb[0] - 100, 'the corner is much darker with the logo');
    assert.ok(tl[0] > 250, 'the rest of the picture is untouched');
  });

  test('10: a broken logo never breaks the design: it is stored without it', async () => {
    const pid = newProject();
    const out = await processAndStoreDesign({ buffer: await solid(800, 800, '#ffffff'), projectId: pid, platform: 'instagram', logo: crypto.randomBytes(100) });
    assert.equal(out.logoApplied, false);
    assert.match(out.url, /\.jpg$/);
  });

  test('11: stored files can be read back only by their exact key and only inside their own project (the logo / product photo source)', async () => {
    const pid = newProject();
    const other = newProject();
    const stored = await mediaStorageService.upload({ buffer: await solid(64, 64, '#123456', 'jpeg'), projectId: pid, extension: '.jpg' });
    const key = `${pid}/${stored.filename}`;
    assert.ok((await mediaStorageService.readByKey(key, { projectId: pid })).length > 0);
    assert.equal(await mediaStorageService.readByKey(key, { projectId: other }), null, 'another project cannot read it');
    for (const bad of [`${pid}/../${stored.filename}`, `../${key}`, `${pid}/notauuid.jpg`, '', null, undefined, 42, `${pid}/${stored.filename}/x`]) assert.equal(await mediaStorageService.readByKey(bad, { projectId: pid }), null, String(bad));
    assert.equal(await mediaStorageService.readByKey(key, { projectId: '' }), null);
    assert.equal(await mediaStorageService.readByKey(`${pid}/${crypto.randomUUID()}.jpg`, { projectId: pid }), null, 'a missing file is null, not an error');
  });
});
