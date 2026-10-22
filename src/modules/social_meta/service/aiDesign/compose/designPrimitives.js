import sharp from 'sharp';
import { fontSpec } from './designFonts.js';

/**
 * Drawing primitives for the composer. Everything is deterministic and local: text is rendered from font files with the
 * layout engine's own wrapping, then fitted to its box by shrinking the size (never by overflowing it and never by cutting a
 * word); shapes are SVG; photos are cropped and masked with sharp. A Scene collects layers and renders ONE image.
 */

const PIXEL_LIMIT = 40_000_000;

/** Characters that are markup to the text layout engine, escaped so business text is only ever text. */
export const escapeMarkup = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const round = (n) => Math.round(n);

// ── text ─────────────────────────────────────────────────────────────────────

/**
 * One rendering of a text block at a given size.
 * `runs` = [{ text, color }]: coloured parts of ONE flow of text (emphasis); `tracking` = letter spacing in px.
 */
export async function renderText({ runs, family, weight = 400, size, width = null, align = 'left', color = '#000000', lineGap = 0, tracking = 0, wrap = 'word-char' }) {
  const spec = fontSpec(family, weight);
  const markup = runs.map((r) => {
    const attrs = [`foreground="${r.color || color}"`];
    if (tracking) attrs.push(`letter_spacing="${Math.round(tracking * 1024)}"`);
    return `<span ${attrs.join(' ')}>${escapeMarkup(r.text)}</span>`;
  }).join('');
  const { data, info } = await sharp({
    text: {
      text: markup, font: `${spec.family} ${spec.weightName} ${Math.max(6, round(size))}`, fontfile: spec.fontfile, rgba: true,
      ...(width ? { width: round(width), wrap } : {}), align, spacing: round(lineGap), dpi: 72,
    },
  }).png().toBuffer({ resolveWithObject: true });
  return { buffer: data, width: info.width, height: info.height, size: round(size) };
}

const asRuns = (text, runs, color) => (runs?.length ? runs : [{ text: String(text ?? ''), color }]);
const plain = (runs) => runs.map((r) => r.text).join('');

/** Drops trailing words (adding an ellipsis) until the runs are short enough; the last resort when the minimum size still overflows. */
function shorten(runs) {
  const flat = plain(runs).replace(/[….]+$/, '').trim().split(' ');
  if (flat.length <= 1) return null;
  flat.pop();
  return [{ text: `${flat.join(' ').replace(/[,;:\-–—\s]+$/, '')}…`, color: runs[runs.length - 1].color }];
}

/**
 * A wrapped text block that FITS: the largest size between minSize and maxSize whose rendering is no taller than maxHeight and
 * no wider than width. If even minSize overflows, words are dropped from the end ("…") - text is never drawn outside its box.
 * @returns {{ buffer, width, height, size, shortened: boolean }}
 */
export async function fitText({ text, runs = null, family, weight = 400, width, maxHeight, maxSize, minSize = 14, align = 'left', color = '#000000', lineGapRatio = 0, tracking = 0 }) {
  let current = asRuns(text, runs, color);
  let shortened = false;
  for (let guard = 0; guard < 12; guard += 1) {
    let size = maxSize;
    while (size >= minSize) {
      // eslint-disable-next-line no-await-in-loop
      const r = await renderText({ runs: current, family, weight, size, width, align, color, lineGap: size * lineGapRatio, tracking });
      if (r.height <= maxHeight && r.width <= width + 1) return { ...r, shortened };
      size = Math.floor(size * 0.93) - (size > 40 ? 0 : 1);
    }
    const next = shorten(current);
    if (!next) break;
    current = next; shortened = true;
  }
  const last = await renderText({ runs: current, family, weight, size: minSize, width, align, color, lineGap: 0, tracking });
  return { ...last, shortened: true, overflow: last.height > maxHeight };
}

