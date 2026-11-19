import sharp from 'sharp';
import { Scene, renderText } from '../compose/designPrimitives.js';
import { buildPalette, contrast, luminance, mix, darken, toHex } from '../compose/designPalette.js';
import { resolveTypography } from '../compose/designFonts.js';
import { MIN_HEADLINE_PX_AT_1080, SINGLE_LAYOUTS, BUSY_TILE_PX, BUSY_TILE_STDEV, BUSY_FRACTION } from './conceptConfig.js';

/**
 * The single-image layouts of concept designs, drawn by Odito (never by the image model) over the generated picture: the headline,
 * subline, CTA and the brand mark, from real font files.
 *
 * TEXT IS NEVER CROPPED OR SHORTENED. Each text is drawn at the largest size that fits its box, down to its minimum (a headline never
 * below 64 px at 1080 wide). Text that does not fit at its minimum is not drawn smaller or cut: the composition fails with
 * TEXT_DOES_NOT_FIT (the pipeline then drops the optional subline, or rejects the design). Contrast meets WCAG AA (4.5:1 small text,
 * 3:1 large text) on the MEASURED pixels behind the text; a scrim (gradient) is added only when the picture alone does not reach it.
 * The brand mark (the real logo, or the brand name as a wordmark in the heading font) is always in the same spot: top-left.
 *
 * NO TEXT OVER A BUSY AREA: before a text block is drawn over the picture, the exact pixels behind it are measured; when more than
 * BUSY_FRACTION of its small tiles are detailed, the block gets a plate (a solid, rounded scrim) - whatever the average contrast says.
 * The accent rule is drawn only directly under text, with calm space around it. Image labels (what an object stands for, "Before" /
 * "After") are drawn by Odito as small chips; a two-sided comparison also gets an arrow.
 */

export const LAYOUT_NAMES = Object.freeze(Object.keys(SINGLE_LAYOUTS));

const fail = (reason, extra = {}) => Object.assign(new Error('TEXT_DOES_NOT_FIT'), { code: 'TEXT_DOES_NOT_FIT', reason, ...extra });
const INK = '#0f172a';

/** The largest size in [minSize, maxSize] at which the text fits (w x maxH), or null - never a shortened text. */
async function fitStrict({ text, family, weight, width, maxHeight, maxSize, minSize, color, align = 'left', lineGapRatio = 0.08, tracking = 0 }) {
  if (!text) return null;
  // a hyphenated word ("in-house") is never broken across two lines: a word joiner after the hyphen keeps it whole
  const drawn = String(text).replace(/(\p{L})-(\p{L})/gu, '$1-⁠$2');
  for (let size = maxSize; size >= minSize; size = Math.floor(size * 0.95) - (size > 40 ? 0 : 1)) {
    // eslint-disable-next-line no-await-in-loop
    const r = await renderText({ runs: [{ text: drawn, color }], family, weight, size, width, align, color, lineGap: size * lineGapRatio, tracking, wrap: 'word' });
    // a single word wider than the box would be broken mid-word by the wrap: that does not count as fitting
    const longest = Math.max(...text.split(/\s+/).map((w) => w.length));
    // eslint-disable-next-line no-await-in-loop
    const wordFits = longest < 14 || (await renderText({ runs: [{ text: text.split(/\s+/).sort((a, b) => b.length - a.length)[0], color }], family, weight, size, width: null, tracking })).width <= width;
    if (r.height <= maxHeight && r.width <= width + 1 && wordFits) return r;
  }
  return null;
}

/** Mean colour (and a bright-side estimate) of the picture in a region, for contrast decisions. */
async function regionTone(image, { x, y, w, h }, W, H) {
  const left = Math.max(0, Math.round(x)); const top = Math.max(0, Math.round(y));
  const width = Math.max(1, Math.min(W - left, Math.round(w))); const height = Math.max(1, Math.min(H - top, Math.round(h)));
  const stats = await sharp(image).extract({ left, top, width, height }).stats();
  const [r, g, b] = stats.channels;
  const mean = toHex({ r: r.mean, g: g.mean, b: b.mean });
  const bright = toHex({ r: Math.min(255, r.mean + 1.5 * r.stdev), g: Math.min(255, g.mean + 1.5 * g.stdev), b: Math.min(255, b.mean + 1.5 * b.stdev) });
  const dark = toHex({ r: Math.max(0, r.mean - 1.5 * r.stdev), g: Math.max(0, g.mean - 1.5 * g.stdev), b: Math.max(0, b.mean - 1.5 * b.stdev) });
  return { mean, bright, dark };
}

