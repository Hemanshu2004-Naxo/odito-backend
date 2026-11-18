import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import sharp from 'sharp';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SeoProject from '../../app_user/model/SeoProject.js';
import SocialBusinessProfile from '../model/SocialBusinessProfile.js';
import { uploadBrandFont, deleteBrandFont, sniffFontFormat, fontFamilyName, registerProjectFonts, toPublicFonts, PRIVATE_FONT_ROOT } from './brandFontService.js';
import { FONT_DIR } from './aiDesign/compose/designFonts.js';
import { composeConcept } from './aiDesign/concept/conceptLayouts.js';
import { CONCEPT_SIZES } from './aiDesign/designConfig.js';
import { getEditableProfile } from './socialBusinessProfileService.js';

/**
 * BRAND FONTS (Brand Kit upload) on real MongoDB and real files: the bytes decide the format, the family name is read from the font, every
 * upload is test-rendered by the design renderer, files live in PRIVATE storage (never under the public /storage path), the API never shows
 * a storage key, and the concept designs draw with the uploaded font.
 */
const DM_REGULAR = fs.readFileSync(path.join(FONT_DIR, 'DM_Sans/DMSans-Regular.ttf'));
const DM_BOLD = fs.readFileSync(path.join(FONT_DIR, 'DM_Sans/DMSans-Bold.ttf'));

/** A spec-valid WOFF2 (null transforms) of a TTF, built with Node's brotli - for the WOFF2 parser and the renderability guard. */
function ttfToWoff2(ttf) {
  const n = ttf.readUInt16BE(4);
  const tables = Array.from({ length: n }, (_, i) => { const o = 12 + i * 16; return { tag: ttf.toString('latin1', o, o + 4), off: ttf.readUInt32BE(o + 8), len: ttf.readUInt32BE(o + 12) }; });
  const base128 = (v) => { const out = []; do { out.unshift(v & 0x7f); v >>>= 7; } while (v); return Buffer.from(out.map((b, i) => (i < out.length - 1 ? b | 0x80 : b))); };
  const dir = Buffer.concat(tables.flatMap((t) => [Buffer.from([0x3f | ((t.tag === 'glyf' || t.tag === 'loca' ? 3 : 0) << 6)]), Buffer.from(t.tag, 'latin1'), base128(t.len)]));
  const comp = zlib.brotliCompressSync(Buffer.concat(tables.map((t) => ttf.subarray(t.off, t.off + t.len))));
  const header = Buffer.alloc(48);
  header.write('wOF2', 0, 'latin1'); header.writeUInt32BE(ttf.readUInt32BE(0), 4); header.writeUInt32BE(48 + dir.length + comp.length, 8);
  header.writeUInt16BE(n, 12); header.writeUInt32BE(ttf.length, 16); header.writeUInt32BE(comp.length, 20);
  return Buffer.concat([header, dir, comp]);
}

let mongoAvailable = false;
before(async () => { try { await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 }); mongoAvailable = true; } catch { mongoAvailable = false; } });
after(async () => { if (mongoAvailable) await mongoose.connection.close(); });

describe('brand font files: format, family name', () => {
  test('1: the bytes decide the format (TTF / OTF / WOFF2), and the family name comes from the font itself', () => {
    assert.equal(sniffFontFormat(DM_BOLD), 'ttf');
    assert.equal(fontFamilyName(DM_BOLD, 'ttf'), 'DM Sans');
    const woff2 = ttfToWoff2(DM_BOLD);
    assert.equal(sniffFontFormat(woff2), 'woff2');
    assert.equal(fontFamilyName(woff2, 'woff2'), 'DM Sans');
    assert.equal(sniffFontFormat(Buffer.from('PK\u0003\u0004 this is a zip pretending to be a font')), null);
    const otf = Buffer.concat([Buffer.from('OTTO', 'latin1'), Buffer.alloc(20)]);
    assert.equal(sniffFontFormat(otf), 'otf');
  });
});

