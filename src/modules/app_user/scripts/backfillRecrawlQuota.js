/**
 * One-time backfill for the manual Recrawl allowance (User.subscription.recrawls).
 *
 * The field is new: it is allocated from config/plans.js at subscription
 * activation and renewal (allocateQuotaFromPlan) and re-limited on plan change
 * (reallocateQuotaForPlanChange). Users who subscribed BEFORE it existed have
 * no `recrawls` allowance until their next renewal, which would block their
 * "Start Recrawl" button in the meantime. This script gives every user with a
 * plan the plan's current `recrawls` limit right away.
 *
 * Only touches users whose `subscription.recrawls.limit` is missing or 0 and
 * who have a plan — anyone already allocated (renewal, admin change, or a
 * previous run) is left alone, so re-running is a safe no-op. `used` is never
 * modified.
 *
 * Usage:
 *   npm run migrate:backfill-recrawl-quota
 *   npm run migrate:backfill-recrawl-quota -- --dry-run
 */

import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import connectDB from '../../../config/database.js';
import User from '../../user/model/User.js';
import { getPlanLimits, isValidPlan } from '../../../config/plans.js';

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  await connectDB();

  const candidates = await User.find({
    'subscription.plan': { $ne: null },
    $or: [
      { 'subscription.recrawls.limit': { $exists: false } },
      { 'subscription.recrawls.limit': 0 },
    ],
  })
    .select('_id subscription.plan')
    .lean();

  let updated = 0;
  let skipped = 0;

  for (const user of candidates) {
    const planId = user.subscription?.plan;
    if (!isValidPlan(planId)) {
      skipped += 1;
      continue;
    }
    const { recrawls } = getPlanLimits(planId);
    if (!recrawls) {
      skipped += 1;
      continue;
    }
    if (!DRY_RUN) {
      await User.updateOne(
        { _id: user._id },
        { $set: { 'subscription.recrawls.limit': recrawls } }
      );
    }
    updated += 1;
  }

  console.log(`${DRY_RUN ? '[dry-run] would update' : 'Updated'} ${updated} user(s); skipped ${skipped}; candidates ${candidates.length}.`);
  await mongoose.connection.close();
}

main().catch(async (error) => {
  console.error('Recrawl quota backfill failed:', error);
  await mongoose.connection.close().catch(() => {});
  process.exit(1);
});
