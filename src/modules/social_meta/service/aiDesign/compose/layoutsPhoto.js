import { cornerPath, emphasisRuns, placeLogo, contactLines, contactItems, fadeRect, tint, themeOf, headlineBlock } from './layoutKit.js';
import { fitLine, uniformSize } from './designPrimitives.js';

/**
 * Layouts that carry a PHOTOGRAPH (the AI-generated visual). The photo is cropped to its frame here; every word, the logo and
 * every contact detail is drawn by Odito. A layout never draws a word the brief did not supply.
 *
 * Each is an async (scene, ctx) => void. ctx: { W, H, cls, u, pal, fonts, brief, visual, logo }.
 */

const FOOTER_NOTE = 'visual_missing';

/** What stands in for the photo frame when the visual could not be produced: brand geometry, never a fake photo. */
function noVisual(scene, ctx, { x, y, w, h, circle = false, radius = 0 }) {
  ctx.notes.add(FOOTER_NOTE);
  const { pal } = ctx;
  if (circle) { scene.circle({ cx: x + w / 2, cy: y + h / 2, r: w / 2, fill: pal.deep }); scene.circle({ cx: x + w * 0.62, cy: y + h * 0.4, r: w * 0.28, fill: pal.bright, opacity: 0.9 }); return; }
  scene.rect({ x, y, w, h, radius, fill: pal.deep });
  scene.circle({ cx: x + w * 0.7, cy: y + h * 0.35, r: Math.min(w, h) * 0.32, fill: pal.bright, opacity: 0.85 });
}

// ── photography-led editorial ───────────────────────────────────────────────