describe('brand font upload (real MongoDB, real files)', () => {
  let userId; let project; let pid;
  beforeEach(async () => {
    if (!mongoAvailable) return;
    userId = new mongoose.Types.ObjectId();
    project = await SeoProject.create({ user_id: userId, project_name: `Fonts ${Date.now()} ${Math.random().toString(36).slice(2, 7)}`, main_url: 'https://example.com', seo_scope: 'local', keywords: ['k'], description: 'Agency' });
    pid = String(project._id);
  });
  afterEach(async () => {
    if (!mongoAvailable) return;
    await SocialBusinessProfile.deleteMany({ project_id: project._id });
    await SeoProject.deleteOne({ _id: project._id });
    fs.rmSync(path.join(PRIVATE_FONT_ROOT, pid), { recursive: true, force: true });
  });

  test('2: a TTF is validated, test-rendered, stored PRIVATELY, recorded (family, format, size) and becomes the brand\'s heading font', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const r = await uploadBrandFont({ projectId: pid, userId, role: 'heading', weight: 'bold', buffer: DM_BOLD });
    assert.equal(r.success, true, JSON.stringify(r));
    assert.deepEqual(r.fonts.heading.bold, { family: 'DM Sans', format: 'ttf', size: DM_BOLD.length, uploadedAt: r.fonts.heading.bold.uploadedAt });
    const doc = await SocialBusinessProfile.findOne({ project_id: project._id }).lean();
    assert.equal(doc.brand.fontHeading, 'DM Sans');
    const abs = path.join(PRIVATE_FONT_ROOT, doc.brand.fonts.heading.bold.storageKey);
    assert.ok(fs.existsSync(abs));
    assert.ok(!abs.includes(`${path.sep}storage${path.sep}`), 'never under the public /storage path');
    const editable = await getEditableProfile(pid);
    assert.equal(JSON.stringify(editable).includes('storageKey'), false, 'the API never shows where the file is');
    assert.equal(editable.brand.fonts.heading.bold.family, 'DM Sans');
  });

  test('3: not a font, a bad role / weight, or too big is refused; nothing is stored', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#123456' } }).png().toBuffer();
    assert.equal((await uploadBrandFont({ projectId: pid, userId, role: 'heading', weight: 'regular', buffer: Buffer.concat([png, Buffer.alloc(2048)]) })).error.code, 'INVALID_FONT');
    assert.equal((await uploadBrandFont({ projectId: pid, userId, role: 'title', weight: 'regular', buffer: DM_REGULAR })).error.code, 'INVALID_FONT_ROLE');
    assert.equal((await uploadBrandFont({ projectId: pid, userId, role: 'body', weight: 'italic', buffer: DM_REGULAR })).error.code, 'INVALID_FONT_WEIGHT');
    assert.equal((await uploadBrandFont({ projectId: pid, userId, role: 'body', weight: 'regular', buffer: Buffer.concat([DM_REGULAR, Buffer.alloc(6 * 1024 * 1024)]) })).error.code, 'FONT_TOO_LARGE');
    assert.equal(fs.existsSync(path.join(PRIVATE_FONT_ROOT, pid)) ? fs.readdirSync(path.join(PRIVATE_FONT_ROOT, pid)).length : 0, 0);
  });

  test('4: a WOFF2 is either drawn by this server\'s renderer or refused with the reason (never silently used in a fallback font)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const r = await uploadBrandFont({ projectId: pid, userId, role: 'body', weight: 'regular', buffer: ttfToWoff2(DM_REGULAR) });
    if (r.success) assert.equal(r.fonts.body.regular.format, 'woff2');
    else {
      assert.equal(r.error.code, 'FONT_NOT_RENDERABLE');
      assert.match(r.error.message, /TTF or OTF/);
      assert.equal(fs.existsSync(path.join(PRIVATE_FONT_ROOT, pid)) ? fs.readdirSync(path.join(PRIVATE_FONT_ROOT, pid)).length : 0, 0, 'the refused file is not kept');
    }
  });

  test('5: the concept designs DRAW with the uploaded font; removing it removes the file and falls back', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await uploadBrandFont({ projectId: pid, userId, role: 'heading', weight: 'bold', buffer: DM_BOLD });
    const doc = await SocialBusinessProfile.findOne({ project_id: project._id }).lean();
    const keys = await registerProjectFonts(pid, doc.brand.fonts);
    assert.equal(keys.heading, `brand:${pid}:heading`);
    const brand = { name: 'Sapphire Digital Agency', primary: '#073B73', headingFont: 'DM Sans', bodyFont: 'Open Sans', customFonts: keys };
    const image = await sharp({ create: { width: 1088, height: 1360, channels: 3, background: '#203040' } }).png().toBuffer();
    const brief = { layout: 'full_bleed_bottom', hook_headline: 'Your agency is out of room', subline: '', cta: '', visual_style: 'photo' };
    const withFont = await composeConcept({ brief, image, size: CONCEPT_SIZES.portrait, brand });
    assert.equal(withFont.report.fonts.headingUploaded, true);
    const without = await composeConcept({ brief, image, size: CONCEPT_SIZES.portrait, brand: { ...brand, headingFont: 'Some Unshipped Font', customFonts: null } });
    assert.equal(without.report.fonts.headingUploaded, false);
    assert.ok(without.report.notes.includes('brand_font_unavailable'), 'a named font that is neither shipped nor uploaded is flagged');
    const stored = path.join(PRIVATE_FONT_ROOT, doc.brand.fonts.heading.bold.storageKey);
    const del = await deleteBrandFont({ projectId: pid, userId, role: 'heading', weight: 'bold' });
    assert.equal(del.success, true);
    assert.equal(del.fonts.heading.bold, null);
    assert.equal(fs.existsSync(stored), false);
    assert.deepEqual(toPublicFonts(null), { heading: { regular: null, bold: null }, body: { regular: null, bold: null } });
  });
});
