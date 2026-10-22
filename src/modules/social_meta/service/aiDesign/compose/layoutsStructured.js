import { cornerPath, emphasisRuns, placeLogo, contactLines, contactItems, themeOf, headlineBlock } from './layoutKit.js';

/**
 * Layouts built from structure instead of a photograph: numbered / process infographics, data-insight cards, the real
 * product showcase and the statement (quote) card. Everything shown is a point, figure, product fact, quote or contact detail
 * the brief supplies; a layout adds no wording of its own besides the one structural label "INTRODUCING".
 */

async function footer(scene, ctx, { y, onDark = false }) {
  const { W, u, pal, fonts, brief } = ctx;
  const contact = contactItems(brief);
  let x = 6 * u;
  if (brief.cta) {
    const pill = await scene.pill(brief.cta, { x, y, h: 7 * u, family: fonts.heading, fill: pal.bright, color: pal.onBright, maxW: W * 0.5, arrow: { fill: pal.onBright, color: pal.bright } });
    x += pill.w + 4 * u;
  }
  if (contact.length) await contactLines(scene, ctx, contact.slice(0, 2), { x, y: y + (brief.cta ? 0 : 0.4 * u), maxW: W - x - 6 * u, size: 2.4 * u, color: onDark ? '#ffffff' : pal.ink, iconColor: pal.bright, gap: 0.45 });
}

// ── numbered list / process ─────────────────────────────────────────────────

export async function infographicPoints(scene, ctx) {
  const { W, H, u, pal, fonts, brief, cls } = ctx;
  const wide = cls === 'wide';
  const points = (brief.points || []).slice(0, 5);
  const timeline = brief.pointStyle === 'process';
  const contact = contactItems(brief);
  const theme = themeOf(ctx, false);
  scene.rect({ x: 0, y: 0, w: W, h: H, fill: theme.soft });

  const headH = H * (wide ? 0.34 : cls === 'tall' ? 0.27 : 0.31);
  scene.path({ d: cornerPath(0, 0, W, headH, { bl: 7 * u, br: 7 * u }), fill: pal.deep });
  scene.circle({ cx: W * 0.94, cy: headH * 0.2, r: headH * 0.55, fill: pal.bright, opacity: 0.18 });
  await placeLogo(scene, ctx, { x: 5.5 * u, y: 4.6 * u, maxW: 34 * u, maxH: 10 * u, surface: pal.deep });
  const head = await headlineBlock(scene, ctx, {
    x: 6 * u, y: 16.5 * u, w: W - 12 * u, maxH: headH - 16.5 * u - 4 * u, family: fonts.heading, weight: 800, maxSize: 8.4 * u, minSize: 3.8 * u, valign: 'middle',
    color: '#ffffff', runs: emphasisRuns(brief.headline, '#ffffff', pal.bright), lineGapRatio: -0.12,
  });
  void head;

  let top = headH + 4 * u;
  const footerH = brief.cta || contact.length ? 11.5 * u : 3 * u;
  if (brief.subheadline) {
    const sub = await scene.text(brief.subheadline, { x: 6 * u, y: top, w: W - 12 * u, maxH: 9 * u, family: fonts.body, weight: 500, maxSize: 2.8 * u, minSize: 1.8 * u, color: theme.sub, label: 'subheadline' });
    top += sub.h + 2.6 * u;
  }
  const bottom = H - footerH - 2 * u;
  const cols = wide ? 2 : 1;
  const rows = Math.ceil(points.length / cols);
  const gap = 2.2 * u;
  const cardW = (W - 12 * u - gap * (cols - 1)) / cols;
  // a card is as tall as its text needs (never a big empty box), and the whole grid sits in the middle of the free height
  const cardH = Math.min((wide ? 19 : 16) * u, (bottom - top - gap * (rows - 1)) / rows);
  const gridOffset = Math.max(0, Math.min(6 * u, (bottom - top - (rows * cardH + gap * (rows - 1))) / 2));
  const numR = Math.min(cardH * 0.34, 4.4 * u);
  for (let i = 0; i < points.length; i += 1) {
    const col = i % cols; const row = Math.floor(i / cols);
    const spans = wide && i === points.length - 1 && points.length % 2 === 1; // a lone last card takes the whole row instead of leaving a hole
    const cw = spans ? W - 12 * u : cardW;
    const x = 6 * u + (spans ? 0 : col * (cardW + gap)); const y = top + gridOffset + row * (cardH + gap);
    scene.rect({ x, y, w: cw, h: cardH, radius: 2.4 * u, fill: '#ffffff', stroke: pal.deep, strokeW: 0.25 * u });
    const cx = x + numR + 2.2 * u; const cy = y + cardH / 2;
    if (timeline && i < points.length - 1 && cols === 1) scene.rect({ x: cx - 0.3 * u, y: cy + numR, w: 0.6 * u, h: cardH + gap - numR * 2 + 0.01, fill: pal.bright, opacity: 0.5 });
    scene.circle({ cx, cy, r: numR, fill: i % 2 === 0 ? pal.deep : pal.bright });
    if (timeline) scene.icon('check', { x: cx - numR * 0.5, y: cy - numR * 0.5, size: numR, color: i % 2 === 0 ? pal.onDeep : pal.onBright, strokeW: 3 });
    // eslint-disable-next-line no-await-in-loop
    else await scene.line(String(i + 1).padStart(2, '0'), { x: cx - numR, y: cy - numR, boxH: numR * 2, nudge: 0.04, maxW: numR * 2, family: fonts.heading, weight: 800, maxSize: numR * 0.95, minSize: 10, color: i % 2 === 0 ? pal.onDeep : pal.onBright, align: 'center', label: `numeral:${i}` });
    // eslint-disable-next-line no-await-in-loop
    await scene.text(points[i], { x: cx + numR + 2.4 * u, y: y + 1.4 * u, w: cw - (cx - x) - numR - 4.8 * u, maxH: cardH - 2.8 * u, family: fonts.body, weight: 600, maxSize: 3.3 * u, minSize: 1.8 * u, color: pal.deep, valign: 'middle', label: `point:${i}` });
  }
  if (brief.cta || contact.length) await footer(scene, ctx, { y: H - footerH + 1.2 * u, onDark: theme.dark });
}

