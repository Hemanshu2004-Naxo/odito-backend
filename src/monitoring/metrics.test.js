import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { counter, gauge, histogram, registerCollector, renderMetrics, resetMetricValues } from './metrics.js';

/** Pure tests: the registry bounds cardinality by construction, renders Prometheus text, and never throws into the code it observes. */

let n = 0;
const uniq = (base) => `${base}_${process.pid}_${n += 1}`;
const lines = (text) => text.split('\n').filter((l) => l && !l.startsWith('#'));

describe('metrics registry', () => {
  beforeEach(() => resetMetricValues());

  test('1: a labelled metric must list every value its label may take; unlabelled ones must not', () => {
    assert.throws(() => counter({ name: uniq('m'), help: 'x', label: 'outcome' }), /explicit list of allowed values/);
    assert.throws(() => counter({ name: uniq('m'), help: 'x', label: 'outcome', allowed: [] }), /explicit list/);
    assert.throws(() => counter({ name: uniq('m'), help: 'x', allowed: ['a'] }), /without a label/);
    assert.throws(() => counter({ name: 'bad name', help: 'x' }), /invalid metric name/);
    const name = uniq('dup');
    counter({ name, help: 'x' });
    assert.throws(() => counter({ name, help: 'x' }), /already defined/);
  });

  test('2: every allowed value exists from the start at zero, so rate() and increase() work before the first event', async () => {
    const name = uniq('seeded');
    counter({ name, help: 'x', label: 'outcome', allowed: ['ok', 'bad'] });
    const out = lines(await renderMetrics()).filter((l) => l.startsWith(name));
    assert.deepEqual(out.sort(), [`${name}{outcome="bad"} 0`, `${name}{outcome="ok"} 0`, `${name}{outcome="other"} 0`]);
  });

  test('3: a value outside the list is recorded as "other" - an id, a URL, a token or an exception message can never become a series', async () => {
    const name = uniq('bounded');
    const c = counter({ name, help: 'x', label: 'code', allowed: ['A', 'B'] });
    c.inc('A');
    for (const hostile of ['6acdc368dfdd3468860b6348', 'https://evil.example/?token=abc', 'Error: connection refused 10.0.0.5:27017', 'a'.repeat(5000), undefined, null, 42, '"}\n# injected']) c.inc(hostile);
    const out = lines(await renderMetrics()).filter((l) => l.startsWith(name));
    assert.deepEqual(out.sort(), [`${name}{code="A"} 1`, `${name}{code="B"} 0`, `${name}{code="other"} 8`]);
    assert.equal(out.length, 3, 'three series however many hostile values were recorded');
  });

  test('4: counters only go up, by positive finite amounts', () => {
    const c = counter({ name: uniq('up'), help: 'x' });
    c.inc(); c.inc('', 4); c.inc('', -3); c.inc('', NaN); c.inc('', Infinity); c.inc('', 0);
    assert.equal(c.get(), 5);
  });

  test('5: gauges are set to finite numbers (anything else becomes 0)', async () => {
    const name = uniq('g');
    const g = gauge({ name, help: 'x', label: 'state', allowed: ['a', 'b'] });
    g.set('a', 7); g.set('b', Number.NaN); g.set('zzz', 3);
    assert.deepEqual([g.get('a'), g.get('b'), g.get('other')], [7, 0, 3]);
  });

  test('6: a histogram reports cumulative buckets, sum and count', async () => {
    const name = uniq('h');
    const h = histogram({ name, help: 'x', buckets: [10, 1, 5] });
    [0.5, 3, 7, 100, -1, NaN].forEach((v) => h.observe(v));
    const out = lines(await renderMetrics()).filter((l) => l.startsWith(name));
    assert.deepEqual(out, [`${name}_bucket{le="1"} 1`, `${name}_bucket{le="5"} 2`, `${name}_bucket{le="10"} 3`, `${name}_bucket{le="+Inf"} 4`, `${name}_sum 110.5`, `${name}_count 4`]);
  });

  test('7: the text format has HELP and TYPE lines and ends with a newline', async () => {
    const name = uniq('fmt');
    counter({ name, help: 'multi\nline help', label: 'k', allowed: ['v'] });
    const text = await renderMetrics();
    assert.match(text, new RegExp(`# HELP ${name} multi line help\\n# TYPE ${name} counter\\n${name}\\{k="v"\\} 0\\n`));
    assert.ok(text.endsWith('\n'));
    assert.match(text, /odito_process_uptime_seconds \d+/);
  });

  test('8: a collector that fails or hangs cannot break or stall a scrape beyond the bound', async () => {
    registerCollector(() => { throw new Error('collector exploded'); });
    registerCollector(() => new Promise(() => {})); // never resolves
    const started = Date.now();
    const text = await renderMetrics({ collectTimeoutMs: 150 });
    assert.ok(Date.now() - started < 1500, 'bounded');
    assert.match(text, /odito_process_uptime_seconds/);
  });

  test('9: recording never throws, whatever it is given', () => {
    const c = counter({ name: uniq('safe'), help: 'x', label: 'k', allowed: ['v'] });
    const h = histogram({ name: uniq('safeh'), help: 'x', buckets: [1] });
    assert.doesNotThrow(() => { c.inc({}); c.inc(Symbol.iterator.description); h.observe('abc'); h.observe({}); });
  });
});
