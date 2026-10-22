import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

import { composeDesign, LAYOUTS } from './designComposer.js';
import { LAYOUT_NEEDS, missingForLayout } from './layoutNeeds.js';
import { fontsInstalled, matchFamily, resolveTypography, fontSpec, AVAILABLE_FAMILIES } from './designFonts.js';
import { buildPalette, contrast, readableOn, parseColor, luminance } from './designPalette.js';
import { fitText, escapeMarkup } from './designPrimitives.js';
import { prepareLogo } from '../designMedia.js';

/**
 * The composer, for real: real fonts, real sharp, real pixels. No network, no database, no image model - the photograph is a
 * generated test picture. Proves the deterministic half of the hybrid pipeline: every layout renders at every format, with the
 * brand colours, the real logo (never stretched), exactly the words of the brief, contact details only when supplied, and the
 * real product photo.
 */

const SIZES = { square: [1024, 1024], wide: [1536, 1024], tall: [1024, 1280], story: [1080, 1920] };
const BRAND = { primary: '#0b3270', secondary: '#e1570a', accent: null };

const photo = (w = 1200, h = 800, color = '#7a8a99') => sharp({ create: { width: w, height: h, channels: 3, background: color } })
  .composite([{ input: Buffer.from(`<svg width="${w}" height="${h}"><circle cx="${w * 0.4}" cy="${h * 0.45}" r="${h * 0.3}" fill="#c9b8a8"/></svg>`) }]).png().toBuffer();
const flat = (w, h, color) => sharp({ create: { width: w, height: h, channels: 3, background: color } }).png().toBuffer();
const logoPng = async (w = 400, h = 100, color = '#ff00ff') => prepareLogo(await sharp({ create: { width: w, height: h, channels: 4, background: color } }).png().toBuffer());

const base = (over = {}) => ({
  brandColors: BRAND, typography: { heading: 'Poppins', body: 'Poppins' }, tone: null, creativeType: 'premium_editorial',
  headline: 'Digital Marketing That Drives Growth', subheadline: 'Boost your business with tailored strategies.', points: [], services: [], figures: [], product: null,
  cta: 'Contact Us', contact: { phone: '+1 (332) 238-3228', website: 'sapphiredigitalagency.com', email: null }, ...over,
});
const CASES = {
  photo_hero: base({ layoutId: 'photo_hero' }),
  service_list: base({ layoutId: 'service_list', creativeType: 'service_promotion', services: ['Social Media Marketing', 'Search Engine Optimization', 'Pay-Per-Click Advertising', 'Content Marketing'], servicesLabel: 'OUR SERVICES' }),
  announcement_banner: base({ layoutId: 'announcement_banner', creativeType: 'announcement', headline: 'Free SEO Audit For Your Website' }),
  infographic_points: base({ layoutId: 'infographic_points', creativeType: 'educational_list', headline: '5 SEO Mistakes Costing You Traffic', subheadline: '', points: ['Ignoring search intent', 'Weak internal linking', 'Slow, bloated pages', 'Thin, copied content', 'No content strategy'], contact: { phone: null, website: null, email: null } }),
  insight_stats: base({ layoutId: 'insight_stats', creativeType: 'data_insight', headline: 'Organic traffic grew after the fixes', subheadline: '', figures: [{ value: '42%', context: 'Organic traffic growth in 90 days' }, { value: '3x', context: 'More qualified enquiries' }], contact: { phone: null, website: null, email: null } }),
  product_hero: base({ layoutId: 'product_hero', creativeType: 'product_showcase', headline: 'Meet the Growth Kit', product: { name: 'Growth Starter Kit', benefits: ['Done-for-you audit', 'Monthly report', 'Priority support'] }, kicker: 'INTRODUCING' }),
  statement_quote: base({ layoutId: 'statement_quote', creativeType: 'quote', headline: 'Positioning beats polish. Always.', subheadline: '', contact: { phone: null, website: null, email: null } }),
};
const compose = async (id, size, over = {}, assets = {}) => composeDesign({
  brief: { ...CASES[id], ...over }, size: { width: size[0], height: size[1] }, visual: LAYOUT_NEEDS[id].photo ? await photo() : null, logo: await logoPng(), productImages: id === 'product_hero' ? [await flat(900, 900, '#3366aa')] : [], ...assets,
});
const pixel = async (buffer, x, y) => { const { data } = await sharp(buffer).extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true }); return [data[0], data[1], data[2]]; };
const near = (a, hex, tol = 30) => { const c = parseColor(hex); return Math.hypot(a[0] - c.r, a[1] - c.g, a[2] - c.b) <= tol; };

