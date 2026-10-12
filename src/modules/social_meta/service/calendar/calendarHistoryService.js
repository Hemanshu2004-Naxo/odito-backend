import SocialContentCalendar from '../../model/SocialContentCalendar.js';
import SocialContentCalendarItem from '../../model/SocialContentCalendarItem.js';
import SocialAIStrategy from '../../model/SocialAIStrategy.js';
import { loadPublicationSummaries } from './calendarItemLinks.js';
import { toId, fail } from './calendarPlanningContext.js';
import { LoggerUtil } from '../../../../utils/LoggerUtil.js';

/**
 * calendarHistoryService - the versions of a project's content calendar, as the person can actually reach them.
 *
 * Regenerating never deletes the calendar it replaces: it becomes `archived`, with every post, edit and approval exactly as they were.
 * This service is what makes that promise real: list the versions (with how much of each was edited, approved or turned into posts),
 * read any version's posts (read-only), and RESTORE a version - which swaps it back in as the current calendar and moves the current
 * one into history. Nothing is merged or rewritten: a version is always restored whole, with its own strategy pin, so posts planned
 * from different strategies are never mixed in one calendar.
 *
 * Everything is scoped by project: a calendar id from another project is simply "not found".
 */

const VERSION_STATUSES = ['ready', 'archived'];

const iso = (d) => (d ? new Date(d).toISOString() : null);

function toApiVersion(doc, counts, currentId) {
  const c = counts.get(String(doc._id)) || { total: 0, edited: 0, approved: 0, withContent: 0 };
  return {
    id: String(doc._id),
    version: doc.version,
    status: doc.status,
    isCurrent: String(doc._id) === String(currentId),
    generatedAt: iso(doc.generation?.finishedAt),
    config: { startDate: doc.config.startDate, endDate: doc.config.endDate, months: doc.config.months ?? null, postsPerWeek: doc.config.postsPerWeek, platforms: [...doc.config.platforms], distributionMode: doc.config.distributionMode },
    strategy: { version: doc.strategy.version },
    counts: { total: c.total, edited: c.edited, approvedPlans: c.approved, withPosts: c.withContent },
  };
}

async function countsFor(projectId, calendarIds) {
  const rows = await SocialContentCalendarItem.aggregate([
    { $match: { project_id: toId(projectId), calendar_id: { $in: calendarIds } } },
    {
      $group: {
        _id: '$calendar_id',
        total: { $sum: 1 },
        edited: { $sum: { $cond: [{ $gt: [{ $size: { $ifNull: ['$editedFields', []] } }, 0] }, 1, 0] } },
        approved: { $sum: { $cond: [{ $ne: [{ $ifNull: ['$planApprovedAt', null] }, null] }, 1, 0] } },
        withContent: { $sum: { $cond: [{ $gt: [{ $size: { $ifNull: ['$publicationIds', []] } }, 0] }, 1, 0] } },
      },
    },
  ]);
  return new Map(rows.map((r) => [String(r._id), r]));
}

/** Every version the person can open: the current calendar and its archived predecessors, newest first. */
export async function listCalendarVersions(projectId) {
  const docs = await SocialContentCalendar.find({ project_id: toId(projectId), status: { $in: VERSION_STATUSES } }).sort({ version: -1 }).lean();
  const current = docs.find((d) => d.status === 'ready');
  const counts = await countsFor(projectId, docs.map((d) => d._id));
  return { success: true, versions: docs.map((d) => toApiVersion(d, counts, current?._id)), currentVersion: current?.version || null };
}

