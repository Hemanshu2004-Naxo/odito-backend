import fs from 'fs/promises';
import path from 'path';
import zlib from 'zlib';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import SocialBusinessProfile from '../model/SocialBusinessProfile.js';
import { registerCustomFamily } from './aiDesign/compose/designFonts.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * BRAND FONTS: a brand's own heading / body font files (regular + bold), uploaded in the Brand Kit and used by the design renderer.
 *
 *   - Accepted: .ttf, .otf, .woff2, at most MAX_FONT_BYTES. The BYTES decide, not the name: the file must carry the TrueType / OpenType /
 *     WOFF2 signature, and its family name is read from the font's own name table.
 *   - Every upload is TEST-RENDERED with the server's text renderer; a font the renderer cannot draw (e.g. a WOFF2 this server's renderer
 *     cannot read) is refused with a clear message instead of silently falling back.
 *   - Files live in PRIVATE storage (private_storage/brand_fonts/<project>/), never under the public /storage path: font licences rarely
 *     allow public hosting. Only Odito's renderer reads them.
 *   - Additive: brand.fonts.{heading|body}.{regular|bold} on the Business Profile; the font NAME fields are unchanged except that an upload
 *     sets the role's name to the uploaded family (so it is the font the brand uses).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
export const PRIVATE_FONT_ROOT = path.resolve(here, '../../../../private_storage/brand_fonts');
export const MAX_FONT_BYTES = 5 * 1024 * 1024;
export const FONT_ROLES = Object.freeze(['heading', 'body']);
export const FONT_WEIGHTS = Object.freeze({ regular: 400, bold: 700 });
const EXT = Object.freeze({ ttf: '.ttf', otf: '.otf', woff2: '.woff2' });
const fail = (code, message, status = 400) => ({ success: false, error: { code, message, status } });

/** The font format from its signature: 'ttf' | 'otf' | 'woff2' | null (WOFF1 and collections are not accepted). */
export function sniffFontFormat(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  const tag = buf.toString('latin1', 0, 4);
  if (buf.readUInt32BE(0) === 0x00010000 || tag === 'true') return 'ttf';
  if (tag === 'OTTO') return 'otf';
  if (tag === 'wOF2') return 'woff2';
  return null;
}

/** The family name in an sfnt `name` table (typographic family 16 first, then family 1; Windows Unicode first, then Mac Roman). */
function familyFromNameTable(table) {
  if (!table || table.length < 6) return null;
  const count = table.readUInt16BE(2);
  const strings = table.readUInt16BE(4);
  const found = {};
  for (let i = 0; i < count; i += 1) {
    const o = 6 + i * 12;
    if (o + 12 > table.length) break;
    const platform = table.readUInt16BE(o); const nameId = table.readUInt16BE(o + 6); const len = table.readUInt16BE(o + 8); const off = table.readUInt16BE(o + 10);
    if (![1, 16].includes(nameId)) continue;
    const start = strings + off;
    if (start + len > table.length) continue;
    const raw = table.subarray(start, start + len);
    let text = null;
    if (platform === 3 || platform === 0) { const s = Buffer.from(raw); s.swap16(); text = s.toString('utf16le'); } else if (platform === 1) text = raw.toString('latin1');
    if (text && text.trim()) found[`${nameId}:${platform === 1 ? 'mac' : 'win'}`] = text.replace(/\0/g, '').trim();
  }
  return found['16:win'] || found['1:win'] || found['16:mac'] || found['1:mac'] || null;
}

function sfntTable(buf, tag) {
  const n = buf.readUInt16BE(4);
  for (let i = 0; i < n; i += 1) {
    const o = 12 + i * 16;
    if (o + 16 > buf.length) return null;
    if (buf.toString('latin1', o, o + 4) === tag) {
      const off = buf.readUInt32BE(o + 8); const len = buf.readUInt32BE(o + 12);
      return off + len <= buf.length ? buf.subarray(off, off + len) : null;
    }
  }
  return null;
}

const WOFF2_TAGS = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill'];

