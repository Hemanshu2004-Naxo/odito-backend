import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SeoProject from '../model/SeoProject.js';
import SocialContentCalendar from '../../social_meta/model/SocialContentCalendar.js';
import SocialContentCalendarItem from '../../social_meta/model/SocialContentCalendarItem.js';
import { deleteProjectCascade } from './projectCascadeDeleteService.js';

/** Regression: permanently deleting a project must purge its content calendars AND their items (every version), and only that project's. */
let mongoAvailable = false;
before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
  } catch { mongoAvailable = false; }
});
after(async () => { if (mongoAvailable) await mongoose.connection.close(); });

describe('deleteProjectCascade — content calendars', () => {
  let userId;
  beforeEach(() => { userId = new mongoose.Types.ObjectId(); });

  const project = () => SeoProject.create({ user_id: userId, project_name: `Cascade Calendar ${Date.now()} ${Math.random().toString(36).slice(2, 8)}`, main_url: 'https://example.com', seo_scope: 'local', keywords: ['k'] });
  const seed = async (p) => {
    const strategyId = new mongoose.Types.ObjectId();
    for (const [version, status] of [[1, 'archived'], [2, 'ready']]) {
      const cal = await SocialContentCalendar.create({
        project_id: p._id, version, status, config: { startDate: '2026-10-06', endDate: '2026-10-12', postsPerWeek: 3, platforms: ['facebook'], distributionMode: 'balanced' }, strategy: { id: strategyId, version: 1, profileSnapshotHash: 'h' },
      });
      for (let order = 0; order < 3; order += 1) {
        await SocialContentCalendarItem.create({
          project_id: p._id, calendar_id: cal._id, strategyId, strategyVersion: 1, order, contentDate: `2026-10-0${6 + order}`, dayOfWeek: 'monday', platforms: ['facebook'], format: 'static_post',
          contentPillar: 'Tips', contentType: 'educational', objective: 'engagement', primaryKpi: 'saves', topic: `Topic ${order}`,
        });
      }
    }
  };

  test('1: removes every calendar version and every item of the project, and leaves other projects\' alone', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const doomed = await project();
    const kept = await project();
    await seed(doomed); await seed(kept);
    const summary = await deleteProjectCascade(String(doomed._id));
    assert.equal(summary.projectDeleted, true);
    assert.equal(summary.failures.length, 0);
    assert.equal(summary.collectionCounts.social_content_calendars, 2, 'both versions');
    assert.equal(summary.collectionCounts.social_content_calendar_items, 6);
    assert.equal(await SocialContentCalendar.countDocuments({ project_id: doomed._id }), 0);
    assert.equal(await SocialContentCalendarItem.countDocuments({ project_id: doomed._id }), 0, 'no orphaned item');
    assert.equal(await SocialContentCalendar.countDocuments({ project_id: kept._id }), 2);
    assert.equal(await SocialContentCalendarItem.countDocuments({ project_id: kept._id }), 6);
    await deleteProjectCascade(String(kept._id));
    assert.equal(await SocialContentCalendarItem.countDocuments({ project_id: kept._id }), 0);
  });

  test('2: is idempotent', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await project();
    await seed(p);
    await deleteProjectCascade(String(p._id));
    const again = await deleteProjectCascade(String(p._id));
    assert.equal(again.failures.length, 0);
    assert.equal(again.collectionCounts.social_content_calendars, 0);
    assert.equal(again.collectionCounts.social_content_calendar_items, 0);
  });
});