/** The largest size at which EVERY text fits on one line within maxWidth: items of a list are all drawn at it. */
export async function uniformSize(texts, { family, weight = 600, maxWidth, maxSize, minSize = 12 }) {
  let size = maxSize;
  for (const t of texts) {
    // eslint-disable-next-line no-await-in-loop
    const r = await fitLine({ text: t, family, weight, maxWidth, maxSize: size, minSize });
    size = Math.min(size, r.size);
  }
  return size;
}

/** One line of text no wider than maxWidth (shrinks from maxSize; ellipsis only as a last resort). */
export async function fitLine({ text, runs = null, family, weight = 600, maxWidth, maxSize, minSize = 12, color = '#000000', tracking = 0 }) {
  let current = asRuns(text, runs, color);
  let shortened = false;
  for (let guard = 0; guard < 10; guard += 1) {
    let size = maxSize;
    while (size >= minSize) {
      // eslint-disable-next-line no-await-in-loop
      const r = await renderText({ runs: current, family, weight, size, width: null, color, tracking });
      if (r.width <= maxWidth) return { ...r, shortened };
      size = Math.floor(size * 0.94) - 1;
    }
    const next = shorten(current);
    if (!next) break;
    current = next; shortened = true;
  }
  const last = await renderText({ runs: current, family, weight, size: minSize, width: null, color, tracking });
  return { ...last, shortened: true, overflow: last.width > maxWidth };
}

// ── icons ────────────────────────────────────────────────────────────────────

/** 24x24 stroke icons (simple geometry; drawn with a stroke colour, no fill). */
export const ICONS = Object.freeze({
  check: 'M5 12.5l4.5 4.5L19 7',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  phone: 'M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z',
  globe: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z',
  mail: 'M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM22 6l-10 7L2 6',
  pin: 'M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0zM12 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
});

// ── scene ────────────────────────────────────────────────────────────────────

/**
 * Collects layers (in paint order) and renders them as one PNG. Shapes are batched into full-canvas SVG layers (so a shape
 * that runs off the edge is simply clipped); text, photos and logos are composited as images and clipped to the canvas.
 */
export class Scene {
  constructor(width, height, background = '#ffffff') {
    this.width = width; this.height = height; this.background = background;
    this.layers = []; this.pending = [];
    this.report = { texts: [], shortened: [], overflow: [] };
  }

  // shapes -------------------------------------------------------------
  /** Raw SVG elements (absolute canvas coordinates), batched. */
  svg(inner) { this.pending.push(inner); return this; }

