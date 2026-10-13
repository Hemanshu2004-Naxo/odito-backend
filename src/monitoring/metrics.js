/**
 * A deliberately small Prometheus-format metrics registry (no dependency): counters, gauges and one histogram type.
 *
 * Cardinality is bounded BY CONSTRUCTION: a metric has at most ONE label, and a labelled metric must declare the complete list of values that label
 * may take. Any other value is recorded as "other", so a project id, a URL, a token or an exception message can never become a label value
 * (and a typo cannot create a new series). Recording never throws - a metrics bug must not break the business operation it observes.
 *
 * Counters live in this process; Prometheus adds them up across instances. Gauges filled by collectors read shared database state, so every
 * instance reports the same number: alert on max(), not sum().
 */

const OTHER = 'other';
const NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const labelValue = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const numberText = (n) => (Number.isFinite(n) ? String(n) : (n > 0 ? '+Inf' : n < 0 ? '-Inf' : 'NaN'));

const metrics = [];
const collectors = [];

function define(kind, { name, help, label = null, allowed = null, buckets = null }) {
  if (!NAME_RE.test(name)) throw new Error(`invalid metric name: ${name}`);
  if (label && (!Array.isArray(allowed) || !allowed.length)) throw new Error(`metric ${name}: a label needs an explicit list of allowed values (bounded cardinality)`);
  if (!label && allowed) throw new Error(`metric ${name}: allowed values without a label`);
  if (metrics.some((m) => m.name === name)) throw new Error(`metric ${name} is already defined`);
  const metric = { kind, name, help, label, allowed: allowed ? [...allowed] : null, buckets, values: new Map() };
  // every allowed value starts at zero, so the series exists (and rate()/increase() work) before the first event
  if (kind !== 'histogram') {
    // 'other' always exists too: the series for anything outside the list is visible (at 0) from the first scrape
    if (label) for (const v of [...metric.allowed, OTHER]) metric.values.set(v, 0);
    else metric.values.set('', 0);
  } else {
    metric.hist = { counts: buckets.map(() => 0), sum: 0, count: 0 };
  }
  metrics.push(metric);
  return metric;
}

const keyFor = (metric, value) => {
  if (!metric.label) return '';
  const v = String(value ?? '');
  return metric.allowed.includes(v) ? v : OTHER;
};

function ensureOther(metric, key) {
  if (key === OTHER && !metric.values.has(OTHER)) metric.values.set(OTHER, 0);
}

export function counter(def) {
  const metric = define('counter', def);
  return {
    inc(value = '', n = 1) {
      try {
        const key = keyFor(metric, value);
        ensureOther(metric, key);
        metric.values.set(key, (metric.values.get(key) || 0) + (Number.isFinite(n) && n > 0 ? n : 0));
      } catch { /* never break the caller */ }
    },
    get(value = '') { return metric.values.get(keyFor(metric, value)) || 0; },
  };
}

export function gauge(def) {
  const metric = define('gauge', def);
  return {
    set(value, n) {
      try {
        const key = keyFor(metric, value);
        ensureOther(metric, key);
        metric.values.set(key, Number.isFinite(n) ? n : 0);
      } catch { /* never break the caller */ }
    },
    setUnlabelled(n) { this.set('', n); },
    get(value = '') { return metric.values.get(keyFor(metric, value)) || 0; },
  };
}

export function histogram(def) {
  const buckets = [...def.buckets].sort((a, b) => a - b);
  const metric = define('histogram', { ...def, buckets });
  return {
    observe(n) {
      try {
        if (!Number.isFinite(n) || n < 0) return;
        buckets.forEach((upper, i) => { if (n <= upper) metric.hist.counts[i] += 1; });
        metric.hist.sum += n;
        metric.hist.count += 1;
      } catch { /* never break the caller */ }
    },
    snapshot() { return { counts: [...metric.hist.counts], sum: metric.hist.sum, count: metric.hist.count, buckets }; },
  };
}

/** A function that refreshes gauges from shared state just before a scrape. It may be slow or fail; neither delays or breaks the scrape beyond a bound. */
export function registerCollector(fn) { collectors.push(fn); }

async function runCollectors(timeoutMs) {
  if (!collectors.length) return;
  let timer;
  const bound = new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); });
  await Promise.race([Promise.allSettled(collectors.map((c) => Promise.resolve().then(c))), bound]);
  clearTimeout(timer);
}

/** The Prometheus text exposition of everything registered. */
export async function renderMetrics({ collectTimeoutMs = 3000 } = {}) {
  await runCollectors(collectTimeoutMs);
  const lines = [];
  for (const m of metrics) {
    lines.push(`# HELP ${m.name} ${m.help.replace(/\n/g, ' ')}`);
    lines.push(`# TYPE ${m.name} ${m.kind}`);
    if (m.kind === 'histogram') {
      m.buckets.forEach((upper, i) => lines.push(`${m.name}_bucket{le="${upper}"} ${m.hist.counts[i]}`));
      lines.push(`${m.name}_bucket{le="+Inf"} ${m.hist.count}`);
      lines.push(`${m.name}_sum ${numberText(m.hist.sum)}`);
      lines.push(`${m.name}_count ${m.hist.count}`);
      continue;
    }
    for (const [key, value] of m.values) {
      lines.push(m.label ? `${m.name}{${m.label}="${labelValue(key)}"} ${numberText(value)}` : `${m.name} ${numberText(value)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

// process basics, always present
const uptime = gauge({ name: 'odito_process_uptime_seconds', help: 'Seconds since this API process started.' });
const rss = gauge({ name: 'odito_process_resident_memory_bytes', help: 'Resident memory of this API process.' });
registerCollector(() => { uptime.setUnlabelled(Math.round(process.uptime())); rss.setUnlabelled(process.memoryUsage().rss); });

/** Test helper: forget every value (definitions stay). */
export function resetMetricValues() {
  for (const m of metrics) {
    if (m.kind === 'histogram') m.hist = { counts: m.buckets.map(() => 0), sum: 0, count: 0 };
    else for (const key of [...m.values.keys()]) { if (m.label && !m.allowed.includes(key)) m.values.delete(key); else m.values.set(key, 0); }
  }
}

export default { counter, gauge, histogram, registerCollector, renderMetrics, resetMetricValues };