/** How busy the picture is in a rectangle: the share of BUSY_TILE_PX tiles whose grey-level stdev exceeds BUSY_TILE_STDEV. */
export async function busyness(image, { x, y, w, h }, W, H) {
  const left = Math.max(0, Math.round(x)); const top = Math.max(0, Math.round(y));
  const width = Math.max(1, Math.min(W - left, Math.round(w))); const height = Math.max(1, Math.min(H - top, Math.round(h)));
  const { data, info } = await sharp(image).extract({ left, top, width, height }).greyscale().raw().toBuffer({ resolveWithObject: true });
  const T = Math.min(BUSY_TILE_PX, info.width, info.height);
  let tiles = 0; let busy = 0;
  for (let ty = 0; ty + T <= info.height; ty += T) {
    for (let tx = 0; tx + T <= info.width; tx += T) {
      let s = 0; let s2 = 0;
      for (let yy = ty; yy < ty + T; yy += 1) for (let xx = tx; xx < tx + T; xx += 1) { const v = data[yy * info.width + xx]; s += v; s2 += v * v; }
      const n = T * T; const sd = Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2));
      tiles += 1; if (sd > BUSY_TILE_STDEV) busy += 1;
    }
  }
  const fraction = tiles ? busy / tiles : 0;
  return { fraction: Math.round(fraction * 100) / 100, busy: fraction > BUSY_FRACTION };
}

/**
 * Text colour + scrim for a text zone over a photo: white or ink, whichever needs less help; then the smallest scrim opacity that
 * brings the WORST realistic pixel (mean +/- one stdev) to `ratio`. Returns { color, scrim: { color, opacity } | null, contrast }.
 */
export async function legibilityFor(image, zone, W, H, { ratio = 4.5, brandDark }) {
  const tone = await regionTone(image, zone, W, H);
  const options = [
    { color: '#ffffff', worst: tone.bright, scrimColor: brandDark },
    { color: INK, worst: tone.dark, scrimColor: '#ffffff' },
  ].map((o) => {
    for (let opacity = 0; opacity <= 0.95; opacity += 0.05) {
      const blended = mix(o.worst, o.scrimColor, opacity);
      const c = contrast(blended, o.color);
      if (c >= ratio) return { color: o.color, scrim: opacity > 0 ? { color: o.scrimColor, opacity: Math.round(opacity * 100) / 100 } : null, contrast: Math.round(c * 100) / 100 };
    }
    return { color: o.color, scrim: { color: o.scrimColor, opacity: 0.95 }, contrast: Math.round(contrast(mix(o.worst, o.scrimColor, 0.95), o.color) * 100) / 100 };
  });
  return options.sort((a, b) => (a.scrim?.opacity || 0) - (b.scrim?.opacity || 0))[0];
}

/** A vertical (or horizontal) gradient scrim: transparent at `from`, `opacity` over the text area. */
function scrim(scene, { x, y, w, h, color, opacity, direction = 'up', id }) {
  if (!opacity) return;
  const [x1, y1, x2, y2] = direction === 'up' ? [0, 1, 0, 0] : direction === 'down' ? [0, 0, 0, 1] : [0, 0, 1, 0];
  scene.svg(`<defs><linearGradient id="${id}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"><stop offset="0" stop-color="${color}" stop-opacity="${opacity}"/><stop offset="0.55" stop-color="${color}" stop-opacity="${opacity}"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="url(#${id})"/>`);
}

/** The brand mark, always top-left: the real logo when there is one, else the brand name as a wordmark in the heading font. */
async function brandMark(scene, ctx, surfaceTone, { solid = false } = {}) {
  const { W, H, u, fonts, brand } = ctx;
  const x = 6 * u; const y = 5.5 * u;
  if (ctx.logo) {
    const lum = surfaceTone ? luminance(surfaceTone) : 1;
    await scene.logo(ctx.logo, { x, y, maxW: 26 * u, maxH: 8 * u, plate: lum < 0.35 ? { fill: '#ffffff', opacity: 0.92, radius: 1.2 * u } : null });
    return { kind: 'logo' };
  }
  if (!brand.name) return { kind: 'none' };
  // on a solid brand surface the colour is known; over the picture it is measured on the pixels behind the wordmark
  const leg = solid
    ? { color: contrast(surfaceTone, '#ffffff') >= 4.5 ? '#ffffff' : INK, scrim: null }
    : await legibilityFor(ctx.imageFitted, { x: x - u, y: y - u, w: W * 0.52, h: 6.5 * u }, W, H, { ratio: 4.5, brandDark: darken(ctx.pal.primary, 0.55) });
  const r = await fitStrict({ text: brand.name, family: fonts.heading, weight: 700, width: W * 0.5, maxHeight: 6 * u, maxSize: Math.round(3.1 * u), minSize: Math.round(2.2 * u), color: leg.color });
  if (!r) return { kind: 'none' };
  if (leg.scrim) scene.rect({ x: x - 1.6 * u, y: y - 1 * u, w: r.width + 3.2 * u, h: r.height + 2 * u, radius: 1.2 * u, fill: leg.scrim.color, opacity: Math.max(0.7, leg.scrim.opacity) });
  await scene.add(r.buffer, x, y);
  scene.report.texts.push({ label: 'wordmark', size: r.size, width: r.width, height: r.height, x, y });
  return { kind: 'wordmark', color: leg.color, plate: !!leg.scrim };
}