/** The `name` table of a WOFF2 (its tables are one brotli stream after the table directory; `name` is never transformed). */
function woff2NameTable(buf) {
  const numTables = buf.readUInt16BE(12);
  const compressedLength = buf.readUInt32BE(20);
  let p = 48;
  const readBase128 = () => { let v = 0; for (let i = 0; i < 5; i += 1) { const b = buf[p]; p += 1; v = (v << 7) | (b & 0x7f); if (!(b & 0x80)) return v >>> 0; } return null; };
  const entries = [];
  for (let i = 0; i < numTables; i += 1) {
    const flags = buf[p]; p += 1;
    const tag = (flags & 0x3f) === 63 ? buf.toString('latin1', p, (p += 4)) : WOFF2_TAGS[flags & 0x3f];
    const transform = (flags >> 6) & 0x03;
    const origLength = readBase128();
    const transformed = (tag === 'glyf' || tag === 'loca') ? transform === 0 : transform !== 0;
    const length = transformed ? readBase128() : origLength;
    entries.push({ tag, length });
  }
  const data = zlib.brotliDecompressSync(buf.subarray(p, p + compressedLength));
  let off = 0;
  for (const e of entries) {
    if (e.tag === 'name') return data.subarray(off, off + e.length);
    off += e.length;
  }
  return null;
}

/** The font's own family name, or null. */
export function fontFamilyName(buf, format) {
  try {
    if (format === 'woff2') return familyFromNameTable(woff2NameTable(buf));
    return familyFromNameTable(sfntTable(buf, 'name'));
  } catch { return null; }
}

const PROBE = path.join(here, 'brandFontProbe.mjs');

/**
 * Can the server's renderer DRAW this font file? A FRESH process measures the renderer's fallback width first, then draws the sample with
 * the file (brandFontProbe.mjs): the same width means the file was not used. (In this long-running process the fallback is whatever font
 * was loaded last, so the comparison would not be reliable here.)
 */
export function rendersWith(filePath, family, weight) {
  const weightName = weight >= 700 ? 'Bold' : 'Regular';
  return new Promise((resolve) => {
    execFile(process.execPath, [PROBE, filePath, family, weightName], { timeout: 20_000, cwd: path.resolve(here, '../../../..') }, (error, stdout) => {
      if (error) return resolve(false);
      try {
        const r = JSON.parse(String(stdout || '{}'));
        return resolve(!r.error && r.own > 0 && Math.abs(r.own - r.fallback) > 2);
      } catch { return resolve(false); }
    });
  });
}

const roleKey = (projectId, role) => `brand:${projectId}:${role}`;

/** Registers the project's uploaded fonts with the renderer; returns { heading, body } renderer keys (null where none). */
export async function registerProjectFonts(projectId, fonts) {
  const out = { heading: null, body: null };
  for (const role of FONT_ROLES) {
    const r = fonts?.[role];
    if (!r?.regular?.storageKey && !r?.bold?.storageKey) continue;
    const files = {};
    for (const [w, num] of Object.entries(FONT_WEIGHTS)) {
      const f = r[w];
      if (!f?.storageKey) continue;
      const abs = path.join(PRIVATE_FONT_ROOT, f.storageKey);
      try { await fs.access(abs); files[num] = abs; } catch { /* a missing file is simply not used */ }
    }
    if (!Object.keys(files).length) continue;
    const family = r.regular?.family || r.bold?.family;
    registerCustomFamily(roleKey(projectId, role), { family, files });
    out[role] = roleKey(projectId, role);
  }
  return out;
}

/** The API view of the uploaded fonts (never a storage key or path). */
export function toPublicFonts(fonts) {
  const one = (f) => (f?.storageKey ? { family: f.family, format: f.format, size: f.size, uploadedAt: f.uploadedAt ? new Date(f.uploadedAt).toISOString() : null } : null);
  return Object.fromEntries(FONT_ROLES.map((role) => [role, { regular: one(fonts?.[role]?.regular), bold: one(fonts?.[role]?.bold) }]));
}

/**
 * Stores and records one font file. input: { projectId, userId, role, weight, buffer, originalName }.
 * Returns { success, fonts } or { success: false, error }.
 */