// ── data insight ────────────────────────────────────────────────────────────

export async function insightStats(scene, ctx) {
  const { W, H, u, pal, fonts, brief, cls } = ctx;
  const wide = cls === 'wide';
  const figures = (brief.figures || []).slice(0, 3);
  const theme = themeOf(ctx, true);
  scene.rect({ x: 0, y: 0, w: W, h: H, fill: theme.dark ? pal.deep : pal.soft });
  scene.circle({ cx: W * 0.9, cy: H * 0.12, r: Math.min(W, H) * 0.4, fill: pal.bright, opacity: 0.16 });
  scene.circle({ cx: W * 0.05, cy: H * 1.0, r: Math.min(W, H) * 0.3, fill: pal.bright, opacity: 0.1 });
  await placeLogo(scene, ctx, { x: 5.5 * u, y: 4.8 * u, maxW: 34 * u, maxH: 10 * u, surface: theme.dark ? pal.deep : pal.soft });
  const head = await headlineBlock(scene, ctx, {
    x: 6 * u, y: 17 * u, w: W - 12 * u, maxH: H * (wide ? 0.3 : 0.25), family: fonts.heading, weight: 800, maxSize: 8 * u, minSize: 3.6 * u,
    color: theme.dark ? '#ffffff' : pal.deep, runs: emphasisRuns(brief.headline, theme.dark ? '#ffffff' : pal.deep, pal.bright), lineGapRatio: -0.12,
  });
  const top = 17 * u + head.h + 4 * u;
  const footerH = brief.cta ? 11 * u : 3 * u;
  const bottom = H - footerH - 2 * u;
  const horizontal = wide || figures.length === 1 ? figures.length > 1 : false;
  const n = Math.max(1, figures.length);
  const gap = 2.4 * u;
  const cardCap = (horizontal ? 46 : 30) * u;
  const fullH = horizontal ? bottom - top : (bottom - top - gap * (n - 1)) / n;
  const stackH = Math.min(fullH, cardCap);
  const groupH = horizontal ? stackH : n * stackH + gap * (n - 1);
  const groupTop = top + Math.max(0, Math.min(6 * u, ((bottom - top) - groupH) / 2));
  for (let i = 0; i < figures.length; i += 1) {
    const f = figures[i];
    const w = horizontal ? (W - 12 * u - gap * (n - 1)) / n : W - 12 * u;
    const x = 6 * u + (horizontal ? i * (w + gap) : 0);
    const y = horizontal ? groupTop : groupTop + i * (stackH + gap);
    scene.rect({ x, y, w, h: stackH, radius: 2.6 * u, fill: '#ffffff' });
    scene.rect({ x, y: y + stackH * 0.18, w: 1 * u, h: stackH * 0.64, fill: pal.bright, radius: 0.5 * u });
    const numW = horizontal ? w - 5 * u : Math.min(w * 0.4, 40 * u);
    // eslint-disable-next-line no-await-in-loop
    const num = await scene.line(f.value, { x: x + 3.2 * u, y: y + stackH * (horizontal ? 0.12 : 0.5) - (horizontal ? 0 : 4.6 * u), maxW: numW, family: fonts.heading, weight: 800, maxSize: Math.min(stackH * 0.5, 14 * u), minSize: 5 * u, color: pal.bright === '#ffffff' ? pal.deep : pal.deep, label: `figure:${i}` });
    // eslint-disable-next-line no-await-in-loop
    await scene.text(f.context, horizontal
      ? { x: x + 3.2 * u, y: y + num.h + 4 * u, w: w - 5.4 * u, maxH: stackH - num.h - 5.4 * u, family: fonts.body, weight: 500, maxSize: 2.7 * u, minSize: 1.7 * u, color: pal.ink, label: `context:${i}` }
      : { x: x + 3.2 * u + numW + 2.4 * u, y: y + 1.4 * u, w: w - numW - 8.4 * u, maxH: stackH - 2.8 * u, family: fonts.body, weight: 500, maxSize: 2.9 * u, minSize: 1.7 * u, color: pal.ink, valign: 'middle', label: `context:${i}` });
  }
  if (brief.cta || contactItems(brief).length) await footer(scene, ctx, { y: H - footerH + 1 * u, onDark: theme.dark });
}