/** Renders the headline, subline and CTA as a stack that fits width w (strict); returns the buffers and the total height. */
async function textStack(ctx, { w, maxH, color, accent, align = 'left', headlineMax, sublineMax, gap }) {
  const { brief, fonts, u, W } = ctx;
  const minHead = Math.round(MIN_HEADLINE_PX_AT_1080 * (W / 1080));
  const parts = [];
  const head = await fitStrict({ text: brief.hook_headline, family: fonts.heading, weight: 800, width: w, maxHeight: maxH * 0.72, maxSize: headlineMax, minSize: minHead, color, align, lineGapRatio: 0.02 });
  if (!head) throw fail('headline', { label: 'headline' });
  parts.push({ label: 'headline', r: head });
  if (brief.subline) {
    const sub = await fitStrict({ text: brief.subline, family: fonts.body, weight: 500, width: w, maxHeight: maxH * 0.22, maxSize: sublineMax, minSize: Math.round(26 * (W / 1080)), color, align });
    if (!sub) throw fail('subline', { label: 'subline' });
    parts.push({ label: 'subline', r: sub });
  }
  if (brief.cta) {
    const cta = await fitStrict({ text: `${brief.cta}  →`, family: fonts.body, weight: 700, width: w, maxHeight: 9 * u, maxSize: Math.round(3.4 * u), minSize: Math.round(26 * (W / 1080)), color: accent, align });
    if (!cta) throw fail('cta', { label: 'cta' });
    parts.push({ label: 'cta', r: cta });
  }
  const height = parts.reduce((s, p) => s + p.r.height, 0) + gap * (parts.length - 1) + (parts.length > 1 ? gap * 0.5 : 0);
  if (height > maxH) throw fail('stack', { label: 'stack' });
  return { parts, height };
}

/**
 * Draws the stack. `over` = the context when the stack sits ON the picture: then the pixels behind it are measured and a busy area
 * gets a plate (in the colour that carries the text). Returns { plate } so a layout can skip decorations that would crowd it.
 */
async function drawStack(scene, stack, { x, y, w, gap, align = 'left', over = null, busyStyle = 'plate' }) {
  let plate = false;
  if (over) {
    const u = over.u;
    const widest = Math.max(...stack.parts.map((p) => p.r.width));
    const rx = align === 'center' ? x + (w - widest) / 2 : x;
    const rect = { x: rx - 1.5 * u, y: y - 1.5 * u, w: widest + 3 * u, h: stack.height + 3 * u };
    // every line is measured on its own: a calm headline area must not hide a subline sitting on detail
    let top = y; let anyBusy = false;
    for (const p of stack.parts) {
      const left = align === 'center' ? x + (w - p.r.width) / 2 : x;
      // eslint-disable-next-line no-await-in-loop
      const m = await busyness(over.imageFitted, { x: left - u, y: top - 0.5 * u, w: p.r.width + 2 * u, h: p.r.height + u }, over.W, over.H);
      over.busy = [...(over.busy || []), { zone: p.label, fraction: m.fraction, busy: m.busy }];
      anyBusy = anyBusy || m.busy;
      top += p.r.height + (p.label === 'headline' ? gap * 1.5 : gap);
    }
    if (anyBusy) {
      const textIsLight = stack.parts[0]?.r && over.legibility?.color === '#ffffff';
      const fill = textIsLight ? darken(over.pal.primary, 0.55) : '#ffffff';
      if (busyStyle === 'scrim') {
        // text at the foot of a full-bleed picture: a full-width scrim, solid behind the text and fading out above it (never a box)
        const sTop = Math.max(0, rect.y - 14 * u); const h = over.H - sTop; const solidFrom = Math.min(0.95, (12 * u) / h);
        over.busyScrimN = (over.busyScrimN || 0) + 1;
        const id = `busyScrim${over.busyScrimN}`;
        scene.svg(`<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${fill}" stop-opacity="0"/><stop offset="${solidFrom}" stop-color="${fill}" stop-opacity="0.9"/><stop offset="1" stop-color="${fill}" stop-opacity="0.94"/></linearGradient></defs><rect x="0" y="${sTop}" width="${over.W}" height="${h}" fill="url(#${id})"/>`);
      } else {
        scene.rect({ x: rect.x - 1.5 * u, y: rect.y - 1 * u, w: rect.w + 3 * u, h: rect.h + 2 * u, radius: 2 * u, fill, opacity: 0.9 });
      }
      plate = true;
    }
  }
  let top = y;
  for (const p of stack.parts) {
    const left = align === 'center' ? x + (w - p.r.width) / 2 : x;
    // eslint-disable-next-line no-await-in-loop
    await scene.add(p.r.buffer, left, top);
    scene.report.texts.push({ label: p.label, size: p.r.size, width: p.r.width, height: p.r.height, x: left, y: top });
    top += p.r.height + (p.label === 'headline' ? gap * 1.5 : gap);
  }
  return { plate };
}

/**
 * The accent rule - drawn ONLY directly under the HEADLINE, when the headline is the last line of the stack (no subline / CTA under
 * it) and the space around the rule is calm. Under a subline or a CTA it reads as a floating underline (live report, Nov 2026), so
 * it is not drawn there. Returns the rule's rectangle (and what it sits under) or null.
 */