describe('fonts and palette', () => {
  test('1: the shipped font files are all present, and a brand font name resolves to a shipped family (or falls back and says so)', () => {
    assert.equal(fontsInstalled(), true);
    assert.deepEqual([...AVAILABLE_FAMILIES].sort(), ['Inter', 'Manrope', 'Montserrat', 'Poppins', 'Sora']);
    assert.equal(matchFamily('Poppins'), 'Poppins');
    assert.equal(matchFamily('inter, sans-serif'), 'Inter');
    assert.equal(matchFamily('Poppins SemiBold'), 'Poppins');
    assert.equal(matchFamily('Comic Sans'), null);
    assert.equal(matchFamily(''), null);
    assert.deepEqual(resolveTypography({ heading: 'Montserrat', body: 'Inter' }), { heading: 'Montserrat', body: 'Inter', headingFromBrand: true, bodyFromBrand: true, brandFontUnavailable: false });
    assert.equal(resolveTypography({ heading: 'Papyrus' }).heading, 'Poppins');
    assert.equal(resolveTypography({ heading: 'Papyrus' }).brandFontUnavailable, true);
    assert.match(fontSpec('Poppins', 800).fontfile, /Poppins-ExtraBold\.ttf$/);
    assert.match(fontSpec('Inter', 700).fontfile, /Inter\.var\.ttf$/);
    assert.equal(fontSpec('Nope', 400).family, 'Poppins');
  });

  test('2: the palette IS the brand: the darkest colour is the deep tone, the most lively other colour the accent; text on them always has legible contrast', () => {
    const p = buildPalette(BRAND);
    assert.equal(p.deep, '#0b3270');
    assert.equal(p.bright, '#e1570a');
    assert.equal(p.fromBrand, true);
    assert.ok(contrast(p.onDeep, p.deep) >= 4.5);
    assert.ok(contrast(p.onBright, p.bright) >= 3, 'white on the brand orange, as designers do');
    assert.equal(readableOn('#ffffff'), '#0b1220');
    assert.equal(readableOn('#000000'), '#ffffff');
    assert.ok(luminance(p.soft) > 0.8, 'the soft background is a very light tint of the brand');
  });

  test('3: one brand colour yields a deep tone and a lively tone of IT; a colour too light for text is darkened; none configured is a neutral palette and says so', () => {
    const one = buildPalette({ primary: '#1d4ed8' });
    assert.equal(one.fromBrand, true);
    assert.notEqual(one.deep, one.bright);
    assert.ok(contrast(one.deep, '#ffffff') >= 4.5);
    const light = buildPalette({ primary: '#ffe08a' });
    assert.ok(contrast(light.deep, '#ffffff') >= 4.5, 'a pale yellow brand still carries white text');
    const none = buildPalette({});
    assert.equal(none.fromBrand, false);
    assert.deepEqual(none.notes, ['brand_colors_missing']);
    assert.equal(buildPalette({ primary: 'javascript:1' }).fromBrand, false);
  });
});