export async function photoHero(scene, ctx) {
  const { W, H, u, pal, fonts, brief, cls } = ctx;
  const wide = cls === 'wide';
  const contact = contactItems(brief);
  const theme = themeOf(ctx, false);
  scene.rect({ x: 0, y: 0, w: W, h: H, fill: theme.page });

  if (!wide) {
    // no button and no contact line below the copy: the photograph takes that room instead of leaving it blank
    const photoH = Math.round(H * ((cls === 'tall' ? 0.6 : 0.64) + (brief.cta || contact.length ? 0 : 0.08)));
    const frame = { x: 0, y: 0, w: W, h: photoH };
    if (ctx.visual) await scene.photo(ctx.visual, { ...frame, radius: 0 });
    else noVisual(scene, ctx, frame);
    // masked bottom corners: a paper-coloured cut so the photo's lower edge is a soft curve
    scene.path({ d: `M0 ${photoH - 7 * u}Q0 ${photoH} ${7 * u} ${photoH}H0Z`, fill: theme.page });
    scene.path({ d: `M${W} ${photoH - 7 * u}Q${W} ${photoH} ${W - 7 * u} ${photoH}H${W}Z`, fill: theme.page });
    fadeRect(scene, { x: 0, y: photoH * 0.34, w: W, h: photoH * 0.66, color: pal.deep, from: 0, to: 0.93, id: 'ph-fade' });
    await placeLogo(scene, ctx, { x: 5 * u, y: 5 * u, maxW: 36 * u, maxH: 10 * u, surface: '#ffffff' });

    const head = await headlineBlock(scene, ctx, {
      x: 6 * u, y: photoH * 0.5, w: W - 12 * u, maxH: photoH * 0.5 - 4 * u, family: fonts.heading, weight: 800, maxSize: 9.4 * u, minSize: 4.2 * u,
      color: '#ffffff', runs: emphasisRuns(brief.headline, '#ffffff', pal.bright), valign: 'bottom', lineGapRatio: -0.12,
    });
    void head;
    // accent bar under the photo, then the supporting copy, CTA and contact on paper
    scene.rect({ x: 6 * u, y: photoH + 2.2 * u, w: 11 * u, h: 1.1 * u, fill: pal.bright, radius: 0.6 * u });
    const y = photoH + 5.4 * u;
    const rowH = 7.4 * u;
    const rowY = H - 4.2 * u - rowH;
    if (brief.subheadline) {
      await scene.text(brief.subheadline, { x: 6 * u, y, w: W - 12 * u, maxH: Math.max(5 * u, rowY - y - 2.4 * u), family: fonts.body, weight: 500, maxSize: 3.3 * u, minSize: 2 * u, color: theme.sub, label: 'subheadline' });
    }
    let x = 6 * u;
    if (brief.cta) {
      const pill = await scene.pill(brief.cta, { x, y: rowY, h: rowH, family: fonts.heading, fill: pal.bright, color: pal.onBright, maxW: 46 * u, arrow: { fill: pal.onBright, color: pal.bright } });
      x += pill.w + 4 * u;
    }
    if (contact.length) {
      const room = W - x - 6 * u;
      await contactLines(scene, ctx, contact.slice(0, 2), { x, y: rowY + (contact.length > 1 ? 0 : rowH * 0.2), maxW: room, size: 2.5 * u, color: theme.ink, iconColor: pal.bright, gap: 0.5 });
    }
    return;
  }

  // wide: a text column on the left, the photograph full-height on the right
  const split = Math.round(W * 0.46);
  const frame = { x: split, y: 0, w: W - split, h: H };
  if (ctx.visual) await scene.photo(ctx.visual, { ...frame, radius: 0 });
  else noVisual(scene, ctx, frame);
  scene.path({ d: cornerPath(split - 1, 0, 9 * u, H, { tr: 0, br: 0 }), fill: 'none' });
  scene.rect({ x: split - 1.1 * u, y: 0, w: 1.1 * u, h: H, fill: pal.bright });
  scene.rect({ x: 0, y: 0, w: split, h: H, fill: theme.page });
  await placeLogo(scene, ctx, { x: 5 * u, y: 4.6 * u, maxW: 30 * u, maxH: 9.5 * u, surface: theme.page });
  // with nothing to put under the copy (no button, no contact line) the text block sits lower, so the column is balanced instead of top-heavy with an empty bottom half
  let y = brief.cta || contact.length ? 17 * u : H * 0.26;
  const head = await headlineBlock(scene, ctx, {
    x: 5 * u, y, w: split - 10 * u, maxH: H * 0.4, family: fonts.heading, weight: 800, maxSize: 8.6 * u, minSize: 4 * u,
    color: theme.lead, runs: emphasisRuns(brief.headline, theme.lead, pal.bright), lineGapRatio: -0.12,
  });
  y += head.h + 3 * u;
  if (brief.subheadline) {
    const sub = await scene.text(brief.subheadline, { x: 5 * u, y, w: split - 10 * u, maxH: 17 * u, family: fonts.body, weight: 500, maxSize: 3 * u, minSize: 2 * u, color: theme.sub, label: 'subheadline' });
    y += sub.h + 3 * u;
  }
  if (brief.cta) {
    const pill = await scene.pill(brief.cta, { x: 5 * u, y, h: 7.2 * u, family: fonts.heading, fill: pal.bright, color: pal.onBright, maxW: split - 10 * u, arrow: { fill: pal.onBright, color: pal.bright } });
    y += pill.h + 3 * u;
  }
  if (contact.length) await contactLines(scene, ctx, contact.slice(0, 2), { x: 5 * u, y: Math.max(y, H - 17 * u), maxW: split - 10 * u, size: 2.5 * u, color: theme.ink, iconColor: pal.bright, gap: 0.5 });
}

// ── services / lead generation (the reference's design language) ────────────