export function accentRulePlacement(stack, { x, y: stackTop, gap, u }) {
  const last = stack.parts[stack.parts.length - 1];
  if (!last || last.label !== 'headline') return null;
  const headlineBottom = stackTop + stack.parts.slice(0, -1).reduce((s, p) => s + p.r.height + (p.label === 'headline' ? gap * 1.5 : gap), 0) + last.r.height;
  return { x, y: headlineBottom + 2.4 * u, w: 14 * u, h: 0.7 * u, under: 'headline', gapAbove: 2.4 * u };
}
async function accentRule(scene, ctx, { stack, x, y, gap, plate }) {
  const { u, W, H, pal } = ctx;
  const place = accentRulePlacement(stack, { x, y, gap, u });
  if (!place || plate || place.y + 3 * u > H) return null;
  const around = await busyness(ctx.imageFitted, { x: x - 2 * u, y: place.y - 1.5 * u, w: 18 * u, h: 4 * u }, W, H);
  if (around.busy) return null;
  scene.rect({ x: place.x, y: place.y, w: place.w, h: place.h, fill: pal.accent, radius: 0.35 * u });
  return place;
}

/**
 * The website as its BARE domain, small, in the footer (bottom-right) - only when the brief wanted the site shown, and only on a single
 * image or the carousel's CTA slide. Skipped (never squeezed) when it would touch another text.
 */
async function footerDomainText(scene, ctx, domain) {
  const { W, H, u, fonts, pal } = ctx;
  const r = await fitStrict({ text: domain, family: fonts.body, weight: 600, width: W * 0.4, maxHeight: 3.6 * u, maxSize: Math.round(2.1 * u), minSize: Math.round(18 * (W / 1080)), color: '#ffffff' });
  if (!r) return null;
  const x = W - 6 * u - r.width; const y = H - 2.6 * u - r.height;
  const box = { x: x - 1.2 * u, y: y - 0.8 * u, w: r.width + 2.4 * u, h: r.height + 1.6 * u };
  const touches = (scene.report.texts || []).some((t) => t.x != null && t.x < box.x + box.w && t.x + t.width > box.x && t.y < box.y + box.h && t.y + t.height > box.y);
  if (touches) return null;
  const leg = await legibilityFor(ctx.imageFitted, box, W, H, { ratio: 4.5, brandDark: darken(pal.primary, 0.55) });
  const colored = await fitStrict({ text: domain, family: fonts.body, weight: 600, width: W * 0.4, maxHeight: 3.6 * u, maxSize: Math.round(2.1 * u), minSize: Math.round(18 * (W / 1080)), color: leg.color });
  if (leg.scrim) scene.rect({ x: box.x, y: box.y, w: box.w, h: box.h, radius: 1 * u, fill: leg.scrim.color, opacity: Math.max(0.7, leg.scrim.opacity) });
  await scene.add(colored.buffer, x, y);
  scene.report.texts.push({ label: 'domain', size: colored.size, width: colored.width, height: colored.height, x, y });
  return domain;
}

/** Image labels as chips inside `area` (the picture's frame on the canvas), plus an arrow between a left and a right label. */
async function imageLabels(scene, ctx, area) {
  const { u, W, fonts, pal, brief } = ctx;
  const labels = (brief.image_labels || []).slice(0, 2);
  if (!labels.length) return;
  const chipFill = darken(pal.primary, 0.55);
  const placed = {};
  for (const l of labels) {
    // eslint-disable-next-line no-await-in-loop
    const r = await fitStrict({ text: l.text.toUpperCase(), family: fonts.body, weight: 800, width: area.w * 0.42, maxHeight: 5 * u, maxSize: Math.round(2.8 * u), minSize: Math.round(24 * (W / 1080)), color: '#ffffff', tracking: 1.5 });
    if (!r) throw fail('label', { label: 'label' });
    const cw = r.width + 4 * u; const ch = r.height + 2 * u;
    const pos = {
      left: { x: area.x + area.w * 0.25 - cw / 2, y: area.y + area.h - ch - 3 * u },
      right: { x: area.x + area.w * 0.75 - cw / 2, y: area.y + area.h - ch - 3 * u },
      top: { x: area.x + (area.w - cw) / 2, y: area.y + 14 * u },
      bottom: { x: area.x + (area.w - cw) / 2, y: area.y + area.h - ch - 3 * u },
    }[l.position] || { x: area.x + 4 * u, y: area.y + area.h - ch - 3 * u };
    scene.rect({ x: pos.x, y: pos.y, w: cw, h: ch, radius: ch / 2, fill: chipFill, opacity: 0.94 });
    // eslint-disable-next-line no-await-in-loop
    await scene.add(r.buffer, pos.x + 2 * u, pos.y + 1 * u);
    scene.report.texts.push({ label: 'label', size: r.size, width: r.width, height: r.height, x: pos.x + 2 * u, y: pos.y + 1 * u });
    placed[l.position] = { ...pos, cw, ch };
  }
  if (placed.left && placed.right) {
    const cy = placed.left.y + placed.left.ch / 2; const cx = area.x + area.w / 2; const rr = 3.4 * u;
    scene.badge('arrow', { cx, cy, r: rr, fill: pal.accent, color: '#ffffff' });
    ctx.arrow = true;
  }
}