describe('text is fitted, never overflowed, never cut mid-word', () => {
  test('4: fitText shrinks to fit its box and wraps on words; a one-word headline wider than the box still fits (shrunk)', async () => {
    const small = await fitText({ text: 'Digital marketing that drives growth', family: 'Poppins', weight: 800, width: 400, maxHeight: 200, maxSize: 90, minSize: 20, color: '#000' });
    assert.ok(small.height <= 200 && small.width <= 401, `${small.width}x${small.height}`);
    assert.ok(small.size < 90);
    const wordy = await fitText({ text: 'Supercalifragilisticexpialidocious', family: 'Poppins', weight: 800, width: 300, maxHeight: 120, maxSize: 80, minSize: 14, color: '#000' });
    assert.ok(wordy.width <= 301 && wordy.height <= 120);
    const impossible = await fitText({ text: 'word '.repeat(80), family: 'Poppins', weight: 600, width: 300, maxHeight: 60, maxSize: 30, minSize: 14, color: '#000' });
    assert.equal(impossible.shortened, true);
    assert.ok(impossible.height <= 60 || impossible.overflow === true);
  });
  test('5: business text is only ever TEXT: markup characters are escaped and render literally', async () => {
    assert.equal(escapeMarkup('<b>Tom & "Jerry"</b>'), '&lt;b&gt;Tom &amp; "Jerry"&lt;/b&gt;');
    const r = await composeDesign({ brief: { ...CASES.statement_quote, headline: '<span foreground="#ff0000">Tom & Jerry</span>' }, size: { width: 1024, height: 1024 }, logo: null });
    assert.equal(r.report.overflow.length, 0);
    const meta = await sharp(r.buffer).metadata();
    assert.deepEqual([meta.width, meta.height], [1024, 1024]);
  });
});

describe('every layout renders at every format', () => {
  for (const [name, size] of Object.entries(SIZES)) {
    test(`6: every layout at ${name} (${size.join('x')}): exact size, a decodable PNG, no overflow, the logo placed, the words drawn`, async () => {
      for (const id of Object.keys(LAYOUTS)) {
        const started = Date.now();
        const { buffer, report } = await compose(id, size);
        const meta = await sharp(buffer).metadata();
        assert.deepEqual([meta.format, meta.width, meta.height], ['png', size[0], size[1]], id);
        assert.deepEqual(report.overflow, [], `${id}@${name} overflowed: ${report.overflow}`);
        assert.equal(report.logoApplied, true, id);
        assert.equal(report.layout, id);
        assert.ok(report.texts.some((t) => t.label === 'headline' || t.label === 'productName'), `${id}: the headline is drawn`);
        assert.ok(Date.now() - started < 6000, `${id} took ${Date.now() - started}ms`);
      }
    });
  }
});

