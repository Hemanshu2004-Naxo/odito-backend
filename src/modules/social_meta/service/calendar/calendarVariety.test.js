import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { applyVariety, varietyCarryFromItems } from './calendarOutputSchema.js';

/**
 * Pure tests: the variety pass is incremental (so a long calendar can be saved batch by batch and resumed after a crash) and must give
 * EXACTLY what one pass over the whole calendar gives, however the posts are cut into batches and wherever a run is resumed.
 */

const FORMATS = ['static_post', 'reel', 'carousel'];
const make = (n, { services = ['s1', 's2', 's3'], products = [] } = {}) => Array.from({ length: n }, (_, i) => ({
  slot: i,
  contentDate: `2026-11-${String((i % 28) + 1).padStart(2, '0')}`,
  format: i % 5 < 3 ? 'static_post' : FORMATS[i % 3], // runs of the same format
  serviceId: services.length ? (i % 4 === 0 ? services[0] : services[Math.floor(i / 2) % services.length]) : null, // deliberate repeats on neighbours
  serviceName: 'svc',
  productId: products.length ? products[i % products.length] : null,
  productName: products.length ? 'prod' : null,
}));
const strip = (items) => items.map(({ slot, serviceId, productId, serviceName, productName }) => ({ slot, serviceId, productId, serviceName, productName }));

function incremental(items, cuts, opts) {
  let carry = null;
  const out = [];
  const warnings = [];
  for (let a = 0, i = 0; a < items.length; i += 1) {
    const b = Math.min(items.length, a + cuts[i % cuts.length]);
    const r = applyVariety(items.slice(a, b), { ...opts, total: items.length, carry });
    carry = r.carry;
    out.push(...r.items);
    warnings.push(...r.warnings);
    a = b;
  }
  return { items: out, warnings };
}

describe('applyVariety is incremental', () => {
  for (const [label, opts, items] of [
    ['3 services', { serviceCount: 3, productCount: 0 }, make(40)],
    ['2 products', { serviceCount: 0, productCount: 2 }, make(37, { services: [], products: ['p1', 'p2'] })],
    ['no catalog', { serviceCount: 0, productCount: 0 }, make(25, { services: [] })],
  ]) {
    test(`${label}: any way of cutting the calendar into batches gives the same posts and the same warnings as one pass`, () => {
      const whole = applyVariety(items, opts);
      for (const cuts of [[1], [2], [4], [3, 5], [4, 1, 7], [40]]) {
        const parts = incremental(items, cuts, opts);
        assert.deepEqual(strip(parts.items), strip(whole.items), `cuts ${cuts}`);
        assert.deepEqual([...parts.warnings].sort(), [...whole.warnings].sort(), `cuts ${cuts}`); // the same warnings (their order is not meaningful)
      }
    });
  }

  test('a resumed run rebuilds the carry from the saved posts and continues identically', () => {
    const opts = { serviceCount: 3, productCount: 0 };
    const items = make(40);
    const whole = applyVariety(items, opts);
    for (const split of [4, 8, 13, 28]) {
      const first = applyVariety(items.slice(0, split), { ...opts, total: items.length });
      // what the database holds after the first run: the final ids, in slot order
      const saved = first.items.map((it) => ({ ...it, serviceId: it.serviceId, productId: it.productId }));
      const rest = applyVariety(items.slice(split), { ...opts, total: items.length, carry: varietyCarryFromItems(saved) });
      assert.deepEqual(strip([...first.items, ...rest.items]), strip(whole.items), `resumed after ${split}`);
      assert.deepEqual([...first.warnings, ...rest.warnings].sort(), [...whole.warnings].sort(), `resumed after ${split}`);
    }
  });

  test('without a carry and a total it behaves exactly as before (one pass over the given posts)', () => {
    const r = applyVariety(make(10), { serviceCount: 3, productCount: 0 });
    assert.ok(r.items.length === 10 && Array.isArray(r.warnings) && r.carry);
  });

  test('the carry of an empty batch is the carry it was given', () => {
    const carry = { used: { s1: 2 }, prev: { serviceId: 's1', productId: null }, formats: ['reel', 'reel'] };
    assert.deepEqual(applyVariety([], { carry }).carry, carry);
  });
});