/** The slide counter of a carousel ("3/7"), top-right, measured like the wordmark (plate when the picture behind it needs one). */
async function slideCounter(scene, ctx) {
  const { slide, W, H, u, fonts, pal } = ctx;
  if (!slide?.total) return;
  const text = `${slide.index}/${slide.total}`;
  const zone = { x: W - 20 * u, y: 4.5 * u, w: 14 * u, h: 6.5 * u };
  const leg = await legibilityFor(ctx.imageFitted, zone, W, H, { ratio: 4.5, brandDark: darken(pal.primary, 0.55) });
  const r = await fitStrict({ text, family: fonts.body, weight: 700, width: 14 * u, maxHeight: 5 * u, maxSize: Math.round(2.8 * u), minSize: Math.round(22 * (W / 1080)), color: leg.color });
  if (!r) return;
  const x = W - 6 * u - r.width; const y = 5.5 * u;
  if (leg.scrim) scene.rect({ x: x - 1.6 * u, y: y - 1 * u, w: r.width + 3.2 * u, h: r.height + 2 * u, radius: 1.2 * u, fill: leg.scrim.color, opacity: Math.max(0.7, leg.scrim.opacity) });
  await scene.add(r.buffer, x, y);
  scene.report.texts.push({ label: 'counter', size: r.size, width: r.width, height: r.height, x, y });
}

/** The CTA colour that reads on `surface`: the brand accent when it does, else white / ink. */
const ctaColor = (accent, surface, ratio = 4.5) => (contrast(accent, surface) >= ratio ? accent : (contrast('#ffffff', surface) >= ratio ? '#ffffff' : INK));

// ── the layouts ─────────────────────────────────────────────────────────────