describe('what is drawn is what the brief says', () => {
  test('7: the brand colours are on the design (the deep tone, the accent) - not random colours', async () => {
    const { buffer } = await compose('infographic_points', SIZES.square);
    assert.ok(near(await pixel(buffer, 700, 130), '#0b3270', 18), 'the header is the deep brand blue');
    const list = (await compose('service_list', SIZES.square)).buffer;
    assert.ok(near(await pixel(list, 1004, 1004), '#e1570a', 18), 'the contact block is the brand orange');
    assert.ok(near(await pixel(list, 100, 900), '#0b3270', 18) || near(await pixel(list, 200, 760), '#0b3270', 18), 'the services panel is the deep brand blue');
  });

  test('8: the REAL logo is placed with its aspect ratio untouched (a 4:1 logo stays 4:1) and is never enlarged beyond its pixels; without a logo nothing is drawn', async () => {
    const { buffer, report } = await compose('infographic_points', SIZES.square, {}, { logo: await logoPng(400, 100, '#ff00ff') });
    assert.equal(report.logoApplied, true);
    const { data, info } = await sharp(buffer).extract({ left: 0, top: 0, width: 520, height: 200 }).raw().toBuffer({ resolveWithObject: true });
    let minX = 1e9; let maxX = -1; let minY = 1e9; let maxY = -1;
    for (let y = 0; y < info.height; y += 1) for (let x = 0; x < info.width; x += 1) {
      const i = (y * info.width + x) * info.channels;
      if (data[i] > 230 && data[i + 1] < 40 && data[i + 2] > 230) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    }
    const ratio = (maxX - minX + 1) / (maxY - minY + 1);
    assert.ok(Math.abs(ratio - 4) < 0.15, `aspect ratio ${ratio.toFixed(2)}`);
    assert.ok(maxX - minX + 1 <= 400, 'never enlarged beyond its own pixels');
    const none = await compose('infographic_points', SIZES.square, {}, { logo: null });
    assert.equal(none.report.logoApplied, false);
  });

  test('9: a dark logo on a dark surface sits on a white plate (always legible); a normal logo on a light surface needs none', async () => {
    const dark = await logoPng(300, 100, '#101820');
    const { buffer } = await compose('infographic_points', SIZES.square, {}, { logo: dark }); // deep blue header
    assert.ok((await pixel(buffer, 62, 60)).every((v) => v > 230), 'the plate is white behind the logo');
    const light = await compose('photo_hero', SIZES.wide, {}, { logo: dark }); // white text column
    assert.ok(near(await pixel(light.buffer, 140, 90), '#101820', 30), 'the logo itself on white');
  });

  test('10: services, points, figures and the product benefits are drawn as listed - one size for every list item', async () => {
    const { report } = await compose('service_list', SIZES.tall);
    const sizes = report.texts.filter((t) => t.label.startsWith('service:')).map((t) => t.size);
    assert.equal(sizes.length, 4);
    assert.equal(new Set(sizes).size, 1, 'a list reads as a system: one size');
    const pts = (await compose('infographic_points', SIZES.square)).report.texts.filter((t) => t.label.startsWith('point:'));
    assert.equal(pts.length, 5);
    const stats = (await compose('insight_stats', SIZES.square)).report.texts.filter((t) => t.label.startsWith('figure:'));
    assert.equal(stats.length, 2);
    const product = (await compose('product_hero', SIZES.square)).report.texts.map((t) => t.label);
    assert.ok(product.includes('headline') && product.includes('kicker') && product.filter((l) => l.startsWith('benefit:')).length === 3);
  });

  test('11: contact details and the call to action are drawn ONLY when the brief supplies them (never a default phone, URL or button)', async () => {
    const withAll = (await compose('service_list', SIZES.square)).report.texts.map((t) => t.label);
    assert.ok(withAll.includes('contact:phone') && withAll.includes('contact:globe') && withAll.includes('cta'));
    const without = (await compose('service_list', SIZES.square, { contact: { phone: null, website: null, email: null }, cta: '' })).report.texts.map((t) => t.label);
    assert.equal(without.some((l) => l.startsWith('contact:')), false);
    assert.equal(without.includes('cta'), false);
    const onlyWeb = (await compose('announcement_banner', SIZES.square, { contact: { phone: null, website: 'example.com', email: null } })).report.texts.map((t) => t.label);
    assert.deepEqual(onlyWeb.filter((l) => l.startsWith('contact:')), ['contact:globe']);
  });

  test('12: the real product photo is the product on the design (a blue photo gives a blue card), cropped never stretched; a design cannot be made without it', async () => {
    const blue = (await compose('product_hero', SIZES.wide)).buffer;
    const [r, , b] = await pixel(blue, 384, 512);
    assert.ok(b > r + 60, 'the product card shows the supplied photograph');
    await assert.rejects(() => composeDesign({ brief: CASES.product_hero, size: { width: 1024, height: 1024 }, productImages: [] }), (e) => e.code === 'COMPOSE_INVALID' && e.reason === 'layout_needs_product_photo');
  });

  test('13: a photographic layout uses the supplied photograph; without one it says so and draws brand geometry - never a stand-in picture', async () => {
    const used = (await compose('photo_hero', SIZES.square)).report;
    assert.equal(used.visualUsed, true);
    const missing = await composeDesign({ brief: CASES.photo_hero, size: { width: 1024, height: 1024 }, visual: null, logo: null });
    assert.equal(missing.report.visualUsed, false);
    assert.ok(missing.report.notes.includes('visual_missing'));
    const meta = await sharp(missing.buffer).metadata();
    assert.equal(meta.width, 1024);
  });

  test('14: a layout the brief cannot fill is refused with a reason (no empty list, no empty stat card); an unknown layout and a missing headline too', async () => {
    for (const [id, over, reason] of [['infographic_points', { points: ['a', 'b'] }, 'layout_needs_points'], ['service_list', { services: ['only one'] }, 'layout_needs_services'], ['insight_stats', { figures: [] }, 'layout_needs_figures']]) {
      await assert.rejects(async () => composeDesign({ brief: { ...CASES[id], ...over }, size: { width: 1024, height: 1024 }, visual: await photo() }), (e) => e.code === 'COMPOSE_INVALID' && e.reason === reason, id);
    }
    await assert.rejects(() => composeDesign({ brief: { ...CASES.photo_hero, layoutId: 'nope' }, size: { width: 1024, height: 1024 } }), (e) => e.reason === 'unknown_layout');
    await assert.rejects(() => composeDesign({ brief: { ...CASES.photo_hero, headline: '' }, size: { width: 1024, height: 1024 } }), (e) => e.reason === 'no_headline');
    await assert.rejects(() => composeDesign({ brief: CASES.photo_hero, size: { width: 100, height: 100 } }), (e) => e.reason === 'size');
    assert.equal(missingForLayout('photo_hero', {}), null);
  });

  test('15: the brand font is used when it is a shipped family; an unavailable one falls back to Poppins and the report says so', async () => {
    const inter = await composeDesign({ brief: { ...CASES.statement_quote, typography: { heading: 'Montserrat', body: 'Inter' } }, size: { width: 1024, height: 1024 }, logo: null });
    assert.equal(inter.report.fonts.heading, 'Montserrat');
    assert.equal(inter.report.fonts.headingFromBrand, true);
    const unknown = await composeDesign({ brief: { ...CASES.statement_quote, typography: { heading: 'Papyrus', body: null } }, size: { width: 1024, height: 1024 }, logo: null });
    assert.equal(unknown.report.fonts.heading, 'Poppins');
    assert.ok(unknown.report.notes.includes('brand_font_unavailable'));
    assert.notDeepEqual(inter.buffer, unknown.buffer);
  });

  test('16: deterministic: the same brief, photograph and logo always produce the identical image; a different headline produces a different one', async () => {
    const a = await compose('service_list', SIZES.square);
    const b = await compose('service_list', SIZES.square);
    assert.deepEqual(a.buffer, b.buffer);
    const c = await compose('service_list', SIZES.square, { headline: 'A different headline here' });
    assert.notDeepEqual(a.buffer, c.buffer);
  });

  test('16b: regression (found in the browser run): the product accent disc never reaches the text column, where an accent-coloured word would vanish into it', async () => {
    for (const size of [SIZES.wide, SIZES.square, SIZES.tall]) {
      const { buffer } = await compose('product_hero', size, { product: { name: 'Growth Starter Kit', benefits: ['A', 'B', 'C'] } });
      if (size === SIZES.wide) {
        for (const y of [0.15, 0.25, 0.35, 0.45]) assert.ok(!near(await pixel(buffer, Math.round(size[0] * 0.495), Math.round(size[1] * y)), '#e1570a', 40), `the text column starts clear of the disc (y=${y})`);
      }
    }
  });

  test('16c: a service list of four or fewer in the wide format is ONE larger column, not two cramped ones', async () => {
    const wide = (await compose('service_list', SIZES.wide)).report.texts.filter((t) => t.label.startsWith('service:'));
    assert.equal(wide.length, 4);
    assert.ok(wide.every((t) => t.size >= 28), `sizes ${wide.map((t) => t.size)}`);
    const five = (await compose('service_list', SIZES.wide, { services: ['One', 'Two', 'Three', 'Four', 'Five'] })).report.texts.filter((t) => t.label.startsWith('service:'));
    assert.equal(five.length, 5);
  });

  test('17b: "darker" / "lighter" really change the page of EVERY layout (and leave each layout its own natural tone when nothing is asked)', async () => {
    const night = buildPalette(BRAND);
    const nightHex = (await import('./designPalette.js')).darken(night.deep, 0.5);
    for (const id of ['service_list', 'infographic_points', 'product_hero', 'photo_hero']) {
      const size = id === 'photo_hero' ? SIZES.wide : SIZES.square;
      const natural = await compose(id, size);
      const dark = await compose(id, size, { tone: 'dark' });
      assert.notDeepEqual(natural.buffer, dark.buffer, `${id}: darker changes the design`);
      const probe = { photo_hero: [20, 700], service_list: [900, 650], infographic_points: [20, 1000], product_hero: [20, 700] }[id]; // a spot of bare page in each layout
      assert.ok(near(await pixel(dark.buffer, probe[0], probe[1]), nightHex, 25), `${id}: the page is the dark brand tone`);
      assert.ok(luminance(`#${(await pixel(natural.buffer, probe[0], probe[1])).map((v) => v.toString(16).padStart(2, '0')).join('')}`) > 0.6, `${id}: a light page when nothing is asked`);
    }
    for (const id of ['statement_quote', 'insight_stats']) {
      const natural = await compose(id, SIZES.square);
      const light = await compose(id, SIZES.square, { tone: 'light' });
      assert.notDeepEqual(natural.buffer, light.buffer, `${id}: lighter changes the design`);
      assert.ok(luminance(`#${(await pixel(light.buffer, 20, 500)).map((v) => v.toString(16).padStart(2, '0')).join('')}`) > 0.6, `${id}: a light page`);
    }
    const unchanged = await compose('service_list', SIZES.square, { tone: null });
    assert.deepEqual(unchanged.buffer, (await compose('service_list', SIZES.square)).buffer);
  });

  test('17c: a headline size request is real where the layout has room (larger / smaller), and honestly reported where it does not', async () => {
    const headlineSize = (r) => r.report.texts.find((t) => t.label === 'headline').size;
    const short = { headline: 'Grow Faster', points: ['One point here', 'Two point here', 'Three point here'] };
    const base = await compose('infographic_points', SIZES.square, short);
    const larger = await compose('infographic_points', SIZES.square, { ...short, headlineScale: 1.15 });
    const smaller = await compose('infographic_points', SIZES.square, { ...short, headlineScale: 0.88 });
    assert.ok(headlineSize(larger) >= headlineSize(base) * 1.1, `${headlineSize(base)} -> ${headlineSize(larger)}`);
    assert.ok(headlineSize(smaller) <= headlineSize(base) * 0.92);
    assert.equal(larger.report.notes.includes('headline_scale_limited'), false);
    // a headline that already fills its box cannot grow: the size is unchanged AND the composition says so
    const full = await compose('service_list', SIZES.square, { headlineScale: 1.3 });
    assert.equal(full.report.notes.includes('headline_scale_limited'), true);
    assert.equal((await compose('service_list', SIZES.square, { headlineScale: 1 })).report.notes.includes('headline_scale_limited'), false);
  });

  test('17: tone and headline scale change the design (a darker background, a larger headline) within bounds', async () => {
    const dark = await compose('announcement_banner', SIZES.square, { tone: 'dark' });
    const light = await compose('announcement_banner', SIZES.square, { tone: 'light' });
    assert.notDeepEqual(dark.buffer, light.buffer);
    assert.ok(near(await pixel(dark.buffer, 20, 500), '#0b3270', 20), 'dark: the deep brand tone');
    assert.ok(near(await pixel(light.buffer, 20, 500), '#e1570a', 20), 'light: the brand accent');
  });
});
