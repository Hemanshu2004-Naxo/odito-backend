import sharp from 'sharp';
import { luminance, mix, darken } from './designPalette.js';
import { uniformSize, fitText } from './designPrimitives.js';

/**
 * Shared building blocks of the layout templates: orientation classes, emphasis runs for headlines, rounded-corner paths,
 * the real-logo placement rule, and the contact / CTA blocks. Layouts only ever draw what the brief supplies; nothing here
 * has any wording of its own except the two structural labels a layout names itself ("OUR SERVICES", "INTRODUCING").
 */

/** wide (feed landscape), square, tall (4:5 portrait, 9:16 story). */
export function orientationOf(width, height) {
  const aspect = width / height;
  if (aspect >= 1.25) return 'wide';
  if (aspect <= 0.9) return 'tall';
  return 'square';
}

/** A path for a rectangle with an individual radius on each corner. */
export function cornerPath(x, y, w, h, { tl = 0, tr = 0, br = 0, bl = 0 } = {}) {
  return `M${x + tl} ${y}H${x + w - tr}${tr ? `A${tr} ${tr} 0 0 1 ${x + w} ${y + tr}` : ''}V${y + h - br}${br ? `A${br} ${br} 0 0 1 ${x + w - br} ${y + h}` : ''}H${x + bl}${bl ? `A${bl} ${bl} 0 0 1 ${x} ${y + h - bl}` : ''}V${y + tl}${tl ? `A${tl} ${tl} 0 0 1 ${x + tl} ${y}` : ''}Z`;
}

/**
 * Headline split into [lead, emphasis]: the last words take the accent colour (a designer's emphasis), never more than ~40% of
 * the text and only when the headline has at least three words. The text itself is untouched.
 */
export function emphasisRuns(text, lead, accent) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (words.length < 3) return [{ text: words.join(' '), color: lead }];
  const take = words.length >= 7 ? 3 : words.length >= 4 ? 2 : 1;
  return [{ text: `${words.slice(0, -take).join(' ')} `, color: lead }, { text: words.slice(-take).join(' '), color: accent }];
}

