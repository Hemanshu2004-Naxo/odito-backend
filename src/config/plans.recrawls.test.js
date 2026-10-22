import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import User from '../modules/user/model/User.js';
import { getPlanLimits, getPlan } from './plans.js';
import { allocateQuotaFromPlan, reallocateQuotaForPlanChange, summarizeQuota } from '../utils/creditService.js';

// Manual Recrawl allowance: single source of truth is config/plans.js.
// Starter 3 / Pro 10 / Premium 30 per billing period, per user, reset on renewal.

describe('plan manual recrawl allowance (config)', () => {
  test('Starter 3, Pro 10, Premium 30 — read through the plan accessors', () => {
    assert.equal(getPlanLimits('starter').recrawls, 3);
    assert.equal(getPlanLimits('pro').recrawls, 10);
    assert.equal(getPlanLimits('premium').recrawls, 30);
    assert.equal(getPlan('premium').recrawls, 30);
  });
});

describe('recrawl allowance follows the subscription renewal mechanism (live Mongo)', () => {
  let mongoAvailable = false;
  const ids = [];

  before(async () => {
    try {
      await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
      mongoAvailable = true;
    } catch {
      mongoAvailable = false;
    }
  });

  after(async () => {
    if (mongoAvailable) {
      await User.collection.deleteMany({ _id: { $in: ids } });
      await mongoose.connection.close();
    }
  });

  async function makeUser(plan, recrawls) {
    const _id = new mongoose.Types.ObjectId();
    ids.push(_id);
    await User.collection.insertOne({
      _id, firstName: 'Plan', lastName: 'Tester', email: `plan-recrawls-${_id}@example.test`, roleId: 2,
      subscription: { plan, status: 'active', credits: { limit: 1, used: 0 }, pages: { limit: 1, used: 0 }, recrawls },
    });
    return _id;
  }

  test('activation/renewal allocates each plan\'s allowance and resets usage to 0 (per user, monthly)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    for (const [plan, expected] of [['starter', 3], ['pro', 10], ['premium', 30]]) {
      const id = await makeUser(plan, { limit: expected, used: expected });
      const updated = await allocateQuotaFromPlan(id, getPlanLimits(plan));
      assert.deepEqual(summarizeQuota(updated).recrawls, { limit: expected, used: 0, remaining: expected });
    }
  });

  test('a plan change re-limits the allowance but keeps usage already consumed', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const id = await makeUser('pro', { limit: 10, used: 4 });
    const updated = await reallocateQuotaForPlanChange(id, getPlanLimits('premium'));
    assert.deepEqual(summarizeQuota(updated).recrawls, { limit: 30, used: 4, remaining: 26 });
  });
});