export async function uploadBrandFont({ projectId, userId, role, weight, buffer }) {
  if (!mongoose.Types.ObjectId.isValid(String(projectId))) return fail('NOT_FOUND', 'Project not found.', 404);
  if (!FONT_ROLES.includes(role)) return fail('INVALID_FONT_ROLE', 'role must be heading or body.');
  if (!FONT_WEIGHTS[weight]) return fail('INVALID_FONT_WEIGHT', 'weight must be regular or bold.');
  if (!Buffer.isBuffer(buffer) || buffer.length < 1024) return fail('INVALID_FONT', 'That file is not a font.');
  if (buffer.length > MAX_FONT_BYTES) return fail('FONT_TOO_LARGE', `Font files must be ${MAX_FONT_BYTES / 1024 / 1024} MB or smaller.`, 413);
  const format = sniffFontFormat(buffer);
  if (!format) return fail('INVALID_FONT', 'Upload a TTF, OTF or WOFF2 font file.');
  const family = fontFamilyName(buffer, format);
  if (!family || family.length > 80) return fail('INVALID_FONT', 'The font\'s family name could not be read from the file.');

  const dir = path.join(PRIVATE_FONT_ROOT, String(projectId));
  await fs.mkdir(dir, { recursive: true });
  const filename = `${crypto.randomUUID()}${EXT[format]}`;
  const abs = path.join(dir, filename);
  await fs.writeFile(abs, buffer);
  if (!(await rendersWith(abs, family, FONT_WEIGHTS[weight]))) {
    await fs.rm(abs, { force: true });
    return fail('FONT_NOT_RENDERABLE', format === 'woff2'
      ? 'This WOFF2 font cannot be drawn by Odito\'s design renderer on this server. Upload the TTF or OTF version of the font instead.'
      : 'Odito\'s design renderer could not draw text with this font file. Check the file, or upload another format.', 422);
  }

  const storageKey = `${projectId}/${filename}`;
  const previous = await SocialBusinessProfile.findOne({ project_id: projectId }).select(`brand.fonts.${role}.${weight}.storageKey`).lean();
  const nameField = role === 'heading' ? 'brand.fontHeading' : 'brand.fontBody';
  const doc = await SocialBusinessProfile.findOneAndUpdate(
    { project_id: projectId },
    { $set: { [`brand.fonts.${role}.${weight}`]: { storageKey, family, format, size: buffer.length, uploadedAt: new Date() }, [nameField]: family, updatedBy: userId || null }, $setOnInsert: { createdBy: userId || null } },
    { new: true, upsert: true },
  ).lean();
  const old = previous?.brand?.fonts?.[role]?.[weight]?.storageKey;
  if (old && old !== storageKey) await fs.rm(path.join(PRIVATE_FONT_ROOT, old), { force: true });
  LoggerUtil.info('[SOCIAL_BRAND_FONT] uploaded', { event: 'brand_font_uploaded', projectId: String(projectId), role, weight, format, size: buffer.length });
  return { success: true, fonts: toPublicFonts(doc.brand?.fonts) };
}

/** Removes one uploaded font file (the font NAME stays; without a file it falls back as before and is flagged). */
export async function deleteBrandFont({ projectId, userId, role, weight }) {
  if (!FONT_ROLES.includes(role) || !FONT_WEIGHTS[weight]) return fail('INVALID_FONT_ROLE', 'role must be heading or body, weight regular or bold.');
  const previous = await SocialBusinessProfile.findOne({ project_id: projectId }).select('brand.fonts').lean();
  const old = previous?.brand?.fonts?.[role]?.[weight]?.storageKey;
  const doc = await SocialBusinessProfile.findOneAndUpdate({ project_id: projectId }, { $set: { [`brand.fonts.${role}.${weight}`]: { storageKey: null, family: null, format: null, size: null, uploadedAt: null }, updatedBy: userId || null } }, { new: true }).lean();
  if (old) await fs.rm(path.join(PRIVATE_FONT_ROOT, old), { force: true });
  return { success: true, fonts: toPublicFonts(doc?.brand?.fonts) };
}

export default { uploadBrandFont, deleteBrandFont, registerProjectFonts, toPublicFonts, sniffFontFormat, fontFamilyName, rendersWith };