/** One version's posts, read-only (an archived calendar is never edited; the current one is edited in the plan). */
export async function getCalendarVersion(projectId, calendarId, toApiItem) {
  const cid = toId(calendarId);
  if (!cid || typeof cid === 'string') return fail('NOT_FOUND', 'That calendar version was not found.');
  const doc = await SocialContentCalendar.findOne({ _id: cid, project_id: toId(projectId), status: { $in: VERSION_STATUSES } }).lean();
  if (!doc) return fail('NOT_FOUND', 'That calendar version was not found.');
  const items = await SocialContentCalendarItem.find({ project_id: toId(projectId), calendar_id: doc._id }).sort({ contentDate: 1, order: 1 }).lean();
  const publications = await loadPublicationSummaries(projectId, items.flatMap((i) => i.publicationIds || []));
  const current = await SocialContentCalendar.findOne({ project_id: toId(projectId), status: 'ready' }).sort({ version: -1 }).select('_id').lean();
  const counts = await countsFor(projectId, [doc._id]);
  return {
    success: true,
    version: toApiVersion(doc, counts, current?._id),
    items: items.map((i) => ({ ...toApiItem(i, (i.publicationIds || []).map((id) => publications.get(String(id))).filter(Boolean)), locked: true })),
  };
}

/**
 * Makes an ARCHIVED version the current calendar again, whole (its posts, edits and approvals are exactly as they were), and moves the
 * current one into history. Two conditional updates, in an order that never leaves the project without a valid current calendar: the
 * target is promoted first (the current calendar is simply the highest READY version, so while both are ready the person still sees
 * a complete calendar), then the previous one is archived; if the second step fails the first is undone.
 * Refused while a generation is running or unfinished (it would archive / compete with the one just restored).
 */
export async function restoreCalendarVersion(projectId, calendarId) {
  const pid = toId(projectId);
  const cid = toId(calendarId);
  if (!cid || typeof cid === 'string') return fail('NOT_FOUND', 'That calendar version was not found.');
  const target = await SocialContentCalendar.findOne({ _id: cid, project_id: pid }).lean();
  if (!target || !VERSION_STATUSES.includes(target.status)) return fail('NOT_FOUND', 'That calendar version was not found.');
  if (target.status === 'ready') return fail('ALREADY_CURRENT', 'That version is already the current calendar.');
  if (await SocialContentCalendar.exists({ project_id: pid, status: { $in: ['generating', 'partial'] } })) {
    return fail('GENERATION_IN_PROGRESS', 'A calendar is being generated, or has an unfinished draft. Finish, resume or discard it before restoring an earlier version.');
  }
  if (!(await SocialAIStrategy.exists({ _id: target.strategy.id, project_id: pid }))) {
    return fail('NO_STRATEGY', 'The strategy this version was planned from is no longer available, so it cannot be restored.');
  }

  const previous = await SocialContentCalendar.findOne({ project_id: pid, status: 'ready' }).sort({ version: -1 }).lean();
  const promoted = await SocialContentCalendar.findOneAndUpdate({ _id: target._id, project_id: pid, status: 'archived' }, { $set: { status: 'ready' } }, { new: true }).lean();
  if (!promoted) return fail('CONFLICT', 'That version changed at the same moment. Please try again.');
  if (previous) {
    const archived = await SocialContentCalendar.updateOne({ _id: previous._id, project_id: pid, status: 'ready' }, { $set: { status: 'archived' } });
    if (!archived.modifiedCount) {
      // the previous calendar moved under us (another restore, a generation finishing): put things back and let the person retry
      await SocialContentCalendar.updateOne({ _id: target._id, project_id: pid, status: 'ready' }, { $set: { status: 'archived' } });
      return fail('CONFLICT', 'The calendar changed at the same moment. Please try again.');
    }
  }
  // any other READY version (there should be none) is archived too, so exactly one calendar is current
  await SocialContentCalendar.updateMany({ project_id: pid, status: 'ready', _id: { $ne: target._id } }, { $set: { status: 'archived' } });
  // a failed attempt from before the restore must not be reported as "the last attempt failed" against the calendar just brought back
  await SocialContentCalendar.updateMany({ project_id: pid, status: 'failed' }, { $set: { status: 'cancelled' } });
  LoggerUtil.info('[SOCIAL_CALENDAR] Calendar version restored', { projectId: String(projectId), restored: target.version, replaced: previous?.version || null });
  return { success: true, restoredVersion: target.version, replacedVersion: previous?.version || null };
}

export default { listCalendarVersions, getCalendarVersion, restoreCalendarVersion };