export async function serviceList(scene, ctx) {
  const { W, H, u, pal, fonts, brief, cls } = ctx;
  const wide = cls === 'wide';
  const items = (brief.services || []).slice(0, wide ? 6 : 5);
  const contact = contactItems(brief);
  const theme = themeOf(ctx, false);
  scene.rect({ x: 0, y: 0, w: W, h: H, fill: theme.page });

  if (!wide) {
    // top-right: a deep block with the photograph in a ringed circle
    scene.path({ d: cornerPath(W * 0.5, 0, W * 0.5, H * 0.33, { bl: W * 0.16 }), fill: pal.deep });
    scene.path({ d: cornerPath(W * 0.47, 0, 4 * u, H * 0.12, { br: 4 * u }), fill: pal.bright });
    const d = W * 0.47;
    const cx = W * 0.745; const cy = H * 0.275;
    scene.circle({ cx, cy, r: d / 2 + 1.6 * u, fill: pal.bright });
    if (ctx.visual) await scene.photo(ctx.visual, { x: cx - d / 2, y: cy - d / 2, w: d, h: d, circle: true });
    else noVisual(scene, ctx, { x: cx - d / 2, y: cy - d / 2, w: d, h: d, circle: true });

    await placeLogo(scene, ctx, { x: 5.5 * u, y: 5 * u, maxW: 38 * u, maxH: 12 * u, surface: theme.page });
    const head = await headlineBlock(scene, ctx, {
      x: 5.5 * u, y: H * 0.205, w: W * 0.47, maxH: H * 0.27, family: fonts.heading, weight: 800, maxSize: 7.4 * u, minSize: 3.6 * u,
      color: theme.lead, runs: emphasisRuns(brief.headline, theme.lead, pal.bright), lineGapRatio: -0.12,
    });
    let y = H * 0.205 + head.h + 2.2 * u;
    if (brief.subheadline) {
      await scene.text(brief.subheadline, { x: 5.5 * u, y, w: W * 0.5, maxH: Math.max(6 * u, H * 0.6 - 6.2 * u - 3.8 * u - y), family: fonts.body, weight: 500, maxSize: 2.7 * u, minSize: 1.8 * u, color: theme.sub, label: 'subheadline' });
    }

    // the services panel (deep) with its tab, the check list, the call to action
    const panelY = H * 0.6;
    const panelW = W * (contact.length ? 0.64 : 0.78);
    scene.path({ d: cornerPath(0, panelY, panelW, H - panelY, { tr: 7 * u }), fill: pal.deep });
    const tabLabel = await fitLine({ text: brief.servicesLabel || 'OUR SERVICES', family: fonts.heading, weight: 700, maxWidth: W * 0.6, maxSize: 2.6 * u, minSize: 1.6 * u, color: pal.onBright, tracking: 0.15 * u });
    scene.path({ d: cornerPath(0, panelY - 6.2 * u, tabLabel.width + 11 * u, 6.2 * u, { tr: 3.1 * u }), fill: pal.bright });
    await scene.add(tabLabel.buffer, 5.5 * u, panelY - 6.2 * u + (6.2 * u - tabLabel.height) / 2);
    const listTop = panelY + 4.2 * u;
    const ctaH = brief.cta ? 7.2 * u : 0;
    const listBottom = H - 4 * u - (brief.cta ? ctaH + 3.4 * u : 0);
    const rowH = Math.min(7.6 * u, (listBottom - listTop) / Math.max(1, items.length));
    const listSize = await uniformSize(items, { family: fonts.body, weight: 600, maxWidth: panelW - 11.4 * u - 4 * u, maxSize: 2.9 * u, minSize: 1.7 * u });
    for (let i = 0; i < items.length; i += 1) {
      const cy = listTop + rowH * i + rowH / 2;
      scene.badge('check', { cx: 7.6 * u, cy, r: 1.9 * u, fill: pal.bright, color: pal.onBright, strokeW: 3 });
      // eslint-disable-next-line no-await-in-loop
      const t = await scene.line(items[i], { x: 11.4 * u, y: cy - 1.8 * u, maxW: panelW - 11.4 * u - 4 * u, family: fonts.body, weight: 600, maxSize: listSize, minSize: listSize, color: pal.onDeep, label: `service:${i}` });
      void t;
    }
    if (brief.cta) await scene.pill(brief.cta, { x: 5.5 * u, y: H - 4 * u - ctaH, h: ctaH, family: fonts.heading, fill: '#ffffff', color: pal.deep, maxW: panelW - 11 * u, arrow: { fill: pal.bright, color: pal.onBright } });

    if (contact.length) {
      const bx = W * 0.62; const by = H * 0.76;
      scene.path({ d: cornerPath(bx, by, W - bx, H - by, { tl: 8 * u }), fill: pal.bright });
      await contactLines(scene, ctx, contact.slice(0, 3), { x: bx + 5 * u, y: by + 5.4 * u, maxW: W - bx - 7.5 * u, size: 2.5 * u, color: pal.onBright, gap: 0.85 });
    }
    return;
  }

  // wide: headline + services on the left, the photograph and contact on the right
  const rightX = Math.round(W * 0.6);
  scene.path({ d: cornerPath(rightX, 0, W - rightX, H, { bl: 10 * u }), fill: pal.deep });
  const d = (W - rightX) * 0.78;
  const cx = rightX + (W - rightX) / 2; const cy = H * 0.36;
  scene.circle({ cx, cy, r: d / 2 + 1.5 * u, fill: pal.bright });
  if (ctx.visual) await scene.photo(ctx.visual, { x: cx - d / 2, y: cy - d / 2, w: d, h: d, circle: true });
  else noVisual(scene, ctx, { x: cx - d / 2, y: cy - d / 2, w: d, h: d, circle: true });
  if (contact.length) await contactLines(scene, ctx, contact.slice(0, 3), { x: rightX + 6 * u, y: H * 0.72, maxW: W - rightX - 9 * u, size: 2.6 * u, color: pal.onDeep, iconColor: pal.bright, gap: 0.9 });
  await placeLogo(scene, ctx, { x: 5 * u, y: 4.6 * u, maxW: 30 * u, maxH: 10 * u, surface: theme.page });
  const head = await headlineBlock(scene, ctx, { x: 5 * u, y: 17 * u, w: rightX - 10 * u, maxH: H * 0.3, family: fonts.heading, weight: 800, maxSize: 8 * u, minSize: 3.6 * u, color: theme.lead, runs: emphasisRuns(brief.headline, theme.lead, pal.bright), lineGapRatio: -0.12 });
  let y = 17 * u + head.h + 2.4 * u;
  if (brief.subheadline) {
    const sub = await scene.text(brief.subheadline, { x: 5 * u, y, w: rightX - 10 * u, maxH: 12 * u, family: fonts.body, weight: 500, maxSize: 2.8 * u, minSize: 1.8 * u, color: theme.sub, label: 'subheadline' });
    y += sub.h + 3 * u;
  }
  const panelY = Math.max(y + 6 * u, H * 0.58);
  scene.path({ d: cornerPath(0, panelY, rightX - 4 * u, H - panelY, { tr: 6 * u }), fill: pal.deep });
  const wTab = await fitLine({ text: brief.servicesLabel || 'OUR SERVICES', family: fonts.heading, weight: 700, maxWidth: rightX * 0.6, maxSize: 2.4 * u, minSize: 1.5 * u, color: pal.onBright, tracking: 0.15 * u });
  scene.path({ d: cornerPath(0, panelY - 5.6 * u, wTab.width + 10 * u, 5.6 * u, { tr: 2.8 * u }), fill: pal.bright });
  await scene.add(wTab.buffer, 5 * u, panelY - 5.6 * u + (5.6 * u - wTab.height) / 2);
  const cols = items.length > 4 ? 2 : 1; // four or fewer read better as ONE larger column
  const colW = (rightX - 4 * u - 10 * u) / cols;
  const rows = Math.ceil(items.length / cols);
  const listTop = panelY + 4 * u; const ctaRoom = brief.cta ? 11 * u : 0;
  const rowH = Math.min(9.4 * u, (H - 3 * u - ctaRoom - listTop) / Math.max(1, rows));
  const wideSize = await uniformSize(items, { family: fonts.body, weight: 600, maxWidth: colW - 6 * u, maxSize: 3 * u, minSize: 1.6 * u });
  for (let i = 0; i < items.length; i += 1) {
    const col = i % cols; const row = Math.floor(i / cols);
    const cx2 = 5 * u + col * colW + 1.8 * u; const cy2 = listTop + rowH * row + rowH / 2;
    scene.badge('check', { cx: cx2, cy: cy2, r: 1.7 * u, fill: pal.bright, color: pal.onBright, strokeW: 3 });
    // eslint-disable-next-line no-await-in-loop
    await scene.line(items[i], { x: cx2 + 3.2 * u, y: cy2 - 1.6 * u, maxW: colW - 6 * u, family: fonts.body, weight: 600, maxSize: wideSize, minSize: wideSize, color: pal.onDeep, label: `service:${i}` });
  }
  if (brief.cta) await scene.pill(brief.cta, { x: 5 * u, y: H - 3 * u - 6.6 * u, h: 6.6 * u, family: fonts.heading, fill: '#ffffff', color: pal.deep, maxW: 40 * u, arrow: { fill: pal.bright, color: pal.onBright } });
}