const LAYOUTS = {
  /** The photo fills the frame; the text stack sits at the bottom, over a scrim only if the measured contrast needs one. */
  async full_bleed_bottom(scene, ctx) {
    const { W, H, u, image, pal } = ctx;
    await scene.photo(image, { x: 0, y: 0, w: W, h: H });
    const x = 7 * u; const w = W - 14 * u; const gap = 2.2 * u;
    const zone = { x: 0, y: H * 0.58, w: W, h: H * 0.42 };
    const leg = await legibilityFor(ctx.imageFitted, zone, W, H, { ratio: 4.5, brandDark: darken(pal.primary, 0.55) });
    const stack = await textStack(ctx, { w, maxH: H * 0.38, color: leg.color, accent: ctaColor(pal.accent, leg.scrim ? mix(leg.color === '#ffffff' ? '#000000' : '#ffffff', leg.scrim.color, leg.scrim.opacity) : (await regionTone(ctx.imageFitted, zone, W, H)).mean), headlineMax: Math.round(10.6 * u), sublineMax: Math.round(3.6 * u), gap });
    const y = H - 7 * u - stack.height;
    if (leg.scrim) scrim(scene, { x: 0, y: y - 14 * u, w: W, h: H - y + 14 * u, color: leg.scrim.color, opacity: leg.scrim.opacity, direction: 'up', id: 'scrimB' });
    ctx.legibility = leg;
    await imageLabels(scene, ctx, { x: 0, y: 0, w: W, h: y - 4 * u });
    await drawStack(scene, stack, { x, y, w, gap, over: ctx, busyStyle: 'scrim' });
    await slideCounter(scene, ctx);
    ctx.mark = await brandMark(scene, ctx, null);
  },

  /** A magazine cover: a small kicker, the headline at the top over the photo, a thin accent rule, the CTA at the foot. */
  async editorial_cover(scene, ctx) {
    const { W, H, u, image, pal, fonts, brief } = ctx;
    await scene.photo(image, { x: 0, y: 0, w: W, h: H });
    const x = 7 * u; const w = W - 14 * u; const gap = 2 * u;
    const zone = { x: 0, y: 0, w: W, h: H * 0.42 };
    const leg = await legibilityFor(ctx.imageFitted, zone, W, H, { ratio: 4.5, brandDark: darken(pal.primary, 0.55) });
    const top = 16 * u;
    const kicker = brief.kicker ? await fitStrict({ text: brief.kicker.toUpperCase(), family: fonts.body, weight: 700, width: w, maxHeight: 4 * u, maxSize: Math.round(2.6 * u), minSize: Math.round(20 * (W / 1080)), color: leg.color, tracking: 2 }) : null;
    const stackTop = top + (kicker ? kicker.height + 2.4 * u : 0);
    const stack = await textStack(ctx, { w, maxH: H * 0.44 - stackTop, color: leg.color, accent: leg.color, headlineMax: Math.round(11.5 * u), sublineMax: Math.round(3.6 * u), gap });
    if (leg.scrim) scrim(scene, { x: 0, y: 0, w: W, h: stackTop + stack.height + 16 * u, color: leg.scrim.color, opacity: leg.scrim.opacity, direction: 'down', id: 'scrimT' });
    ctx.legibility = leg;
    if (kicker) { await scene.add(kicker.buffer, x, top); scene.report.texts.push({ label: 'kicker', size: kicker.size, width: kicker.width, height: kicker.height, x, y: top }); }
    const drawn = await drawStack(scene, stack, { x, y: stackTop, w, gap, over: ctx });
    ctx.rule = await accentRule(scene, ctx, { stack, x, y: stackTop, gap, plate: drawn.plate });
    await imageLabels(scene, ctx, { x: 0, y: stackTop + stack.height + 6 * u, w: W, h: H - (stackTop + stack.height + 6 * u) });
    ctx.mark = await brandMark(scene, ctx, null);
  },

  /** Image above, a solid brand panel with the text below: no text ever sits on the picture. */
  async split_image_text(scene, ctx) {
    const { W, H, u, image, pal } = ctx;
    const imageH = Math.round(H * (H > W ? 0.56 : 0.5));
    await scene.photo(image, { x: 0, y: 0, w: W, h: imageH });
    const panel = pal.primary;
    scene.rect({ x: 0, y: imageH, w: W, h: H - imageH, fill: panel });
    const text = contrast(panel, '#ffffff') >= 4.5 ? '#ffffff' : INK;
    const x = 7 * u; const w = W - 14 * u; const gap = 2 * u;
    const stack = await textStack(ctx, { w, maxH: H - imageH - 12 * u, color: text, accent: ctaColor(pal.accent, panel), headlineMax: Math.round(9.6 * u), sublineMax: Math.round(3.4 * u), gap });
    await drawStack(scene, stack, { x, y: imageH + Math.max(6 * u, (H - imageH - stack.height) / 2), w, gap });
    await imageLabels(scene, ctx, { x: 0, y: 0, w: W, h: imageH });
    ctx.legibility = { color: text, scrim: null, contrast: Math.round(contrast(panel, text) * 100) / 100 };
    ctx.mark = await brandMark(scene, ctx, null);
  },

  /** Big type on the brand colour; the picture is a small framed image in the corner. */
  async big_type_statement(scene, ctx) {
    const { W, H, u, image, pal } = ctx;
    const bg = pal.primary;
    scene.rect({ x: 0, y: 0, w: W, h: H, fill: bg });
    const text = contrast(bg, '#ffffff') >= 4.5 ? '#ffffff' : INK;
    const x = 7 * u; const w = W - 14 * u; const gap = 2.4 * u;
    const imgW = W * 0.46; const imgH = H * (H > W ? 0.33 : 0.36);
    const stack = await textStack(ctx, { w, maxH: H - imgH - 30 * u, color: text, accent: ctaColor(pal.accent, bg), headlineMax: Math.round(12.5 * u), sublineMax: Math.round(3.6 * u), gap });
    await drawStack(scene, stack, { x, y: 17 * u, w, gap });
    await scene.photo(image, { x: W - imgW - 6 * u, y: H - imgH - 6 * u, w: imgW, h: imgH, radius: 2.4 * u });
    await imageLabels(scene, ctx, { x: W - imgW - 6 * u, y: H - imgH - 6 * u, w: imgW, h: imgH });
    ctx.legibility = { color: text, scrim: null, contrast: Math.round(contrast(bg, text) * 100) / 100 };
    ctx.mark = await brandMark(scene, ctx, bg, { solid: true });
  },

  /** One real number, big, with one line; over the photo's calm left side. The number must be in the caption or the facts (brief rule). */
  async proof_stat(scene, ctx) {
    const { W, H, u, image, pal, fonts, brief } = ctx;
    await scene.photo(image, { x: 0, y: 0, w: W, h: H });
    const x = 7 * u; const w = W * 0.6; const gap = 2 * u;
    const zone = { x: 0, y: H * 0.25, w: W * 0.62, h: H * 0.6 };
    const leg = await legibilityFor(ctx.imageFitted, zone, W, H, { ratio: 4.5, brandDark: darken(pal.primary, 0.55) });
    if (leg.scrim) scrim(scene, { x: 0, y: 0, w: W * 0.8, h: H, color: leg.scrim.color, opacity: leg.scrim.opacity, direction: 'right', id: 'scrimL' });
    const figure = (brief.hook_headline.match(/[$€£]?\d[\d,.]*\s?%?/) || [])[0];
    let y = H * 0.3;
    if (figure) {
      const big = await fitStrict({ text: figure.trim(), family: fonts.heading, weight: 800, width: w, maxHeight: H * 0.22, maxSize: Math.round(26 * u), minSize: Math.round(14 * u), color: pal.accent && contrast(pal.accent, leg.scrim ? leg.scrim.color : '#000000') >= 3 ? pal.accent : leg.color });
      if (!big) throw fail('figure', { label: 'figure' });
      await scene.add(big.buffer, x, y); scene.report.texts.push({ label: 'figure', size: big.size, width: big.width, height: big.height });
      y += big.height + 2 * u;
    }
    const stack = await textStack(ctx, { w, maxH: H * 0.45, color: leg.color, accent: leg.color, headlineMax: Math.round(8.4 * u), sublineMax: Math.round(3.4 * u), gap });
    ctx.legibility = leg;
    await drawStack(scene, stack, { x, y, w, gap, over: ctx });
    ctx.mark = await brandMark(scene, ctx, null);
  },

  /**
   * Carousel POINT slide: the picture fills the frame; the bottom carries a big number (the point's position, not a claim) and ONE line
   * of at most 12 words, over a scrim when the measured contrast needs one and on a plate when the pixels behind are busy.
   */
  async carousel_point(scene, ctx) {
    const { W, H, u, image, pal, fonts, brief } = ctx;
    await scene.photo(image, { x: 0, y: 0, w: W, h: H });
    const x = 7 * u; const w = W - 14 * u; const gap = 1.6 * u;
    const zone = { x: 0, y: H * 0.5, w: W, h: H * 0.5 };
    const leg = await legibilityFor(ctx.imageFitted, zone, W, H, { ratio: 4.5, brandDark: darken(pal.primary, 0.55) });
    ctx.legibility = leg;
    const minHead = Math.round(MIN_HEADLINE_PX_AT_1080 * (W / 1080));
    const head = await fitStrict({ text: brief.hook_headline, family: fonts.heading, weight: 800, width: w, maxHeight: H * 0.24, maxSize: Math.round(7 * u), minSize: minHead, color: leg.color, lineGapRatio: 0.04 });
    if (!head) throw fail('headline', { label: 'headline' });
    const surface = leg.scrim ? leg.scrim.color : (await regionTone(ctx.imageFitted, zone, W, H)).mean;
    const numColor = contrast(pal.accent, surface) >= 3 ? pal.accent : leg.color;
    const num = brief.number != null ? await fitStrict({ text: String(brief.number).padStart(2, '0'), family: fonts.heading, weight: 800, width: w, maxHeight: H * 0.14, maxSize: Math.round(14 * u), minSize: Math.round(9 * u), color: numColor, lineGapRatio: 0 }) : null;
    const parts = [...(num ? [{ label: 'number', r: num }] : []), { label: 'headline', r: head }];
    const stack = { parts, height: parts.reduce((s, p) => s + p.r.height, 0) + gap * (parts.length - 1) };
    const y = H - 8 * u - stack.height;
    if (leg.scrim) scrim(scene, { x: 0, y: y - 16 * u, w: W, h: H - y + 16 * u, color: leg.scrim.color, opacity: leg.scrim.opacity, direction: 'up', id: 'scrimP' });
    await imageLabels(scene, ctx, { x: 0, y: 0, w: W, h: y - 4 * u });
    await drawStack(scene, stack, { x, y, w, gap, over: ctx, busyStyle: 'scrim' });
    await slideCounter(scene, ctx);
    ctx.mark = await brandMark(scene, ctx, null);
  },

  /** Carousel CTA slide: the picture, a headline and the call to action as a button. */
  async carousel_cta(scene, ctx) {
    const { W, H, u, image, pal, fonts, brief } = ctx;
    await scene.photo(image, { x: 0, y: 0, w: W, h: H });
    const x = 7 * u; const w = W - 14 * u; const gap = 2.2 * u;
    const zone = { x: 0, y: H * 0.5, w: W, h: H * 0.5 };
    const leg = await legibilityFor(ctx.imageFitted, zone, W, H, { ratio: 4.5, brandDark: darken(pal.primary, 0.55) });
    ctx.legibility = leg;
    const stack = await textStack({ ...ctx, brief: { ...brief, cta: '' } }, { w, maxH: H * 0.3, color: leg.color, accent: leg.color, headlineMax: Math.round(9.4 * u), sublineMax: Math.round(3.6 * u), gap });
    let button = null;
    if (brief.cta) {
      const btnText = contrast(pal.accent, '#ffffff') >= 3 ? '#ffffff' : INK;
      button = await fitStrict({ text: `${brief.cta}  →`, family: fonts.body, weight: 800, width: w - 8 * u, maxHeight: 7 * u, maxSize: Math.round(3.6 * u), minSize: Math.round(28 * (W / 1080)), color: btnText });
      if (!button) throw fail('cta', { label: 'cta' });
    }
    const btnH = button ? button.height + 3.6 * u : 0;
    const y = H - 9 * u - btnH - (button ? 3.2 * u : 0) - stack.height;
    if (leg.scrim) scrim(scene, { x: 0, y: y - 16 * u, w: W, h: H - y + 16 * u, color: leg.scrim.color, opacity: leg.scrim.opacity, direction: 'up', id: 'scrimC' });
    await drawStack(scene, stack, { x, y, w, gap, over: ctx, busyStyle: 'scrim' });
    if (button) {
      const by = y + stack.height + 3.2 * u;
      scene.rect({ x, y: by, w: button.width + 6 * u, h: btnH, radius: btnH / 2, fill: pal.accent });
      await scene.add(button.buffer, x + 3 * u, by + 1.8 * u);
      scene.report.texts.push({ label: 'cta', size: button.size, width: button.width, height: button.height, x: x + 3 * u, y: by + 1.8 * u });
    }
    await slideCounter(scene, ctx);
    ctx.mark = await brandMark(scene, ctx, null);
  },

  /** The photo fills the frame; a calm left panel carries the headline and (up to 3) short labels. */
  async infographic_image(scene, ctx) {
    const { W, H, u, image, pal, fonts, brief } = ctx;
    await scene.photo(image, { x: 0, y: 0, w: W, h: H });
    const panelW = W * 0.56;
    const panel = darken(pal.primary, 0.15);
    scrim(scene, { x: 0, y: 0, w: W * 0.74, h: H, color: panel, opacity: 0.9, direction: 'right', id: 'scrimP' });
    const text = '#ffffff';
    const x = 7 * u; const w = panelW - 9 * u; const gap = 2 * u;
    const stack = await textStack(ctx, { w, maxH: H * 0.5, color: text, accent: ctaColor(pal.accent, panel), headlineMax: Math.round(8.8 * u), sublineMax: Math.round(3.2 * u), gap });
    await drawStack(scene, stack, { x, y: 16 * u, w, gap });
    let y = 16 * u + stack.height + 4 * u;
    for (const label of (brief.labels || []).slice(0, 3)) {
      // eslint-disable-next-line no-await-in-loop
      const r = await fitStrict({ text: label, family: fonts.body, weight: 600, width: w - 6 * u, maxHeight: 8 * u, maxSize: Math.round(3.6 * u), minSize: Math.round(26 * (W / 1080)), color: text });
      if (!r) throw fail('label', { label: 'label' });
      scene.circle({ cx: x + 1.4 * u, cy: y + r.height / 2, r: 1.1 * u, fill: pal.accent });
      // eslint-disable-next-line no-await-in-loop
      await scene.add(r.buffer, x + 5 * u, y);
      scene.report.texts.push({ label: 'label', size: r.size, width: r.width, height: r.height });
      y += r.height + 2.2 * u;
    }
    ctx.legibility = { color: text, scrim: { color: panel, opacity: 0.9 }, contrast: Math.round(contrast(panel, text) * 100) / 100 };
    ctx.mark = await brandMark(scene, ctx, null);
  },
};