/** Average luminance (0..1) of the opaque pixels of a logo PNG: decides whether it needs a plate to be seen. */
export async function logoLuminance(png) {
  try {
    const { data, info } = await sharp(png).resize({ width: 64, height: 64, fit: 'inside' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let sum = 0; let n = 0; let transparent = 0;
    for (let i = 0; i < data.length; i += info.channels) {
      if (data[i + 3] > 128) { sum += luminance(`#${[data[i], data[i + 1], data[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`); n += 1; } else transparent += 1;
    }
    return { lum: n ? sum / n : 0.5, transparentShare: transparent / (data.length / info.channels) };
  } catch {
    return { lum: 0.5, transparentShare: 0 };
  }
}

/**
 * Places the real logo. On a light surface a normal logo needs nothing; on a dark surface (or a logo that is itself light) it
 * sits on a white rounded plate, so it is always legible and never recoloured, stretched or enlarged.
 * `surface` is the colour behind the logo.
 */
export async function placeLogo(scene, ctx, { x, y, maxW, maxH, surface, align = 'left' }) {
  if (!ctx.logo) return null;
  const stats = ctx.logoStats || (ctx.logoStats = await logoLuminance(ctx.logo));
  const surfaceLum = luminance(surface);
  const needsPlate = Math.abs(surfaceLum - stats.lum) < 0.45 && (stats.transparentShare > 0.05 || surfaceLum < 0.6);
  const darkSurface = surfaceLum < 0.35;
  const plate = needsPlate || darkSurface
    ? { fill: stats.lum > 0.75 && !darkSurface ? ctx.pal.deep : '#ffffff', pad: Math.round(Math.min(maxW, maxH) * 0.14), radius: Math.round(maxH * 0.22), opacity: 0.97 }
    : null;
  const rect = await scene.logo(ctx.logo, { x, y, maxW, maxH, plate, align });
  ctx.logoPlaced = true;
  return rect;
}

/**
 * The contact block (real phone / website / email only). Returns the rect used. Each line: a small icon, then one line of text.
 * `lines` = [{ icon, text }] already filtered to what exists.
 */
export async function contactLines(scene, ctx, lines, { x, y, maxW, size, color, iconColor = color, gap = 0.9, align = 'left' }) {
  let cy = y;
  let widest = 0;
  const lineSize = await uniformSize(lines.map((l) => l.text), { family: ctx.fonts.body, weight: 600, maxWidth: maxW - size * 1.15 * 1.5, maxSize: size, minSize: Math.max(11, size * 0.6) });
  for (const item of lines) {
    const iconSize = size * 1.15;
    // eslint-disable-next-line no-await-in-loop
    const t = await scene.line(item.text, { x: x + iconSize * 1.5, y: cy, maxW: maxW - iconSize * 1.5, family: ctx.fonts.body, weight: 600, maxSize: lineSize, minSize: lineSize, color, label: `contact:${item.icon}` });
    scene.icon(item.icon, { x, y: cy + (t.h - iconSize) / 2, size: iconSize, color: iconColor, strokeW: 2.2 });
    cy += t.h + size * gap;
    widest = Math.max(widest, t.w + iconSize * 1.5);
  }
  void align;
  return { x, y, w: widest, h: cy - y };
}

/** The contact lines a brief supplies, in display order. */
export function contactItems(brief) {
  const c = brief.contact || {};
  const items = [];
  if (c.phone) items.push({ icon: 'phone', text: c.phone });
  if (c.website) items.push({ icon: 'globe', text: c.website });
  if (c.email) items.push({ icon: 'mail', text: c.email });
  return items;
}

/** A soft vertical fade (transparent to `color`) as one SVG rectangle: the legibility layer under text that sits on a photo. */
export function fadeRect(scene, { x, y, w, h, color, from = 0, to = 0.92, id }) {
  scene.svg(`<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity="${from}"/><stop offset="1" stop-color="${color}" stop-opacity="${to}"/></linearGradient></defs><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="url(#${id})"/>`);
}

/** Subtle decorative rings / dots in a corner, in the brand colours (pure geometry, no content). */
export function ringDecor(scene, { cx, cy, r, color, opacity = 0.14, width }) {
  scene.circle({ cx, cy, r, stroke: color, strokeW: width, opacity });
  scene.circle({ cx, cy, r: r * 0.62, stroke: color, strokeW: width, opacity: opacity * 0.8 });
}

export const tint = (color, amount) => mix(color, '#ffffff', amount);

/**
 * The page colours of a layout for the requested tone. Each layout has a NATURAL tone (light pages for the service / photo /
 * infographic / product layouts, dark for the insight, statement and announcement layouts); an explicit "darker" / "lighter"
 * request from the person (brief.tone) flips it. Panels and accents keep the brand colours either way.
 */
export function themeOf(ctx, naturalDark) {
  const { pal, brief } = ctx;
  const dark = brief.tone === 'dark' ? true : brief.tone === 'light' ? false : naturalDark;
  ctx.theme = dark
    ? { dark, page: darken(pal.deep, 0.5), soft: darken(pal.deep, 0.5), lead: '#ffffff', text: '#ffffff', sub: '#e5e7eb', ink: '#e5e7eb', surface: pal.deep }
    : { dark, page: pal.paper, soft: pal.soft, lead: pal.deep, text: pal.deep, sub: pal.ink, ink: pal.ink, surface: pal.deep };
  return ctx.theme;
}

/**
 * The headline, honouring a size request (brief.headlineScale): "larger" lets the text grow to scale x the size it would have had,
 * "smaller" shrinks it - as far as its box allows. When the box cannot take a larger headline the size is simply unchanged and the
 * composition says so (note `headline_scale_limited`), instead of pretending the request was applied.
 */
export async function headlineBlock(scene, ctx, opts) {
  const { brief } = ctx;
  const scale = brief.headlineScale && brief.headlineScale !== 1 ? brief.headlineScale : 1;
  const text = opts.text ?? brief.headline;
  if (scale === 1) return scene.text(text, { ...opts, label: 'headline' });
  const base = await fitText({ text, runs: opts.runs, family: opts.family, weight: opts.weight, width: opts.w, maxHeight: opts.maxH, maxSize: opts.maxSize, minSize: opts.minSize, align: opts.align, color: opts.color, lineGapRatio: opts.lineGapRatio });
  const target = base.size * scale;
  const placed = await scene.text(text, { ...opts, maxSize: Math.max(opts.minSize ?? 12, scale > 1 ? target : target), minSize: Math.min(opts.minSize ?? 12, target), label: 'headline' });
  const changed = scale > 1 ? placed.size >= base.size * 1.04 : placed.size <= base.size * 0.96;
  if (!changed) ctx.notes.add('headline_scale_limited');
  return placed;
}