// ── announcement banner ─────────────────────────────────────────────────────

export async function announcementBanner(scene, ctx) {
  const { W, H, u, pal, fonts, brief, cls } = ctx;
  const wide = cls === 'wide';
  const contact = contactItems(brief);
  const dark = themeOf(ctx, true).dark;
  const field = dark ? pal.deep : pal.bright;
  const onField = dark ? pal.onDeep : pal.onBright;
  const accent = dark ? pal.bright : pal.deep;
  scene.rect({ x: 0, y: 0, w: W, h: H, fill: field });
  scene.circle({ cx: W * 0.92, cy: H * 0.08, r: Math.min(W, H) * 0.34, fill: accent, opacity: 0.2 });
  scene.circle({ cx: W * 0.04, cy: H * 0.98, r: Math.min(W, H) * 0.26, fill: accent, opacity: 0.16 });

  await placeLogo(scene, ctx, { x: 5.5 * u, y: 5 * u, maxW: 34 * u, maxH: 11 * u, surface: field });
  const photoD = wide ? H * 0.62 : Math.min(W, H) * 0.34;
  // the text column ends before the photograph's ring (centre at 78% of the width): copy must never run into the picture
  const ringLeft = W * 0.78 - photoD / 2 - 1.4 * u;
  const textW = wide ? Math.min(W * 0.56, ringLeft - 6 * u - 3 * u) : W - 12 * u;
  let y = wide ? H * 0.2 : H * 0.2;
  const head = await headlineBlock(scene, ctx, {
    x: 6 * u, y, w: textW, maxH: H * (wide ? 0.42 : 0.3), family: fonts.heading, weight: 800, maxSize: (wide ? 9.2 : 9.6) * u, minSize: 4 * u,
    color: onField, runs: emphasisRuns(brief.headline, onField, dark ? pal.bright : '#ffffff'), lineGapRatio: -0.12,
  });
  y += head.h + 3 * u;
  if (brief.subheadline) {
    const sub = await scene.text(brief.subheadline, { x: 6 * u, y, w: textW, maxH: 16 * u, family: fonts.body, weight: 500, maxSize: 3.1 * u, minSize: 2 * u, color: onField, label: 'subheadline' });
    y += sub.h + 3.4 * u;
  }
  if (brief.cta) await scene.pill(brief.cta, { x: 6 * u, y, h: 7.6 * u, family: fonts.heading, fill: '#ffffff', color: dark ? pal.deep : pal.deep, maxW: textW, arrow: { fill: dark ? pal.bright : pal.deep, color: dark ? pal.onBright : '#ffffff' } });

  if (wide) {
    const cx = W * 0.78; const cy = H * 0.46;
    scene.circle({ cx, cy, r: photoD / 2 + 1.4 * u, fill: dark ? pal.bright : '#ffffff' });
    if (ctx.visual) await scene.photo(ctx.visual, { x: cx - photoD / 2, y: cy - photoD / 2, w: photoD, h: photoD, circle: true });
    else noVisual(scene, ctx, { x: cx - photoD / 2, y: cy - photoD / 2, w: photoD, h: photoD, circle: true });
  } else if (ctx.visual) {
    const cx = W * 0.8; const cy = H * 0.7;
    scene.circle({ cx, cy, r: photoD / 2 + 1.4 * u, fill: dark ? pal.bright : '#ffffff' });
    await scene.photo(ctx.visual, { x: cx - photoD / 2, y: cy - photoD / 2, w: photoD, h: photoD, circle: true });
  }
  if (contact.length) {
    const barH = (contact.length > 1 ? 10 : 7) * u;
    scene.rect({ x: 0, y: H - barH, w: W, h: barH, fill: dark ? pal.bright : pal.deep });
    const cols = contact.slice(0, 3);
    const each = (W - 12 * u) / cols.length;
    for (let i = 0; i < cols.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await contactLines(scene, ctx, [cols[i]], { x: 6 * u + each * i, y: H - barH + (barH - 2.9 * u) / 2, maxW: each - 2 * u, size: 2.5 * u, color: dark ? pal.onBright : '#ffffff', iconColor: dark ? pal.onBright : pal.bright, gap: 0 });
    }
  }
  void tint;
}

export const PHOTO_LAYOUTS = Object.freeze({ photo_hero: photoHero, service_list: serviceList, announcement_banner: announcementBanner });