  rect({ x, y, w, h, fill, radius = 0, opacity = 1, stroke = null, strokeW = 0, rx = null }) {
    const r = rx ?? radius;
    return this.svg(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" ry="${r}" fill="${fill || 'none'}" fill-opacity="${opacity}"${stroke ? ` stroke="${stroke}" stroke-width="${strokeW}"` : ''}/>`);
  }

  circle({ cx, cy, r, fill, opacity = 1, stroke = null, strokeW = 0 }) {
    return this.svg(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill || 'none'}" fill-opacity="${opacity}"${stroke ? ` stroke="${stroke}" stroke-width="${strokeW}" stroke-opacity="${opacity}"` : ''}/>`);
  }

  path({ d, fill = 'none', stroke = null, strokeW = 0, opacity = 1, cap = 'round' }) {
    return this.svg(`<path d="${d}" fill="${fill}" fill-opacity="${opacity}"${stroke ? ` stroke="${stroke}" stroke-width="${strokeW}" stroke-linecap="${cap}" stroke-linejoin="round"` : ''}/>`);
  }

  icon(name, { x, y, size, color, strokeW = 2.4 }) {
    const d = ICONS[name];
    if (!d) return this;
    const s = size / 24;
    return this.svg(`<g transform="translate(${x} ${y}) scale(${s})"><path d="${d}" fill="none" stroke="${color}" stroke-width="${strokeW}" stroke-linecap="round" stroke-linejoin="round"/></g>`);
  }

  /** A filled circle with a centred icon (the check marks of a list, the arrow of a button). */
  badge(name, { cx, cy, r, fill, color, strokeW = 2.6, inner = 0.56 }) {
    this.circle({ cx, cy, r, fill });
    const size = r * 2 * inner;
    return this.icon(name, { x: cx - size / 2, y: cy - size / 2, size, color, strokeW });
  }

  async flush() {
    if (!this.pending.length) return;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${this.width}" height="${this.height}" viewBox="0 0 ${this.width} ${this.height}">${this.pending.join('')}</svg>`;
    this.pending = [];
    this.layers.push({ input: Buffer.from(svg), left: 0, top: 0 });
  }

  // images -------------------------------------------------------------
  async add(buffer, left, top) {
    await this.flush();
    const l = round(left); const t = round(top);
    const meta = await sharp(buffer).metadata();
    const w = meta.width; const h = meta.height;
    const x0 = Math.max(0, -l); const y0 = Math.max(0, -t);
    const x1 = Math.min(w, this.width - l); const y1 = Math.min(h, this.height - t);
    if (x1 <= x0 || y1 <= y0) return;
    if (x0 === 0 && y0 === 0 && x1 === w && y1 === h) { this.layers.push({ input: buffer, left: l, top: t }); return; }
    const clipped = await sharp(buffer).extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 }).png().toBuffer();
    this.layers.push({ input: clipped, left: l + x0, top: t + y0 });
  }

  /**
   * A photo cropped to cover a w x h frame and masked to a rounded rectangle or a circle, with an optional ring.
   * `buffer` is any decodable raster (the generated visual, a real product photo).
   */
  async photo(buffer, { x, y, w, h, radius = 0, circle = false, ring = null, position = 'attention', fit = 'cover', background = '#ffffff' }) {
    const W = round(w); const H = round(h);
    const resized = await sharp(buffer, { limitInputPixels: PIXEL_LIMIT }).rotate()
      .resize({ width: W, height: H, fit, position: fit === 'cover' ? (position === 'attention' ? sharp.strategy.attention : position) : 'centre', background })
      .flatten({ background }).png().toBuffer();
    const mask = circle
      ? `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><ellipse cx="${W / 2}" cy="${H / 2}" rx="${W / 2}" ry="${H / 2}" fill="#fff"/></svg>`
      : `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" rx="${radius}" ry="${radius}" fill="#fff"/></svg>`;
    const masked = await sharp(resized).composite([{ input: Buffer.from(mask), blend: 'dest-in' }]).png().toBuffer();
    await this.add(masked, x, y);
    if (ring) {
      if (circle) this.circle({ cx: x + w / 2, cy: y + h / 2, r: w / 2 - ring.width / 2, stroke: ring.color, strokeW: ring.width });
      else this.rect({ x: x + ring.width / 2, y: y + ring.width / 2, w: w - ring.width, h: h - ring.width, radius, stroke: ring.color, strokeW: ring.width });
    }
    return { x, y, w, h };
  }

  // text ---------------------------------------------------------------
  /**
   * A fitted text block inside the box (x, y, w, maxH). Returns where it landed ({ x, y, w, h, size }) so the layout can stack
   * the next element under it. `valign` places a block shorter than the box at the top, middle or bottom of it.
   */
  async text(content, { x, y, w, maxH, family, weight = 400, maxSize, minSize = 14, color = '#000000', align = 'left', valign = 'top', runs = null, lineGapRatio = 0, tracking = 0, label = 'text' }) {
    const r = await fitText({ text: content, runs, family, weight, width: w, maxHeight: maxH, maxSize, minSize, align, color, lineGapRatio, tracking });
    const left = align === 'center' ? x + (w - r.width) / 2 : align === 'right' ? x + w - r.width : x;
    const top = valign === 'middle' ? y + (maxH - r.height) / 2 : valign === 'bottom' ? y + maxH - r.height : y;
    await this.add(r.buffer, left, top);
    this.report.texts.push({ label, size: r.size, width: r.width, height: r.height });
    if (r.shortened) this.report.shortened.push(label);
    if (r.overflow) this.report.overflow.push(label);
    return { x: left, y: top, w: r.width, h: r.height, size: r.size };
  }

  /** One line of text (labels, list items, contact lines). Returns { x, y, w, h, size }. */
  async line(content, { x, y, maxW, family, weight = 600, maxSize, minSize = 12, color = '#000000', align = 'left', runs = null, tracking = 0, label = 'line', boxH = null, nudge = 0 }) {
    const r = await fitLine({ text: content, runs, family, weight, maxWidth: maxW, maxSize, minSize, color, tracking });
    const left = align === 'center' ? x + (maxW - r.width) / 2 : align === 'right' ? x + maxW - r.width : x;
    if (boxH != null) y += (boxH - r.height) / 2 + nudge * r.height;
    await this.add(r.buffer, left, y);
    this.report.texts.push({ label, size: r.size, width: r.width, height: r.height });
    if (r.shortened) this.report.shortened.push(label);
    if (r.overflow) this.report.overflow.push(label);
    return { x: left, y, w: r.width, h: r.height, size: r.size };
  }

  /** A button-like pill: filled rounded rectangle, a one-line label and (optionally) an arrow badge. Returns its rect. */
  async pill(label, { x, y, h, family, weight = 700, fill, color, maxW, arrow = null, tracking = 0 }) {
    const padX = round(h * 0.62);
    const arrowSpace = arrow ? h * 0.86 : 0;
    const textMax = maxW - padX * 2 - arrowSpace;
    const t = await fitLine({ text: label, family, weight, maxWidth: textMax, maxSize: round(h * 0.42), minSize: 12, color, tracking });
    this.report.texts.push({ label: 'cta', size: t.size, width: t.width, height: t.height });
    if (t.shortened) this.report.shortened.push('cta');
    const w = round(t.width + padX * 2 + arrowSpace);
    this.rect({ x, y, w, h, radius: h / 2, fill });
    await this.add(t.buffer, x + padX, y + (h - t.height) / 2 - h * 0.02);
    if (arrow) this.badge('arrow', { cx: x + w - h * 0.5 - h * 0.06, cy: y + h / 2, r: h * 0.36, fill: arrow.fill, color: arrow.color, strokeW: 2.8 });
    return { x, y, w, h };
  }

  // logo ---------------------------------------------------------------
  /**
   * The REAL logo, scaled to fit (maxW x maxH) with its aspect ratio untouched and never above its own pixels, optionally on a
   * rounded plate (so a dark logo is never lost on a dark surface). Returns the rect it occupies (incl. the plate).
   */
  async logo(png, { x, y, maxW, maxH, plate = null, align = 'left' }) {
    const pad = plate ? round(plate.pad ?? Math.min(maxW, maxH) * 0.12) : 0;
    const fitted = await sharp(png).resize({ width: Math.max(8, round(maxW - pad * 2)), height: Math.max(8, round(maxH - pad * 2)), fit: 'inside', withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true });
    const lw = fitted.info.width; const lh = fitted.info.height;
    const w = lw + pad * 2; const h = lh + pad * 2;
    const left = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    if (plate) this.rect({ x: left, y, w, h, radius: plate.radius ?? Math.min(w, h) * 0.2, fill: plate.fill, opacity: plate.opacity ?? 1 });
    await this.add(fitted.data, left + pad, y + pad);
    return { x: left, y, w, h, logoW: lw, logoH: lh };
  }

  async render() {
    await this.flush();
    return sharp({ create: { width: this.width, height: this.height, channels: 4, background: this.background } })
      .composite(this.layers).png().toBuffer();
  }
}

export { escapeXml };
