import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

// No post limits here - only the safety cap on generations running at once per account (set before the config is first imported).
process.env.SOCIAL_AI_CALENDAR_QUOTA_MAX_IN_FLIGHT_PER_USER = '2';
delete process.env.SOCIAL_AI_CALENDAR_QUOTA_USER_POSTS_PER_MONTH;
delete process.env.SOCIAL_AI_CALENDAR_QUOTA_PROJECT_POSTS_PER_MONTH;

const { default: SocialAIUsage } = await import('../../model/SocialAIUsage.js');
const quota = await import('./calendarQuotaService.js');

let mongoAvailable = false;
const userId = new mongoose.Types.ObjectId();
before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
    await SocialAIUsage.init();
  } catch { mongoAvailable = false; }
});
afterEach(async () => { if (mongoAvailable) await SocialAIUsage.deleteMany({ $or: [{ scope: 'user', scope_id: userId }, { scope: 'project' }] }); });
after(async () => { if (mongoAvailable) await mongoose.connection.close(); });

describe('generations in flight per account (database-enforced safety cap)', () => {
  const reserve = (calendarId = new mongoose.Types.ObjectId()) => quota.reserveCalendarQuota({ userId, projectId: new mongoose.Types.ObjectId(), calendarId, posts: 10 });

  test('1: with no post limit configured the allowance is unlimited, and the cap alone limits concurrency - exactly 2 of 8 simultaneous generations get a slot', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    assert.equal((await quota.limitsFor(userId)).userPosts, null);
    const ids = Array.from({ length: 8 }, () => new mongoose.Types.ObjectId());
    const results = await Promise.all(ids.map((id) => reserve(id)));
    assert.equal(results.filter((r) => r.success).length, 2);
    assert.ok(results.filter((r) => !r.success).every((r) => r.error.code === 'TOO_MANY_GENERATIONS' && r.error.maxInFlight === 2));
    assert.match(results.find((r) => !r.success).error.message, /already have 2 calendars being generated/);
    const ledger = await SocialAIUsage.findOne({ scope: 'user', scope_id: userId }).lean();
    assert.equal(ledger.reservations.length, 2);
    // the losers did not leave a reservation on their project ledgers
    assert.equal(await SocialAIUsage.countDocuments({ scope: 'project', 'reservations.0': { $exists: true } }), 2);
  });

  test('2: finishing one frees its slot at once; reserving the same calendar twice is one slot (idempotent)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const a = new mongoose.Types.ObjectId();
    const b = new mongoose.Types.ObjectId();
    assert.equal((await reserve(a)).success, true);
    assert.equal((await reserve(a)).success, true, 'the same calendar again: already reserved');
    assert.equal((await reserve(b)).success, true);
    assert.equal((await reserve()).error.code, 'TOO_MANY_GENERATIONS');
    assert.equal((await quota.settleCalendarQuota(a)).settled >= 1, true);
    assert.equal((await reserve()).success, true, 'the freed slot is usable');
    assert.equal((await SocialAIUsage.findOne({ scope: 'user', scope_id: userId }).lean()).reservations.length, 2);
  });

  test('3: the usage summary reports the cap and what is in flight', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await reserve();
    const s = await quota.getUsageSummary({ userId, projectId: new mongoose.Types.ObjectId(), internal: true });
    assert.deepEqual([s.inFlight, s.maxInFlight, s.user.limit, s.user.remaining], [1, 2, null, null]);
    assert.equal(s.usage.estimatedCostUsd, null, 'no prices configured: no invented cost');
  });
});