// ── product showcase (the REAL product photo) ───────────────────────────────

export async function productHero(scene, ctx) {
  const { W, H, u, pal, fonts, brief, cls } = ctx;
  const wide = cls === 'wide';
  const product = brief.product || {};
  const bullets = (product.benefits || []).slice(0, 3);
  const contact = contactItems(brief);
  const theme = themeOf(ctx, false);
  scene.rect({ x: 0, y: 0, w: W, h: H, fill: theme.soft });
  const photoBox = wide
    ? { x: W * 0.05, y: H * 0.13, w: W * 0.4, h: H * 0.74 }
    : { x: W * 0.07, y: H * 0.15, w: W * 0.86, h: H * (cls === 'tall' ? 0.4 : 0.42) };
  // the accent disc stays BEHIND the photograph card (inside its own column): it must never reach the text, where accent-coloured words would vanish into it
  const disc = Math.min(photoBox.w, photoBox.h) * (wide ? 0.34 : 0.44);
  scene.circle({ cx: Math.min(photoBox.x + photoBox.w * 0.9, wide ? W * 0.47 - disc : W), cy: photoBox.y + photoBox.h * 0.1, r: disc, fill: pal.bright, opacity: 0.9 });
  scene.circle({ cx: photoBox.x + photoBox.w * 0.04, cy: photoBox.y + photoBox.h * 0.04, r: Math.min(photoBox.w, photoBox.h) * 0.12, fill: pal.deep });
  scene.rect({ ...photoBox, radius: 4 * u, fill: '#ffffff' });
  const real = (ctx.productImages || [])[0];
  if (real) await scene.photo(real, { x: photoBox.x + 1.4 * u, y: photoBox.y + 1.4 * u, w: photoBox.w - 2.8 * u, h: photoBox.h - 2.8 * u, radius: 3 * u, fit: 'contain', background: '#ffffff' });
  scene.rect({ ...photoBox, radius: 4 * u, stroke: pal.deep, strokeW: 0.3 * u });
  await placeLogo(scene, ctx, { x: 5.5 * u, y: 4 * u, maxW: 30 * u, maxH: 8.4 * u, surface: theme.soft });

  const tx = wide ? W * 0.5 : 6 * u;
  const tw = wide ? W * 0.45 : W - 12 * u;
  let y = wide ? H * 0.16 : photoBox.y + photoBox.h + 3.4 * u;
  if (brief.kicker) {
    const k = await scene.line(brief.kicker, { x: tx, y, maxW: tw, family: fonts.heading, weight: 700, maxSize: 2.4 * u, minSize: 1.5 * u, color: pal.bright, tracking: 0.2 * u, label: 'kicker' });
    y += k.h + 1 * u;
  }
  const name = await headlineBlock(scene, ctx, {
    text: product.name || brief.headline, x: tx, y, w: tw, maxH: H * (wide ? 0.26 : 0.17), family: fonts.heading, weight: 800, maxSize: 7.6 * u, minSize: 3.4 * u, color: theme.lead,
    runs: emphasisRuns(product.name || brief.headline, theme.lead, pal.bright), lineGapRatio: -0.12,
  });
  y += name.h + 2 * u;
  if (brief.subheadline && brief.subheadline !== product.name) {
    const sub = await scene.text(brief.subheadline, { x: tx, y, w: tw, maxH: 10 * u, family: fonts.body, weight: 500, maxSize: 2.8 * u, minSize: 1.8 * u, color: theme.sub, label: 'subheadline' });
    y += sub.h + 2.2 * u;
  }
  const footerReserve = (brief.cta ? 9.6 * u : 2 * u) + (contact.length && !wide ? 0 : 0);
  const room = H - footerReserve - y - 2 * u;
  const rowH = bullets.length ? Math.min(5.8 * u, room / bullets.length) : 0;
  for (let i = 0; i < bullets.length; i += 1) {
    if (rowH < 3.2 * u) break;
    const cy = y + rowH * i + rowH / 2;
    scene.badge('check', { cx: tx + 1.7 * u, cy, r: 1.6 * u, fill: pal.bright, color: pal.onBright, strokeW: 3 });
    // eslint-disable-next-line no-await-in-loop
    await scene.line(bullets[i], { x: tx + 4.4 * u, y: cy - 1.5 * u, maxW: tw - 4.4 * u, family: fonts.body, weight: 600, maxSize: 2.6 * u, minSize: 1.6 * u, color: theme.text, label: `benefit:${i}` });
  }
  if (brief.cta) {
    const pill = await scene.pill(brief.cta, { x: tx, y: H - 4 * u - 7 * u, h: 7 * u, family: fonts.heading, fill: pal.bright, color: pal.onBright, maxW: tw, arrow: { fill: pal.onBright, color: pal.bright } });
    if (contact.length) await contactLines(scene, ctx, contact.slice(0, 1), { x: tx + pill.w + 3.4 * u, y: H - 4 * u - 5.8 * u, maxW: tw - pill.w - 3.4 * u, size: 2.3 * u, color: theme.ink, iconColor: pal.bright, gap: 0 });
  }
}