/**
 * Composes one concept design. `brief` = { hook_headline, subline, cta, layout, kicker?, labels? }, `image` = the generated picture.
 * Returns { buffer (PNG at W x H), report: { layout, texts, legibility, mark, fonts, notes } }. Throws TEXT_DOES_NOT_FIT (never draws a
 * cut text). `size` = { width, height } of the delivered design (1080x1350 / 1080x1080).
 */
export async function composeConcept({ brief, image, size, brand = {}, logo = null, slide = null, footerDomain = null }) {
  const layout = LAYOUTS[brief.layout];
  if (!layout) throw Object.assign(new Error('COMPOSE_INVALID'), { code: 'COMPOSE_INVALID', reason: `unknown_layout_${brief.layout}` });
  const W = size.width; const H = size.height;
  const pal = buildPalette({ primary: brand.primary, secondary: brand.secondary, accent: brand.accent });
  const typography = resolveTypography({ heading: brand.headingFont, body: brand.bodyFont }, brand.customFonts || null);
  // the picture, fitted once to the canvas: layouts measure contrast on exactly the pixels they draw over
  const imageFitted = await sharp(image).resize({ width: W, height: H, fit: 'cover', position: sharp.strategy.attention }).png().toBuffer();
  const ctx = {
    // panels: the brand's dark tone (already made dark enough for white text at AA); accents: its most saturated colour
    W, H, u: Math.min(W, H) / 100, pal: { ...pal, primary: pal.deep, accent: pal.bright },
    fonts: { heading: typography.heading, body: typography.body }, brief, image, imageFitted, brand, logo, slide,
  };
  const scene = new Scene(W, H, '#ffffff');
  await layout(scene, ctx);
  // the bare domain only where it belongs (the caller decides: a single image, or the carousel's CTA slide)
  const domainDrawn = footerDomain && (!slide || brief.layout === 'carousel_cta') ? await footerDomainText(scene, ctx, footerDomain) : null;
  const buffer = await scene.render();
  return {
    buffer,
    report: {
      layout: brief.layout, width: W, height: H, texts: scene.report.texts, legibility: ctx.legibility || null, mark: ctx.mark || null,
      busy: ctx.busy || [], plate: (ctx.busy || []).some((b) => b.busy), rule: !!ctx.rule, rulePlacement: ctx.rule || null, arrow: !!ctx.arrow, footerDomain: domainDrawn || null,
      fonts: { heading: typography.heading, body: typography.body, headingFromBrand: typography.headingFromBrand, bodyFromBrand: typography.bodyFromBrand, headingUploaded: !!typography.headingUploaded, bodyUploaded: !!typography.bodyUploaded },
      notes: [...(typography.brandFontUnavailable ? ['brand_font_unavailable'] : []), ...(ctx.mark?.kind === 'wordmark' ? ['wordmark_used'] : []), ...((ctx.busy || []).some((b) => b.busy) ? ['busy_area_plate'] : [])],
    },
  };
}

export default { composeConcept, legibilityFor, LAYOUT_NAMES };
