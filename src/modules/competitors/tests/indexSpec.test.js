import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { diffIndexes, REQUIRED_INDEXES } from '../model/indexSpec.js';

const asMongo = (spec) => ({ v: 2, name: spec.name, key: { ...spec.key }, unique: spec.unique, ...(spec.partialFilterExpression ? { partialFilterExpression: JSON.parse(JSON.stringify(spec.partialFilterExpression)) } : {}) });
const good = () => [{ name: '_id_', key: { _id: 1 } }, { name: 'project_id_1', key: { project_id: 1 } }, { name: 'project_competitor_enrichment_queue', key: { 'enrichment.status': 1 } }, ...REQUIRED_INDEXES.map(asMongo)];

describe('diffIndexes (what MongoDB reports vs what My Competitors requires)', () => {
  test('the exact required set is ok, and the plain lookup index is not "unexpected"', () => {
    assert.deepEqual(diffIndexes(good()), { ok: true, missing: [], wrong: [], conflicting: [], unexpected: [] });
  });

  test('required indexes are the four intended ones, in the intended key order', () => {
    assert.deepEqual(REQUIRED_INDEXES.map((i) => [i.name, Object.keys(i.key).join('+'), i.unique, i.partialFilterExpression ?? null]), [
      ['project_competitor_domain_unique', 'project_id+domain', true, { domain: { $type: 'string' } }],
      ['project_competitor_place_unique', 'project_id+place_id', true, { place_id: { $type: 'string' } }],
      ['project_competitor_branch_place_unique', 'project_id+branches.place_id', true, { 'branches.place_id': { $type: 'string' } }],
      ['project_competitor_slot_unique', 'project_id+slot', true, null],
    ]);
  });

  test('a missing index is reported by name', () => {
    const d = diffIndexes(good().filter((i) => i.name !== 'project_competitor_slot_unique'));
    assert.equal(d.ok, false);
    assert.deepEqual(d.missing, ['project_competitor_slot_unique']);
  });

  test('wrong uniqueness, key order and partial filter are each caught', () => {
    const idx = good();
    idx.find((i) => i.name === 'project_competitor_slot_unique').unique = false;
    idx.find((i) => i.name === 'project_competitor_domain_unique').key = { domain: 1, project_id: 1 };
    idx.find((i) => i.name === 'project_competitor_place_unique').partialFilterExpression = { place_id: { $exists: true } };
    const d = diffIndexes(idx);
    assert.equal(d.ok, false);
    assert.deepEqual(d.wrong.map((w) => w.name).sort(), ['project_competitor_domain_unique', 'project_competitor_place_unique', 'project_competitor_slot_unique']);
    assert.match(d.wrong.find((w) => w.name === 'project_competitor_domain_unique').problems.join(), /key is/);
    assert.match(d.wrong.find((w) => w.name === 'project_competitor_slot_unique').problems.join(), /not unique/);
    assert.match(d.wrong.find((w) => w.name === 'project_competitor_place_unique').problems.join(), /partial filter/);
  });

  test('a required key under another name is a conflict (MongoDB cannot build the required one beside it)', () => {
    const idx = good().filter((i) => i.name !== 'project_competitor_slot_unique');
    idx.push({ name: 'old_slot_idx', key: { project_id: 1, slot: 1 }, unique: true });
    const d = diffIndexes(idx);
    assert.equal(d.ok, false);
    assert.deepEqual(d.conflicting, [{ name: 'old_slot_idx', required: 'project_competitor_slot_unique' }]);
    assert.deepEqual(d.unexpected, ['old_slot_idx']);
  });

  test('an unrelated extra index is reported as unexpected but does not fail the check', () => {
    const d = diffIndexes([...good(), { name: 'something_else', key: { notes: 1 } }]);
    assert.equal(d.ok, true);
    assert.deepEqual(d.unexpected, ['something_else']);
  });

  test('a collection with no indexes at all reports all four missing', () => {
    assert.equal(diffIndexes([{ name: '_id_', key: { _id: 1 } }]).missing.length, 4);
    assert.equal(diffIndexes(undefined).missing.length, 4);
  });
});