// ── statement / quote ───────────────────────────────────────────────────────

export async function statementQuote(scene, ctx) {
  const { W, H, u, pal, fonts, brief } = ctx;
  const quote = brief.creativeType === 'quote';
  const theme = themeOf(ctx, true);
  scene.rect({ x: 0, y: 0, w: W, h: H, fill: theme.dark ? pal.deep : pal.soft });
  scene.circle({ cx: W * 0.88, cy: H * 0.14, r: Math.min(W, H) * 0.36, fill: pal.bright, opacity: 0.14 });
  scene.path({ d: cornerPath(0, H * 0.72, W * 0.5, H * 0.28, { tr: 9 * u }), fill: pal.bright, opacity: 0.12 });
  await placeLogo(scene, ctx, { x: 5.5 * u, y: 4.8 * u, maxW: 34 * u, maxH: 10 * u, surface: theme.dark ? pal.deep : pal.soft });
  if (quote) {
    const q = 0.62 * u; // one scale for both marks
    for (const dx of [0, 24 * q]) scene.svg(`<g transform="translate(${6 * u + dx + 14 * q} ${H * 0.16 + 32 * q}) rotate(180)"><path d="M14 0C6 3 0 10.5 0 20v12h14V20H8c0-5 2.4-8.4 6-10.6z" transform="scale(${q})" fill="${pal.bright}"/></g>`);
  }
  const y0 = quote ? H * 0.4 : H * 0.28; // a quote's marks are ~20u tall from 16% of the height: the text starts below them
  const ink = theme.dark ? '#ffffff' : pal.deep;
  const head = await headlineBlock(scene, ctx, {
    x: 6 * u, y: y0, w: W - 12 * u, maxH: H * 0.42, family: fonts.heading, weight: quote ? 700 : 800, maxSize: (quote ? 7.4 : 9.4) * u, minSize: 3.4 * u,
    color: ink, runs: quote ? [{ text: brief.headline, color: ink }] : emphasisRuns(brief.headline, ink, pal.bright), lineGapRatio: -0.1,
  });
  let y = y0 + head.h + 3 * u;
  scene.rect({ x: 6 * u, y, w: 14 * u, h: 1.1 * u, fill: pal.bright, radius: 0.55 * u });
  y += 4 * u;
  if (brief.subheadline) {
    const sub = await scene.text(brief.subheadline, { x: 6 * u, y, w: W - 12 * u, maxH: H * 0.14, family: fonts.body, weight: 500, maxSize: 3 * u, minSize: 1.8 * u, color: theme.dark ? '#e5e7eb' : pal.ink, label: 'subheadline' });
    y += sub.h + 3 * u;
  }
  if (brief.cta || contactItems(brief).length) await footer(scene, ctx, { y: H - 11.5 * u, onDark: theme.dark });
}

export const STRUCTURED_LAYOUTS = Object.freeze({ infographic_points: infographicPoints, insight_stats: insightStats, product_hero: productHero, statement_quote: statementQuote });
