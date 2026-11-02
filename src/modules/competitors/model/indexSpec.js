/**
 * The indexes the project_competitors collection must have. ONE definition, used by the model (to declare them), by the startup /
 * first-write check in the service (to refuse writes when they are not really in place) and by the read-only inspection script
 * (scripts/inspectMyCompetitorIndexes.js), so the three can never disagree.
 *
 * REQUIRED_INDEXES are the feature's guarantees and writes are refused without them:
 *   - website: one entry per (project, website)           - place: one entry per (project, primary Google place)
 *   - branch place: one entry per (project, any branch place) - a brand's other branches are embedded in `branches`
 *   - slot: no more than MY_COMPETITORS_MAX entries per project
 * SUPPORTING_INDEXES only make queries fast (the enrichment queue, the plain project lookup). They carry no rule, so a failure to build
 * one never stops a write; they are declared by the model and known to the inspection script.
 */
export const REQUIRED_INDEXES = Object.freeze([
  Object.freeze({ name: 'project_competitor_domain_unique', key: Object.freeze({ project_id: 1, domain: 1 }), unique: true, partialFilterExpression: Object.freeze({ domain: Object.freeze({ $type: 'string' }) }) }),
  Object.freeze({ name: 'project_competitor_place_unique', key: Object.freeze({ project_id: 1, place_id: 1 }), unique: true, partialFilterExpression: Object.freeze({ place_id: Object.freeze({ $type: 'string' }) }) }),
  Object.freeze({ name: 'project_competitor_branch_place_unique', key: Object.freeze({ project_id: 1, 'branches.place_id': 1 }), unique: true, partialFilterExpression: Object.freeze({ 'branches.place_id': Object.freeze({ $type: 'string' }) }) }),
  Object.freeze({ name: 'project_competitor_slot_unique', key: Object.freeze({ project_id: 1, slot: 1 }), unique: true }),
]);

export const SUPPORTING_INDEXES = Object.freeze([
  Object.freeze({ name: 'project_id_1', key: Object.freeze({ project_id: 1 }) }),
  // The enrichment sweeper claims "pending and due" or "processing with an expired lease".
  Object.freeze({
    name: 'project_competitor_enrichment_queue',
    key: Object.freeze({ 'enrichment.status': 1, 'enrichment.next_attempt_at': 1, 'enrichment.lease_until': 1 }),
    // $type (not $in): the widest set of partial-filter operators MongoDB versions accept.
    partialFilterExpression: Object.freeze({ 'enrichment.status': Object.freeze({ $type: 'string' }) }),
  }),
]);

// Key ORDER matters for an index, so keys are compared as ordered entries; filters are compared as stable JSON.
const keyString = (key) => JSON.stringify(Object.entries(key ?? {}));
const stable = (value) => (value && typeof value === 'object' && !Array.isArray(value)
  ? `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`
  : Array.isArray(value) ? `[${value.map(stable).join(',')}]` : JSON.stringify(value ?? null));

/**
 * Compares the indexes found in MongoDB (`collection.indexes()`) with REQUIRED_INDEXES. Pure.
 *   missing     required indexes that do not exist (by name)
 *   wrong       required indexes that exist but with a different key order, uniqueness or partial filter
 *   conflicting indexes with a required KEY but another name (MongoDB would refuse to build the required one)
 *   unexpected  any other index (reported, never dropped by Odito)
 * `ok` is true only when nothing is missing, wrong or conflicting.
 */
export function diffIndexes(actual) {
  const found = actual ?? [];
  const missing = []; const wrong = []; const conflicting = [];
  for (const want of REQUIRED_INDEXES) {
    const byName = found.find((i) => i.name === want.name);
    if (!byName) {
      missing.push(want.name);
      for (const other of found) if (keyString(other.key) === keyString(want.key) && other.name !== want.name) conflicting.push({ name: other.name, required: want.name });
      continue;
    }
    const problems = [];
    if (keyString(byName.key) !== keyString(want.key)) problems.push(`key is ${keyString(byName.key)}, expected ${keyString(want.key)}`);
    if (Boolean(byName.unique) !== Boolean(want.unique)) problems.push(want.unique ? 'not unique' : 'unexpectedly unique');
    if (stable(byName.partialFilterExpression) !== stable(want.partialFilterExpression)) problems.push(`partial filter is ${stable(byName.partialFilterExpression)}, expected ${stable(want.partialFilterExpression)}`);
    if (problems.length) wrong.push({ name: want.name, problems });
  }
  const known = new Set(['_id_', ...REQUIRED_INDEXES.map((i) => i.name), ...SUPPORTING_INDEXES.map((i) => i.name)]);
  const unexpected = found.filter((i) => !known.has(i.name)).map((i) => i.name);
  return { ok: missing.length === 0 && wrong.length === 0 && conflicting.length === 0, missing, wrong, conflicting, unexpected };
}
